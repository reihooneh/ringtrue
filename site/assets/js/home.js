import { DEFAULT_SET } from './presets.js';
import { barRequest, cents } from './core.js';
import * as engine from './engine.js';
import { createStage } from './stage3d.js';
import { svg, responsive, fmt } from './draw.js';
import { materialById, playBar } from './ui.js';

const preset = DEFAULT_SET.bars.find((b) => b.note === 'C4');
const mat = materialById(DEFAULT_SET.wood);
const spec = {
  mat, width: preset.width, thickness: preset.thickness, minThickness: preset.minThickness,
  f1: preset.targets[0], r2: 4, r3: 10, count: 3, length: preset.length,
};
const readout = document.getElementById('hero-readout');
const buttons = [...document.querySelectorAll('.mode-picker button')];

const section = { width: spec.width, thickness: spec.thickness };
const [tuned, plain] = (await Promise.all([
  engine.analyse(barRequest({ ...spec, cut: { span: preset.span, depths: preset.depths } })),
  engine.analyse(barRequest({ ...spec, cut: { span: 0, depths: [0, 0, 0, 0] } })),
])).map((r) => ({ ...r, ...section }));

const stage = createStage(document.getElementById('hero-view'), { bar: tuned });
document.getElementById('hero').dataset.mode = stage.mode;
let shown = 0;

function describe(k) {
  const f = tuned.freq;
  readout.replaceChildren(
    'Middle C in Honduras rosewood: ',
    Object.assign(document.createElement('b'), { textContent: `${fmt.hz(f[k])}` }),
    k === 0 ? ', the note you hear.' : `, ${(f[k] / f[0]).toFixed(2)} times the note. The pale lines stay still.`,
  );
}
describe(0);
stage.setMode(0);
for (const b of buttons) {
  b.addEventListener('click', () => {
    shown = Number(b.dataset.step);
    for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
    stage.setMode(shown);
    describe(shown);
  });
}
document.getElementById('strike').addEventListener('click', () => {
  playBar(tuned, mat);
  stage.strike();
});

// The plain bar, transposed to the same note so only the overtones differ.
const plainAtC4 = { ...plain, freq: plain.freq.map((f) => (f * tuned.freq[0]) / plain.freq[0]) };
document.getElementById('play-plain').addEventListener('click', () => playBar(plainAtC4, mat));
document.getElementById('play-tuned').addEventListener('click', () => playBar(tuned, mat));

document.getElementById('plain-r2').textContent = (plain.freq[1] / plain.freq[0]).toFixed(2);
document.getElementById('plain-r3').textContent = (plain.freq[2] / plain.freq[0]).toFixed(2);

// The ladder: partials on a log scale, plain above, tuned below.
responsive(document.getElementById('ladder'), (width) => {
  const padX = 20, drawW = width - padX * 2, f0 = tuned.freq[0];
  const X = (r) => padX + (Math.log(r) / Math.log(12)) * drawW;
  const rows = [
    { name: 'Plain bar', ratios: plainAtC4.freq.slice(0, 3).map((f) => f / f0), y: 46 },
    { name: 'Tuned bar', ratios: tuned.freq.slice(0, 3).map((f) => f / f0), y: 136 },
  ];
  const kids = [svg('title', { text: 'Partials of a plain and a tuned bar' })];
  for (let h = 1; h <= 12; h++) {
    kids.push(svg('line', { x1: X(h), x2: X(h), y1: 22, y2: 176, class: 'd-axis' }));
    if ([1, 2, 4, 8].includes(h) || (h === 10 && drawW > 300) || (h === 3 && drawW > 300)) {
      kids.push(svg('text', { x: X(h), y: 196, 'text-anchor': 'middle', class: 'd-text', text: `×${h}` }));
    }
  }
  for (const row of rows) {
    kids.push(svg('text', { x: padX, y: row.y - 16, class: 'd-text-strong', text: row.name }));
    kids.push(svg('line', { x1: X(1), x2: X(12), y1: row.y + 10, y2: row.y + 10, class: 'd-zero' }));
    row.ratios.forEach((r, k) => {
      kids.push(svg('rect', { x: X(r) - 5, y: row.y, width: 10, height: 20, rx: 2, class: `d-fill-p${k + 1}` }));
      if (k > 0) kids.push(svg('text', { x: X(r), y: row.y + 38, 'text-anchor': 'middle', class: 'd-text', text: r.toFixed(2) }));
    });
  }
  return svg('svg', { viewBox: `0 0 ${width} 206`, width, height: 206, role: 'img', 'aria-label': `Plain bar partials at 1, ${rows[0].ratios[1].toFixed(2)} and ${rows[0].ratios[2].toFixed(2)} times the note; tuned bar at 1, ${rows[1].ratios[1].toFixed(2)} and ${rows[1].ratios[2].toFixed(2)}.` }, kids);
});

document.body.dataset.ready = String(Math.abs(cents(tuned.freq[1], tuned.freq[0] * 4)) < 5);
