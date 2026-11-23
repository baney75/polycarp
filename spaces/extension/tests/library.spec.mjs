// End-to-end check of the Polycarp Library in the unpacked extension: add a link, a note, a PDF,
// a Markdown file and an audio clip; check connections, search, the map, the Markdown export,
// saving from the background menus, and highlights made in the Reader showing up here.
// Run: node tests/library.spec.mjs   (screenshots and design-check-library.json go to tests/out/)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const FX = path.join(here, 'fixtures');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHECK = path.join(os.homedir(), '.claude/skills/web-design-bar/scripts/design_check.js');
const checkSrc = fs.existsSync(CHECK) ? fs.readFileSync(CHECK, 'utf8') : null;

const PAGES = {
  '/water': `<!doctype html><html><head><meta charset="utf-8"><title>The water cycle</title></head><body><article><h1>The water cycle</h1>
<p>Water moves between the oceans, the air and the land in a loop that never stops. The sun warms the sea and lifts water into the air as vapor, a process called evaporation.</p>
<p>As the vapor rises it cools and gathers into clouds through condensation, and when the drops grow heavy they fall back as rain or snow. Rain feeds rivers and groundwater.</p>
<p>Rivers carry much of that water back to the sea, and the loop of evaporation, condensation and rain begins again.</p></article></body></html>`,
  '/clouds': `<!doctype html><html><head><meta charset="utf-8"><title>How clouds form</title></head><body><article><h1>How clouds form</h1>
<p>Clouds form when water vapor in rising air cools and condensation turns it into tiny drops. The drops gather around dust. Heavy clouds bring rain and snow back to the land and the oceans.</p>
<p>Evaporation from the sea feeds the vapor, so clouds are one step in the water cycle.</p></article></body></html>`
};
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGES[req.url.split('?')[0]] || PAGES['/water']); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;

// A one second silent WAV, so the audio path is tested without a real recording.
function wav(seconds) {
  const rate = 8000, n = rate * seconds, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-lib-'));
const wavPath = path.join(tmp, 'Lecture on rain.wav');
fs.writeFileSync(wavPath, wav(3));

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-pw-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const design = {};
async function shots(page, name) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${name}-${width}-${scheme}.png`), fullPage: false });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(over <= 1, `${name} ${width} ${scheme}: no sideways scroll (${over}px over)`);
      if (checkSrc) design[`${name}-${width}-${scheme}`] = JSON.parse(await page.evaluate(checkSrc));
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 860 });
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const X = (p) => `chrome-extension://${id}/${p}`;
  for (const p of ctx.pages()) if (p.url().includes('welcome.html')) await p.close();

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 860 });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(String(e)); if (process.env.SHOW_ERRORS) console.log('pageerror', String(e)); });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  // ---------- Empty state ----------
  await page.goto(X('src/pages/library.html'));
  await page.waitForSelector('#empty:not([hidden])');
  ok(await page.isVisible('#emptyAdd'), 'empty library shows one Add button');
  await shots(page, 'library-empty');

  // ---------- Add two links ----------
  async function addLink(url) {
    await page.click(await page.isVisible('#openAdd') ? '#openAdd' : '#emptyAdd');
    await page.fill('#addUrl', url);
    await page.click('#addGo');
    await page.waitForFunction(() => !document.getElementById('addDlg').open, null, { timeout: 15000 });
  }
  await addLink(site + '/water');
  await page.waitForSelector('#items button[data-id]');
  ok((await page.textContent('#detail h2')).includes('water cycle'), 'link saved with the page title');
  await addLink(site + '/clouds');
  await page.waitForFunction(() => document.querySelectorAll('#items button[data-id]').length === 2);

  // ---------- Add a note that links to the first item ----------
  await page.click('#openAdd');
  await page.click('[data-tab="note"]');
  await page.fill('#noteTitle', 'Weather questions');
  await page.click('#noteBody');
  await page.keyboard.type('Why does rain come back? See [[The wat');
  await page.waitForSelector('.wl-menu li');
  ok((await page.textContent('.wl-menu li')).includes('The water cycle'), '[[ autocomplete offers library titles');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' #weather');
  ok((await page.inputValue('#noteBody')).includes('[[The water cycle]] #weather'), 'autocomplete inserts the full [[title]]');
  await page.click('#addGo');
  await page.waitForFunction(() => document.querySelectorAll('#items button[data-id]').length === 3);
  ok(await page.waitForSelector('#detail .note-body a.wl', { state: 'visible', timeout: 5000 }).then(() => true, () => false), 'note renders its [[link]] as a live link');

  // ---------- Files: PDF, Markdown, audio ----------
  await page.click('#openAdd');
  await page.click('[data-tab="file"]');
  await page.setInputFiles('#addFiles', [path.join(FX, 'fx-paper.pdf'), path.join(FX, 'fx-notes.md'), wavPath]);
  await page.waitForFunction(() => document.querySelectorAll('#queue li.ok, #queue li.err').length === 3, null, { timeout: 30000 });
  const qerr = await page.$$eval('#queue li.err', (l) => l.map((x) => x.textContent + ' ' + x.title));
  ok(!qerr.length, 'all three files added ' + (qerr.length ? JSON.stringify(qerr) : ''));
  await page.click('#addGo');
  await page.waitForFunction(() => document.querySelectorAll('#items button[data-id]').length === 6);
  const chips = await page.$$eval('#kinds .chip', (l) => l.map((c) => c.textContent));
  ok(chips.length === 5, 'filter chips for every kind present: ' + chips.join(', '));

  // ---------- Audio item ----------
  await page.click('#items button:has-text("Lecture on rain")');
  await page.waitForSelector('#aud');
  await page.waitForFunction(() => document.getElementById('aud').src.startsWith('blob:'));
  ok((await page.textContent('#detail .d-meta')).includes('0:03'), 'audio shows its length');
  await page.fill('#dNote', 'Rain starts at the cloud base');
  await page.click('#dNoteForm button[type=submit]');
  await page.waitForSelector('#detail .d-notes li [data-go]');
  ok((await page.textContent('#detail .d-notes [data-go]')) === '0:00', 'audio note saved with a timestamp');
  await shots(page, 'library-audio');

  // ---------- Connections ----------
  await page.click('#items button:has-text("The water cycle")');
  await page.waitForFunction(() => /The water cycle/.test((document.querySelector('#detail h2') || {}).textContent || ''));
  await page.waitForSelector('#detail .conn, #detail .d-sec p.muted');
  const conn = await page.$$eval('#detail .conn li', (l) => l.map((x) => x.textContent));
  ok(conn.some((c) => c.includes('Weather questions')), 'backlink: the note that names this item is connected');
  ok(conn.some((c) => c.includes('How clouds form')), 'topic link: the related page is connected');
  console.log('  connections:', JSON.stringify(conn));
  await page.fill('#dNote', 'Compare with [[How clouds form]]');
  await page.click('#dNoteForm button[type=submit]');
  await page.waitForSelector('#detail .d-notes a.wl');
  await shots(page, 'library-item');

  // ---------- Search ----------
  await page.fill('#q', 'condensation');
  await page.waitForFunction(() => document.querySelectorAll('#items button[data-id]').length < 6);
  const hits = await page.$$eval('#items button[data-id] b', (l) => l.map((x) => x.textContent));
  ok(hits.includes('How clouds form') && hits.includes('The water cycle'), 'search finds text inside pages: ' + hits.join(', '));
  await page.fill('#q', 'cloud base');
  await page.waitForSelector('#noteHits:not([hidden])');
  ok(true, 'search finds words inside notes');
  await page.fill('#q', '');
  await page.waitForFunction(() => document.querySelectorAll('#items button[data-id]').length === 6);

  // ---------- Map ----------
  await page.click('#vMap');
  await page.waitForSelector('#mapSvg .n');
  const nodes = await page.$$eval('#mapSvg .n', (l) => l.length);
  const edges = await page.$$eval('#mapSvg .e', (l) => l.length);
  ok(nodes === 6 && edges >= 2, `map draws every item (${nodes}) and its connections (${edges})`);
  await page.click('#mapSvg .n.note circle');
  await page.waitForFunction(() => document.querySelector('#detail h2')?.textContent === 'Weather questions');
  ok(true, 'clicking a map node opens it');
  await shots(page, 'library-map');
  await page.click('#vList');

  // ---------- Markdown export ----------
  await page.click('#openSync');
  await page.waitForSelector('#obsActs [data-o="zip"]');
  ok(await page.isVisible('#nToken'), 'Notion shows setup steps and a secret field');
  await shots(page, 'library-sync');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#obsActs [data-o="zip"]')]);
  const zipPath = path.join(tmp, 'export.zip');
  await dl.saveAs(zipPath);
  const list = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print("\\n".join(z.namelist())); print("---"); print(z.read("Polycarp/The water cycle.md").decode())', zipPath], { encoding: 'utf8' });
  ok(list.includes('Polycarp/Polycarp Library.md') && list.split('\n').filter((l) => l.endsWith('.md')).length === 7, 'zip holds one Markdown file per item plus the index');
  ok(/## Related[\s\S]*\[\[How clouds form\]\]/.test(list) && list.includes('[[How clouds form]]'), 'exported note keeps [[links]] to related items');
  await page.click('#syncDlg [data-close]');

  // ---------- Background menus ----------
  const tab = await ctx.newPage();
  await tab.goto(site + '/clouds?ref=menu');
  const saved = await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u }); const i = await saveTab(t); return i ? i.title : 'null:' + (t && t.url); }, site + '/clouds?ref=menu');
  ok(saved === 'How clouds form', 'Save page to library works from the background: ' + saved);
  const noted = await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u }); return noteSelection('Clouds form when water vapor cools', t); }, site + '/clouds?ref=menu');
  ok(noted === true, 'Add selection to notes works from the background');
  await tab.close();
  await page.waitForTimeout(600);
  const count = await page.$$eval('#items button[data-id]', (l) => l.length);
  ok(count === 7, 'library updates live when another part of Polycarp saves (' + count + ' items)');

  // ---------- Reader: highlight a passage, see it in the Library ----------
  await page.click('#items button:has-text("The water cycle")');
  await page.waitForSelector('#detail a.btn.primary');
  const reader = await ctx.newPage();
  await reader.goto(X('src/reader/reader.html') + '?src=' + encodeURIComponent(site + '/water'));
  await reader.waitForSelector('body[data-state="reading"]', { timeout: 20000 });
  await reader.waitForFunction(() => !!globalThis.PolycarpReader.itemId, null, { timeout: 8000 });
  await reader.evaluate(() => {
    const blk = [...document.querySelectorAll('#article .blk')].find((b) => /clouds through condensation/.test(b.textContent));
    const r = document.createRange();
    r.selectNodeContents(blk);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await reader.evaluate(() => globalThis.PolycarpReader.highlight(false));
  await reader.waitForFunction(() => CSS.highlights.has('polycarp-hl'));
  ok(true, 'Reader paints the highlight');
  await reader.keyboard.press('n');
  await reader.waitForSelector('#notesSheet:not([hidden]) #notesList blockquote');
  ok((await reader.textContent('#notesList blockquote')).includes('condensation'), 'Reader notes sheet lists the highlight');
  await reader.screenshot({ path: path.join(OUT, 'reader-notes-1280-light.png') });
  await reader.close();
  await page.waitForTimeout(600);
  await page.click('#items button:has-text("The water cycle")');
  await page.waitForSelector('#detail .d-notes blockquote');
  ok((await page.textContent('#detail .d-notes blockquote')).includes('condensation'), 'Library shows the highlight made in the Reader');
  ok((await page.textContent('#detail .d-kind')).trim().length > 0, 'item kind label present');

  // ---------- Phone: list, then item, then back ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-act="back"]');
  await page.waitForFunction(() => !document.body.classList.contains('has-item'));
  ok(await page.isVisible('#items'), 'phone: back returns to the list');
  await page.click('#items button:has-text("Weather questions")');
  await page.waitForFunction(() => document.body.classList.contains('has-item') && /Weather questions/.test((document.querySelector('#detail h2') || {}).textContent || ''));
  ok(!(await page.isVisible('#items')) && (await page.isVisible('#detail h2')), 'phone: an item fills the screen');

  ok(!errors.length, 'no page errors ' + (errors.length ? JSON.stringify(errors.slice(0, 5)) : ''));
} catch (e) {
  console.error(e);
  fails++;
} finally {
  if (checkSrc) fs.writeFileSync(path.join(OUT, 'design-check-library.json'), JSON.stringify(design, null, 1));
  await ctx.close();
  server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
