// Collects a fixed number of microphone samples, then hands them back once.
class Recorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frames = Math.min(Math.max(1, options.processorOptions.frames | 0), 48000 * 10);
    this.buffer = new Float32Array(frames);
    this.filled = 0;
    this.done = false;
    this.tick = 0;
  }
  process(inputs) {
    if (this.done) return false;
    const input = inputs[0] && inputs[0][0];
    if (input) {
      const n = Math.min(input.length, this.buffer.length - this.filled);
      this.buffer.set(input.subarray(0, n), this.filled);
      this.filled += n;
      if (++this.tick % 8 === 0) {
        let peak = 0;
        for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
        this.port.postMessage({ level: peak });
      }
    }
    if (this.filled >= this.buffer.length) {
      this.done = true;
      this.port.postMessage({ samples: this.buffer }, [this.buffer.buffer]);
      return false;
    }
    return true;
  }
}
registerProcessor('ringtrue-recorder', Recorder);
