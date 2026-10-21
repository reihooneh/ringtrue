// Live check: the core against exact Euler-Bernoulli frequencies for a slender free-free bar.
import { barRequest, cents } from './core.js';
import * as engine from './engine.js';
import { el } from './draw.js';

const L = 0.5, W = 0.04, H = 0.003, E = 70e9, RHO = 2700;
const mat = { E, G: 2e11, rho: RHO, loss: 0 };
const r = await engine.analyse(barRequest({
  mat, width: W, thickness: H, minThickness: 0.001, length: L, f1: 40, r2: 4, r3: 10, count: 1,
  cut: { span: 0, depths: [0, 0, 0, 0] },
}));
if (r.status !== 0) throw new Error('the core refused the check bar');
const betas = [4.730040745, 7.853204624, 10.99560784, 14.13716549];
const I = (W * H ** 3) / 12, A = W * H;
const rows = betas.map((bL, k) => {
  const b = bL / L;
  const exact = (b * b * Math.sqrt((E * I) / (RHO * A))) / (2 * Math.PI);
  const d = cents(r.freq[k], exact);
  return el('tr', {}, [
    el('td', { text: `Partial ${k + 1}` }),
    el('td', { class: 'r', text: exact.toFixed(3) }),
    el('td', { class: 'r', text: r.freq[k].toFixed(3) }),
    el('td', { class: 'r', text: `${Math.abs(d) < 0.005 ? '0.00' : d.toFixed(2)} cents` }),
  ]);
});
document.getElementById('check').replaceChildren(...rows);
const node = r.nodes[0][0] / L;
document.getElementById('check-note').textContent =
  `A 500 × 40 × 3 mm aluminium strip with stiff shear, where the two theories should nearly agree: the small gaps are the shear and rotary inertia that thin-beam theory leaves out. Its first partial's node falls ${(node * 100).toFixed(2)}% of the way along (exact: 22.42%).`;
document.body.dataset.ready = 'true';
