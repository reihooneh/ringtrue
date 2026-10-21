// The bridge to the C++ core (WebAssembly), shared by the page, the worker and the tests.
// Field positions mirror core/api.hpp. Every request is validated again inside the core.

export const IN = Object.freeze({
  E: 0, G: 1, RHO: 2, LOSS: 3, WIDTH: 4, THICK: 5, MIN_THICK: 6,
  F1: 7, R2: 8, R3: 9, COUNT: 10, FIXED: 11, LENGTH: 12, MIN_LENGTH: 13, MAX_LENGTH: 14,
  PROFILE_KIND: 15, SPAN: 16, DEPTH0: 17, TABLE_COUNT: 21, TABLE0: 22,
  HEARD_COUNT: 230, HEARD0: 231, RATE: 240, SAMPLES: 241, EXPECT0: 242,
});
const O = Object.freeze({ STATUS: 0, LENGTH: 1, SPAN: 2, DEPTH0: 3, EVALS: 7, FREQ0: 8, ERR0: 13, MET0: 16, MASS: 19, NODES: 20, PROFILE: 40, SHAPES: 170 });
const A = Object.freeze({ STATUS: 0, DONE: 1, FLAT: 2, STIFF: 3, SHEAR: 4, FIT0: 5, NOW0: 8, STEPS: 11, STEP0: 12, SENS0: 70, SENS_POS0: 150, EVALS: 180, PROFILE: 200 });
const H = Object.freeze({ STATUS: 0, ONSET: 1, PEAK_AMP: 2, FOUND: 3, PARTIAL0: 4, LEVEL0: 7, PEAKS: 10, PEAK0: 11 });

export const STATUS = Object.freeze({ OK: 0, MISSED: 1, BAD_INPUT: -1, NO_SOLUTION: -2, TOO_QUIET: -3, NO_PEAKS: -4 });
export const PROFILE_POINTS = 121;
export const SENS_POINTS = 24;
export const IN_SIZE = 512;
export const OUT_SIZE = 2048;

export const TUNINGS = Object.freeze({
  marimba: { label: 'Marimba', ratios: '1 : 4 : 10', r2: 4, r3: 10, count: 3 },
  xylophone: { label: 'Xylophone', ratios: '1 : 3 : 6', r2: 3, r3: 6, count: 3 },
  vibraphone: { label: 'Vibraphone', ratios: '1 : 4', r2: 4, r3: 10, count: 2 },
  note: { label: 'Note only', ratios: '1', r2: 4, r3: 10, count: 1 },
});

// ---------- Notes ----------
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4", "F#3", "Bb5" -> MIDI number (C1..C8), or null. */
export function parseNote(text) {
  const m = /^([A-Ga-g])([#b]?)([0-8])$/.exec(String(text).trim());
  if (!m) return null;
  let pc = LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const midi = (Number(m[3]) + 1) * 12 + pc;
  return midi >= 24 && midi <= 108 ? midi : null;
}
export const noteName = (midi) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
export const noteHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
export const isSharp = (midi) => NAMES[midi % 12].length > 1;

/** Bar sizes graded like a real keyboard (the same rule as the command line). Metres. */
export function gradedSection(midi) {
  const t = Math.min(1, Math.max(0, (midi - 36) / 60));
  return { width: 0.064 - t * (0.064 - 0.038), thickness: 0.025 - t * (0.025 - 0.018) };
}

export const cents = (a, b) => 1200 * Math.log2(a / b);

// ---------- Requests ----------
function base(spec) {
  const r = new Float64Array(IN_SIZE);
  r[IN.E] = spec.mat.E;
  r[IN.G] = spec.mat.G;
  r[IN.RHO] = spec.mat.rho;
  r[IN.LOSS] = spec.mat.loss;
  r[IN.WIDTH] = spec.width;
  r[IN.THICK] = spec.thickness;
  r[IN.MIN_THICK] = spec.minThickness;
  r[IN.F1] = spec.f1;
  r[IN.R2] = spec.r2;
  r[IN.R3] = spec.r3;
  r[IN.COUNT] = spec.count;
  return r;
}

/** spec: {mat, width, thickness, minThickness, f1, r2, r3, count, fixedLength, length?} (metres, Hz) */
export function designRequest(spec) {
  const r = base(spec);
  r[IN.FIXED] = spec.fixedLength ? 1 : 0;
  r[IN.LENGTH] = spec.fixedLength ? spec.length : 0;
  r[IN.MIN_LENGTH] = 0.06;
  r[IN.MAX_LENGTH] = 1.2;
  return r;
}

/** bar: spec fields + {length, cut: {span, depths[4]}} or {length, table: [thickness...]} */
export function barRequest(bar, heard = null) {
  const r = base(bar);
  r[IN.LENGTH] = bar.length;
  if (bar.table) {
    r[IN.PROFILE_KIND] = 1;
    r[IN.TABLE_COUNT] = bar.table.length;
    bar.table.forEach((h, i) => { r[IN.TABLE0 + i] = h; });
  } else {
    r[IN.PROFILE_KIND] = 0;
    r[IN.SPAN] = bar.cut.span;
    bar.cut.depths.forEach((d, i) => { r[IN.DEPTH0 + i] = d; });
  }
  if (heard) {
    r[IN.HEARD_COUNT] = heard.length;
    heard.forEach((f, i) => { r[IN.HEARD0 + i] = f; });
  }
  return r;
}

// ---------- Results ----------
export function decodeBar(o) {
  const nodes = [0, 1, 2].map((k) => {
    const n = o[O.NODES + k * 6];
    return Array.from({ length: n }, (_, i) => o[O.NODES + k * 6 + 1 + i]);
  });
  return {
    status: o[O.STATUS],
    length: o[O.LENGTH],
    span: o[O.SPAN],
    depths: [0, 1, 2, 3].map((k) => o[O.DEPTH0 + k]),
    evaluations: o[O.EVALS],
    freq: [0, 1, 2, 3, 4].map((k) => o[O.FREQ0 + k]),
    error: [0, 1, 2].map((k) => o[O.ERR0 + k]),
    met: [0, 1, 2].map((k) => o[O.MET0 + k] > 0),
    mass: o[O.MASS],
    nodes,
    profile: Array.from(o.subarray(O.PROFILE, O.PROFILE + PROFILE_POINTS)),
    shapes: [0, 1, 2, 3, 4].map((k) => Array.from(o.subarray(O.SHAPES + k * PROFILE_POINTS, O.SHAPES + (k + 1) * PROFILE_POINTS))),
  };
}

export function decodeAdvice(o) {
  const steps = [];
  for (let s = 0; s < o[A.STEPS]; s++) {
    const p = A.STEP0 + s * 7;
    steps.push({ kind: o[p] === 1 ? 'trim' : 'deepen', position: o[p + 1], width: o[p + 2], amount: o[p + 3], after: [o[p + 4], o[p + 5], o[p + 6]] });
  }
  return {
    status: o[A.STATUS],
    done: o[A.DONE] > 0,
    flat: o[A.FLAT] > 0,
    stiffness: o[A.STIFF],
    shear: o[A.SHEAR],
    fit: [0, 1, 2].map((i) => o[A.FIT0 + i]),
    now: [0, 1, 2].map((i) => o[A.NOW0 + i]),
    steps,
    sensitivity: [0, 1, 2].map((i) => Array.from(o.subarray(A.SENS0 + i * SENS_POINTS, A.SENS0 + (i + 1) * SENS_POINTS))),
    sensPositions: Array.from(o.subarray(A.SENS_POS0, A.SENS_POS0 + SENS_POINTS)),
    evaluations: o[A.EVALS],
    profileAfter: Array.from(o.subarray(A.PROFILE, A.PROFILE + PROFILE_POINTS)),
  };
}

export function decodeHearing(o) {
  const peaks = [];
  for (let i = 0; i < o[H.PEAKS]; i++) peaks.push({ freq: o[H.PEAK0 + 2 * i], level: o[H.PEAK0 + 2 * i + 1] });
  const found = o[H.FOUND];
  return {
    status: o[H.STATUS],
    onset: o[H.ONSET],
    peakAmplitude: o[H.PEAK_AMP],
    partials: Array.from({ length: found }, (_, i) => o[H.PARTIAL0 + i]),
    levels: Array.from({ length: found }, (_, i) => o[H.LEVEL0 + i]),
    peaks,
  };
}

// ---------- The module ----------
/** Instantiates the core from the .wasm bytes. Works in a worker, the page or Node. */
export async function instantiate(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  if (x.rt_version() !== 1 || x.rt_in_size() !== IN_SIZE || x.rt_out_size() !== OUT_SIZE) throw new Error('Unexpected core version');
  const view = () => ({
    input: new Float64Array(x.memory.buffer, x.rt_in(), IN_SIZE),
    output: new Float64Array(x.memory.buffer, x.rt_out(), OUT_SIZE),
  });
  const call = (fn, req) => {
    if (!(req instanceof Float64Array) || req.length !== IN_SIZE) throw new TypeError('bad request');
    const { input, output } = view();
    input.set(req);
    fn();
    return output.slice();
  };
  const cap = x.rt_samples_cap();
  return {
    samplesCap: cap,
    design: (req) => decodeBar(call(x.rt_design, req)),
    analyse: (req) => decodeBar(call(x.rt_analyse, req)),
    advise: (req) => decodeAdvice(call(x.rt_advise, req)),
    /** samples: Float32Array (mono), rate in Hz, expect: [f1, f2, f3] or null */
    hear(samples, rate, expect = null) {
      if (!(samples instanceof Float32Array) || samples.length > cap) throw new RangeError('recording too long');
      new Float32Array(x.memory.buffer, x.rt_samples(), samples.length).set(samples);
      const req = new Float64Array(IN_SIZE);
      req[IN.RATE] = rate;
      req[IN.SAMPLES] = samples.length;
      (expect || [0, 0, 0]).forEach((f, i) => { req[IN.EXPECT0 + i] = f; });
      return decodeHearing(call(x.rt_hear, req));
    },
  };
}
