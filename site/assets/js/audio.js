// Sound: playing a bar (synthesised from its partials), recording a tap, reading a sound file.
// Nothing recorded is ever sent anywhere; it is analysed in this tab and then dropped.

let ctx = null;
function context() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/**
 * How loud each partial sounds and how long it rings.
 * freqs: Hz; weights: how much the mallet excites each one (mode shape at the strike point);
 * loss: the material's loss factor. Each partial dies away as exp(-pi f loss t).
 */
export function voice(freqs, weights, loss, { mallet = 0.5, resonator = true } = {}) {
  return freqs
    .map((f, i) => {
      if (!(f > 20 && f < 20000)) return null;
      // A soft mallet (0) barely excites the upper partials; a hard one (1) brings them out.
      const brightness = 0.25 + 0.75 * mallet;
      let gain = Math.abs(weights[i] ?? 1) * brightness ** i * (i === 0 ? 1 : 0.6);
      let decay = 1 / (Math.PI * f * Math.max(loss, 0.0001));
      if (i === 0 && resonator) {
        gain *= 1.6;
        decay *= 1.5;
      }
      return { f, gain, decay: Math.min(decay, 12) };
    })
    .filter(Boolean);
}

/** Plays a bar now. Returns the time it will have died away (seconds). */
export function strike(partials, { volume = 0.35 } = {}) {
  const ac = context();
  const t0 = ac.currentTime + 0.01;
  const out = ac.createGain();
  out.gain.value = volume / Math.max(1, partials.reduce((s, p) => s + p.gain, 0));
  out.connect(ac.destination);
  let end = 0;
  for (const p of partials) {
    const osc = ac.createOscillator();
    osc.frequency.value = p.f;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(p.gain, t0 + 0.002);
    g.gain.setTargetAtTime(0, t0 + 0.002, p.decay);
    osc.connect(g).connect(out);
    const stop = t0 + Math.min(p.decay * 7, 14);
    osc.start(t0);
    osc.stop(stop);
    end = Math.max(end, stop);
  }
  return end - ac.currentTime;
}

/**
 * Renders a tap as samples (for the practice bar): the same voice, a mallet click and a little
 * room noise. Deterministic for a given seed.
 */
export function renderTap(partials, rate = 48000, seconds = 2, seed = 1) {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  const start = Math.round(rate * 0.12);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296 - 0.5;
  };
  const total = partials.reduce((a, p) => a + p.gain, 0) || 1;
  for (let i = 0; i < n; i++) {
    let v = rnd() * 0.002;
    const t = (i - start) / rate;
    if (t >= 0) {
      for (let k = 0; k < partials.length; k++) {
        const p = partials[k];
        v += (0.6 * p.gain / total) * Math.exp(-t / p.decay) * Math.sin(2 * Math.PI * p.f * t + k * 0.7);
      }
      if (t < 0.004) v += rnd() * 0.3 * (1 - t / 0.004);
    }
    x[i] = v;
  }
  return x;
}

/** Records `seconds` of mono audio from the microphone. Resolves {samples, rate}. */
export async function record(seconds = 2.5, onLevel = () => {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone access.');
  const ac = context();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  try {
    await ac.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    const src = ac.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ac, 'ringtrue-recorder', { processorOptions: { frames: Math.round(ac.sampleRate * seconds) } });
    const done = new Promise((resolve) => {
      node.port.onmessage = ({ data }) => {
        if (data.level !== undefined) onLevel(data.level);
        if (data.samples) resolve(data.samples);
      };
    });
    src.connect(node);
    const samples = await done;
    src.disconnect();
    node.disconnect();
    return { samples, rate: ac.sampleRate };
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

export const FILE_LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, seconds: 20 });

/** Decodes a sound file the person chose (WAV, MP3, M4A...) to mono samples, within limits. */
export async function decodeFile(file) {
  if (!file || file.size === 0) throw new Error('That file is empty.');
  if (file.size > FILE_LIMITS.bytes) throw new Error('That file is larger than 20 MB. Trim it to the tap and a second or two after.');
  const buf = await file.arrayBuffer();
  let audio;
  try {
    audio = await context().decodeAudioData(buf);
  } catch {
    throw new Error('That file could not be read as audio. Try a WAV or MP3 recording.');
  }
  if (audio.duration > FILE_LIMITS.seconds) throw new Error('That recording is longer than 20 seconds. Trim it to the tap.');
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  return { samples: mono, rate: audio.sampleRate };
}
