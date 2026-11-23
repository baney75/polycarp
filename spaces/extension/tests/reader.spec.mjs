// End-to-end check of the Polycarp Reader inside the real unpacked extension.
// Run: node tests/reader.spec.mjs   (writes screenshots to tests/out/)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const FX = path.join(here, 'fixtures');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-pw-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const base = `chrome-extension://${id}/src/reader/reader.html`;
  // Close the welcome tab the install opens.
  await new Promise((r) => setTimeout(r, 800));
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(base);
  ok(await page.locator('body[data-state="landing"]').count() === 1, 'landing shows with no params');
  await page.screenshot({ path: path.join(OUT, 'landing-1280.png') });

  for (const fx of ['fx-paper.pdf', 'fx-book.epub', 'fx-doc.docx']) {
    await page.goto(base);
    await page.setInputFiles('#file', path.join(FX, fx));
    await page.waitForSelector('body[data-state="reading"], body[data-state="error"]', { timeout: 30000 });
    const state = await page.evaluate(() => document.body.dataset.state);
    const info = await page.evaluate(() => ({
      blocks: PolycarpReader.blocks.length, words: PolycarpReader.total,
      bionic: document.querySelectorAll('#article polycarp-b').length,
      cps: document.querySelectorAll('#article .checkpoint').length,
      title: document.getElementById('docTitle').textContent,
      url: location.search, err: document.getElementById('errText').textContent
    }));
    ok(state === 'reading', `${fx} opens (${info.blocks} blocks, ${info.words} words, title "${info.title}") ${info.err}`);
    ok(info.bionic > 0, `${fx} gets bold anchors (${info.bionic})`);
    ok(/lib=/.test(info.url), `${fx} URL becomes a library link`);
  }

  // Long text: rounds, checkpoint, tracking, snap.
  await page.goto(base);
  await page.setInputFiles('#file', path.join(FX, 'boring.txt'));
  await page.waitForSelector('body[data-state="reading"]');
  const r = await page.evaluate(() => ({ rounds: PolycarpReader.rounds.length, total: PolycarpReader.total }));
  ok(r.rounds >= 1, `boring.txt gets ${r.rounds} recall rounds for ${r.total} words`);
  await page.waitForTimeout(600);
  ok(await page.locator('.ideas').count() === 1, 'key ideas card renders');
  await page.screenshot({ path: path.join(OUT, 'reader-1280.png') });

  // Scroll to the first checkpoint and answer it.
  await page.evaluate(() => PolycarpReader.rounds[0].el.scrollIntoView({ block: 'center' }));
  await page.waitForSelector('.checkpoint .q', { timeout: 5000 });
  const cp = await page.evaluate(() => {
    const el = document.querySelector('.checkpoint[data-filled]');
    return { qs: el.querySelectorAll('.q').length, prompt: el.querySelector('.q .prompt').textContent };
  });
  ok(cp.qs >= 1, `checkpoint shows ${cp.qs} questions: "${cp.prompt.slice(0, 80)}"`);
  await page.screenshot({ path: path.join(OUT, 'checkpoint-1280.png') });
  await page.locator('.checkpoint [data-skip]').first().click();
  await page.waitForSelector('.checkpoint .cp-done');
  const cards = await page.evaluate(async () => (await PolycarpMemory.load()).length);
  ok(cards >= 1, `skipped checkpoint still planted ${cards} cards`);

  // Judge function
  const j = await page.evaluate(() => [
    PolycarpReader.judge('mitochondria', 'mitochondria'), PolycarpReader.judge('mitocondria', 'mitochondria'),
    PolycarpReader.judge('the Krebs cycle', 'Krebs cycle'), PolycarpReader.judge('banana', 'mitochondria'),
    PolycarpReader.judge('1945', '1945'), PolycarpReader.judge('1944', '1945')]);
  ok(JSON.stringify(j) === JSON.stringify(['got', 'got', 'got', 'missed', 'got', 'missed']), 'answer judge: ' + j.join(','));

  // Tracking: hold the page still with activity and see a block counted.
  await page.evaluate(() => { const b = PolycarpReader.blocks[0]; window.scrollTo(0, b.getBoundingClientRect().top + scrollY - 200); });
  for (let i = 0; i < 16; i++) { await page.mouse.move(200 + i, 300); await page.waitForTimeout(500); }
  const done = await page.evaluate(() => PolycarpReader.done.size);
  ok(done >= 1, `dwell tracking marked ${done} blocks read`);

  // Text sheet, sprint, print dialog
  await page.keyboard.press('a');
  ok(await page.locator('#typeSheet:not([hidden])').count() === 1, 'A opens the text sheet');
  await page.locator('.theme[data-id="night"]').click();
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.documentElement.dataset.rt) === 'night', 'night theme applies');
  await page.screenshot({ path: path.join(OUT, 'sheet-night-1280.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  ok(await page.locator('#sprint:not([hidden])').count() === 1, 'R opens sprint');
  await page.keyboard.press(' ');
  await page.waitForTimeout(1200);
  const word = await page.evaluate(() => document.getElementById('spWord').textContent);
  ok(word.length > 0, `sprint shows a word: "${word}"`);
  await page.screenshot({ path: path.join(OUT, 'sprint-1280.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  ok(await page.locator('#printDlg:not([hidden])').count() === 1, 'P opens print dialog');
  await page.screenshot({ path: path.join(OUT, 'print-1280.png') });
  await page.locator('#pCancel').click();
  await page.locator('.theme').first().count();
  await page.evaluate(() => PolycarpReader.patch({ reader: { theme: 'paper' } }, true));

  // Print output as PDF to prove the print stylesheet and recall sheet.
  await page.evaluate(() => { document.getElementById('pSheet').checked = true; });
  await page.evaluate(() => { document.getElementById('printDlg').hidden = false; });
  await page.evaluate(() => { window.print = () => {}; document.getElementById('pGo').click(); });
  await page.waitForTimeout(300);
  const sheetQs = await page.evaluate(() => document.querySelectorAll('#studySheet li').length);
  ok(sheetQs > 0, `recall sheet has ${sheetQs} items`);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: path.join(OUT, 'print.pdf'), format: 'Letter' });
  await page.emulateMedia({ media: 'screen' });

  // Phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(wide <= 390, `no sideways scroll at 390 (${wide})`);
  await page.screenshot({ path: path.join(OUT, 'reader-390.png') });
  await page.goto(base);
  await page.screenshot({ path: path.join(OUT, 'landing-390.png') });

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
