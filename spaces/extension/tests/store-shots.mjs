// Chrome Web Store screenshots (1280x800) and the small promo tile (440x280), made from the real pages.
// Each screenshot is a page captured at 1120 wide, set in a frame with one headline, as the store shows them.
// The store takes five screenshots at most.
// Writes tests/out/store/*.png. Run: node tests/store-shots.mjs
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const OUT = path.join(here, 'out', 'store');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A demo article written for these shots, so no one else's text is shown.
const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How the printing press changed reading</title>
<meta name="author" content="Field Notes"><style>
body{margin:0;font:18px/1.6 Georgia,serif;color:#222;background:#fff}
header{border-bottom:1px solid #e5e5e5;padding:14px 32px;font:600 15px system-ui;color:#555;display:flex;gap:28px}
header b{color:#111;margin-right:auto}
main{max-width:680px;margin:40px auto;padding:0 20px}
h1{font-size:40px;line-height:1.15;margin:0 0 10px}
.by{font:14px system-ui;color:#777;margin-bottom:28px}
h2{font-size:24px;margin:32px 0 8px}
figure{margin:28px 0}figcaption{font:14px system-ui;color:#777;margin-top:6px}
</style></head><body><header><b>Field Notes</b><span>History</span><span>Books</span><span>About</span></header>
<main><article><h1>How the printing press changed reading</h1><p>Before movable type, a book was copied by hand, one page at a time. A single copy could take a scribe months, and most people never held one. Reading was something done aloud, in a hall or a church, for a room of listeners.</p>
<p>Around 1450 in Mainz, Johannes Gutenberg put together a press with metal type that could be set, inked, printed and set again. Pages that once took a week now took minutes.</p>
<h2>Books for many hands</h2>
<p>As printed books spread, they grew smaller and cheaper. People began to read alone and in silence, at their own pace, and to keep books of their own. Printers added page numbers, title pages and indexes so a reader could find a place again.</p>
<h2>Reading as we know it</h2>
<p>Much of what we take for granted on a page came from the print shop: even margins, chapters, a table of contents. The screen is the newest page, and the same old questions apply. Is the text easy to follow? Can you find your place? Will you remember it tomorrow?</p>
<figure><img src="/press.svg" alt="A wooden hand press with a sheet of paper on its bed" width="640" height="300" style="max-width:100%;height:auto"><figcaption>A hand press of the kind used for centuries.</figcaption></figure>
</article></main></body></html>`;
const PRESS = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300"><rect width="640" height="300" fill="#efe9da"/>
<g fill="none" stroke="#5b4630" stroke-width="10" stroke-linecap="round"><path d="M220 270V60M420 270V60M200 60h240M230 150h180"/><path d="M320 60v60M290 120h60"/></g>
<rect x="250" y="190" width="140" height="18" fill="#8a6a45"/><rect x="262" y="174" width="116" height="16" fill="#fbf8f0" stroke="#b9ab8e"/>
<path d="M180 270h280" stroke="#5b4630" stroke-width="12" stroke-linecap="round"/></svg>`;
// A demo feed for the calmer-feeds shot: made-up people and posts, two of which a filter hides.
const post = (who, name, when, text, boost) => `<article class="post">${boost ? `<div class="status__prepend">${boost} boosted</div>` : ''}
<header><a href="/@${who}"><span class="av">${name[0]}</span><b>${name}</b> <span class="h">@${who}</span></a> · <a href="/@${who}/${when}"><time>${when}h</time></a></header><p>${text}</p></article>`;
const FEED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Commons</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d1f23;background:#f3f4f6}
.top{background:#fff;border-bottom:1px solid #e3e5e8;padding:12px 32px;font-weight:700;font-size:18px}
main{max-width:600px;margin:18px auto;display:grid;gap:10px}
.post{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:12px 16px}
.post header{font-size:14px;color:#6b7280}.post header a{color:inherit;text-decoration:none}
.post b{color:#1d1f23}.av{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#dfe3ea;color:#334;font-weight:700;margin-right:6px}
.post p{margin:6px 0 0}.status__prepend{font-size:13px;color:#6b7280;margin-bottom:4px}
</style></head><body><div class="top">Commons</div><main>
${post('maria', 'Maria Lopez', 2, 'Finished The Federalist No. 10 tonight. Madison on factions still reads like this morning’s paper.')}
${post('prizebot', 'Prize Bot', 3, 'GIVEAWAY!! Follow, repost and tag three friends to win a free phone. Ends tonight!!')}
${post('jonah', 'Jonah Reed', 4, 'Our library’s book sale starts Saturday at nine. Hardcovers are a dollar, paperbacks fifty cents.')}
${post('hotdeals', 'Hot Deals', 5, 'You won’t believe what this one trick does. Click before it’s gone.', 'Sam')}
${post('ellen', 'Ellen Park', 6, 'Morning walk by the creek. The geese are back, and so is the fog.')}
</main></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/feed')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(FEED); }
  if (req.url.startsWith('/press.svg')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(PRESS); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(ARTICLE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const LOCAL = `http://127.0.0.1:${server.address().port}`;

const W = 1120, H = 610; // the part of the window the 1280x800 frame shows
const { chromium } = await loadPlaywright();
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-store-'));
let ctx = null;
const errors = [];
const watch = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e}`)); return p; };
const raw = {};
async function grab(page, name, scheme = 'light') {
  await page.emulateMedia({ colorScheme: scheme });
  await sleep(300);
  raw[name] = await page.screenshot({ type: 'png' });
}

try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium', headless: true, viewport: { width: W, height: H },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const X = (p) => `chrome-extension://${id}/${p}`;
  await sleep(800);
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
  // Every milestone counts as earned already, so no milestone toast lands in a shot.
  await sw.evaluate(() => chrome.storage.local.set({ [Polycarp.STATS_KEY]: { badges: Object.fromEntries(Polycarp.BADGES.map((b) => [b.id, '2026-01-01'])) } }));
  const tabOf = (prefix) => sw.evaluate(async (u) => { const t = (await chrome.tabs.query({})).find((x) => (x.url || '').startsWith(u)); return t ? t.id : null; }, prefix);
  const send = (tabId, msg) => sw.evaluate(([i, m]) => chrome.tabs.sendMessage(i, m, { frameId: 0 }).catch((e) => ({ error: String(e) })), [tabId, msg]);

  // 1. Readable text on the page itself.
  const art = watch(await ctx.newPage(), 'article');
  let tid = null, styled = false;
  for (let tries = 0; tries < 3 && !styled; tries++) {
    await art.goto(LOCAL + '/article');
    tid = await tabOf(LOCAL + '/article');
    for (let i = 0; i < 40 && !(await send(tid, { type: 'polycarp:state' }))?.active; i++) await sleep(250);
    styled = await art.waitForSelector('polycarp-b', { timeout: 10000 }).then(() => true, () => false);
  }
  if (!styled) errors.push('article: no readable text');
  await grab(art, 'page');

  // 2. Calmer feeds: a rule made in this browser hides two posts behind one-line bars.
  await sw.evaluate(() => chrome.storage.local.set({ 'polycarp.filters.local': [
    { id: 'local-store-shot', enabled: true, words: ['giveaway'], accounts: [], sites: [], kinds: ['reposts'] }] }));
  const feed = watch(await ctx.newPage(), 'feed');
  await feed.goto(LOCAL + '/feed');
  const hid = await feed.waitForFunction(() => [...document.querySelectorAll('article')].filter((a) => [...a.querySelectorAll('[data-polycarp-skip]')].some((h) => h.shadowRoot && /Hidden:/.test(h.shadowRoot.textContent))).length === 2, null, { timeout: 10000 }).then(() => true, () => false);
  if (!hid) errors.push('feed: the filter did not hide two posts');
  await grab(feed, 'feeds');

  // 3. The Reader.
  const rp = watch(await ctx.newPage(), 'reader');
  await rp.goto(X('src/reader/reader.html') + '?src=' + encodeURIComponent(LOCAL + '/article'));
  await sleep(2500);
  await grab(rp, 'reader');

  // 4. The library, with notes.
  const lp = watch(await ctx.newPage(), 'library');
  await lp.goto(X('src/pages/library.html'));
  await lp.evaluate(async (local) => {
    const L = PolycarpLibrary;
    const items = [
      ['How the printing press changed reading', local + '/article', 'Movable type made books cheap, and reading became something people did alone, at their own pace.'],
      ['The Federalist No. 10', 'https://www.gutenberg.org/ebooks/1404', 'Madison on factions, and why a large republic can control their effects.'],
      ['The Pilgrim’s Progress, Part One', 'https://www.gutenberg.org/ebooks/131', 'Bunyan’s allegory of a journey from the City of Destruction to the Celestial City.'],
      ['Why handwritten notes stick', 'https://www.youtube.com/watch?v=abc123DEF45', 'Writing notes in your own words helps you remember what you read.'],
      ['Reading slowly on purpose', 'https://example.org/slow-reading', 'Reading at your own pace, and coming back to what matters.']
    ];
    const saved = [];
    for (const [t, u, x] of items) { try { saved.push(await L.saveLink({ url: u, title: t, excerpt: x, text: x })); } catch (e) { /* skip */ } }
    const first = saved[0];
    if (first && first.id) {
      await L.addNote({ itemId: first.id, quote: 'People began to read alone and in silence, at their own pace.' });
      await L.addNote({ itemId: first.id, text: 'Compare with how we read on phones now. See [[Reading slowly on purpose]].' });
    }
  }, LOCAL);
  await lp.goto(X('src/pages/library.html'));
  await sleep(1200);
  await lp.getByText('How the printing press changed reading').first().click();
  await sleep(700);
  await grab(lp, 'library', 'dark');

  // 5. Listen: the dock as it opens.
  await rp.bringToFront();
  await rp.emulateMedia({ colorScheme: 'light' });
  await rp.click('#tListen').catch((e) => errors.push('reader: listen ' + e));
  await sleep(1500);
  await grab(rp, 'listen');

  // The frames.
  const frames = [
    ['1-readable', 'page', 'Text that is easier to follow', 'Polycarp sets any site in clearer type and marks the start of each word, so your eyes keep their place.', 'light'],
    ['2-reader', 'reader', 'Read any page your way', 'The Reader opens articles, PDFs and ebooks in your font, size and spacing, without the clutter.', 'light'],
    ['3-feeds', 'feeds', 'Calmer feeds', 'Hide posts by word, account or kind, each behind a one-line bar you can open. Your rules stay in your browser.', 'light'],
    ['4-library', 'library', 'A library that links your reading', 'Save pages and files, keep highlights and notes, and see what connects. It all stays on your computer.', 'dark'],
    ['5-listen', 'listen', 'Listen while you read', 'Read-aloud follows along word by word, with a voice that runs on your computer.', 'light']
  ];
  const fp = await ctx.newPage();
  await fp.setViewportSize({ width: 1280, height: 800 });
  for (const [file, shotName, head, sub, tone] of frames) {
    const img = raw[shotName].toString('base64');
    const dark = tone === 'dark';
    await fp.setContent(`<!doctype html><html><head><style>
      html,body{margin:0;width:1280px;height:800px;overflow:hidden}
      body{background:${dark ? '#23261f' : '#f4f1e6'};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;position:relative}
      h1{position:absolute;left:80px;top:44px;margin:0;font-size:38px;letter-spacing:-.02em;color:${dark ? '#f1eee4' : '#23261f'}}
      p{position:absolute;left:80px;top:96px;margin:0;width:1000px;font-size:19px;line-height:1.4;color:${dark ? '#bfc2b4' : '#5a5d50'}}
      .win{position:absolute;left:80px;top:156px;width:${W}px;border-radius:12px 12px 0 0;overflow:hidden;
        box-shadow:0 0 0 1px ${dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.10)'},0 24px 60px rgba(0,0,0,${dark ? '.45' : '.16'})}
      .bar{height:34px;background:${dark ? '#34372f' : '#e9e5d8'};display:flex;align-items:center;gap:8px;padding:0 14px}
      .bar i{width:11px;height:11px;border-radius:50%;background:${dark ? '#5a5d52' : '#c9c3b1'}}
      .win img{display:block;width:${W}px}
    </style></head><body><h1>${head}</h1><p>${sub}</p>
      <div class="win"><div class="bar"><i></i><i></i><i></i></div><img src="data:image/png;base64,${img}"></div></body></html>`);
    await sleep(150);
    await fp.screenshot({ path: path.join(OUT, `${file}.png`), clip: { x: 0, y: 0, width: 1280, height: 800 } });
  }

  // The small promo tile.
  const icon = fs.readFileSync(path.join(EXT, 'icons', fs.readdirSync(path.join(EXT, 'icons')).filter((f) => /128.*\.png$/.test(f))[0])).toString('base64');
  await fp.setViewportSize({ width: 440, height: 280 });
  await fp.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;width:440px;height:280px;overflow:hidden}
    body{background:#f4f1e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;display:flex;align-items:center;gap:22px;padding:0 36px;box-sizing:border-box}
    img{width:96px;height:96px}
    b{display:block;font-size:40px;letter-spacing:-.02em;color:#23261f}
    span{display:block;font-size:17px;line-height:1.35;color:#5a5d50;margin-top:6px}
  </style></head><body><img src="data:image/png;base64,${icon}"><div><b>Polycarp</b><span>Easier reading<br>on every page.</span></div></body></html>`);
  await sleep(150);
  await fp.screenshot({ path: path.join(OUT, 'promo-440x280.png'), clip: { x: 0, y: 0, width: 440, height: 280 } });
} finally {
  if (ctx) await ctx.close();
  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
console.log(fs.readdirSync(OUT).map((f) => path.join(OUT, f)).join('\n'));
