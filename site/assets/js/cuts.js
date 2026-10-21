// Bar profiles as thickness tables (samples evenly from one end to the other), and the two kinds
// of cut the workshop suggests. These mirror apply_step in core/advise.cpp; a test checks they agree.

export const TABLE_POINTS = 201;

/** A table from 121-point profile output (or any length), resampled to TABLE_POINTS. */
export function resample(profile, points = TABLE_POINTS) {
  const out = new Array(points);
  for (let i = 0; i < points; i++) {
    const s = (i / (points - 1)) * (profile.length - 1);
    const j = Math.min(profile.length - 2, Math.floor(s));
    out[i] = profile[j] + (profile[j + 1] - profile[j]) * (s - j);
  }
  return out;
}

/** A smooth arch: depth D at the centre, easing to nothing over `span` (all metres). */
export function archTable(length, thickness, centre, span, points = TABLE_POINTS) {
  const depth = Math.max(0, thickness - centre);
  return Array.from({ length: points }, (_, i) => {
    const u = Math.abs((i / (points - 1)) * length - length / 2) / Math.max(span / 2, 1e-9);
    return u >= 1 ? thickness : thickness - depth * (1 - u * u) ** 2;
  });
}

function sampleAt(table, length, x) {
  const s = Math.min(Math.max(x / length, 0), 1) * (table.length - 1);
  const i = Math.min(table.length - 2, Math.floor(s));
  return table[i] + (table[i + 1] - table[i]) * (s - i);
}

/**
 * Applies one cut. step: {kind: 'deepen'|'trim', position, width, amount} in metres.
 * Returns {table, length}; the input is not changed.
 */
export function applyStep(table, length, step, minThickness) {
  if (step.kind === 'trim') {
    const a = Math.min(Math.max(step.amount, 0), length * 0.2);
    const L = length - 2 * a;
    return { length: L, table: table.map((_, i) => sampleAt(table, length, (i / (table.length - 1)) * L + a)) };
  }
  const half = step.width / 2;
  const out = table.map((h, i) => {
    const dist = Math.abs((i / (table.length - 1)) * length - length / 2);
    const off = dist - step.position;
    if (Math.abs(off) >= half) return h;
    const depth = step.amount * 0.5 * (1 + Math.cos((Math.PI * off) / half));
    return Math.max(minThickness, h - depth);
  });
  return { length, table: out };
}

export function applySteps(table, length, steps, minThickness) {
  let cur = { table, length };
  for (const s of steps) cur = applyStep(cur.table, cur.length, s, minThickness);
  return cur;
}
