// Runs the C++ core off the main thread, so the page stays responsive while a bar is designed.
// Messages: {id, op: 'design'|'analyse'|'advise'|'hear', req?, samples?, rate?, expect?}
import { instantiate } from './core.js';

const ready = fetch(new URL('../ringtrue.wasm', import.meta.url))
  .then((r) => {
    if (!r.ok) throw new Error('could not load the core');
    return r.arrayBuffer();
  })
  .then((bytes) => instantiate(bytes));

const OPS = new Set(['design', 'analyse', 'advise', 'hear']);

self.onmessage = async (event) => {
  const msg = event.data;
  const id = msg && Number.isInteger(msg.id) ? msg.id : -1;
  try {
    if (!msg || !OPS.has(msg.op)) throw new Error('unknown request');
    const core = await ready;
    const result = msg.op === 'hear' ? core.hear(msg.samples, msg.rate, msg.expect) : core[msg.op](msg.req);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
