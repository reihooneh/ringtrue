// Promise-based access to the worker. One worker per page; requests are answered in order.
let worker = null;
let next = 1;
const waiting = new Map();

function get() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      if (!w) return;
      waiting.delete(data.id);
      if (data.error) w.reject(new Error(data.error));
      else w.resolve(data.result);
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || 'the calculation stopped'));
      waiting.clear();
    };
  }
  return worker;
}

function send(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    get().postMessage({ ...msg, id }, transfer);
  });
}

export const design = (req) => send({ op: 'design', req });
export const analyse = (req) => send({ op: 'analyse', req });
export const advise = (req) => send({ op: 'advise', req });
export const hear = (samples, rate, expect) => send({ op: 'hear', samples, rate, expect });
