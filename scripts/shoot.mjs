// Screenshots of every page at three widths, for checking the design by eye (not run in CI).
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const out = process.argv[2];
const pages = (process.argv[3] || 'index').split(',');
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
for (const p of pages) {
  for (const [name, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}${p}.html${process.argv[4] || ''}`);
    await page.waitForTimeout(Number(process.env.WAIT || 2500));
    await page.screenshot({ path: `${out}/${p}-${name}.png`, fullPage: true });
    if (errors.length) console.log(p, name, errors);
    await page.close();
  }
}
await browser.close();
server.close();
