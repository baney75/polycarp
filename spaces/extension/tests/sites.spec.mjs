// Site helpers end to end: YouTube, X and Audible pages served at their real addresses through
// Playwright routes, so Polycarp's real host rules run. Also the finder (search, jump, key guard),
// SPA navigation, an endless feed (bounded memory, no long tasks), shadow DOM, list capture
// and pause.
// Run: node tests/sites.spec.mjs   (screenshots to tests/out/)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });

import { VID, YT, XPAGE, AUDIBLE, FEED, LIST } from './fixtures/sites.mjs';

const server = http.createServer((req, res) => {
  const body = req.url.startsWith('/feed') ? FEED : req.url.startsWith('/list') ? LIST : '<p>ok</p>';
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const LOCAL = `http://127.0.0.1:${server.address().port}`;

// ---------- Browser ----------
const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-sites-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body });
await ctx.route('https://www.youtube.com/**', (r) => r.fulfill(html(YT)));
await ctx.route('https://x.com/**', (r) => r.fulfill(html(XPAGE)));
await ctx.route('https://www.audible.com/**', (r) => r.fulfill(html(AUDIBLE)));
await ctx.route('https://m.media-amazon.com/**', (r) => r.fulfill({ status: 404, body: '' }));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a closed shadow root through the DevTools protocol (pierce mode sees closed roots).
async function shadowHTML(page, tag) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (n) => {
      if (n.nodeName === tag.toUpperCase() && n.shadowRoots && n.shadowRoots.length) return n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) { const r = find(c); if (r) return r; }
      return null;
    };
    const host = find(root);
    if (!host) return null;
    let out = '';
    for (const c of host.shadowRoots[0].children || []) out += (await cdp.send('DOM.getOuterHTML', { nodeId: c.nodeId })).outerHTML;
    return out;
  } finally { await cdp.detach(); }
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); }
  return fn();
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sleep(800);
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
  const tabOf = (prefix) => sw.evaluate(async (u) => { const t = (await chrome.tabs.query({})).find((x) => (x.url || '').startsWith(u)); return t ? t.id : null; }, prefix);
  const send = (tabId, msg) => sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m, { frameId: 0 }).catch((e) => ({ error: String(e) })), [tabId, msg]);

  // ---------- YouTube ----------
  const yt = await ctx.newPage();
  const ytErrors = [];
  yt.on('pageerror', (e) => ytErrors.push(String(e)));
  await yt.goto(`https://www.youtube.com/watch?v=${VID}`);
  const ytTab = await until(() => tabOf('https://www.youtube.com/watch'));
  const st = await until(async () => { const s = await send(ytTab, { type: 'polycarp:state' }); return s && s.active ? s : null; });
  ok(st && st.site === 'youtube', `YouTube: content script knows the site (${st && st.site})`);
  await until(() => yt.evaluate(() => !!document.querySelector('#content-text polycarp-t')));
  const yd = await yt.evaluate(() => ({
    comments: !!document.querySelector('#content-text polycarp-t'),
    transcript: !!document.querySelector('.segment-text polycarp-t'),
    chrome: document.querySelectorAll('.ytp-chrome-bottom polycarp-t, #masthead-container polycarp-t').length,
    composer: document.querySelectorAll('#contenteditable-root polycarp-t').length
  }));
  ok(yd.comments && yd.transcript, 'YouTube: comments and transcript text are readable');
  ok(yd.chrome === 0, `YouTube: player controls and the top bar are left alone (${yd.chrome})`);
  ok(yd.composer === 0, 'YouTube: the comment box is left alone');

  // Finder: open, type, results from the transcript, key guard, jump seeks the video.
  await yt.bringToFront();
  await send(ytTab, { type: 'polycarp:find' });
  await until(() => yt.evaluate(() => !!document.querySelector('polycarp-find')));
  await sleep(300);
  await yt.keyboard.type('meander');
  await sleep(500);
  let fh = await shadowHTML(yt, 'polycarp-find');
  ok(fh && /meander/i.test(fh) && /1:42/.test(fh), 'Finder on YouTube: finds the transcript line and shows its time');
  ok(fh && /Transcript/.test(fh) && /Comments/.test(fh), 'Finder on YouTube: offers Transcript and Comments groups');
  ok(fh && /Read transcript in Reader/.test(fh), 'Finder on YouTube: offers to read the transcript in the Reader');
  await yt.keyboard.press('ControlOrMeta+A');
  await yt.keyboard.type('oxbow lake');
  await sleep(500);
  ok((await yt.evaluate(() => window.kHits)) === 0, 'Finder: typing "k" does not reach the site\'s own shortcut');
  await yt.keyboard.press('ControlOrMeta+A');
  await yt.keyboard.type('meander');
  await sleep(400);
  await yt.keyboard.press('Enter');
  await sleep(300);
  const ct = await yt.evaluate(() => document.querySelector('video').currentTime);
  ok(Math.abs(ct - 102) < 1, `Finder: Enter on a transcript line seeks the video to 1:42 (${ct})`);
  await yt.screenshot({ path: path.join(OUT, 'sites-youtube-finder.png') });
  await yt.evaluate(() => document.body.focus());
  await send(ytTab, { type: 'polycarp:find' });
  await sleep(200);
  ok(!(await yt.evaluate(() => !!document.querySelector('polycarp-find'))), 'Finder: the same command closes it');

  // Reader doc for the video.
  const snap = await send(ytTab, { type: 'polycarp:snapshot' });
  ok(snap && snap.site === 'youtube' && /Watch on YouTube/.test(snap.html) && /t=102s/.test(snap.html) && /oxbow lakes/.test(snap.html),
    'YouTube: the Reader gets the transcript with time links, plus comments');

  // Exact link back to a moment.
  await yt.evaluate(() => { const s = document.querySelectorAll('.segment-text')[2]; const r = document.createRange(); r.selectNodeContents(s); getSelection().removeAllRanges(); getSelection().addRange(r); });
  const wh = await send(ytTab, { type: 'polycarp:where' });
  ok(wh && /watch\?v=abc123DEF45&t=102s/.test(wh.url), `YouTube: a saved passage links to its moment (${wh && wh.url})`);

  // SPA navigation closes an open finder.
  await send(ytTab, { type: 'polycarp:find' });
  await until(() => yt.evaluate(() => !!document.querySelector('polycarp-find')));
  await yt.evaluate(() => history.pushState({}, '', '/watch?v=zzzzzzzzzzz'));
  ok(await until(() => yt.evaluate(() => !document.querySelector('polycarp-find')), 3000), 'YouTube: moving to another video closes the finder');
  ok(ytErrors.length === 0, 'YouTube: no page errors' + (ytErrors.length ? ': ' + ytErrors.join(' | ') : ''));

  // ---------- X ----------
  const xp = await ctx.newPage();
  await xp.goto('https://x.com/alice/status/111');
  const xTab = await until(() => tabOf('https://x.com/'));
  await until(() => xp.evaluate(() => !!document.querySelector('[data-testid=tweetText] polycarp-t')));
  const xd = await xp.evaluate(() => ({
    posts: document.querySelectorAll('[data-testid=tweetText] polycarp-t').length > 0,
    nav: document.querySelectorAll('nav polycarp-t').length,
    composer: document.querySelectorAll('[data-testid^=tweetTextarea] polycarp-t').length
  }));
  ok(xd.posts, 'X: post text is readable');
  ok(xd.nav === 0 && xd.composer === 0, `X: the side menu and the reply box are left alone (${xd.nav}, ${xd.composer})`);
  await sleep(2200); // the page drops Bob's post and adds Cara's
  ok(await xp.evaluate(() => !document.querySelector('a[href="/bob/status/222"]')), 'X fixture: the reply scrolled away');
  await xp.bringToFront();
  await send(xTab, { type: 'polycarp:find' });
  await until(() => xp.evaluate(() => !!document.querySelector('polycarp-find')));
  await sleep(300);
  await xp.keyboard.type('turbines');
  await sleep(500);
  fh = await shadowHTML(xp, 'polycarp-find');
  ok(fh && /turbines/i.test(fh) && /@bob/.test(fh), 'Finder on X: still finds a post X has unloaded');
  await xp.keyboard.press('ControlOrMeta+A');
  await xp.keyboard.type('kelp');
  await sleep(500);
  fh = await shadowHTML(xp, 'polycarp-find');
  ok(fh && /kelp/i.test(fh), 'Finder on X: finds a post that loaded later');
  ok((await xp.evaluate(() => window.kHits)) === 0, 'Finder on X: typing "k" does not trigger X shortcuts');
  await xp.screenshot({ path: path.join(OUT, 'sites-x-finder.png') });
  await xp.keyboard.press('Escape');
  await sleep(200);
  ok(!(await xp.evaluate(() => !!document.querySelector('polycarp-find'))), 'Finder: Escape closes it');
  const xs = await send(xTab, { type: 'polycarp:snapshot' });
  ok(xs && /Thread by Alice/.test(xs.title || '') && /pumped seawater/.test(xs.html), `X: the Reader gets the thread (${xs && xs.title})`);
  await xp.evaluate(() => { const s = document.querySelectorAll('[data-testid=tweetText]')[1]; const r = document.createRange(); r.selectNodeContents(s); getSelection().removeAllRanges(); getSelection().addRange(r); });
  const xw = await send(xTab, { type: 'polycarp:where' });
  ok(xw && /x\.com\/alice\/status\/112$/.test(xw.url), `X: a saved passage links to its post (${xw && xw.url})`);

  // ---------- Endless feed: memory stays bounded, no long tasks from Polycarp ----------
  const fp = await ctx.newPage();
  await fp.goto(LOCAL + '/feed');
  const fTab = await until(() => tabOf(LOCAL + '/feed'));
  await until(() => fp.evaluate(() => window.feedDone), 20000);
  await sleep(1500);
  const fs1 = await send(fTab, { type: 'polycarp:state' });
  const connected = await fp.evaluate(() => document.querySelectorAll('polycarp-t').length);
  const longs = await fp.evaluate(() => window.longTasks.filter((d) => d > 120));
  console.log('  feed stats', JSON.stringify(fs1 && fs1.stats), 'connected', connected, 'long tasks >120ms', longs.length);
  ok(fs1 && fs1.stats && fs1.stats.live <= 4000, `Feed: Polycarp keeps a bounded set after 10,000 items (${fs1 && fs1.stats && fs1.stats.live} tracked, ${connected} on the page)`);
  ok(fs1 && fs1.stats && fs1.stats.queued === 0, 'Feed: nothing left in the queue once the page settles');
  ok(longs.length <= 2, `Feed: at most 2 tasks over 120 ms while 10,000 items stream in (${longs.map((d) => Math.round(d)).join(', ')})`);
  const shadow = await fp.evaluate(() => !!document.getElementById('card').shadowRoot.querySelector('polycarp-t'));
  ok(shadow, 'Shadow DOM: text inside a web component is readable');

  // ---------- Pause ----------
  await sw.evaluate(async () => { const s = await Polycarp.getSettings(); s.pausedUntil = Date.now() + 3600e3; await Polycarp.setSettings(s); });
  const paused = await until(async () => { const s = await send(fTab, { type: 'polycarp:state' }); return s && !s.active; }, 4000);
  ok(paused, 'Pause: Polycarp goes quiet on open pages');
  ok(await fp.evaluate(() => document.querySelectorAll('polycarp-t').length === 0), 'Pause: the page text is restored');
  await sw.evaluate(async () => { const s = await Polycarp.getSettings(); s.pausedUntil = 0; await Polycarp.setSettings(s); });
  ok(await until(async () => { const s = await send(fTab, { type: 'polycarp:state' }); return s && s.active; }, 4000), 'Resume: Polycarp comes back');

  // ---------- Library capture ----------
  const ap = await ctx.newPage();
  await ap.goto('https://www.audible.com/library/titles');
  const aTab = await until(() => tabOf('https://www.audible.com/'));
  const pill = await until(async () => { const h = await shadowHTML(ap, 'polycarp-ui'); return h && /Make this library searchable/.test(h) ? h : null; });
  ok(!!pill, 'Audible: the library page offers "Make this library searchable"');
  await ap.screenshot({ path: path.join(OUT, 'sites-audible-pill.png') });
  await sw.evaluate(async () => { const s = await Polycarp.getSettings(); s.helpers.audible = false; await Polycarp.setSettings(s); });
  ok(await until(async () => { const h = await shadowHTML(ap, 'polycarp-ui'); return !h || !/Make this library searchable/.test(h); }, 3000), 'Audible: turning the Audible helper off removes the offer');
  await sw.evaluate(async () => { const s = await Polycarp.getSettings(); s.helpers.audible = true; await Polycarp.setSettings(s); });
  const before = ctx.pages().length;
  const cap = await send(aTab, { type: 'polycarp:capture' });
  ok(cap && cap.ok && cap.count === 3, `Audible: capture reads every title (${JSON.stringify(cap)})`);
  const sp = await until(() => ctx.pages().find((p) => /search\.html\?import=/.test(p.url())));
  ok(!!sp && ctx.pages().length > before, 'Audible: capture opens Polycarp Search with the import');
  if (sp) {
    await sp.waitForLoadState();
    const hasSources = await sp.evaluate(() => !!globalThis.PolycarpSources);
    if (hasSources) {
      const note = await until(() => sp.evaluate(() => { const n = document.getElementById('notice'); return n && /searchable/.test(n.textContent) ? n.textContent : null; }), 8000);
      ok(!!note, `Search: the import notice says the library is searchable (${note})`);
      await sp.fill('#q', 'Hobbit');
      await sp.press('#q', 'Enter');
      const hit = await until(() => sp.evaluate(() => [...document.querySelectorAll('.rt')].some((a) => /Hobbit/.test(a.textContent))), 8000);
      ok(hit, 'Search: a title from the captured Audible library comes up');
      await sp.screenshot({ path: path.join(OUT, 'sites-search-audible.png'), fullPage: true });
    } else console.log('SKIP search import checks: sources.js not built yet');
    await sp.close();
  }

  const lp = await ctx.newPage();
  await lp.goto(LOCAL + '/list');
  const lTab = await until(() => tabOf(LOCAL + '/list'));
  await until(async () => (await send(lTab, { type: 'polycarp:state' }))?.active);
  const lc = await send(lTab, { type: 'polycarp:capture' });
  ok(lc && lc.ok && lc.count === 6, `Any list page: capture finds the 6 books, not the header links (${JSON.stringify(lc)})`);
} catch (e) {
  console.log('FAIL crashed: ' + (e && e.stack || e));
  fails++;
} finally {
  await ctx.close();
  server.close();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
