// End-to-end checks for src/shared/sources.js and search-index.js in a real
// Chromium with the extension loaded. Run: node tests/sources.spec.mjs
// Prints one PASS or FAIL line per check and exits nonzero on any failure.
// node tests/sources.spec.mjs --live runs each built-in source once against the real
// internet for "moby dick" and prints how many results each returned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './pw.mjs';
import { apiSite, feedSite, sitemapSite, crawlSite } from './fixtures/sources/sites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = ROOT;
const LIVE = process.argv.includes('--live');

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log(`PASS  ${name}`); }
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 800) : ''}`); }
}

// ---------------------------------------------------------------------------
// Browser with the extension (falls back to a minimal copy if the real one will not start)
// ---------------------------------------------------------------------------
const { chromium } = await loadPlaywright();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-sources-'));

async function launch(extDir) {
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
  if (!sw) { await ctx.close(); return null; }
  return { ctx, id: new URL(sw.url()).host };
}

function makeStubCopy() {
  const dir = path.join(tmpRoot, 'ext-copy');
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.cpSync(path.join(EXT, 'src', 'shared'), path.join(dir, 'src', 'shared'), { recursive: true });
  fs.copyFileSync(path.join(EXT, 'src', 'pages', 'dev-sources.html'), path.join(dir, 'src', 'pages', 'dev-sources.html'));
  fs.writeFileSync(path.join(dir, 'src', 'background.js'), 'self.addEventListener("install", () => {});\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Polycarp sources test copy', version: '0.0.1',
    background: { service_worker: 'src/background.js' }, host_permissions: ['<all_urls>'], permissions: ['storage', 'unlimitedStorage'],
  }, null, 2));
  return dir;
}

let ext = await launch(EXT);
if (ext) console.log(`extension loaded from ${EXT} (id ${ext.id})`);
else {
  console.log('the extension did not start a service worker; testing a stub copy');
  ext = await launch(makeStubCopy());
  if (!ext) { console.log('FAIL  extension service worker never started'); process.exit(1); }
}

const page = await ext.ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`chrome-extension://${ext.id}/src/pages/dev-sources.html`);
check('harness loads PolycarpSources and PolycarpSearchIndex', await page.evaluate(() =>
  typeof PolycarpSources === 'object' && typeof PolycarpSearchIndex === 'object' &&
  ['search', 'detect', 'addCustom', 'listCustom', 'updateCustom', 'removeCustom', 'refresh', 'importItems'].every((k) => typeof PolycarpSources[k] === 'function') &&
  ['put', 'clear', 'count', 'search'].every((k) => typeof PolycarpSearchIndex[k] === 'function')));

const RESULT_KEYS = ['id', 'source', 'title', 'url', 'snippet', 'by', 'year', 'kind', 'image', 'readUrl', 'files', 'duration'];
const KINDS = ['page', 'book', 'audiobook', 'video', 'paper', 'file', 'item', 'note'];
function shapeProblems(list) {
  const bad = [];
  for (const r of list) {
    const missing = RESULT_KEYS.filter((k) => !(k in r));
    if (missing.length) bad.push({ id: r.id, missing });
    for (const k of ['id', 'title', 'url', 'snippet', 'by', 'year', 'duration']) if (typeof r[k] !== 'string' || r[k] !== r[k].trim()) bad.push({ id: r.id, k, v: r[k] });
    if (r.snippet.length > 280) bad.push({ id: r.id, snippetLen: r.snippet.length });
    if (/<[a-z/][^>]*>/i.test(r.snippet) || /<[a-z/][^>]*>/i.test(r.title)) bad.push({ id: r.id, html: r.snippet.slice(0, 80) });
    if (!KINDS.includes(r.kind)) bad.push({ id: r.id, kind: r.kind });
    if (!Array.isArray(r.files) || r.files.some((f) => !f.url || !f.label || typeof f.type !== 'string')) bad.push({ id: r.id, files: r.files });
    if (r.image !== null && typeof r.image !== 'string') bad.push({ id: r.id, image: r.image });
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------
if (LIVE) {
  const out = await page.evaluate(async () => {
    const ids = PolycarpSources.BUILTIN.map((b) => b.id).filter((id) => id !== 'library');
    const rows = [];
    const t0 = performance.now();
    await PolycarpSources.search('moby dick', {
      sources: ids,
      onResults: (id, res, err) => rows.push({ id, n: res.length, err, ms: Math.round(performance.now() - t0), first: res[0] && res[0].title, sample: res[0] }),
    });
    return rows;
  });
  console.log('live search for "moby dick":');
  for (const r of out) console.log(`  ${r.id.padEnd(12)} ${String(r.n).padStart(3)} results  ${String(r.ms).padStart(6)} ms  ${r.err ? 'ERROR: ' + r.err : 'first: ' + r.first}`);
  const bad = shapeProblems(out.filter((r) => r.sample).map((r) => r.sample));
  check('live: first result of each source has the result shape', !bad.length, bad);
  check('live: no page errors', !pageErrors.length, pageErrors);
  await ext.ctx.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Local servers: one origin per site, each logging requests with timing
// ---------------------------------------------------------------------------
function serve(handler) {
  const log = [];
  let inflight = 0, maxInflight = 0;
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const entry = { path: url.pathname + url.search, start: Date.now(), end: 0 };
    log.push(entry);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    let done = false;
    const finish = () => { if (!done) { done = true; inflight--; entry.end = Date.now(); } };
    res.on('finish', finish); res.on('close', finish);
    handler(req, res, url);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    resolve({ base, log, srv, reset() { log.length = 0; maxInflight = 0; }, get maxInflight() { return maxInflight; } });
  }));
}
const api = await serve(apiSite());
const feeds = await serve(feedSite());
const smap = await serve(sitemapSite());
const site = await serve(crawlSite());

await page.evaluate((b) => {
  const E = PolycarpSources.ENDPOINTS;
  Object.assign(E, { youtube: b + '/yt/results', wikipedia: b + '/wiki', gutenberg: b + '/gut', openlibrary: b + '/ol', archive: b + '/ia', librivox: b + '/lv', arxiv: b + '/arxiv', openalex: b + '/oa' });
}, api.base);
check('ENDPOINTS has every fetched built-in', await page.evaluate(() => ['youtube', 'wikipedia', 'gutenberg', 'openlibrary', 'archive', 'librivox', 'arxiv', 'openalex'].every((k) => typeof PolycarpSources.ENDPOINTS[k] === 'string')));

const run = (q, opts) => page.evaluate(async ({ q, opts }) => {
  const calls = [];
  const t0 = performance.now();
  const map = await PolycarpSources.search(q, Object.assign({}, opts, { onResults: (id, res, err) => calls.push({ id, n: res.length, err, ms: performance.now() - t0 }) }));
  return { map, calls, ms: performance.now() - t0 };
}, { q, opts });

// ---------------------------------------------------------------------------
// Built-in source mappings against recorded fixtures
// ---------------------------------------------------------------------------
{
  const { map, calls } = await run('moby dick', { sources: ['youtube', 'wikipedia', 'gutenberg', 'openlibrary', 'archive', 'librivox', 'arxiv', 'openalex'] });
  check('builtins: onResults called once per source with no errors', calls.length === 8 && calls.every((c) => !c.err), calls);
  const all = Object.values(map).flat();
  const bad = shapeProblems(all);
  check('builtins: every result has the shared shape (trimmed, snippet <= 280, no html)', !bad.length, bad);
  check('builtins: result source field matches the source id', Object.entries(map).every(([id, list]) => list.every((r) => r.source === id)));

  const yt = map.youtube;
  check('youtube: 3 videoRenderers + 1 lockup video, playlist skipped', yt.length === 4, yt.map((r) => r.title));
  check('youtube: videoRenderer mapped', yt[0] && yt[0].title === 'Moby Dick; Or, The Whale by Herman Melville' && yt[0].url === 'https://www.youtube.com/watch?v=zg84olIrn-k' &&
    yt[0].by === 'Chill Industrialist' && yt[0].duration === '23:54:28' && /^https:\/\/i\.ytimg\.com\/vi\/zg84olIrn-k\//.test(yt[0].image) && yt[0].year === '9y ago' && yt[0].kind === 'video', yt[0]);
  const lk = yt.find((r) => r.id === 'LOCKUP12345');
  check('youtube: lockup mapped (title, channel, duration badge, published)', lk && lk.title === 'Moby Dick lecture: the whiteness of the whale' && lk.by === 'Open Yale Courses' &&
    lk.duration === '1:02:03' && lk.year === '4 years ago' && lk.url === 'https://www.youtube.com/watch?v=LOCKUP12345', lk);

  const wk = map.wikipedia;
  check('wikipedia: 10 pages mapped', wk.length === 10, wk.length);
  check('wikipedia: article url, readUrl, https thumbnail, clean snippet', wk[0].title === 'Moby-Dick' && wk[0].url === 'https://en.wikipedia.org/wiki/Moby-Dick' && wk[0].readUrl === wk[0].url &&
    /^https:\/\//.test(wk[0].image) && /1851 novel/.test(wk[0].snippet) && !/searchmatch|&#039;/.test(wk[0].snippet), wk[0]);

  const gb = map.gutenberg;
  check('gutenberg: 3 books, kind book, author flipped', gb.length === 3 && gb.every((r) => r.kind === 'book') && gb[0].by === 'Herman Melville', gb.map((r) => [r.title, r.by]));
  check('gutenberg: readUrl prefers epub3 images, files epub/text/html', gb[0].readUrl === 'https://www.gutenberg.org/ebooks/2701.epub3.images' &&
    JSON.stringify(gb[0].files.map((f) => f.label)) === '["EPUB","Plain text","HTML"]' && gb[0].url === 'https://www.gutenberg.org/ebooks/2701' && /pg2701\.cover/.test(gb[0].image), gb[0]);
  check('gutenberg: summary as snippet, subjects as fallback, html-only book reads html', /Ishmael/.test(gb[0].snippet) && /Sea stories/.test(gb[1].snippet) && gb[2].readUrl === 'https://www.gutenberg.org/ebooks/70391.html.images', gb.map((r) => r.snippet.slice(0, 40)));

  const ol = map.openlibrary;
  check('openlibrary: 6 books mapped with cover and year', ol.length === 6 && ol[0].image === 'https://covers.openlibrary.org/b/id/10544254-M.jpg' && ol[0].year === '1851' && ol[0].by === 'Herman Melville' && ol[0].url.startsWith('https://openlibrary.org/works/'), ol[0]);
  check('openlibrary: public ebook gets archive.org PDF readUrl', ol[0].readUrl === 'https://archive.org/download/bwb_W9-CNP-717/bwb_W9-CNP-717.pdf' && ol[0].files[0].type === 'application/pdf', ol[0]);
  check('openlibrary: printdisabled and no_ebook get no readUrl', ol.slice(1).every((r) => r.readUrl === null && !r.files.length), ol.map((r) => r.readUrl));

  const ia = map.archive;
  check('archive: 15 items with details url and image', ia.length === 15 && ia.every((r) => r.url.startsWith('https://archive.org/details/') && r.image.startsWith('https://archive.org/services/img/')), ia[0]);
  const kindOf = (id) => (ia.find((r) => r.id === id) || {}).kind;
  check('archive: kind from mediatype (texts book, audio audiobook, movies video, other item)', kindOf('billybuddsailoro00herm') === 'book' && kindOf('KMYC_1410_AM_20190806_060000') === 'audiobook' &&
    kindOf('WSLS_20160213_053700_Late_Night_With_Seth_Meyers') === 'video' && kindOf('s400-2022-10-08.aud.weir.flac1648') === 'item');
  check('archive: creator kept', (ia.find((r) => r.id === 'billybuddsailoro00herm') || {}).by === 'Melville, Herman, 1819-1891');

  const lv = map.librivox;
  check('librivox: 2 audiobooks with page url, author, duration', lv.length === 2 && lv[0].kind === 'audiobook' && lv[0].url === 'https://librivox.org/moby-dick-by-herman-melville' && lv[0].by === 'Herman Melville' && lv[0].duration === '24:37:50', lv[0]);
  check('librivox: files are the zip then section mp3s', lv[0].files[0].type === 'application/zip' && lv[0].files.length === 4 && lv[0].files.slice(1).every((f) => f.type === 'audio/mpeg' && /\.mp3$/.test(f.url)), lv[0].files);

  const ax = map.arxiv;
  check('arxiv: 4 papers with pdf readUrl and authors', ax.length === 4 && ax[0].kind === 'paper' && ax[0].title === "Ahab's Arithmetic; or, the mathematics of Moby-Dick" &&
    ax[0].readUrl === 'https://arxiv.org/pdf/1903.12102v1' && ax[0].url === 'https://arxiv.org/abs/1903.12102v1' && ax[0].by === 'Sarah Hart' && ax[0].year === '2019', ax[0]);

  const oa = map.openalex;
  check('openalex: 5 papers, readUrl only when pdf_url exists', oa.length === 5 && oa[0].readUrl === 'https://www.biodiversitylibrary.org/itempdf/126294' && oa[1].readUrl === null && oa[0].url === 'https://doi.org/10.5962/bhl.title.62077' && oa[0].year === '1851' && oa[0].by === 'Herman Melville', oa.slice(0, 2));
  check('openalex: abstract rebuilt from inverted index', oa[2].snippet.split(' ').length > 10, oa[2].snippet);
}

// LibriVox author fallback
{
  const { map, calls } = await run('zzz melville', { sources: ['librivox'] });
  check('librivox: title miss (404) falls back to author search', map.librivox.length === 2 && !calls[0].err, calls);
  api.reset();
  const r2 = await run('nothing at all', { sources: ['librivox'] });
  check('librivox: nothing found is an empty list, not an error', r2.map.librivox.length === 0 && !r2.calls[0].err && api.log.length === 2, { calls: r2.calls, log: api.log.map((l) => l.path) });
}

// Library
{
  await page.evaluate(async () => {
    await PolycarpLibrary.saveLink({ url: 'https://example.com/whales', title: 'Notes on whales and whaling', text: 'Sperm whales dive deep for squid. Whaling ships sailed from Nantucket.' });
  });
  const { map, calls } = await run('whales', { sources: ['library'] });
  const r = map.library[0];
  check('library: wraps PolycarpLibrary.search', map.library.length >= 1 && r.title === 'Notes on whales and whaling' && r.url === 'https://example.com/whales' && r.kind === 'page' && /Sperm whales/.test(r.snippet) && !calls[0].err, { r, calls });
  const gone = await page.evaluate(async () => {
    const keep = globalThis.PolycarpLibrary;
    delete globalThis.PolycarpLibrary;
    const calls = [];
    const map = await PolycarpSources.search('whales', { sources: ['library'], onResults: (id, res, err) => calls.push({ id, err }) });
    globalThis.PolycarpLibrary = keep;
    return { n: map.library.length, calls };
  });
  check('library: missing PolycarpLibrary is skipped without an error', gone.n === 0 && gone.calls.length === 1 && !gone.calls[0].err, gone);
}

// Timeouts, HTTP errors, bad payloads, network failure and stop
{
  await page.evaluate((b) => {
    PolycarpSources.TIMEOUT_MS = 800;
    Object.assign(PolycarpSources.ENDPOINTS, { wikipedia: b + '/slow', gutenberg: b + '/err500', openlibrary: b + '/garbage', archive: 'http://127.0.0.1:9/nothing' });
  }, api.base);
  const { map, calls, ms } = await run('moby dick', { sources: ['youtube', 'wikipedia', 'gutenberg', 'openlibrary', 'archive'] });
  const err = (id) => (calls.find((c) => c.id === id) || {}).err;
  check('errors: YouTube still answers while others fail', map.youtube.length === 4 && !err('youtube'), calls);
  check('errors: slow source times out with a plain message', err('wikipedia') === 'Wikipedia did not answer', err('wikipedia'));
  check('errors: HTTP 500 says returned an error', err('gutenberg') === 'Project Gutenberg returned an error', err('gutenberg'));
  check('errors: unreadable payload has a plain message', err('openlibrary') === 'Open Library sent results Polycarp could not read', err('openlibrary'));
  check('errors: refused connection says did not answer', err('archive') === 'Internet Archive did not answer', err('archive'));
  check('errors: failed sources resolve to empty lists', ['wikipedia', 'gutenberg', 'openlibrary', 'archive'].every((id) => Array.isArray(map[id]) && map[id].length === 0));
  check('errors: the timeout bounds the whole search (under 2 s with an 800 ms timeout)', ms < 2000, ms);
  const ytCall = calls.find((c) => c.id === 'youtube'), wkCall = calls.find((c) => c.id === 'wikipedia');
  check('errors: onResults fires as each source finishes (fast before slow)', ytCall.ms < wkCall.ms && ytCall.ms < 700, { yt: ytCall.ms, wk: wkCall.ms });

  const stop = await page.evaluate(async () => {
    PolycarpSources.TIMEOUT_MS = 12000;
    const ctl = new AbortController();
    const calls = [];
    const t0 = performance.now();
    setTimeout(() => ctl.abort(), 150);
    await PolycarpSources.search('moby dick', { sources: ['wikipedia'], signal: ctl.signal, onResults: (id, res, err) => calls.push({ id, err }) });
    return { calls, ms: performance.now() - t0 };
  });
  check('errors: AbortSignal stops a search right away', stop.calls[0] && stop.calls[0].err === 'Search stopped' && stop.ms < 1000, stop);
  await page.evaluate((b) => {
    PolycarpSources.TIMEOUT_MS = 12000;
    Object.assign(PolycarpSources.ENDPOINTS, { wikipedia: b + '/wiki', gutenberg: b + '/gut', openlibrary: b + '/ol', archive: b + '/ia' });
  }, api.base);
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------
const detect = (u) => page.evaluate(async (u) => { try { return await PolycarpSources.detect(u); } catch (e) { return { error: e.message }; } }, u);
{
  const F = feeds.base;
  const osd = await detect(F + '/osd/');
  check('detect: page with OpenSearch link is opensearch', osd.type === 'opensearch' && osd.name === 'Sea Archive' && osd.icon === F + '/img/sea.png', osd);
  check('detect: OSD prefers the RSS template, fills optional and required params', osd.template === F + '/osd/search?q={q}&count=&start=1&format=rss' && osd.format === 'feed', osd.template);
  check('detect: note is one plain sentence', osd.note === "Found this site's own search. Polycarp will ask it directly.", osd.note);
  const hs = await detect(F + '/htmlsearch/');
  check('detect: OSD with only an html template', hs.type === 'opensearch' && hs.template === F + '/tsearch?q={q}' && hs.format === 'html', hs);
  const rss = await detect(F + '/feed.rss');
  check('detect: RSS feed', rss.type === 'feed' && rss.feedUrl === F + '/feed.rss' && rss.name === 'Sea Notes' && rss.icon === F + '/img/logo.png' && rss.estimate === 3, rss);
  const atom = await detect(F + '/feed.atom');
  check('detect: Atom feed', atom.type === 'feed' && atom.feedUrl === F + '/feed.atom' && atom.name === 'Harbor Log', atom);
  const jf = await detect(F + '/feed.json');
  check('detect: JSON Feed', jf.type === 'feed' && jf.name === 'Quiet Pages' && jf.icon === F + '/img/q.png', jf);
  const blog = await detect(F + '/blog/');
  check('detect: page linking a feed via rel=alternate', blog.type === 'feed' && blog.feedUrl === F + '/feed.rss' && blog.name === 'Sea Notes blog' && blog.icon === F + '/img/fav.png', blog);
  const op = await detect(F + '/opds/');
  check('detect: OPDS catalog by content type', op.type === 'opds' && op.opdsUrl === F + '/opds/' && op.name === 'Home Library', op);
  const op2 = await detect(F + '/opds-plain.xml');
  check('detect: OPDS catalog by namespace and link profiles (plain xml type)', op2.type === 'opds', op2);
  const op3 = await detect(F + '/books/');
  check('detect: page linking an OPDS catalog wins over its RSS', op3.type === 'opds' && op3.opdsUrl === F + '/opds/', op3);
  const tq = await detect(F + '/tsearch?q={q}');
  check('detect: {q} template', tq.type === 'template' && tq.template === F + '/tsearch?q={q}' && tq.url === tq.template, tq);
  const ts = await detect(F + '/jsearch?q=%s');
  check('detect: %s template becomes {q}', ts.type === 'template' && ts.template === F + '/jsearch?q={q}', ts);
  const sm = await detect(smap.base + '/docs/');
  check('detect: site with robots.txt sitemap index is crawl with sitemapUrl and estimate', sm.type === 'crawl' && sm.sitemapUrl === smap.base + '/sitemap_index.xml' && sm.estimate === 6, sm);
  check('detect: crawl note names the estimate', /about 6 pages/.test(sm.note || ''), sm.note);
  const cr = await detect(site.base + '/docs/');
  check('detect: plain site is crawl with no sitemap', cr.type === 'crawl' && !cr.sitemapUrl && cr.estimate === null && cr.name === 'Handbook' && /up to 300 pages/.test(cr.note), cr);
  const no = await detect(site.base + '/docs/private/secret');
  check('detect: a path robots.txt disallows gets estimate 0 and a plain note', no.type === 'crawl' && no.estimate === 0 && /stay out/.test(no.note), no);
  const bad = await detect('ftp://example.com/x');
  check('detect: non-web link is a plain error', /http/.test(bad.error || ''), bad);
  const dead = await detect('http://127.0.0.1:9/');
  check('detect: unreachable link is a plain error', dead.error === 'Polycarp could not open that link.', dead);
}

// ---------------------------------------------------------------------------
// Custom sources: feed refresh + search, OPDS, live template and opensearch, list import
// ---------------------------------------------------------------------------
const P = (fn, arg) => page.evaluate(fn, arg);
{
  const F = feeds.base;
  const rssDef = await P(async (u) => PolycarpSources.addCustom(Object.assign(await PolycarpSources.detect(u), { name: 'My sea blog' })), F + '/feed.rss');
  check('addCustom: stores the proposal with id, name and on', /^c-/.test(rssDef.id) && rssDef.name === 'My sea blog' && rssDef.on === true && rssDef.type === 'feed', rssDef);
  const ref = await P(async (id) => { const prog = []; const r = await PolycarpSources.refresh(id, (d, t) => prog.push([d, t])); return { r, prog }; }, rssDef.id);
  check('refresh feed: indexes every item', ref.r.count === 3 && ref.prog.length >= 1, ref);
  const hits = await P(async (id) => PolycarpSources.search('lighthouse', { sources: [id] }), rssDef.id);
  const h = hits[rssDef.id];
  check('search feed: finds the item by its text', h.length === 1 && h[0].title === 'Lighthouse lamps' && h[0].url === F + '/blog/post-2' && h[0].by === 'Ada Keeper' && h[0].year === '2024' && /lighthouse/i.test(h[0].snippet), h);
  const ep = await P(async (id) => (await PolycarpSources.search('whale road', { sources: [id] }))[id][0], rssDef.id);
  check('search feed: enclosure becomes a file', ep && ep.files.length === 1 && ep.files[0].type === 'audio/mpeg', ep);
  const byAuthor = await P(async (id) => (await PolycarpSources.search('ada', { sources: [id] }))[id].length, rssDef.id);
  check('search feed: by field is searchable', byAuthor === 2, byAuthor);

  const atomDef = await P(async (u) => PolycarpSources.addCustom(await PolycarpSources.detect(u)), F + '/feed.atom');
  const ar = await P(async (id) => PolycarpSources.refresh(id), atomDef.id);
  check('refresh atom: follows rel=next pages', ar.count === 3, ar);
  const jsonDef = await P(async (u) => PolycarpSources.addCustom(await PolycarpSources.detect(u)), F + '/feed.json');
  const jr = await P(async (id) => { await PolycarpSources.refresh(id); return (await PolycarpSources.search('margins', { sources: [id] }))[id]; }, jsonDef.id);
  check('refresh + search JSON Feed', jr.length === 1 && jr[0].title === 'Margins and notes', jr);

  const opDef = await P(async (u) => PolycarpSources.addCustom(await PolycarpSources.detect(u)), F + '/opds/');
  feeds.reset();
  const orf = await P(async (id) => PolycarpSources.refresh(id, null, { delayMs: 50 }), opDef.id);
  check('refresh opds: walks navigation, pagination and dedupes books (6 unique)', orf.count === 6, orf);
  check('refresh opds: stays on the catalog origin', !feeds.log.some((l) => /elsewhere/.test(l.path)), feeds.log.map((l) => l.path));
  const ob = await P(async (id) => (await PolycarpSources.search('melville', { sources: [id] }))[id], opDef.id);
  check('search opds: author search finds the 3 Melville books', ob.length === 3 && ob.every((r) => r.kind === 'book' && r.by === 'Herman Melville'), ob.map((r) => r.title));
  const md = ob.find((r) => r.title === 'Moby-Dick');
  check('search opds: book has epub readUrl, files, cover and year', md && md.readUrl === F + '/get/b1.epub' && md.files.length === 2 && md.image === F + '/covers/b1.jpg' && md.year === '1851' && md.url === F + '/book/b1', md);

  const tDef = await P(async (u) => PolycarpSources.addCustom(await PolycarpSources.detect(u)), F + '/tsearch?q={q}');
  const tr = (await P(async (id) => PolycarpSources.search('whales', { sources: [id] }), tDef.id))[tDef.id];
  check('template html: keeps the 5 result links, deduped', tr.length === 5 && tr.every((r, i) => r.url === F + '/doc/' + (i + 1)), tr.map((r) => r.url));
  check('template html: titles from headings, snippets from the block', tr[0].title === 'Result number 1 about whales and ships' && /Snippet 1/.test(tr[0].snippet), tr[0]);
  check('template html: no nav, header, footer, aside, pager or other-site links', !tr.some((r) => /about-the-archive|privacy|filter|page=|other\.example/.test(r.url)));
  const jDef = await P(async (u) => PolycarpSources.addCustom({ type: 'template', template: u, name: 'JSON search' }), F + '/jsearch?q={q}');
  const jrr = (await P(async (id) => PolycarpSources.search('tides', { sources: [id] }), jDef.id))[jDef.id];
  check('template json: generic JSON array mapped', jrr.length === 2 && jrr[0].title === 'JSON hit about tides' && jrr[0].url === F + '/j/1' && jrr[0].snippet === 'Bold summary text' && jrr[1].title === 'Second JSON hit for tides', jrr);
  const oDef = await P(async (u) => PolycarpSources.addCustom(await PolycarpSources.detect(u)), F + '/osd/');
  const orr = (await P(async (id) => PolycarpSources.search('harbor', { sources: [id] }), oDef.id))[oDef.id];
  check('opensearch: live search parses the RSS answer', orr.length === 1 && orr[0].title === 'Harbor maps' && orr[0].url === F + '/blog/post-3', orr);

  // updateCustom and default source selection
  const up = await P(async (id) => PolycarpSources.updateCustom(id, { on: false, name: 'Renamed', type: 'crawl' }), oDef.id);
  check('updateCustom: patches name and on, keeps type and id', up.on === false && up.name === 'Renamed' && up.type === 'opensearch' && up.id === oDef.id, up);
  const def = await P(async () => Object.keys(await PolycarpSources.search('zzzz', {})));
  check('search: default sources are builtin defaultOn plus custom sources that are on', def.includes('library') && def.includes(rssDef.id) && !def.includes(oDef.id) && !def.includes('arxiv'), def);

  // removeCustom drops the index
  const rm = await P(async (id) => { const before = await PolycarpSearchIndex.count(id); await PolycarpSources.removeCustom(id); return { before, after: await PolycarpSearchIndex.count(id), listed: (await PolycarpSources.listCustom()).some((d) => d.id === id) }; }, rssDef.id);
  check('removeCustom: drops the source and its index', rm.before === 3 && rm.after === 0 && rm.listed === false, rm);
  const gone = await P(async (id) => { const calls = []; await PolycarpSources.search('lighthouse', { sources: [id], onResults: (i, r, e) => calls.push(e) }); return calls[0]; }, rssDef.id);
  check('removeCustom: searching a removed source reports a plain error', /not a Polycarp source/.test(gone || ''), gone);
}

// importItems
{
  const items = [
    { id: 'B001', title: 'Moby-Dick', by: 'Herman Melville', url: 'https://www.audible.com/pd/B001', image: 'https://m.media-amazon.com/x.jpg', kind: 'audiobook', duration: '24 hrs 48 mins', snippet: '  Narrated by William Hootkins.  ' },
    { id: 'B002', title: 'Billy Budd', by: 'Herman Melville', url: 'https://www.audible.com/pd/B002', kind: 'audiobook' },
    { id: 'B003', title: 'The Old Man and the Sea', by: 'Ernest Hemingway', url: 'https://www.audible.com/pd/B003', kind: 'audiobook' },
    { title: 'No id, javascript url', url: 'javascript:alert(1)', by: 'Someone' },
  ];
  const a = await P(async (items) => PolycarpSources.importItems({ key: 'audible', name: 'Audible library', url: 'https://www.audible.com/library' }, items), items);
  check('importItems: creates a list source and indexes items', a.type === 'list' && a.count === 4 && a.name === 'Audible library', { type: a.type, count: a.count });
  const s = (await P(async (id) => PolycarpSources.search('melville', { sources: [id] }), a.id))[a.id];
  check('importItems: search finds imported items in the result shape', s.length === 2 && s.every((r) => r.kind === 'audiobook' && r.source === a.id) && !shapeProblems(s).length, s);
  const md = s.find((r) => r.id === 'B001');
  check('importItems: fields kept and trimmed', md && md.duration === '24 hrs 48 mins' && md.snippet === 'Narrated by William Hootkins.' && md.image === 'https://m.media-amazon.com/x.jpg', md);
  const js = (await P(async (id) => PolycarpSources.search('someone', { sources: [id] }), a.id))[a.id];
  check('importItems: unsafe URLs are dropped', js.length === 1 && js[0].url === '', js);
  const b = await P(async (items) => PolycarpSources.importItems({ key: 'audible', name: 'Audible library' }, items.slice(2, 3)), items);
  const s2 = await P(async (id) => ({ n: await PolycarpSearchIndex.count(id), mel: (await PolycarpSources.search('melville', { sources: [id] }))[id].length, lists: (await PolycarpSources.listCustom()).filter((d) => d.type === 'list').length }), b.id);
  check('importItems: same key replaces the list and its index', b.id === a.id && s2.n === 1 && s2.mel === 0 && s2.lists === 1, { ids: [a.id, b.id], s2 });
  const rr = await P(async (id) => PolycarpSources.refresh(id), b.id);
  check('refresh list: re-indexes stored items', rr.count === 1, rr);
}

// ---------------------------------------------------------------------------
// Crawl: robots, same prefix, cap, politeness, extraction, search
// ---------------------------------------------------------------------------
{
  const def = await P(async (u) => PolycarpSources.addCustom(await PolycarpSources.detect(u)), site.base + '/docs/');
  site.reset();
  const out = await P(async (id) => { const prog = []; const t0 = performance.now(); const r = await PolycarpSources.refresh(id, (d, t) => prog.push([d, t]), { maxPages: 8 }); return { r, prog, ms: performance.now() - t0 }; }, def.id);
  const paths = site.log.map((l) => l.path);
  check('crawl: cap respected (8 pages saved)', out.r.count === 8, out.r);
  check('crawl: robots.txt read first', paths[0] === '/robots.txt', paths);
  check('crawl: disallowed path never requested, allowed override fetched', !paths.includes('/docs/private/secret') && paths.includes('/docs/private/open.html'), paths);
  check('crawl: stays under the pasted path prefix', paths.every((p) => p === '/robots.txt' || p === '/sitemap.xml' || p.startsWith('/docs/')), paths);
  check('crawl: skips non-html links by extension and tracking params', !paths.includes('/docs/manual.pdf') && !paths.some((p) => /utm_/.test(p)), paths);
  check('crawl: one request at a time', site.maxInflight === 1, site.maxInflight);
  const gaps = site.log.slice(1).map((l, i) => l.start - site.log[i].end);
  check('crawl: at least 400 ms between requests', gaps.every((g) => g >= 395), gaps);
  check('crawl: requests bounded by the cap (8 saved + noindex + robots + sitemap)', site.log.length <= 12, paths);
  check('crawl: progress reported', out.prog.length >= 8 && out.prog[out.prog.length - 1][0] === 8, out.prog.slice(-3));
  const hit = (await P(async (id) => PolycarpSources.search('lighthouse keepers', { sources: [id] }), def.id))[def.id];
  check('crawl search: finds the page', hit.length === 1 && hit[0].url === site.base + '/docs/a' && hit[0].title === 'Lighthouse keepers' && hit[0].image === site.base + '/img/lamp.jpg', hit);
  const text = await P(async ([id, u]) => {
    const all = await PolycarpSearchIndex.search([id], 'lighthouse', 5);
    return all.map((r) => r.snippet).join(' ') + ' || ' + JSON.stringify(await PolycarpSearchIndex.search([id], 'navtext', 5)) + JSON.stringify(await PolycarpSearchIndex.search([id], 'asidetext', 5)) + JSON.stringify(await PolycarpSearchIndex.search([id], 'scripttext', 5));
  }, [def.id, site.base]);
  check('crawl extraction: nav, header, aside, footer and script text left out', text.endsWith('|| [][][]') && /wicks/.test(text), text.slice(0, 300));
  const noidx = (await P(async (id) => PolycarpSources.search('hidden from search engines', { sources: [id] }), def.id))[def.id];
  check('crawl: meta robots noindex page not saved', noidx.length === 0, noidx);

  // Abort mid-crawl
  const def2 = await P(async (u) => PolycarpSources.addCustom({ type: 'crawl', url: u, name: 'Abort test' }), site.base + '/docs/');
  const ab = await P(async (id) => { const ctl = new AbortController(); setTimeout(() => ctl.abort(), 1500); const t0 = performance.now(); const r = await PolycarpSources.refresh(id, null, { signal: ctl.signal }); return { r, ms: performance.now() - t0 }; }, def2.id);
  check('crawl: abortable, keeps what it saved', ab.r.stopped === true && ab.r.count >= 1 && ab.r.count < 8 && ab.ms < 2200, ab);
  const meta = await P(async (id) => PolycarpSources.getCustom(id), def2.id);
  check('crawl: aborted refresh marks the source partial', meta.partial === true && meta.count === ab.r.count, meta);
}

// Sitemap crawl
{
  const def = await P(async (u) => PolycarpSources.addCustom(await PolycarpSources.detect(u)), smap.base + '/docs/');
  smap.reset();
  const r = await P(async (id) => PolycarpSources.refresh(id), def.id);
  const paths = smap.log.map((l) => l.path);
  check('sitemap crawl: saves the docs pages the sitemap lists under the prefix', r.count === 6, { r, paths });
  check('sitemap crawl: robots respected and other sections skipped', !paths.some((p) => /hidden|\/blog\//.test(p)), paths);
  const hit = (await P(async (id) => PolycarpSources.search('barnacles', { sources: [id] }), def.id))[def.id];
  check('sitemap crawl search', hit.length === 1 && hit[0].url === smap.base + '/docs/three', hit);
}

// ---------------------------------------------------------------------------
// Index: ranking details and speed with 20000 docs
// ---------------------------------------------------------------------------
{
  const rank = await P(async () => {
    await PolycarpSearchIndex.put('t-rank', [
      { docId: 'd1', title: 'Café society', by: 'Zoë Martin', text: 'A history of coffee houses in Paris.' },
      { docId: 'd2', title: 'Coffee', by: '', text: 'Notes about the cafe on the corner and its society of regulars.' },
      { docId: 'd3', title: 'Whale songs', by: '', text: 'Humpback whales sing long songs. The white whale is a different story.' },
      { docId: 'd4', title: 'White paint', by: '', text: 'Paint the whale white and the fence too.' },
      { docId: 'd5', title: 'Ships', by: 'Ahab', text: 'Nothing relevant here.' },
    ]);
    const s = (q) => PolycarpSearchIndex.search(['t-rank'], q, 10);
    return {
      accent: (await s('cafe')).map((r) => r.id),
      folded: (await s('ZOE')).map((r) => r.id),
      prefix: (await s('humpb')).map((r) => r.id),
      phrase: (await s('white whale')).map((r) => r.id),
      by: (await s('ahab')).map((r) => r.id),
      snippet: (await s('fence'))[0].snippet,
      titleWins: (await s('coffee')).map((r) => r.id),
    };
  });
  check('index: accent and case folding', rank.accent.includes('d1') && rank.accent.includes('d2') && rank.folded[0] === 'd1', rank);
  check('index: prefix match on the last word', rank.prefix[0] === 'd3', rank.prefix);
  check('index: phrase bonus ranks the exact phrase first', rank.phrase[0] === 'd3', rank.phrase);
  check('index: title outranks body (weight 3)', rank.titleWins[0] === 'd2', rank.titleWins);
  check('index: by field searchable', rank.by[0] === 'd5', rank.by);
  check('index: snippet comes from around the match', /fence/.test(rank.snippet), rank.snippet);

  const speed = await P(async () => {
    const N = 20000;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const syll = ['ka', 'lo', 'mi', 'ra', 'te', 'su', 'no', 'vi', 'de', 'po', 'ar', 'en', 'is', 'ul', 'or', 'ba'];
    const vocab = Array.from({ length: 6000 }, () => { let w = ''; const n = 2 + Math.floor(rnd() * 3); for (let i = 0; i < n; i++) w += syll[Math.floor(rnd() * syll.length)]; return w; });
    const zipf = () => vocab[Math.floor(Math.pow(rnd(), 2.2) * vocab.length)];
    const words = (n) => Array.from({ length: n }, zipf).join(' ');
    const docs = Array.from({ length: N }, (_, i) => ({ docId: 'd' + i, title: words(6), by: words(2), text: words(120), url: 'https://example.com/' + i }));
    docs[12345].title = 'The quiet lighthouse of Brindlemoor';
    const t0 = performance.now();
    await PolycarpSearchIndex.put('t-speed', docs);
    const tPut = performance.now() - t0;
    const t1 = performance.now();
    const first = await PolycarpSearchIndex.search(['t-speed'], 'brindlemoor lighthouse', 10);
    const tFirst = performance.now() - t1;
    const qs = ['kalo', 'mira te', 'brindle', 'suno vide', 'kaloka mi', 'ar', 'polo bate', 'quiet lighthouse', 'enis ulor', 'te'];
    const times = [];
    let maxHits = 0;
    for (let round = 0; round < 3; round++) for (const q of qs) {
      const t = performance.now();
      const r = await PolycarpSearchIndex.search(['t-speed'], q, 20);
      times.push(performance.now() - t);
      maxHits = Math.max(maxHits, r.length);
    }
    times.sort((a, b) => a - b);
    return { tPut, tFirst, firstHit: first[0] && first[0].id, median: times[Math.floor(times.length / 2)], max: times[times.length - 1], maxHits, count: await PolycarpSearchIndex.count('t-speed') };
  });
  console.log(`      index speed: put 20000 docs ${speed.tPut.toFixed(0)} ms, first search (load + build) ${speed.tFirst.toFixed(0)} ms, then median ${speed.median.toFixed(1)} ms, max ${speed.max.toFixed(1)} ms over 30 searches`);
  check('index speed: 20000 docs stored', speed.count === 20000, speed.count);
  check('index speed: first search finds the planted doc', speed.firstHit === 'd12345', speed);
  check('index speed: every search after the first load under 150 ms', speed.max < 150, speed);
  await P(async () => { await PolycarpSearchIndex.clear('t-speed'); await PolycarpSearchIndex.clear('t-rank'); });
}

check('no page errors', !pageErrors.length, pageErrors);

await ext.ctx.close();
for (const s of [api, feeds, smap, site]) s.srv.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
