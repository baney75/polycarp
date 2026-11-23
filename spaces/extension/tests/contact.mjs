// Contact sheets of every Polycarp surface and state, at 390 and 1280, light and dark.
// Writes tests/out/contact/<piece>-<state>-<width>-<scheme>.png, a design-check JSON per shot,
// and one sheet per piece (tests/out/contact/sheet-<piece>.png) when ImageMagick or Chrome is around.
// Run: node tests/contact.mjs [piece ...]   (pieces: popup finder pill search reader library review settings welcome)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VID, YT, XPAGE, AUDIBLE } from './fixtures/sites.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const OUT = path.join(here, 'out', 'contact');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const SKILL = path.join(os.homedir(), '.claude/skills/web-design-bar/scripts');
const checkSrc = fs.existsSync(path.join(SKILL, 'design_check.js')) ? fs.readFileSync(path.join(SKILL, 'design_check.js'), 'utf8') : null;
const want = new Set(process.argv.slice(2));
const on = (p) => !want.size || want.has(p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>The water cycle</title></head>
<body style="font-family:Georgia;max-width:40em;margin:2em auto;padding:0 16px"><h1>The water cycle</h1>
<p>Water moves between the oceans, the air and the land in a loop that never stops. The sun warms the sea and lifts water into the air as vapor.</p>
<h2>Clouds</h2><p>As the vapor rises it cools and gathers into clouds, and when the drops grow heavy they fall back as rain or snow.</p>
<h2>Rivers</h2><p>Rivers carry much of that water back to the sea, and the loop begins again. <a href="https://en.wikipedia.org/wiki/River">Read about rivers</a>.</p>
<figure><img src="/pic.svg" alt="A river bending through a green valley" width="600" height="300" style="max-width:100%;height:auto"><figcaption>A river in its valley.</figcaption></figure></body></html>`;
const DARK = ARTICLE.replace('<body style="', '<body style="background:#15171a;color:#e8e6e3;');
const PIC = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#9fc5a8"/><path d="M0 220 C150 120 300 300 600 160" stroke="#3b6ea5" stroke-width="26" fill="none"/></svg>';
const MEDIA = fs.readFileSync(path.join(here, 'fixtures', 'fx-media.html'), 'utf8');
const server = http.createServer((req, res) => {
  const u = req.url;
  if (u.startsWith('/pic.svg') || u.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(PIC); }
  const body = u.startsWith('/dark') ? DARK : u.startsWith('/media') ? MEDIA : ARTICLE;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const LOCAL = `http://127.0.0.1:${server.address().port}`;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>The Quiet Shelf</title><link>https://shelf.example/</link><description>Notes on old books.</description>
${Array.from({ length: 12 }, (_, i) => `<item><title>Reading the classics, part ${i + 1}</title><link>https://shelf.example/p${i}</link><description>Why slow reading pays off, entry ${i + 1}.</description><pubDate>Mon, 0${(i % 9) + 1} Nov 2026 10:00:00 GMT</pubDate></item>`).join('')}
</channel></rss>`;
const dav = (base, items) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">` +
  [{ href: base, dir: true }, ...items].map((i) => `<d:response><d:href>${i.href}</d:href><d:propstat><d:prop>${i.dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${i.size}</d:getcontentlength><d:getcontenttype>${i.type}</d:getcontenttype>`}<d:getlastmodified>Mon, 16 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('') + '</d:multistatus>';
const NASROOT = dav('/', [
  { href: '/Books/', dir: true }, { href: '/Audiobooks/', dir: true }, { href: '/Polycarp/', dir: true },
  { href: '/Mere%20Christianity.epub', size: 482113, type: 'application/epub+zip' },
  { href: '/The%20Federalist%20Papers.pdf', size: 3120443, type: 'application/pdf' },
  { href: '/Sermon%20notes.md', size: 8211, type: 'text/markdown' }
]);

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-contact-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const html = (body, type = 'text/html; charset=utf-8') => ({ status: 200, contentType: type, body });
await ctx.route('https://www.youtube.com/watch**', (r) => r.fulfill(html(YT)));
await ctx.route('https://x.com/**', (r) => r.fulfill(html(XPAGE)));
await ctx.route('https://www.audible.com/**', (r) => r.fulfill(html(AUDIBLE)));
await ctx.route('https://m.media-amazon.com/**', (r) => r.fulfill({ status: 404, body: '' }));
await ctx.route('https://shelf.example/**', (r) => r.fulfill(html(RSS, 'application/rss+xml')));
const SRC = path.join(here, 'fixtures', 'sources');
const routes = { 'https://www.youtube.com/results': 'youtube.html', 'https://en.wikipedia.org/w/rest.php/v1/search/page': 'wikipedia.json', 'https://gutendex.com/books': 'gutenberg.json',
  'https://openlibrary.org/search.json': 'openlibrary.json', 'https://archive.org/advancedsearch.php': 'archive.json', 'https://librivox.org/api/feed/audiobooks': 'librivox.json',
  'https://export.arxiv.org/api/query': 'arxiv.xml', 'https://api.openalex.org/works': 'openalex.json' };
for (const [u, f] of Object.entries(routes)) {
  await ctx.route(u + '**', (r) => r.fulfill(html(fs.readFileSync(path.join(SRC, f), 'utf8'), f.endsWith('.json') ? 'application/json' : f.endsWith('.xml') ? 'application/atom+xml' : 'text/html')));
}
await ctx.route('http://nas.test:5005/**', (r) => {
  const m = r.request().method();
  if (m === 'PROPFIND') return r.fulfill({ status: 207, contentType: 'application/xml', body: new URL(r.request().url()).pathname === '/' ? NASROOT : dav(new URL(r.request().url()).pathname, []) });
  return r.fulfill({ status: 200, body: '' });
});

const report = {};
const shots = {};
function add(piece, file) { (shots[piece] = shots[piece] || []).push(file); }
async function shot(page, piece, state, { schemes = ['light', 'dark'], full = false } = {}) {
  const w = page.viewportSize().width;
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(200);
    const f = path.join(OUT, `${piece}-${state}-${w}-${scheme}.png`);
    await page.screenshot({ path: f, fullPage: full });
    add(piece, f);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth).catch(() => 0);
    const r = { over };
    if (checkSrc) { try { r.check = JSON.parse(await page.evaluate(checkSrc)); } catch (e) { r.check = String(e); } }
    report[`${piece}-${state}-${w}-${scheme}`] = r;
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
// Click a button inside a closed shadow root by its title, through the DevTools protocol.
async function clickShadow(page, tag, title) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    let hit = null;
    const walk = (n, inHost) => {
      if (hit) return;
      const host = inHost || n.nodeName === tag.toUpperCase();
      if (host && n.nodeName === 'BUTTON' && (n.attributes || []).join('|').includes(title)) { hit = n; return; }
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, host);
    };
    walk(root, false);
    if (!hit) return false;
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: hit.nodeId });
    const q = model.content;
    await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
    return true;
  } finally { await cdp.detach(); }
}
const errors = [];
function watch(page, name) {
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${name}: ${m.text()}` + (process.env.SHOW_ERRORS ? " at " + JSON.stringify(m.location()) : "")); });
  return page;
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const X = (p) => `chrome-extension://${id}/${p}`;
  await sleep(800);
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
  const tabOf = (prefix) => sw.evaluate(async (u) => { const t = (await chrome.tabs.query({})).find((x) => (x.url || '').startsWith(u)); return t ? t.id : null; }, prefix);
  const send = (tabId, msg) => sw.evaluate(([i, m]) => chrome.tabs.sendMessage(i, m, { frameId: 0 }).catch((e) => ({ error: String(e) })), [tabId, msg]);
  const setS = (patch) => sw.evaluate((p) => Polycarp.patchSettings(p, { keepProfile: true }), patch);

  // A real web page in a tab, so the popup and finder have something to act on.
  const art = watch(await ctx.newPage(), 'article');
  await art.goto(LOCAL + '/article');
  const artTab = await tabOf(LOCAL + '/article');

  // ---------- Popup ----------
  if (on('popup')) {
    // The toolbar popup is 360 wide; 390 and 1280 show it as a page on a phone and a desktop too.
    const openPopup = async (w = 360) => {
      const pp = watch(await ctx.newPage(), 'popup');
      await pp.addInitScript(([tid, url]) => {
        const real = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (q) => (q && q.active ? [{ id: tid, url, title: 'The water cycle', active: true }] : real(q));
      }, [artTab, LOCAL + '/article']);
      await pp.setViewportSize({ width: w, height: w < 500 ? 640 : 900 });
      await pp.goto(X('src/popup/popup.html'));
      await sleep(600);
      return pp;
    };
    let pp;
    for (const w of [390, 1280]) { pp = await openPopup(w); await shot(pp, 'popup', 'page', { full: true }); await pp.close(); }
    pp = await openPopup();
    await shot(pp, 'popup', 'normal', { full: true });
    const menuBtn = await pp.$('[aria-controls="powerMenu"], #power, .headr button');
    if (menuBtn) { await menuBtn.click(); await sleep(200); await shot(pp, 'popup', 'menu', { full: true }); }
    await pp.close();
    await setS({ pausedUntil: Date.now() + 3600e3 });
    pp = await openPopup(); await shot(pp, 'popup', 'paused', { full: true }); await pp.close();
    await setS({ pausedUntil: 0, enabled: false });
    pp = await openPopup(); await shot(pp, 'popup', 'off', { full: true }); await pp.close();
    await setS({ enabled: true });
  }

  // ---------- Finder and page UI ----------
  if (on('finder')) {
    const finderOn = async (page, url, q, prefix, w) => {
      await page.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await page.goto(url);
      const tid = await tabOf(prefix);
      for (let i = 0; i < 30 && !(await send(tid, { type: 'polycarp:state' }))?.active; i++) await sleep(150);
      await page.bringToFront();
      await send(tid, { type: 'polycarp:find' });
      await sleep(500);
      if (q) { await page.keyboard.type(q); await sleep(500); }
      return tid;
    };
    const fp = watch(await ctx.newPage(), 'finder');
    for (const w of [1280, 390]) {
      await finderOn(fp, `https://www.youtube.com/watch?v=${VID}`, 'river', 'https://www.youtube.com/', w);
      await shot(fp, 'finder', 'youtube', { schemes: ['light'] });
      await finderOn(fp, 'https://x.com/alice/status/111', 'tidal', 'https://x.com/', w);
      await shot(fp, 'finder', 'x', { schemes: ['light'] });
      await finderOn(fp, LOCAL + '/dark', '', LOCAL + '/dark', w);
      await shot(fp, 'finder', 'dark-empty', { schemes: ['dark'] });
      await fp.keyboard.type('river'); await sleep(400);
      await shot(fp, 'finder', 'dark-results', { schemes: ['dark'] });
      await finderOn(fp, LOCAL + '/find', '', LOCAL + '/find', w);
      await shot(fp, 'finder', 'article', { schemes: ['light'] });
      const hitMenu = await clickShadow(fp, 'polycarp-find', 'Polycarp options for this site'); await sleep(300);
      if (!hitMenu) errors.push('finder: options button not found');
      await shot(fp, 'finder', 'menu', { schemes: ['light'] });
    }
    await fp.close();
  }
  if (on('pill')) {
    const ap = watch(await ctx.newPage(), 'pill');
    for (const w of [1280, 390]) {
      await ap.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await ap.goto('https://www.audible.com/library/titles');
      await sleep(1200);
      await shot(ap, 'pill', 'audible', { schemes: ['light'] });
    }
    await ap.close();
  }

  // ---------- Search ----------
  if (on('search')) {
    const sp = watch(await ctx.newPage(), 'search');
    for (const w of [1280, 390]) {
      await sp.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await sp.goto(X('src/pages/search.html'));
      await sleep(500);
      await shot(sp, 'search', 'home', { full: true });
      await sp.fill('#q', 'moby dick');
      await sp.press('#q', 'Enter');
      await sleep(2500);
      await shot(sp, 'search', 'results', { full: true });
      await sp.goto(X('src/pages/search.html'));
      await sleep(400);
      await sp.fill('#addUrl', 'https://shelf.example/feed.xml');
      await sp.click('#addGo');
      await sp.waitForSelector('#proposal .pname', { timeout: 8000 }).catch(() => {});
      await sp.locator('#addBlock').scrollIntoViewIfNeeded();
      await shot(sp, 'search', 'proposal');
      await sp.click('#nasBody .btn').catch(() => {});
      await sleep(300);
      await shot(sp, 'search', 'nas-dialog');
      await sp.keyboard.press('Escape');
    }
    // Connected NAS, its browse sheet, and a captured library notice.
    await sp.evaluate(() => PolycarpNAS.setConfig({ url: 'http://nas.test:5005/', user: 'donovan', password: 'x', folder: '/', remember: false }));
    await sp.evaluate(async () => {
      const k = 'import-contact';
      await chrome.storage.session.set({ [k]: { def: { id: 'audible', name: 'Your Audible library', type: 'list', url: 'https://www.audible.com/library/titles' },
        items: [{ id: 'B1', title: 'The Hobbit', by: 'J. R. R. Tolkien', kind: 'audiobook', url: 'https://www.audible.com/pd/B1', snippet: 'Narrated by Andy Serkis', files: [] }] } });
    });
    for (const w of [1280, 390]) {
      await sp.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await sp.goto(X('src/pages/search.html') + (w === 1280 ? '?import=import-contact' : ''));
      await sleep(1200);
      await shot(sp, 'search', 'connected', { full: true });
      const browse = sp.locator('#nasBody .btn', { hasText: 'Browse' });
      if (await browse.count()) { await browse.click(); await sleep(800); await shot(sp, 'search', 'browse'); await sp.keyboard.press('Escape'); }
    }
    await sp.evaluate(() => PolycarpNAS.forget());
    await sp.close();
  }

  // ---------- Reader with embedded media ----------
  if (on('reader')) {
    const rp = watch(await ctx.newPage(), 'reader');
    for (const w of [1280, 390]) {
      await rp.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await rp.goto(X('src/reader/reader.html') + '?src=' + encodeURIComponent(LOCAL + '/media'));
      await sleep(2500);
      await shot(rp, 'reader', 'media');
      await rp.evaluate(() => { const f = document.querySelector('figure, .embed, .polycarp-embed'); if (f) f.scrollIntoView({ block: 'center' }); });
      await sleep(300);
      await shot(rp, 'reader', 'embed');
      await rp.goto(X('src/reader/reader.html'));
      await sleep(800);
      await shot(rp, 'reader', 'landing');
    }
    await rp.close();
  }

  // ---------- Library ----------
  if (on('library')) {
    const lp = watch(await ctx.newPage(), 'library');
    await lp.goto(X('src/pages/library.html'));
    await lp.evaluate(async () => {
      const L = PolycarpLibrary;
      for (const [t, u, x] of [['The water cycle', 'https://example.org/water', 'Water moves between the oceans, the air and the land in a loop.'],
        ['How rivers shape valleys', 'https://www.youtube.com/watch?v=abc123DEF45', 'Rivers carve valleys over thousands of years.'],
        ['Mere Christianity, Book One', 'https://example.org/mere', 'Right and wrong as a clue to the meaning of the universe.']]) {
        try { await L.saveLink({ url: u, title: t, excerpt: x, text: x }); } catch (e) { /* skip */ }
      }
    });
    for (const w of [1280, 390]) {
      await lp.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await lp.goto(X('src/pages/library.html'));
      await sleep(900);
      await shot(lp, 'library', 'list');
    }
    await lp.close();
  }

  // ---------- Review, including the leech box ----------
  if (on('review')) {
    const rv = watch(await ctx.newPage(), 'review');
    await rv.goto(X('src/pages/review.html'));
    await rv.evaluate(async () => {
      const M = PolycarpMemory, now = Date.now();
      const mk = (f, extra) => Object.assign(M.newCard(f, now - 9 * 864e5), { due: now - 1000 }, extra || {});
      await M.addMany([
        mk({ type: 'gist', prompt: 'What keeps the water cycle going?', answer: 'The sun warms the sea and the water loops back by rivers.', source: { title: 'The water cycle', docKey: 'a' } }, { lapses: 3, tier: 2 }),
        mk({ type: 'cloze', prompt: 'Rivers carry water back to the _____.', answer: 'sea', source: { title: 'The water cycle', docKey: 'a' } }, { tier: 4 }),
        mk({ type: 'qa', prompt: 'Who wrote Mere Christianity?', answer: 'C. S. Lewis', source: { title: 'Mere Christianity', docKey: 'b' } }, { tier: 6 })
      ]);
    });
    for (const w of [1280, 390]) {
      await rv.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await rv.goto(X('src/pages/review.html'));
      await rv.waitForSelector('#go');
      await shot(rv, 'review', 'home', { full: true });
      if (w === 1280) {
        await rv.click('#go');
        await rv.waitForSelector('#card #ans');
        await shot(rv, 'review', 'card');
        await rv.fill('#ans', 'something about rain');
        await rv.press('#ans', 'Enter');
        await rv.waitForSelector('#card [data-r]', { timeout: 4000 }).catch(() => {});
        const missed = rv.locator('#card [data-r="missed"]');
        if (await missed.count()) await missed.click(); else await rv.keyboard.press('1');
        await sleep(400);
        await shot(rv, 'review', 'leech');
        const reword = rv.locator('button', { hasText: 'Reword it' });
        if (await reword.count()) { await reword.click(); await sleep(300); await shot(rv, 'review', 'reword'); }
      }
    }
    await rv.close();
  }

  // ---------- Settings and Welcome ----------
  for (const [piece, url] of [['settings', 'src/pages/settings.html'], ['welcome', 'src/pages/welcome.html']]) {
    if (!on(piece)) continue;
    const pg = watch(await ctx.newPage(), piece);
    for (const w of [1280, 390]) {
      await pg.setViewportSize({ width: w, height: w < 500 ? 844 : 900 });
      await pg.goto(X(url));
      await sleep(900);
      await shot(pg, piece, 'top');
      if (piece === 'settings') {
        await pg.evaluate(() => [...document.querySelectorAll('h2')].find((h) => /Site helpers/.test(h.textContent))?.scrollIntoView({ block: 'start' }));
        await sleep(200);
        await shot(pg, piece, 'helpers');
      }
    }
    await pg.close();
  }
} catch (e) {
  console.log('CRASH ' + (e && e.stack || e));
} finally {
  await ctx.close();
  server.close();
}

fs.writeFileSync(path.join(OUT, 'design-check.json'), JSON.stringify(report, null, 2));
// One sheet per piece.
for (const [piece, files] of Object.entries(shots)) {
  try { execFileSync('sh', [path.join(SKILL, 'contact_sheet.sh'), path.join(OUT, `sheet-${piece}.png`), ...files], { stdio: 'ignore', timeout: 120000 }); }
  catch (e) { console.log(`sheet ${piece}: could not build (${e.message.split('\n')[0]})`); }
}
const flags = Object.entries(report).filter(([, r]) => r.over > 1).map(([k, r]) => `${k}: ${r.over}px sideways`);
console.log(Object.values(shots).flat().length + ' shots in ' + OUT);
if (flags.length) console.log('Sideways scroll:\n  ' + flags.join('\n  '));
if (errors.length) console.log('Page errors:\n  ' + [...new Set(errors)].join('\n  '));
