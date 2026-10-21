import { TUNINGS, designRequest, gradedSection, noteHz, noteName } from './core.js';
import * as engine from './engine.js';
import { createStage } from './stage3d.js';
import { el, fmt, profileDrawing, modesDrawing, responsive, download } from './draw.js';
import { materialById, readHash, writeHash, playBar, setStatus, fillWoods, partialLabel, TUNING_IDS, WOOD_IDS } from './ui.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const LIMITS = { width: [10, 150], thick: [5, 60], min: [2, 50], length: [40, 1200] };

// ---------- Controls ----------
const noteSel = $('note');
for (let m = 48; m <= 96; m++) noteSel.append(el('option', { value: m, text: noteName(m) }));
$('tuning').replaceChildren(
  ...TUNING_IDS.map((id) => el('label', {}, [el('input', { type: 'radio', name: 'tuning', value: id }), el('span', { text: TUNINGS[id].label })])),
);
fillWoods($('wood'), 'rosewood');

const hash = readHash({
  note: { kind: 'note' },
  tuning: { kind: 'choice', choices: TUNING_IDS },
  wood: { kind: 'choice', choices: WOOD_IDS },
  w: { kind: 'number', min: LIMITS.width[0], max: LIMITS.width[1] },
  t: { kind: 'number', min: LIMITS.thick[0], max: LIMITS.thick[1] },
  min: { kind: 'number', min: LIMITS.min[0], max: LIMITS.min[1] },
  len: { kind: 'number', min: LIMITS.length[0], max: LIMITS.length[1] },
});

function setSizes(midi) {
  const g = gradedSection(midi);
  $('width').value = (g.width * 1000).toFixed(1);
  $('thick').value = (g.thickness * 1000).toFixed(1);
  $('min').value = (Math.max(4, g.thickness * 250)).toFixed(1);
}
let sizesTouched = false;
noteSel.value = String(hash.note && hash.note >= 48 && hash.note <= 96 ? hash.note : 60);
form.tuning.value = hash.tuning || 'marimba';
$('wood').value = hash.wood || (hash.tuning === 'vibraphone' ? 'aluminium' : 'rosewood');
setSizes(Number(noteSel.value));
if (hash.w) { $('width').value = hash.w; sizesTouched = true; }
if (hash.t) { $('thick').value = hash.t; sizesTouched = true; }
if (hash.min) { $('min').value = hash.min; sizesTouched = true; }
if (hash.len) { form.lenmode.value = 'fixed'; $('length').value = hash.len; }

function syncHints() {
  const t = TUNINGS[form.tuning.value];
  $('tuning-hint').textContent = t.count === 1 ? 'Only the note is tuned; the overtones fall where they fall.' : `Partials tuned to ${t.ratios}.`;
  const m = materialById($('wood').value);
  $('wood-hint').textContent = `${(m.E / 1e9).toFixed(1)} GPa, ${m.rho} kg/m³. Real boards vary: the workshop page measures yours.`;
  $('length-field').hidden = form.lenmode.value !== 'fixed';
}
syncHints();
form.addEventListener('change', (e) => {
  if (e.target === noteSel && !sizesTouched) setSizes(Number(noteSel.value));
  if (['width', 'thick', 'min'].includes(e.target.id)) sizesTouched = true;
  if (e.target.name === 'tuning' && e.target.value === 'vibraphone' && $('wood').value !== 'aluminium') $('wood').value = 'aluminium';
  syncHints();
});

/** Reads and checks the form. Returns {spec, values} or marks the bad fields and returns null. */
function readForm() {
  const err = $('form-error');
  err.textContent = '';
  const num = (id, [lo, hi], label) => {
    const input = $(id);
    const v = Number(input.value);
    const ok = input.value.trim() !== '' && Number.isFinite(v) && v >= lo && v <= hi;
    input.setAttribute('aria-invalid', String(!ok));
    if (!ok && !err.textContent) err.textContent = `${label} must be between ${lo} and ${hi} mm.`;
    return ok ? v : null;
  };
  const width = num('width', LIMITS.width, 'Width');
  const thick = num('thick', LIMITS.thick, 'Thickness');
  const min = num('min', LIMITS.min, 'Thinnest');
  const fixed = form.lenmode.value === 'fixed';
  const length = fixed ? num('length', LIMITS.length, 'Length') : null;
  if ([width, thick, min].includes(null) || (fixed && length === null)) return null;
  if (min > thick * 0.9) {
    $('min').setAttribute('aria-invalid', 'true');
    err.textContent = 'Thinnest must leave room for an arch: at most 90% of the thickness.';
    return null;
  }
  const midi = Number(noteSel.value);
  const tuning = TUNINGS[form.tuning.value];
  const mat = materialById($('wood').value);
  if (!mat || !tuning || !(midi >= 48 && midi <= 96)) return null;
  return {
    midi,
    values: { note: midi, tuning: form.tuning.value, wood: mat.id, w: width, t: thick, min, len: fixed ? length : undefined },
    spec: {
      mat, width: width / 1000, thickness: thick / 1000, minThickness: min / 1000,
      f1: noteHz(midi), r2: tuning.r2, r3: tuning.r3, count: tuning.count, fixedLength: fixed, length: fixed ? length / 1000 : 0,
    },
  };
}

// ---------- Results ----------
let current = null;  // {bar, spec, midi, values}
let stage = null;
const modeButtons = [...document.querySelectorAll('.mode-picker button')];
modeButtons.forEach((b) => b.addEventListener('click', () => {
  modeButtons.forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  stage?.setMode(Number(b.dataset.step));
}));
$('play').addEventListener('click', () => {
  if (!current) return;
  playBar(current.bar, current.spec.mat);
  stage?.strike();
});

const redrawProfile = responsive($('profile'), (w) => (current ? profileDrawing({ ...current.bar, nodes: current.bar.nodes[0], width: w }) : el('span')));
const redrawModes = responsive($('modes'), (w) => (current ? modesDrawing({ ...current.bar, count: 3, width: w }) : el('span')));

function show(result, spec, midi, values) {
  const bar = { ...result, width: spec.width, thickness: spec.thickness };
  current = { bar, spec, midi, values };
  const name = noteName(midi);
  const count = spec.count;
  const missed = [0, 1, 2].filter((i) => i < count && !result.met[i]);
  if (missed.length === 0) {
    setStatus($('status'), `${name} ${TUNINGS[values.tuning].label.toLowerCase()} bar in ${spec.mat.name}: every tuned partial is within a cent or two.`, 'good');
  } else {
    setStatus($('status'), `${name}: the closest this blank allows. ${missed.map((i) => partialLabel(i).toLowerCase()).join(' and ')} can't reach the target; see below.`, 'warn');
  }
  if (!stage) {
    stage = createStage($('stage-view'), { bar, metal: spec.mat.id === 'aluminium' });
    $('stage').dataset.mode = stage.mode;
    stage.setMode(0);
  } else {
    stage.setBar(bar, spec.mat.id === 'aluminium');
  }
  modeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === 0)));
  stage.setMode(0);

  const thinnest = Math.min(...bar.profile);
  const facts = [
    ['Length', fmt.mm(bar.length)],
    ['Weight', fmt.grams(bar.mass)],
    ['Deepest cut', fmt.mm(spec.thickness - thinnest)],
    ['Cord holes from each end', fmt.mm(bar.nodes[0][0] ?? 0)],
  ];
  $('facts').replaceChildren(...facts.map(([k, v]) => el('div', {}, [el('dt', { text: k }), el('dd', { text: v })])));

  const targets = [spec.f1, spec.f1 * spec.r2, spec.f1 * spec.r3];
  $('partials').replaceChildren(
    ...[0, 1, 2].map((i) => {
      const tuned = i < count;
      return el('tr', {}, [
        el('td', {}, [el('span', { class: `chip p${i + 1}`, 'aria-hidden': 'true' }), `Partial ${i + 1}`]),
        el('td', { class: 'r', text: tuned ? fmt.hz(targets[i]) : 'not tuned' }),
        el('td', { class: 'r', text: fmt.hz(bar.freq[i]) }),
        el('td', { class: 'r', text: tuned ? fmt.cents(result.error[i]) : `×${(bar.freq[i] / bar.freq[0]).toFixed(2)}` }),
        el('td', {}, [el('span', { class: `tag ${tuned ? (result.met[i] ? 'ok' : 'miss') : ''}`, text: tuned ? (result.met[i] ? 'In tune' : 'Missed') : 'Free' })]),
      ]);
    }),
  );
  $('advice').textContent = missed.length
    ? 'Short, thick bars can’t bend enough to reach these overtones. Try a thinner blank, a smaller "thinnest", or tune fewer partials (high marimba bars are usually tuned to the note and the second partial only).'
    : `Found with ${result.evaluations} vibration solves of the bar.`;

  redrawProfile();
  redrawModes();
  const workshopLink = new URLSearchParams({ note: name, tuning: values.tuning, wood: values.wood, w: values.w, t: values.t, min: values.min });
  if (values.len) workshopLink.set('len', values.len);
  $('to-workshop').href = `workshop.html#${workshopLink}`;
}

async function run() {
  const read = readForm();
  if (!read) return;
  const { spec, midi, values } = read;
  writeHash({ ...values, note: noteName(midi) });
  $('go').disabled = true;
  setStatus($('status'), `Designing ${noteName(midi)}…`, 'busy');
  try {
    const result = await engine.design(designRequest(spec));
    if (result.status < 0) {
      setStatus($('status'), result.status === -1 ? 'Those sizes are out of range.' : 'No workable bar for these settings. Try a thicker blank or a smaller "thinnest".', 'warn');
      return;
    }
    show(result, spec, midi, values);
    document.body.dataset.ready = 'true';
  } catch (e) {
    setStatus($('status'), `The calculation stopped: ${e.message}`, 'warn');
  } finally {
    $('go').disabled = false;
  }
}
form.addEventListener('submit', (e) => { e.preventDefault(); run(); });

// ---------- Downloads ----------
function sampleAt(profile, length, x) {
  const s = (x / length) * (profile.length - 1);
  const i = Math.min(profile.length - 2, Math.max(0, Math.floor(s)));
  return profile[i] + (profile[i + 1] - profile[i]) * (s - i);
}

$('dl-csv').addEventListener('click', () => {
  if (!current) return;
  const { bar, spec, midi } = current;
  const L = bar.length * 1000;
  const lines = [
    `# Ringtrue: ${noteName(midi)} bar in ${spec.mat.name}, ${L.toFixed(1)} x ${(spec.width * 1000).toFixed(1)} x ${(spec.thickness * 1000).toFixed(1)} mm`,
    `# cord holes at ${bar.nodes[0].map((x) => (x * 1000).toFixed(1)).join(' and ')} mm from the left end`,
    'position_mm,thickness_mm,cut_depth_mm',
  ];
  for (let x = 0; x <= L + 1e-9; x += 5) {
    const h = sampleAt(bar.profile, L, Math.min(x, L)) * 1000;
    lines.push(`${x.toFixed(0)},${h.toFixed(2)},${(spec.thickness * 1000 - h).toFixed(2)}`);
  }
  download(`ringtrue-${noteName(midi).replace('#', 'sharp')}.csv`, `${lines.join('\n')}\n`, 'text/csv');
});

$('dl-svg').addEventListener('click', () => {
  if (!current) return;
  const { bar, spec, midi } = current;
  const L = bar.length * 1000, T = spec.thickness * 1000, m = 15, H = T + 60;
  const pts = bar.profile.map((h, i) => `${(m + (L * i) / (bar.profile.length - 1)).toFixed(2)},${(m + 20 + h * 1000).toFixed(2)}`);
  const ticks = [];
  for (let x = 0; x <= L; x += 10) ticks.push(`<line x1="${(m + x).toFixed(1)}" x2="${(m + x).toFixed(1)}" y1="${m + 26 + T}" y2="${m + 26 + T + (x % 50 === 0 ? 6 : 3)}" stroke="#000" stroke-width="0.2"/>`);
  const holes = bar.nodes[0].map((x) => `<circle cx="${(m + x * 1000).toFixed(2)}" cy="${(m + 20 + T * 0.4).toFixed(2)}" r="1.5" fill="none" stroke="#000" stroke-width="0.3"/><line x1="${(m + x * 1000).toFixed(2)}" x2="${(m + x * 1000).toFixed(2)}" y1="${m + 16}" y2="${m + 24 + T}" stroke="#000" stroke-width="0.15" stroke-dasharray="1 1"/>`);
  // Only numbers and fixed names go into the file, so it can't carry anything unexpected.
  const title = `${noteName(midi)} bar, ${spec.mat.name}: ${L.toFixed(1)} x ${(spec.width * 1000).toFixed(1)} x ${T.toFixed(1)} mm. Holes at ${bar.nodes[0].map((x) => (x * 1000).toFixed(1)).join(' and ')} mm. Print at 100%.`;
  const file = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${(L + 2 * m).toFixed(1)}mm" height="${H.toFixed(1)}mm" viewBox="0 0 ${(L + 2 * m).toFixed(1)} ${H.toFixed(1)}">
  <text x="${m}" y="${m + 2}" font-family="sans-serif" font-size="4">${title.replace(/[<>&"]/g, '')}</text>
  <path d="M${m},${m + 20} L${(m + L).toFixed(2)},${m + 20} L${pts.reverse().join(' L')} Z" fill="none" stroke="#000" stroke-width="0.3"/>
  <line x1="${(m + L / 2).toFixed(2)}" x2="${(m + L / 2).toFixed(2)}" y1="${m + 14}" y2="${m + 26 + T}" stroke="#000" stroke-width="0.15"/>
  ${holes.join('\n  ')}
  ${ticks.join('\n  ')}
  <text x="${m}" y="${(m + 40 + T).toFixed(1)}" font-family="sans-serif" font-size="3">Ruler: 10 mm ticks, longer every 50 mm. Check one with a real ruler before cutting.</text>
</svg>
`;
  download(`ringtrue-${noteName(midi).replace('#', 'sharp')}-template.svg`, file, 'image/svg+xml');
});

run();
