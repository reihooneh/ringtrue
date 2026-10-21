// Browser tests for every page at phone, tablet and desktop widths: no errors, no sideways
// scrolling, no text on top of other text (HTML or SVG), and the main things work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serve } from '../../scripts/serve.mjs';

const PAGES = ['index.html', 'design.html', 'workshop.html', 'set.html', 'method.html'];
const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
];
let server, browser, base;

before(async () => {
  server = await serve();
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  server?.close();
});

async function open(path, size = SIZES[0], opts = {}) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: 'reduce', acceptDownloads: true, ...opts });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|WebGL/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + path);
  await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { page, context, errors };
}

// Every piece of visible text, HTML or SVG: no two different pieces overlap.
async function textOverlaps(page) {
  return page.evaluate(() => {
    const boxes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.textContent.trim()) continue;
      const elx = n.parentElement;
      if (elx.closest('.visually-hidden, [hidden], .skip, option, title, select')) continue;
      const cs = getComputedStyle(elx);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (elx instanceof SVGElement) {
        const r = elx.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1) boxes.push({ r, text: n.textContent.trim().slice(0, 40), node: n });
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width >= 1 && r.height >= 1) boxes.push({ r, text: n.textContent.trim().slice(0, 40), node: n });
    }
    const out = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.node === b.node) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 2 && h > Math.min(a.r.height, b.r.height) * 0.35) out.push(`"${a.text}" overlaps "${b.text}"`);
      }
    }
    return out;
  });
}

// SVG text must stay inside its drawing.
async function svgTextOutside(page) {
  return page.evaluate(() => {
    const out = [];
    for (const s of document.querySelectorAll('.svg-frame svg, .keys-frame svg')) {
      const f = s.getBoundingClientRect();
      for (const t of s.querySelectorAll('text')) {
        const r = t.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left < f.left - 1 || r.right > f.right + 1 || r.top < f.top - 1 || r.bottom > f.bottom + 1) out.push(t.textContent);
      }
    }
    return out;
  });
}

for (const path of PAGES) {
  for (const size of SIZES) {
    test(`${path} at ${size.name}: no errors, no sideways scroll, nothing overlapping`, async () => {
      const { page, context, errors } = await open(path, size);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(scroll <= 0, `page scrolls sideways by ${scroll}px`);
      assert.deepEqual(await textOverlaps(page), []);
      assert.deepEqual(await svgTextOutside(page), []);
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
}

test('built pages: strict CSP, no inline code, nothing loaded from other sites', () => {
  const dir = new URL('../../site/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(new URL(f, dir), 'utf8');
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval';/, f);
    assert.doesNotMatch(html, /'unsafe-inline'|'unsafe-eval'/, f);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f} has an inline script`);
    assert.doesNotMatch(html, /\sstyle=|<style|\son[a-z]+=/i, `${f} has inline styles or handlers`);
    const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
    for (const url of external) assert.ok(/^https:\/\/(github\.com\/reihooneh|www\.wood-database\.com|woodsolutions\.com\.au|espace\.curtin\.edu\.au|lafavre\.us|www\.mmdigest\.com)\//.test(url), `${f} links ${url}`);
    assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)="https?:/, `${f} loads code or styles from another site`);
  }
  for (const f of readdirSync(new URL('assets/js/', dir))) {
    const js = readFileSync(new URL(`assets/js/${f}`, dir), 'utf8');
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, `${f} builds HTML from strings`);
  }
});

test('home: the 3D bar loads, partials switch, the ladder shows 1:4:10', async () => {
  const { page, context, errors } = await open('index.html');
  assert.ok(['webgl', 'flat'].includes(await page.$eval('#hero-view', (n) => n.dataset.mode)));
  await page.click('.mode-picker [data-step="1"]');
  assert.match(await page.textContent('#hero-readout'), /4\.00 times the note/);
  await page.click('#strike');
  await page.click('#play-plain');
  assert.match(await page.textContent('#ladder'), /4\.00/);
  assert.match(await page.textContent('#ladder'), /10\.00/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('home: works without WebGL (flat fallback)', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/.test(type) ? null : orig.call(this, type, ...rest);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}index.html`);
  await page.waitForFunction(() => document.querySelector('#hero-view')?.dataset.mode);
  assert.equal(await page.$eval('#hero-view', (n) => n.dataset.mode), 'flat');
  await page.click('.mode-picker [data-step="2"]');
  assert.deepEqual(errors, []);
  await context.close();
});

test('designer: a new note and tuning, the link, and the downloads', async () => {
  const { page, context, errors } = await open('design.html');
  assert.match(await page.textContent('#status'), /C4 marimba bar/);
  await page.selectOption('#note', '57');
  await page.check('input[name="tuning"][value="xylophone"]', { force: true });
  await page.click('#go');
  await page.waitForFunction(() => /A3 xylophone/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  assert.match(page.url(), /#note=A3&tuning=xylophone&wood=rosewood/);
  const rows = await page.$$eval('#partials tr', (r) => r.map((x) => x.textContent));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => /In tune/.test(r)), rows.join('\n'));
  assert.deepEqual(await textOverlaps(page), []);

  const [svgDl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-svg')]);
  assert.equal(svgDl.suggestedFilename(), 'ringtrue-A3-template.svg');
  const svgText = readFileSync(await svgDl.path(), 'utf8');
  assert.match(svgText, /width="[\d.]+mm"/);
  assert.doesNotMatch(svgText, /<script|on\w+=/i);
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-csv')]);
  const csv = readFileSync(await csvDl.path(), 'utf8').trim().split('\n');
  assert.equal(csv[2], 'position_mm,thickness_mm,cut_depth_mm');
  assert.ok(csv.length > 50);
  assert.match(await page.getAttribute('#to-workshop', 'href'), /^workshop\.html#note=A3&tuning=xylophone/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('designer: bad sizes are explained, not sent; a crafted link is ignored', async () => {
  const { page, context, errors } = await open('design.html#note=%3Cimg%20src=x%3E&w=99999&tuning=__proto__&wood=../../etc');
  assert.equal(await page.inputValue('#note'), '60');
  assert.equal(await page.inputValue('#wood'), 'rosewood');
  await page.fill('#min', '30');
  await page.click('#go');
  assert.match(await page.textContent('#form-error'), /at most 90%|between/);
  assert.equal(await page.getAttribute('#min', 'aria-invalid'), 'true');
  await page.fill('#min', '5.5');
  await page.fill('#width', '');
  await page.click('#go');
  assert.match(await page.textContent('#form-error'), /Width must be between/);
  assert.equal(await page.$('img[src="x"]'), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('workshop: the practice bar can be tuned by following the advice', async () => {
  const { page, context, errors } = await open('workshop.html#seed=42');
  let rounds = 0;
  for (; rounds < 8; rounds++) {
    await page.click('#tap-sim');
    await page.waitForFunction(() => !document.getElementById('tap-sim').disabled, null, { timeout: 30000 });
    if (!(await page.isHidden('#verdict'))) break;
    assert.ok((await page.locator('#cuts li').count()) >= 1);
    assert.deepEqual(await textOverlaps(page), []);
    await page.click('#made');
  }
  assert.match(await page.textContent('#verdict'), /In tune/);
  assert.ok(rounds <= 6, `took ${rounds + 1} taps`);
  await page.click('#undo');
  assert.match(await page.textContent('#hear-status'), /Back one round/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('workshop: my bar from the designer link, a junk recording, and bad measurements', async () => {
  const { page, context, errors } = await open('workshop.html#note=E4&tuning=marimba&wood=jarrah');
  assert.match(await page.textContent('#bar-summary'), /E4 marimba bar in Jarrah/);
  const dir = mkdtempSync(join(tmpdir(), 'ringtrue-'));
  try {
    const junk = join(dir, 'tap.wav');
    writeFileSync(junk, 'RIFF....WAVEfmt not really audio');
    await page.setInputFiles('#file', junk);
    await page.waitForFunction(() => /could not be read|No clear note|too quiet/.test(document.getElementById('hear-status').textContent));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await page.click('#mine-details summary');
  await page.fill('#m-centre', '30');
  await page.click('#mine-form button');
  assert.match(await page.textContent('#mine-error'), /highlighted|can.t be thicker/);
  await page.fill('#m-centre', '9');
  await page.click('#mine-form button');
  assert.match(await page.textContent('#bar-summary'), /9\.0 mm at the thinnest/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('set: bars play from the mouse and the keyboard, and the list matches', async () => {
  const { page, context, errors } = await open('set.html');
  assert.equal(await page.locator('.bar-key').count(), 25);
  assert.equal(await page.locator('#list tr').count(), 25);
  await page.click('.bar-key[data-midi="60"]');
  await page.keyboard.press('d');
  await page.focus('.bar-key[data-midi="61"]');
  await page.keyboard.press('Enter');
  await page.selectOption('#to', '60');
  await page.click('#go');
  assert.match(await page.textContent('#status'), /lowest note below/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('method: the live check agrees with beam theory', async () => {
  const { page, context, errors } = await open('method.html');
  const cells = await page.$$eval('#check tr td:last-child', (t) => t.map((x) => Math.abs(parseFloat(x.textContent))));
  assert.equal(cells.length, 4);
  assert.ok(cells.every((c) => c < 1), cells.join());
  assert.match(await page.textContent('#check-note'), /22\.4\d% of the way along/);
  assert.deepEqual(errors, []);
  await context.close();
});
