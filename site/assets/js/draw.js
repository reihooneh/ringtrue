// Small, safe drawing helpers. Everything is built with createElement / createElementNS and
// textContent: no HTML strings, so nothing a user types can become markup.

const SVGNS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
}

export function svg(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'text') n.textContent = v;
    else n.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
}

export const fmt = {
  mm: (m, d = 1) => `${(m * 1000).toFixed(d)} mm`,
  hz: (f) => (f >= 10000 ? `${f.toFixed(0)} Hz` : `${f.toFixed(1)} Hz`),
  cents: (c) => {
    const d = Math.abs(c) < 10 ? 1 : 0;
    const shown = Math.abs(c).toFixed(d);
    return `${Number(shown) === 0 ? '' : c > 0 ? '+' : '−'}${shown} ¢`;
  },
  grams: (kg) => `${(kg * 1000).toFixed(0)} g`,
};

/** Measures text in an SVG font (approximately; good enough for placing labels apart). */
function textWidth(s, size = 13) {
  return s.length * size * 0.56;
}

/**
 * Places labels along a line so none overlap: each wants an x; labels that would collide move to
 * the next row. Returns [{x, row}].
 */
export function placeLabels(items, minX, maxX, size = 13) {
  const rows = [];
  return items.map((it) => {
    const w = textWidth(it.text, size) + 10;
    let x = Math.min(Math.max(it.x, minX + w / 2), maxX - w / 2);
    for (let row = 0; ; row++) {
      rows[row] = rows[row] || [];
      const clash = rows[row].some((b) => x - w / 2 < b.right && b.left < x + w / 2);
      if (!clash) {
        rows[row].push({ left: x - w / 2, right: x + w / 2 });
        return { ...it, x, row, w };
      }
    }
  });
}

/**
 * Side view of a bar to scale along its length (height exaggerated, and labelled as such).
 * profile: thickness samples end to end (m). Options: nodes (m from the left), plan (thickness
 * after this round's cuts, to show the wood to take off), width in px.
 */
export function profileDrawing({ length, thickness, profile, nodes = [], plan = null, width = 640, title = 'Side view of the bar' }) {
  const padX = 18;
  const drawW = Math.max(200, width - padX * 2);
  const sx = drawW / length;
  const exaggerate = Math.min(4, Math.max(1, (drawW * 0.14) / (thickness * sx)));
  const sy = sx * exaggerate;
  const top = 34;
  const barH = thickness * sy;
  const X = (x) => padX + x * sx;
  const Y = (h) => top + h * sy;  // depth below the top surface
  const n = profile.length;
  const pts = profile.map((h, i) => `${X((length * i) / (n - 1)).toFixed(2)},${Y(h).toFixed(2)}`);
  const body = `M${X(0)},${top} L${X(length)},${top} L${pts.slice().reverse().join(' L')} Z`;
  const kids = [svg('title', { text: title })];
  kids.push(svg('path', { d: body, class: 'd-wood' }));
  // Grain lines inside the bar, following the top surface.
  for (let g = 1; g <= 3; g++) {
    const y = top + (barH * g) / 5;
    kids.push(svg('line', { x1: X(0) + 4, x2: X(length) - 4, y1: y, y2: y, stroke: 'rgba(60,20,10,.18)', 'stroke-width': 1 }));
  }
  if (plan) {
    // Wood to remove this round: between today's underside and the planned one.
    const a = profile.map((h, i) => `${X((length * i) / (n - 1)).toFixed(2)},${Y(h).toFixed(2)}`);
    const b = plan.map((h, i) => `${X((length * i) / (n - 1)).toFixed(2)},${Y(h).toFixed(2)}`).reverse();
    kids.push(svg('path', { d: `M${a.join(' L')} L${b.join(' L')} Z`, class: 'd-plan' }));
  }
  // Re-draw the uncut outline as a dashed line so the depth of the arch reads clearly.
  kids.push(svg('line', { x1: X(0), x2: X(length), y1: Y(thickness), y2: Y(thickness), class: 'd-cut' }));
  // Support holes at the nodes of the first partial.
  const holeY = top + Math.min(barH * 0.35, profile[Math.round((n - 1) * 0.22)] * sy * 0.5);
  for (const x of nodes) kids.push(svg('circle', { cx: X(x), cy: holeY, r: 4, class: 'd-node' }));

  // Labels above: thickness at the end and at the thinnest point.
  let thinI = 0;
  profile.forEach((h, i) => { if (h < profile[thinI]) thinI = i; });
  const above = placeLabels(
    [
      { x: X(0) + 50, text: `${(thickness * 1000).toFixed(1)} mm thick` },
      { x: X((length * thinI) / (n - 1)), text: `${(profile[thinI] * 1000).toFixed(1)} mm at the thinnest` },
    ],
    padX,
    padX + drawW,
  );
  for (const l of above) kids.push(svg('text', { x: l.x, y: top - 10 - l.row * 16, 'text-anchor': 'middle', class: 'd-text', text: l.text }));

  // Below: the length, and where the holes go.
  const baseY = Y(thickness) + 22;
  kids.push(svg('line', { x1: X(0), x2: X(length), y1: baseY, y2: baseY, class: 'd-dim' }));
  kids.push(svg('line', { x1: X(0), x2: X(0), y1: baseY - 5, y2: baseY + 5, class: 'd-dim' }));
  kids.push(svg('line', { x1: X(length), x2: X(length), y1: baseY - 5, y2: baseY + 5, class: 'd-dim' }));
  const below = placeLabels(
    [
      { x: X(length / 2), text: `${(length * 1000).toFixed(1)} mm long`, strong: true },
      ...nodes.map((x) => ({ x: X(x), text: `hole ${(x * 1000).toFixed(0)} mm` })),
    ],
    padX,
    padX + drawW,
  );
  for (const l of below) {
    kids.push(svg('text', { x: l.x, y: baseY + 18 + l.row * 16, 'text-anchor': 'middle', class: l.strong ? 'd-text-strong' : 'd-text', text: l.text }));
  }
  const rowsBelow = Math.max(0, ...below.map((l) => l.row)) + 1;
  const height = baseY + 10 + rowsBelow * 16 + 14;
  kids.push(svg('text', {
    x: padX + drawW, y: height - 2, 'text-anchor': 'end', class: 'd-text',
    text: exaggerate > 1.05 ? `height drawn ×${exaggerate.toFixed(1)}` : 'drawn to scale',
  }));
  return svg('svg', { viewBox: `0 0 ${width} ${height + 4}`, width, height: height + 4, role: 'img', 'aria-label': title }, kids);
}

/** Small multiples: how the bar bends in each partial, with its still points (nodes). */
export function modesDrawing({ length, shapes, nodes, freq, count = 3, width = 640 }) {
  const padX = 18, rowH = 74, labelH = 18;
  const drawW = Math.max(200, width - padX * 2);
  const kids = [svg('title', { text: 'How the bar bends in each partial' })];
  for (let k = 0; k < count; k++) {
    const y0 = k * (rowH + labelH) + labelH + rowH / 2;
    kids.push(svg('text', { x: padX, y: y0 - rowH / 2 - 4, class: 'd-text-strong', text: `Partial ${k + 1}: ${fmt.hz(freq[k])}` }));
    kids.push(svg('line', { x1: padX, x2: padX + drawW, y1: y0, y2: y0, class: 'd-zero' }));
    const s = shapes[k];
    const d = s.map((v, i) => `${i ? 'L' : 'M'}${(padX + (drawW * i) / (s.length - 1)).toFixed(2)},${(y0 - v * (rowH / 2 - 6)).toFixed(2)}`).join(' ');
    kids.push(svg('path', { d, class: `d-line d-p${k + 1}` }));
    for (const x of nodes[k] || []) kids.push(svg('circle', { cx: padX + (x / length) * drawW, cy: y0, r: 4, class: 'd-node' }));
  }
  const height = count * (rowH + labelH) + 4;
  return svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Mode shapes' }, kids);
}

/** The heard spectrum on a log frequency axis, with the picked partials and the targets. */
export function spectrumDrawing({ peaks, partials, targets = [], width = 640 }) {
  const padX = 18, top = 24, h = 150;
  const drawW = Math.max(200, width - padX * 2);
  const fMin = 50, fMax = 16000;
  const X = (f) => padX + (Math.log(f / fMin) / Math.log(fMax / fMin)) * drawW;
  const Y = (db) => top + Math.min(1, Math.max(0, -db / 70)) * h;
  const kids = [svg('title', { text: 'What the microphone heard' })];
  for (const f of [100, 200, 500, 1000, 2000, 5000, 10000]) {
    kids.push(svg('line', { x1: X(f), x2: X(f), y1: top, y2: top + h, class: 'd-axis' }));
    kids.push(svg('text', { x: X(f), y: top + h + 16, 'text-anchor': 'middle', class: 'd-text', text: f >= 1000 ? `${f / 1000} kHz` : `${f} Hz` }));
  }
  targets.forEach((f, i) => {
    if (f > fMin && f < fMax) kids.push(svg('line', { x1: X(f), x2: X(f), y1: top - 6, y2: top + h, class: `d-line d-p${i + 1}`, 'stroke-dasharray': '3 4', 'stroke-width': 1.5 }));
  });
  for (const p of peaks) {
    if (p.freq < fMin || p.freq > fMax) continue;
    kids.push(svg('line', { x1: X(p.freq), x2: X(p.freq), y1: top + h, y2: Y(p.level), class: 'd-spectrum' }));
  }
  partials.forEach((f, i) => {
    const p = peaks.find((q) => Math.abs(q.freq - f) < 1e-6) || { level: 0 };
    kids.push(svg('circle', { cx: X(f), cy: Y(p.level), r: 7, class: `d-fill-p${i + 1}` }));
    kids.push(svg('text', { x: X(f), y: Y(p.level) + 4, 'text-anchor': 'middle', fill: '#fff', 'font-size': 10, 'font-family': 'Bricolage, sans-serif', text: String(i + 1) }));
  });
  const height = top + h + 24;
  return svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Spectrum of the tap' }, kids);
}

/** A cents meter row: −50 ... +50 cents, dot clamped at the ends. */
export function meter(label, value, k) {
  const pos = 50 + Math.max(-50, Math.min(50, value));
  const dot = el('span', { class: `meter-dot p${k + 1}` });
  dot.style.left = `${pos}%`;
  return el('div', { class: 'meter' }, [
    el('span', { text: label }),
    el('span', { class: 'meter-track', role: 'img', 'aria-label': `${label}: ${fmt.cents(value)} from the target` }, [dot]),
    el('span', { class: 'meter-val', text: Math.abs(value) > 50 ? `${fmt.cents(value)} (off scale)` : fmt.cents(value) }),
  ]);
}

/** Calls draw(width) now and whenever the container's width changes. */
export function responsive(container, draw) {
  let last = -1;
  const render = () => {
    const w = Math.floor(container.clientWidth);
    if (w <= 0 || w === last) return;
    last = w;
    container.replaceChildren(draw(w));
  };
  render();
  if ('ResizeObserver' in window) new ResizeObserver(render).observe(container);
  return () => { last = -1; render(); };
}

/** Starts a download of text the page made (no network involved). */
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
