// The WebAssembly core and the page's JavaScript helpers, in Node (no browser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  instantiate, designRequest, barRequest, parseNote, noteName, noteHz, gradedSection, cents, IN, IN_SIZE, STATUS,
} from '../../site/assets/js/core.js';
import { applySteps, archTable, resample } from '../../site/assets/js/cuts.js';
import { renderTap, voice } from '../../site/assets/js/audio.js';
import { readHash } from '../../site/assets/js/ui.js';
import { MATERIALS } from '../../site/assets/js/materials.js';
import { DEFAULT_SET } from '../../site/assets/js/presets.js';

const wasmBytes = readFileSync(new URL('../../site/assets/ringtrue.wasm', import.meta.url));
const core = await instantiate(wasmBytes);
const rose = MATERIALS.find((m) => m.id === 'rosewood');

test('the module imports nothing, so it cannot reach the page or the network', () => {
  const mod = new WebAssembly.Module(wasmBytes);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  const names = WebAssembly.Module.exports(mod).map((e) => e.name);
  for (const n of ['rt_design', 'rt_analyse', 'rt_advise', 'rt_hear', 'memory']) assert.ok(names.includes(n), n);
});

test('notes', () => {
  assert.equal(parseNote('C4'), 60);
  assert.equal(parseNote('A4'), 69);
  assert.equal(parseNote('Bb3'), 58);
  assert.equal(parseNote('f#5'), 78);
  for (const bad of ['H4', 'C9', 'C', '', 'C4; drop', '<b>', 'C#44', null]) assert.equal(parseNote(bad), null, String(bad));
  assert.equal(noteName(61), 'C#4');
  assert.ok(Math.abs(noteHz(69) - 440) < 1e-12);
});

test('the WebAssembly build gives the same bars as the native command line', () => {
  const cli = new URL('../../build/ringtrue', import.meta.url).pathname;
  const native = JSON.parse(execFileSync(cli, ['design', '--note', 'E4', '--json'], { encoding: 'utf8' }));
  const g = gradedSection(64);
  assert.ok(Math.abs(g.width - native.width) < 1e-6 && Math.abs(g.thickness - native.thickness) < 1e-6, 'same graded sizes');
  const r = core.design(designRequest({
    mat: rose, width: g.width, thickness: g.thickness, minThickness: Math.max(0.004, g.thickness * 0.25),
    f1: noteHz(64), r2: 4, r3: 10, count: 3, fixedLength: false,
  }));
  assert.equal(r.status, STATUS.OK);
  assert.ok(Math.abs(r.length - native.length) < 1e-5, `${r.length} vs ${native.length}`);  // the JSON is rounded to micrometres
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(cents(r.freq[k], native.freq[k])) < 0.05, `${r.freq[k]} vs ${native.freq[k]}`);
});

test('the built-in set is in tune', () => {
  assert.equal(DEFAULT_SET.bars.length, 25);
  for (const b of DEFAULT_SET.bars) {
    for (let k = 0; k < b.count; k++) assert.ok(Math.abs(b.error[k]) < 3, `${b.note} partial ${k + 1}: ${b.error[k]}`);
  }
  const lengths = DEFAULT_SET.bars.map((b) => b.length);
  for (let i = 1; i < lengths.length; i++) assert.ok(lengths[i] < lengths[i - 1], 'bars get shorter going up');
});

test('the page applies cuts exactly as the core does', () => {
  const p = DEFAULT_SET.bars.find((b) => b.note === 'C4');
  const bar = {
    mat: rose, width: p.width, thickness: p.thickness, minThickness: p.minThickness, f1: p.targets[0], r2: 4, r3: 10, count: 3,
    length: p.length, cut: { span: p.span, depths: p.depths.map((d) => d * 0.85) },
  };
  const shaped = core.analyse(barRequest(bar));
  const table = resample(shaped.profile);
  const tableBar = { ...bar, table };
  const sharp = core.analyse(barRequest(tableBar));
  const a = core.advise(barRequest(tableBar, sharp.freq.slice(0, 3)));
  assert.equal(a.status, STATUS.OK);
  assert.ok(a.steps.length >= 1, 'a bar cut too shallow gets cuts');
  const mine = applySteps(table, bar.length, a.steps, bar.minThickness);
  // Compare the wood removed (the core samples the bar in 300 flat steps, the page as points, so
  // the profiles themselves differ slightly on steep slopes; the cuts must not).
  const at = (tbl, x) => {
    const j = x * (tbl.length - 1);
    const lo = Math.min(tbl.length - 2, Math.floor(j));
    return tbl[lo] + (tbl[lo + 1] - tbl[lo]) * (j - lo);
  };
  assert.ok(a.steps.every((s) => s.kind === 'deepen'), 'this bar only needs deeper cuts');
  let removedC = 0, removedJ = 0;
  for (let i = 0; i < a.profileAfter.length; i++) {
    const x = i / (a.profileAfter.length - 1);
    const c = sharp.profile[i] - a.profileAfter[i];
    const js = at(table, x) - at(mine.table, x);
    removedC += c;
    removedJ += js;
    assert.ok(Math.abs(c - js) < 0.00025, `at ${(x * 100).toFixed(0)}%: core removes ${c}, page ${js}`);
  }
  assert.ok(Math.abs(removedC - removedJ) < 0.02 * removedC + 1e-6, 'same total');
  // And doing the cuts on the model moves every partial towards its target.
  const after = core.analyse(barRequest({ ...tableBar, table: mine.table, length: mine.length }));
  const before = [0, 1, 2].map((k) => Math.abs(cents(sharp.freq[k], [261.6256, 1046.5023, 2616.2557][k])));
  const now = [0, 1, 2].map((k) => Math.abs(cents(after.freq[k], [261.6256, 1046.5023, 2616.2557][k])));
  assert.ok(now[0] < before[0] && now.reduce((s, v) => s + v) < before.reduce((s, v) => s + v) / 2, `${before} -> ${now}`);
});

test('a simulated tap is heard correctly', () => {
  const p = DEFAULT_SET.bars[0];
  const samples = renderTap(voice(p.freq.slice(0, 3), [1, 0.6, 0.5], rose.loss), 48000, 2, 7);
  const h = core.hear(samples, 48000, null);
  assert.equal(h.status, STATUS.OK);
  assert.equal(h.partials.length, 3);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(cents(h.partials[k], p.freq[k])) < 0.5, `${h.partials[k]} vs ${p.freq[k]}`);
});

test('bad requests are refused by the core, not misread', () => {
  const ok = designRequest({ mat: rose, width: 0.05, thickness: 0.022, minThickness: 0.006, f1: 440, r2: 4, r3: 10, count: 1, fixedLength: false });
  for (const [field, value] of [[IN.E, NaN], [IN.WIDTH, -1], [IN.F1, Infinity], [IN.COUNT, 7], [IN.MIN_THICK, 0.5], [IN.FIXED, 0.5]]) {
    const req = ok.slice();
    req[field] = value;
    assert.equal(core.design(req).status, STATUS.BAD_INPUT, `field ${field}`);
  }
  assert.throws(() => core.design(new Float64Array(IN_SIZE - 1)), /bad request/);
  assert.throws(() => core.hear(new Float32Array(core.samplesCap + 1), 48000), /too long/);
  assert.equal(core.hear(new Float32Array(100), 48000).status, STATUS.BAD_INPUT, 'too short');
  assert.equal(core.hear(new Float32Array(48000), 48000).status, STATUS.TOO_QUIET, 'silence');
  const nan = new Float32Array(48000).fill(0.1);
  nan[10] = NaN;
  assert.equal(core.hear(nan, 48000).status, STATUS.BAD_INPUT, 'NaN');
});

test('links: only known keys and valid values are read', () => {
  const schema = {
    note: { kind: 'note' },
    tuning: { kind: 'choice', choices: ['marimba', 'xylophone'] },
    w: { kind: 'number', min: 10, max: 150 },
  };
  assert.deepEqual(readHash(schema, '#note=C%234&tuning=xylophone&w=45.5'), { note: 61, tuning: 'xylophone', w: 45.5 });
  assert.deepEqual(readHash(schema, '#note=%3Cscript%3E&tuning=__proto__&w=1e3&evil=1'), {});
  assert.deepEqual(readHash(schema, '#w=9999&w2=20'), {});
  assert.deepEqual(readHash(schema, `#w=${'1'.repeat(5000)}`), {});
});

test('a hand-measured arch', () => {
  const t = archTable(0.4, 0.022, 0.009, 0.2);
  assert.equal(t.length, 201);
  assert.ok(Math.abs(t[100] - 0.009) < 1e-12 && t[0] === 0.022 && t[200] === 0.022);
  assert.ok(Math.min(...t) >= 0.009 - 1e-12);
});
