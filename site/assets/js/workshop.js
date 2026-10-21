import { TUNINGS, barRequest, designRequest, gradedSection, noteHz, noteName, STATUS } from './core.js';
import * as engine from './engine.js';
import { DEFAULT_SET } from './presets.js';
import { el, fmt, meter, profileDrawing, spectrumDrawing, responsive } from './draw.js';
import { record, decodeFile, renderTap, voice } from './audio.js';
import { resample, archTable, applySteps } from './cuts.js';
import { materialById, readHash, setStatus, fillWoods, partialLabel, TUNING_IDS, WOOD_IDS, weightsAt, playBar } from './ui.js';

const $ = (id) => document.getElementById(id);

// ---------- State ----------
// bar: what the maker knows (book wood, the profile as cut so far).
// real: for the practice bar only, the board as it really is (unknown to the advice).
let bar = null, real = null, round = 1, history = [], lastAdvice = null, stiffness = 1;
let busy = false;

const hash = readHash({
  note: { kind: 'note' },
  tuning: { kind: 'choice', choices: TUNING_IDS },
  wood: { kind: 'choice', choices: WOOD_IDS },
  w: { kind: 'number', min: 10, max: 150 },
  t: { kind: 'number', min: 5, max: 60 },
  min: { kind: 'number', min: 2, max: 50 },
  len: { kind: 'number', min: 40, max: 1200 },
  seed: { kind: 'number', min: 1, max: 9999 },
});

// A small seeded generator, so a practice board can be replayed (#seed=…).
let seed = hash.seed || 1 + Math.floor(Math.random() * 9999);
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

function targetsOf(b) {
  return [b.f1, b.f1 * b.r2, b.f1 * b.r3].slice(0, b.count);
}

function describe() {
  const t = TUNINGS[bar.tuning];
  const thinnest = Math.min(...bar.table);
  $('bar-summary').textContent = `${noteName(bar.midi)} ${t.label.toLowerCase()} bar in ${bar.mat.name}: ${fmt.mm(bar.length)} long, ${fmt.mm(bar.width)} wide, ${fmt.mm(bar.thickness)} thick, ${fmt.mm(thinnest)} at the thinnest.`;
  $('round-note').textContent = `Round ${round}${real ? '. The practice board’s real stiffness is hidden until it’s in tune.' : ''}`;
}

// ---------- Setting up a bar ----------
async function designed(midi, tuningId, mat, widthMm, thickMm, minMm, lenMm) {
  const t = TUNINGS[tuningId];
  const spec = {
    mat, width: widthMm / 1000, thickness: thickMm / 1000, minThickness: minMm / 1000,
    f1: noteHz(midi), r2: t.r2, r3: t.r3, count: t.count, fixedLength: !!lenMm, length: lenMm ? lenMm / 1000 : 0,
  };
  const r = await engine.design(designRequest(spec));
  if (r.status < 0) throw new Error('No workable bar for those settings.');
  return { ...spec, midi, tuning: tuningId, length: r.length, table: resample(r.profile), cut: { span: r.span, depths: r.depths } };
}

async function startPractice() {
  const p = DEFAULT_SET.bars.find((b) => b.note === 'C4');
  const mat = materialById('rosewood');
  bar = {
    mat, width: p.width, thickness: p.thickness, minThickness: p.minThickness, f1: p.targets[0], r2: 4, r3: 10, count: 3,
    midi: 60, tuning: 'marimba', length: p.length, cut: { span: p.span, depths: p.depths },
  };
  // The maker roughed the arch out shallow, as advised: 80-90% of the depth.
  const rough = 0.8 + 0.1 * rnd();
  const roughCut = { span: p.span, depths: p.depths.map((d) => d * rough) };
  const shaped = await engine.analyse(barRequest({ ...bar, cut: roughCut }));
  bar.table = resample(shaped.profile);
  // The real board: stiffer or softer than the book by up to about 10%, and its shear stiffness
  // anywhere from 0.8 to 1.4 times the usual guess.
  const e = 0.92 + 0.18 * rnd();
  const g = 0.8 + 0.6 * rnd();
  real = { ...bar, mat: { ...mat, E: mat.E * e, G: mat.G * e * g }, table: bar.table.slice() };
  reset();
}

async function startFromHash() {
  const midi = hash.note && hash.note >= 48 && hash.note <= 96 ? hash.note : 60;
  const tuning = hash.tuning || 'marimba';
  const mat = materialById(hash.wood || 'rosewood');
  const g = gradedSection(midi);
  bar = await designed(midi, tuning, mat, hash.w || g.width * 1000, hash.t || g.thickness * 1000, hash.min || Math.max(4, g.thickness * 250), hash.len);
  real = null;
  reset();
}

function reset() {
  round = 1;
  history = [];
  lastAdvice = null;
  stiffness = 1;
  $('next').hidden = true;
  $('verdict').hidden = true;
  $('cuts').hidden = false;
  $('spectrum-fig').hidden = true;
  $('undo').disabled = true;
  setStatus($('hear-status'), real ? 'Nothing heard yet. Tap the practice bar to start.' : 'Nothing heard yet.');
  describe();
}

function setSource(source) {
  $('tap-practice').hidden = source !== 'practice';
  $('tap-mine').hidden = source !== 'mine';
  $('mine-details').hidden = source !== 'mine';
  $('tap-help').hidden = source !== 'mine';
}

// ---------- Hearing ----------
async function heardSamples(samples, rate) {
  // After the first round we know roughly how this board sounds, so look near the prediction.
  let expect = null;
  if (lastAdvice) {
    const model = await engine.analyse(barRequest(bar));
    expect = model.freq.slice(0, 3).map((f) => f * Math.sqrt(stiffness));
  }
  const h = await engine.hear(samples, rate, expect);
  if (h.status === STATUS.TOO_QUIET) {
    setStatus($('hear-status'), 'That was too quiet to read. Tap a little harder, closer to the microphone.', 'warn');
    return;
  }
  if (h.status < 0 || h.partials.length === 0) {
    setStatus($('hear-status'), 'No clear note in that recording. Tap once, firmly, and let the bar ring for a second.', 'warn');
    return;
  }
  const tg = targetsOf(bar);
  $('spectrum-fig').hidden = false;
  // Show the clear peaks only; the faint ones are the window's side lobes and room noise.
  const clear = h.peaks.filter((p) => p.level > -45 || h.partials.includes(p.freq));
  drawSpectrum = (w) => spectrumDrawing({ peaks: clear, partials: h.partials, targets: tg, width: w });
  redrawSpectrum();
  const parts = h.partials.map((f, i) => `${fmt.hz(f)}`).join(', ');
  const clipped = h.peakAmplitude >= 0.99 ? ' The recording clipped; tap a little more gently next time.' : '';
  setStatus($('hear-status'), `Heard ${h.partials.length === 1 ? 'one partial' : `${h.partials.length} partials`}: ${parts}.${clipped}`, clipped ? 'warn' : 'good');
  await advise(h.partials.slice(0, Math.max(1, Math.min(3, h.partials.length))));
}

let drawSpectrum = () => el('span');
const redrawSpectrum = responsive($('spectrum'), (w) => drawSpectrum(w));
let drawPlan = () => el('span');
const redrawPlan = responsive($('plan'), (w) => drawPlan(w));

async function advise(heard) {
  const a = await engine.advise(barRequest(bar, heard));
  if (a.status < 0) {
    setStatus($('hear-status'), 'Those partials don’t fit this bar. Check the note and measurements, then tap again.', 'warn');
    return;
  }
  lastAdvice = a;
  stiffness = a.stiffness;
  $('next').hidden = false;
  const n = bar.count;
  $('meters').replaceChildren(...a.now.slice(0, n).map((c, i) => meter(`Partial ${i + 1}`, c, i)));

  const pct = (a.stiffness - 1) * 100;
  const fitWorst = Math.max(...a.fit.slice(0, heard.length).map(Math.abs));
  let calib = `This board is ${Math.abs(pct) < 0.5 ? 'as stiff as' : `${Math.abs(pct).toFixed(1)}% ${pct > 0 ? 'stiffer' : 'softer'} than`} the book value for ${bar.mat.name}`;
  if (heard.length >= 2) calib += `, and its shear stiffness is ×${a.shear.toFixed(2)} the usual guess`;
  calib += `. The model now matches what was heard to within ${fitWorst < 0.1 ? '0.1' : fitWorst.toFixed(1)} cents.`;
  $('calibration').textContent = calib;

  const cuts = $('cuts');
  const verdict = $('verdict');
  verdict.hidden = !a.done;
  cuts.hidden = a.done;
  if (a.done) {
    verdict.textContent = `In tune: the note is within 3 cents and the overtones within 5 and 8. ${real ? `The practice board was really ${((real.mat.E / bar.mat.E - 1) * 100).toFixed(1)}% off the book stiffness, and it took ${round} ${round === 1 ? 'tap' : 'taps'}.` : 'Seal the bar and you’re done.'}`;
    drawPlan = (w) => profileDrawing({ length: bar.length, thickness: bar.thickness, profile: bar.table, width: w });
    redrawPlan();
    return;
  }
  if (a.steps.length === 0) {
    cuts.replaceChildren(el('li', {}, [el('p', { text: a.flat
      ? 'The note is flat and nothing more can come off the arch. Trim the ends a little at a time to raise it.'
      : 'No cut would bring it closer. It may be as good as this blank allows.' })]));
  } else {
    cuts.replaceChildren(...a.steps.map((s) => {
      const text = s.kind === 'trim'
        ? `Trim ${fmt.mm(s.amount, 2)} off each end. That raises every partial.`
        : s.position < 0.002
          ? `Deepen the arch at the centre by ${fmt.mm(s.amount, 2)}, over about ${fmt.mm(s.width, 0)}.`
          : `Deepen the arch ${fmt.mm(s.position, 0)} either side of the centre by ${fmt.mm(s.amount, 2)}, over about ${fmt.mm(s.width, 0)} each.`;
      return el('li', {}, [el('p', { text })]);
    }));
  }
  const after = applySteps(bar.table, bar.length, a.steps, bar.minThickness);
  // Drawn on the bar as it is now (a trim shortens it, shown as the plan line at the ends).
  const planOnCurrent = after.length === bar.length ? after.table : bar.table;
  drawPlan = (w) => profileDrawing({ length: bar.length, thickness: bar.thickness, profile: bar.table, plan: planOnCurrent, width: w });
  redrawPlan();
  const last = a.steps[a.steps.length - 1];
  if (last) {
    const pred = last.after.slice(0, n).map((c, i) => `partial ${i + 1} ${fmt.cents(c)}`).join(', ');
    cuts.append(el('li', {}, [el('p', { text: `Then tap again. Predicted afterwards: ${pred}.` })]));
  }
}

async function guarded(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('#results button').forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    setStatus($('hear-status'), e.message || 'Something went wrong. Try again.', 'warn');
  } finally {
    busy = false;
    document.querySelectorAll('#results button').forEach((b) => { b.disabled = false; });
    $('undo').disabled = history.length === 0;
    $('made').disabled = !(lastAdvice && !lastAdvice.done && lastAdvice.steps.length > 0);
  }
}

// ---------- Actions ----------
$('tap-sim').addEventListener('click', () => guarded(async () => {
  setStatus($('hear-status'), 'Tapping…', 'busy');
  const r = await engine.analyse(barRequest(real));
  const sound = { ...r, width: real.width, thickness: real.thickness };
  playBar(sound, real.mat);
  const v = voice(r.freq.slice(0, 4), weightsAt(sound, 0.5 + 0.06 * rnd()), real.mat.loss);
  const samples = renderTap(v, 48000, 2, Math.floor(rnd() * 1e9));
  await heardSamples(samples, 48000);
}));

$('listen').addEventListener('click', () => guarded(async () => {
  setStatus($('hear-status'), 'Listening for 3 seconds: tap the bar now.', 'busy');
  const { samples, rate } = await record(3, (level) => {
    if (level > 0.02) setStatus($('hear-status'), 'Heard something. Let it ring…', 'busy');
  });
  await heardSamples(samples, rate);
}));

$('file').addEventListener('change', () => guarded(async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  setStatus($('hear-status'), 'Reading the recording…', 'busy');
  const { samples, rate } = await decodeFile(f);
  await heardSamples(samples, rate);
}));

$('made').addEventListener('click', () => {
  if (!lastAdvice || !lastAdvice.steps.length) return;
  history.push({ bar: { ...bar, table: bar.table.slice() }, real: real && { ...real, table: real.table.slice() } });
  const m = applySteps(bar.table, bar.length, lastAdvice.steps, bar.minThickness);
  bar = { ...bar, table: m.table, length: m.length };
  if (real) {
    const r = applySteps(real.table, real.length, lastAdvice.steps, real.minThickness);
    real = { ...real, table: r.table, length: r.length };
  }
  round += 1;
  lastAdvice = { ...lastAdvice, steps: [] };
  $('made').disabled = true;
  $('undo').disabled = false;
  setStatus($('hear-status'), 'Cuts made. Tap the bar again.', '');
  describe();
});

$('undo').addEventListener('click', () => {
  const prev = history.pop();
  if (!prev) return;
  bar = prev.bar;
  real = prev.real;
  round = Math.max(1, round - 1);
  $('undo').disabled = history.length === 0;
  setStatus($('hear-status'), 'Back one round. Tap again to check.', '');
  describe();
});

// My own bar, from measurements.
for (let m = 48; m <= 96; m++) $('m-note').append(el('option', { value: m, text: noteName(m), selected: m === 60 }));
$('m-tuning').replaceChildren(...TUNING_IDS.map((id) => el('option', { value: id, text: `${TUNINGS[id].label} (${TUNINGS[id].ratios})` })));
fillWoods($('m-wood'), 'rosewood');
$('mine-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('mine-error');
  err.textContent = '';
  const read = (id, lo, hi) => {
    const v = Number($(id).value);
    const ok = $(id).value.trim() !== '' && Number.isFinite(v) && v >= lo && v <= hi;
    $(id).setAttribute('aria-invalid', String(!ok));
    return ok ? v : null;
  };
  const L = read('m-length', 40, 1200), W = read('m-width', 10, 150), T = read('m-thick', 5, 60);
  const C = read('m-centre', 2, 60), S = read('m-span', 0, 1200), M = read('m-min', 2, 50);
  if ([L, W, T, C, S, M].includes(null)) { err.textContent = 'Check the highlighted measurements.'; return; }
  if (C > T || M > C || S > L) { err.textContent = 'The centre can’t be thicker than the bar, thinner than "thinnest allowed", or the arch longer than the bar.'; return; }
  const midi = Number($('m-note').value), t = TUNINGS[$('m-tuning').value], mat = materialById($('m-wood').value);
  if (!t || !mat || !(midi >= 48 && midi <= 96)) return;
  bar = {
    mat, width: W / 1000, thickness: T / 1000, minThickness: M / 1000, f1: noteHz(midi), r2: t.r2, r3: t.r3, count: t.count,
    midi, tuning: $('m-tuning').value, length: L / 1000, table: archTable(L / 1000, T / 1000, C / 1000, S / 1000),
  };
  real = null;
  reset();
});

for (const r of document.querySelectorAll('input[name="source"]')) {
  r.addEventListener('change', () => guarded(async () => {
    setSource(r.value);
    if (r.value === 'practice') await startPractice();
    else await startFromHash();
  }));
}

// Start: a bar from the designer if the link has one, otherwise the practice bar.
if (hash.note) {
  document.querySelector('input[name="source"][value="mine"]').checked = true;
  setSource('mine');
  await guarded(startFromHash);
} else {
  setSource('practice');
  await guarded(startPractice);
}
document.body.dataset.ready = 'true';
