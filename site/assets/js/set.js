import { TUNINGS, designRequest, gradedSection, noteHz, noteName, isSharp } from './core.js';
import * as engine from './engine.js';
import { DEFAULT_SET } from './presets.js';
import { el, svg, fmt, responsive } from './draw.js';
import { voice, strike } from './audio.js';
import { materialById, fillWoods, setStatus } from './ui.js';

const $ = (id) => document.getElementById(id);
let wood = materialById(DEFAULT_SET.wood);
// Each bar: {midi, length, width, thickness, depth, freq[], error[], count}
let bars = DEFAULT_SET.bars.map((b) => ({
  midi: b.midi, length: b.length, width: b.width, thickness: b.thickness,
  depth: Math.max(...b.depths), freq: b.freq, error: b.error, count: b.count,
}));

for (const id of ['from', 'to']) {
  for (let m = 48; m <= 96; m++) if (!isSharp(m)) $(id).append(el('option', { value: m, text: noteName(m) }));
}
$('from').value = '60';
$('to').value = '84';
fillWoods($('wood'), 'rosewood');


// ---------- Sound ----------
function play(bar) {
  const hard = $('hard').checked;
  const v = voice(bar.freq.slice(0, 3), [1, 0.7, 0.5], wood.loss, { mallet: hard ? 0.95 : 0.35 });
  strike(v, { volume: 0.3 });
  const node = document.querySelector(`[data-midi="${bar.midi}"]`);
  if (node && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.classList.remove('struck');
    void node.getBBox();
    node.classList.add('struck');
  }
}

// ---------- Keyboard drawing ----------
const redraw = responsive($('keys'), (width) => {
  const naturals = bars.filter((b) => !isSharp(b.midi));
  const pad = 8;
  const slot = (width - pad * 2) / Math.max(1, naturals.length);
  const longest = Math.max(...bars.map((b) => b.length));
  const scale = Math.min(230, Math.max(150, width * 0.32)) / longest;
  const rowGap = 26;
  const sharpRowH = longest * scale * 0.95;
  const centreSharp = pad + sharpRowH / 2 + 10;
  const centreNat = centreSharp + sharpRowH / 2 + rowGap + (longest * scale) / 2;
  const height = centreNat + (longest * scale) / 2 + 16;
  const barW = Math.max(10, Math.min(46, slot * 0.78));
  const kids = [svg('title', { text: 'Marimba keyboard, bars drawn to scale' })];
  // The two rails each row rests on, at the bars' nodes (about 22% in from each end).
  const xOf = new Map();
  naturals.forEach((b, i) => xOf.set(b.midi, pad + slot * (i + 0.5)));
  for (const b of bars) {
    if (!isSharp(b.midi)) continue;
    const below = xOf.get(b.midi - 1);
    xOf.set(b.midi, below !== undefined ? below + slot / 2 : pad + slot / 2);
  }
  const rail = (list, cy) => {
    if (!list.length) return;
    const pts = (sign) => list.map((b) => `${xOf.get(b.midi).toFixed(1)},${(cy + sign * b.length * scale * 0.276).toFixed(1)}`).join(' L');
    kids.push(svg('path', { d: `M${pts(-1)}`, stroke: '#5a463c', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }));
    kids.push(svg('path', { d: `M${pts(1)}`, stroke: '#5a463c', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }));
  };
  rail(bars.filter((b) => isSharp(b.midi)), centreSharp);
  rail(naturals, centreNat);
  const showAll = barW >= 22;
  for (const b of bars) {
    const sharp = isSharp(b.midi);
    const cx = xOf.get(b.midi), cy = sharp ? centreSharp : centreNat;
    const h = b.length * scale;
    const w = sharp ? barW * 0.9 : barW;
    const name = noteName(b.midi);
    const g = svg('g', { class: 'bar-key', 'data-midi': b.midi, tabindex: 0, role: 'button', 'aria-label': `Play ${name}, ${fmt.mm(b.length, 0)} long` }, [
      svg('rect', { class: 'wood', x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: 3, fill: wood.id === 'aluminium' ? '#c3c8cf' : sharp ? '#7a3424' : '#93432c' }),
    ]);
    if (showAll || b.midi % 12 === 0) {
      g.append(svg('text', { x: cx, y: cy + h / 2 - 8, 'text-anchor': 'middle', 'font-size': 11, fill: wood.id === 'aluminium' ? '#1d2421' : '#f6e6cf', text: sharp && !showAll ? '' : name.replace('#', '♯') }));
    }
    g.addEventListener('pointerdown', (e) => { e.preventDefault(); play(b); });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(b); }
    });
    kids.push(g);
  }
  return svg('svg', { viewBox: `0 0 ${width} ${height.toFixed(0)}`, width, height: height.toFixed(0), role: 'group', 'aria-label': 'Playable bars' }, kids);
});

function list() {
  $('list').replaceChildren(...bars.map((b) => {
    const offs = b.error.slice(0, b.count).map((c) => fmt.cents(c).replace(' ¢', '')).join(' / ') + ' ¢';
    const link = new URLSearchParams({ note: noteName(b.midi), tuning: b.count === 1 ? 'note' : b.count === 2 ? 'vibraphone' : 'marimba', wood: wood.id });
    return el('tr', {}, [
      el('td', { text: noteName(b.midi) }),
      el('td', { class: 'r', text: fmt.mm(b.length) }),
      el('td', { class: 'r wide-only', text: fmt.mm(b.width) }),
      el('td', { class: 'r wide-only', text: fmt.mm(b.thickness) }),
      el('td', { class: 'r', text: fmt.mm(b.depth) }),
      el('td', { class: 'r', text: offs }),
      el('td', {}, [el('a', { href: `design.html#${link}`, text: 'Open', 'aria-label': `Open ${noteName(b.midi)} in the designer` })]),
    ]);
  }));
}
list();

// Computer keyboard: home row for naturals from the lowest C, the row above for sharps.
const NAT_KEYS = 'asdfghjkl;';
const SHARP_KEYS = { w: 1, e: 3, t: 6, y: 8, u: 10, o: 13, p: 15 };
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, select, textarea')) return;
  const low = Math.min(...bars.map((b) => b.midi));
  const base = low - (low % 12);
  const k = e.key.toLowerCase();
  let target = null;
  const ni = NAT_KEYS.indexOf(k);
  if (ni >= 0) target = bars.filter((b) => !isSharp(b.midi))[ni];
  else if (SHARP_KEYS[k] !== undefined) target = bars.find((b) => b.midi === base + SHARP_KEYS[k]);
  if (target) play(target);
});

// ---------- Redesigning ----------
$('set-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = Number($('from').value), to = Number($('to').value);
  const mat = materialById($('wood').value);
  if (!(from >= 48 && to <= 96 && to > from) || !mat) {
    setStatus($('status'), 'Choose a lowest note below the highest.', 'warn');
    return;
  }
  if (to - from > 24) {
    setStatus($('status'), 'Up to two octaves at a time, please: each bar takes about half a second to design.', 'warn');
    return;
  }
  $('go').disabled = true;
  const next = [];
  try {
    for (let m = from; m <= to; m++) {
      setStatus($('status'), `Designing ${noteName(m)} (${m - from + 1} of ${to - from + 1})…`, 'busy');
      const t = TUNINGS.marimba;
      const g = gradedSection(m);
      const spec = {
        mat, width: g.width, thickness: g.thickness, minThickness: Math.max(0.004, g.thickness * 0.25),
        f1: noteHz(m), r2: t.r2, r3: t.r3, count: t.count, fixedLength: false,
      };
      const r = await engine.design(designRequest(spec));
      if (r.status < 0) throw new Error(`No workable bar for ${noteName(m)}.`);
      next.push({ midi: m, length: r.length, width: g.width, thickness: g.thickness, depth: Math.max(...r.depths), freq: r.freq, error: r.error, count: t.count });
    }
    bars = next;
    wood = mat;
    redraw();
    list();
    setStatus($('status'), `${noteName(from)} to ${noteName(to)} in ${mat.name}: ${bars.length} bars.`, 'good');
  } catch (err) {
    setStatus($('status'), err.message, 'warn');
  } finally {
    $('go').disabled = false;
  }
});

document.body.dataset.ready = 'true';
