// Shared page helpers: materials, link state, sound for a bar, status lines.
import { MATERIALS } from './materials.js';
import { TUNINGS, parseNote, noteName } from './core.js';
import { voice, strike } from './audio.js';
import { el } from './draw.js';

export const materialById = (id) => MATERIALS.find((m) => m.id === id) || null;
export { MATERIALS };

/**
 * Reads settings from the link (#key=value&...). Only known keys, only valid values: anything
 * else is ignored, so a crafted link can't put odd values into the page.
 * schema: {key: {kind: 'note'|'choice'|'number', choices?, min?, max?}}
 */
export function readHash(schema, hash = location.hash) {
  const out = {};
  const params = new URLSearchParams(hash.replace(/^#/, '').slice(0, 600));
  for (const [key, rule] of Object.entries(schema)) {
    const raw = params.get(key);
    if (raw === null || raw.length > 24) continue;
    if (rule.kind === 'note') {
      const m = parseNote(raw);
      if (m !== null) out[key] = m;
    } else if (rule.kind === 'choice') {
      if (rule.choices.includes(raw)) out[key] = raw;
    } else if (rule.kind === 'number') {
      if (!/^\d{1,4}(\.\d{1,3})?$/.test(raw)) continue;
      const v = Number(raw);
      if (v >= rule.min && v <= rule.max) out[key] = v;
    }
  }
  return out;
}

export function writeHash(values) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, typeof v === 'number' && k === 'note' ? noteName(v) : String(v));
  }
  history.replaceState(null, '', `#${p.toString()}`);
}

export const TUNING_IDS = Object.keys(TUNINGS);
export const WOOD_IDS = MATERIALS.map((m) => m.id);

/** Where a player strikes: a little off centre, so the second partial (silent at the centre) speaks. */
const STRIKE_AT = 0.42;

export function weightsAt(bar, at = STRIKE_AT) {
  const i = Math.round(at * (bar.shapes[0].length - 1));
  return bar.shapes.map((s) => s[i]);
}

export function playBar(bar, mat, options = {}) {
  return strike(voice(bar.freq.slice(0, 4), weightsAt(bar), mat.loss, options));
}

/** Sets a status line's text and tone (good, warn, busy or plain). */
export function setStatus(node, text, tone = '') {
  node.className = `status${tone ? ` ${tone}` : ''}`;
  node.textContent = text;
}

/** Fills a <select> with the woods. */
export function fillWoods(select, selected) {
  select.replaceChildren(...MATERIALS.map((m) => el('option', { value: m.id, text: m.name, selected: m.id === selected })));
}

export function partialLabel(k) {
  return ['First partial (the note)', 'Second partial', 'Third partial'][k];
}
