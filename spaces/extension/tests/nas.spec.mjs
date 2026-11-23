// End-to-end checks for src/shared/nas.js and backup.js against a mock WebDAV server,
// in a real Chromium with the extension loaded (page and service worker).
// Run: node tests/nas.spec.mjs
// Prints one PASS or FAIL line per check and exits nonzero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './pw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = ROOT;

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log(`PASS  ${name}`); }
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); }
}

// ---------------------------------------------------------------------------
// Mock WebDAV server (http module only)
// ---------------------------------------------------------------------------
const USER = 'reader';
const PW = 'Pa55-w0rd-NAS-7731';
const BAD_PW = 'wrong-guess-4410';
const fsMap = new Map(); // "/dav/a/b" -> { dir, data, type, mtime }
const deletes = [];
const t0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function addDir(p) { fsMap.set(p, { dir: true, mtime: t0 }); }
function addFile(p, data, type) {
  const parts = p.split('/');
  for (let i = 2; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!fsMap.has(d)) addDir(d); }
  fsMap.set(p, { dir: false, data: Buffer.isBuffer(data) ? data : Buffer.from(String(data)), type: type || 'application/octet-stream', mtime: t0 });
}
addDir('/dav');
addFile('/dav/Books/Pride_and_Prejudice.epub', crypto.randomBytes(2000), 'application/epub+zip');
addFile('/dav/Books/Émile Zola - Germinal.epub', crypto.randomBytes(1000), 'application/epub+zip');
addFile('/dav/Books/Zebra.pdf', crypto.randomBytes(500), 'application/pdf');
addFile('/dav/Books/Pride Collection/reading-list.txt', 'books to read', 'text/plain');
addFile('/dav/Books/Series/Book.One.epub', crypto.randomBytes(100), 'application/epub+zip');
addFile('/dav/Books/@eaDir/Pride_and_Prejudice.epub@SynoEAStream', 'x');
addFile('/dav/Books/#recycle/pride-old.epub', 'x');
addFile('/dav/Books/.hidden-pride.epub', 'x');
addFile('/dav/Books/.Trashes/pride-trash.epub', 'x');
addFile('/dav/Papers/Attention_Is_All_You_Need.pdf', crypto.randomBytes(800), 'application/pdf');
addFile('/dav/Papers/Café Résumé (draft).pdf', crypto.randomBytes(300), 'application/pdf');
addFile('/dav/Papers/deep.learning.notes.txt', 'notes', 'text/plain');
addFile('/dav/Audio/The Hobbit/01 Chapter One.mp3', crypto.randomBytes(400), 'audio/mpeg');
addFile('/dav/Audio/The Hobbit/02 Chapter Two.mp3', crypto.randomBytes(400), 'audio/mpeg');
addFile('/dav/Audio/Dune.m4b', crypto.randomBytes(400), 'audio/mp4');
addFile('/dav/Movies/Nature Walk.mkv', crypto.randomBytes(100), 'video/x-matroska');
// Fifteen older Polycarp backups plus files Polycarp must never prune.
for (let d = 1; d <= 15; d++) addFile(`/dav/Polycarp/Backups/polycarp-backup-2026-10-${String(d).padStart(2, '0')}.json`, '{"app":"polycarp"}', 'application/json');
addFile('/dav/Polycarp/Backups/polycarp-backup-notes.json', 'mine', 'application/json');
addFile('/dav/Polycarp/Backups/my-backup-2026-01-01.json', 'mine', 'application/json');
addFile('/dav/Polycarp/Backups/polycarp-backup-2026-01-01.json.bak', 'mine');
addFile('/dav/Polycarp/polycarp-backup-2020-01-01.json', 'mine', 'application/json');

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function keyOf(urlPath) { return '/' + urlPath.split('/').filter(Boolean).map((s) => decodeURIComponent(s)).join('/'); }
const parentOf = (k) => k.slice(0, k.lastIndexOf('/')) || '/';
function children(k) { return [...fsMap.keys()].filter((p) => p !== k && parentOf(p) === k); }
// Synology style: d: prefix and path hrefs. Nextcloud style (Papers): default namespace,
// absolute URL hrefs, parentheses percent-encoded. Root: uppercase D: prefix.
function styleOf(k) { return k.startsWith('/dav/Papers') ? 'default' : k === '/dav' ? 'D' : 'd'; }
function hrefOf(k, e, style, port) {
  let h = k.split('/').map(encodeURIComponent).join('/') + (e.dir ? '/' : '');
  if (style === 'default') h = `http://127.0.0.1:${port}` + h.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return h;
}
function responseXml(k, e, style, port) {
  const p = style === 'default' ? '' : style + ':';
  const rt = e.dir ? `<${p}resourcetype><${p}collection/></${p}resourcetype>` : `<${p}resourcetype/>`;
  const fileProps = e.dir ? '' : `<${p}getcontentlength>${e.data.length}</${p}getcontentlength><${p}getcontenttype>${e.type}</${p}getcontenttype>`;
  const ok = `<${p}propstat><${p}prop>${rt}${fileProps}<${p}getlastmodified>${new Date(e.mtime).toUTCString()}</${p}getlastmodified></${p}prop><${p}status>HTTP/1.1 200 OK</${p}status></${p}propstat>`;
  const missing = e.dir ? `<${p}propstat><${p}prop><${p}getcontentlength/><${p}getcontenttype/></${p}prop><${p}status>HTTP/1.1 404 Not Found</${p}status></${p}propstat>` : '';
  return `<${p}response>\n  <${p}href>${xmlEsc(hrefOf(k, e, style, port))}</${p}href>${ok}${missing}</${p}response>\n`;
}

function readBody(req) { return new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); }); }

const dav = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/dav')) { res.writeHead(404); return res.end(); }
  const auth = req.headers.authorization || '';
  const ok = auth === 'Basic ' + Buffer.from(USER + ':' + PW).toString('base64');
  if (!ok) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock nas"' }); return res.end('no'); }
  const k = keyOf(u.pathname);
  const e = fsMap.get(k);
  const port = dav.address().port;
  switch (req.method) {
    case 'PROPFIND': {
      if (!e) { res.writeHead(404); return res.end(); }
      const style = styleOf(k);
      const depth = req.headers.depth === '0' ? 0 : 1;
      const list = [[k, e]].concat(depth && e.dir ? children(k).map((c) => [c, fsMap.get(c)]) : []);
      const open = style === 'default' ? '<multistatus xmlns="DAV:">' : `<${style}:multistatus xmlns:${style}="DAV:">`;
      const close = style === 'default' ? '</multistatus>' : `</${style}:multistatus>`;
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end('<?xml version="1.0" encoding="utf-8"?>\n' + open + list.map(([p, x]) => responseXml(p, x, style, port)).join('') + close);
    }
    case 'GET': {
      if (!e || e.dir) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': e.type, 'Content-Length': e.data.length });
      return res.end(e.data);
    }
    case 'PUT': {
      const par = fsMap.get(parentOf(k));
      if (!par || !par.dir) { res.writeHead(409); return res.end(); }
      if (e && req.headers['if-none-match'] === '*') { res.writeHead(412); return res.end(); }
      fsMap.set(k, { dir: false, data: body, type: req.headers['content-type'] || 'application/octet-stream', mtime: Date.now() });
      res.writeHead(e ? 204 : 201); return res.end();
    }
    case 'MKCOL': {
      if (e) { res.writeHead(405); return res.end(); }
      const par = fsMap.get(parentOf(k));
      if (!par || !par.dir) { res.writeHead(409); return res.end(); }
      addDir(k); res.writeHead(201); return res.end();
    }
    case 'DELETE': {
      deletes.push(k);
      if (!e) { res.writeHead(404); return res.end(); }
      for (const p of [...fsMap.keys()]) if (p === k || p.startsWith(k + '/')) fsMap.delete(p);
      res.writeHead(204); return res.end();
    }
    default: res.writeHead(405); return res.end();
  }
});

// A plain web server: downloads for saveUrl, and two "not WebDAV" answers.
const epubBytes = crypto.randomBytes(300 * 1024);
const pdfBytes = crypto.randomBytes(50 * 1024);
const web = http.createServer(async (req, res) => {
  await readBody(req);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/book.epub') {
    res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': epubBytes.length, 'Content-Disposition': 'attachment; filename="Pride & Prejudice.epub"' });
    return res.end(epubBytes);
  }
  if (u.pathname === '/pdf/2401.12345') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(pdfBytes); }
  if (u.pathname === '/ebooks/1342.epub3.images') { res.writeHead(302, { Location: '/cache/epub/1342/pg1342-images-3.epub' }); return res.end(); }
  if (u.pathname === '/cache/epub/1342/pg1342-images-3.epub') { res.writeHead(200, { 'Content-Type': 'application/epub+zip' }); return res.end(epubBytes); }
  if (u.pathname === '/utf8') {
    res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Disposition': "attachment; filename*=UTF-8''Les%20Mis%C3%A9rables.epub" });
    return res.end(epubBytes);
  }
  if (u.pathname === '/evil') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="../../etc/passwd"' }); return res.end('x'); }
  if (u.pathname === '/missing') { res.writeHead(404); return res.end(); }
  if (u.pathname.startsWith('/api405') && req.method === 'PROPFIND') { res.writeHead(405); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>router</title><p>Welcome to your router.</p>');
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const DAV_PORT = await listen(dav);
const WEB_PORT = await listen(web);
const DEAD_PORT = await (async () => { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; })();
const DAV = `http://127.0.0.1:${DAV_PORT}/dav`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

// ---------------------------------------------------------------------------
// Browser with the extension
// ---------------------------------------------------------------------------
const { chromium } = await loadPlaywright();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-nas-'));

// Use the real extension once its service worker loads nas.js; until the lead wires it,
// test a copy whose service worker imports the same shared files.
function extDir() {
  const bg = fs.readFileSync(path.join(EXT, 'src', 'background.js'), 'utf8');
  if (/nas\.js/.test(bg) && /backup\.js/.test(bg)) return { dir: EXT, real: true };
  const dir = path.join(tmpRoot, 'ext-copy');
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.cpSync(path.join(EXT, 'src', 'shared'), path.join(dir, 'src', 'shared'), { recursive: true });
  fs.copyFileSync(path.join(EXT, 'src', 'pages', 'dev-nas.html'), path.join(dir, 'src', 'pages', 'dev-nas.html'));
  fs.writeFileSync(path.join(dir, 'src', 'background.js'), [
    'importScripts("shared/core.js");',
    'try { importScripts("shared/memory.js"); } catch (e) {}',
    'try { importScripts("shared/library.js"); } catch (e) {}',
    'importScripts("shared/backup.js", "shared/nas.js");',
    'chrome.alarms.onAlarm.addListener((a) => { PolycarpNAS.onAlarm(a); });',
  ].join('\n'));
  const real = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Polycarp NAS test copy', version: real.version,
    background: { service_worker: 'src/background.js' },
    permissions: ['storage', 'unlimitedStorage', 'alarms'], host_permissions: ['<all_urls>'],
  }, null, 2));
  return { dir, real: false };
}

const ext = extDir();
const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${ext.dir}`, `--load-extension=${ext.dir}`],
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
if (!sw) { console.log('FAIL  extension service worker did not start'); await ctx.close(); process.exit(1); }
const ID = new URL(sw.url()).host;
console.log(`extension ${ext.real ? 'loaded from the extension folder' : 'test copy (service worker does not load nas.js yet)'} (id ${ID})`);

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`chrome-extension://${ID}/src/pages/dev-nas.html`);
await page.waitForFunction(() => globalThis.PolycarpNAS && globalThis.PolycarpBackup, null, { timeout: 10000 });
const ev = (fn, arg) => page.evaluate(fn, arg);
const errorTexts = []; // every error the API produced, to scan for the password

try {
  // ---------- connect and test ----------
  const cfg = await ev(async ({ DAV, USER, PW }) => {
    await PolycarpNAS.setConfig({ url: DAV, user: USER, password: PW, folder: '', remember: false });
    return PolycarpNAS.getConfig();
  }, { DAV, USER, PW });
  check('setConfig stores url and user, reports a password without returning it', cfg.url === DAV && cfg.user === USER && cfg.hasPassword && !JSON.stringify(cfg).includes(PW), cfg);

  const t = await ev(() => PolycarpNAS.test());
  check('test() ok on a good connection', t.ok === true && t.error === null, t);

  const store1 = await ev(async () => ({ local: JSON.stringify(await chrome.storage.local.get(null)), session: JSON.stringify(await chrome.storage.session.get(null)) }));
  check('remember off: password not in chrome.storage.local', !store1.local.includes(PW));
  check('remember off: password kept in chrome.storage.session', store1.session.includes(PW));

  const bad = await ev((pw) => PolycarpNAS.test({ password: pw }), BAD_PW);
  errorTexts.push(bad.error);
  check('test() bad password: plain words, code auth', !bad.ok && bad.code === 'auth' && /user name or password/.test(bad.error), bad);

  const dead = await ev((url) => PolycarpNAS.test({ url }), `http://127.0.0.1:${DEAD_PORT}/dav`);
  errorTexts.push(dead.error);
  check('test() unreachable port: says check address, same network, WebDAV on', !dead.ok && dead.code === 'unreachable' && /same network/.test(dead.error) && /WebDAV/.test(dead.error), dead);

  const plain = await ev((url) => PolycarpNAS.test({ url }), `${WEB}/plain`);
  errorTexts.push(plain.error);
  check('test() plain web page (200, not multistatus): not a WebDAV folder', !plain.ok && plain.code === 'notWebdav' && /not as a WebDAV folder/.test(plain.error), plain);

  const m405 = await ev((url) => PolycarpNAS.test({ url }), `${WEB}/api405`);
  errorTexts.push(m405.error);
  check('test() 405 on PROPFIND: not a WebDAV folder', !m405.ok && m405.code === 'notWebdav', m405);

  const cert = await ev((url) => PolycarpNAS.test({ url }), `https://127.0.0.1:${DAV_PORT}/dav`);
  errorTexts.push(cert.error);
  check('test() https failure on a local IP: certificate advice', !cert.ok && cert.code === 'cert' && /does not trust/.test(cert.error) && /http on your home network/.test(cert.error), cert);

  const nf = await ev(() => PolycarpNAS.test({ folder: 'No Such Folder' }));
  errorTexts.push(nf.error);
  check('test() missing folder: not found', !nf.ok && nf.code === 'notFound', nf);

  const thrown = await ev(async (pw) => {
    await PolycarpNAS.setConfig({ password: pw });
    const out = [];
    for (const f of [() => PolycarpNAS.list(''), () => PolycarpNAS.get('Books/Zebra.pdf'), () => PolycarpNAS.put('x.txt', 'x'), () => PolycarpNAS.index()]) {
      try { await f(); out.push('no error'); } catch (e) { out.push([e.message, String(e), e.stack || '', JSON.stringify(e), e.code].join(' | ')); }
    }
    return out;
  }, BAD_PW);
  errorTexts.push(...thrown);
  check('wrong password: list, get, put and index all throw auth errors', thrown.every((s) => /\| auth$/.test(s)), thrown);
  await ev((pw) => PolycarpNAS.setConfig({ password: pw }), PW);

  // ---------- list ----------
  const rootList = await ev(() => PolycarpNAS.list(''));
  const firstFile = rootList.findIndex((e) => !e.dir);
  const foldersFirst = firstFile === -1 || rootList.slice(firstFile).every((e) => !e.dir);
  check('list("") (D: prefix): folders first, sorted', foldersFirst && rootList.filter((e) => e.dir).map((e) => e.name).join(',') === 'Audio,Books,Movies,Papers,Polycarp', rootList.map((e) => e.name));

  const books = await ev(() => PolycarpNAS.list('Books'));
  const bnames = books.map((e) => e.name);
  check('list("Books") (d: prefix): folders first, then files by name',
    JSON.stringify(bnames) === JSON.stringify(['Pride Collection', 'Series', 'Émile Zola - Germinal.epub', 'Pride_and_Prejudice.epub', 'Zebra.pdf']), bnames);
  check('list hides NAS system folders and dotfiles', !bnames.some((n) => /^[@#.]/.test(n)), bnames);
  const zebra = books.find((e) => e.name === 'Zebra.pdf');
  check('list entries carry path, size, modified, type', zebra && zebra.path === 'Books/Zebra.pdf' && zebra.size === 500 && typeof zebra.modified === 'number' && zebra.type === 'application/pdf' && zebra.dir === false, zebra);

  const papers = await ev(() => PolycarpNAS.list('Papers'));
  const cafe = papers.find((e) => e.name === 'Café Résumé (draft).pdf');
  check('list("Papers") (default namespace, absolute hrefs, %28 %29): names decoded', papers.length === 3 && cafe && cafe.size === 300 && cafe.path === 'Papers/Café Résumé (draft).pdf', papers);

  // ---------- mkdir, put, get ----------
  await ev(() => PolycarpNAS.mkdir('A/B/C'));
  check('mkdir("A/B/C") creates missing parents', ['/dav/A', '/dav/A/B', '/dav/A/B/C'].every((p) => fsMap.get(p) && fsMap.get(p).dir));
  const again = await ev(() => PolycarpNAS.mkdir('A/B/C').then(() => 'ok', (e) => e.message));
  check('mkdir on an existing folder is fine', again === 'ok', again);

  const rt = await ev(async () => {
    const n = 2 * 1024 * 1024, bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(n, i + 65536)));
    const hex = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const put = await PolycarpNAS.put('Uploads/deep/er/blob.bin', new Blob([bytes]));
    let ticks = 0;
    const got = await PolycarpNAS.get('Uploads/deep/er/blob.bin', { onProgress: () => ticks++ });
    const back = new Uint8Array(await got.arrayBuffer());
    let same = back.length === n;
    for (let i = 0; same && i < n; i++) if (back[i] !== bytes[i]) same = false;
    let dup = null;
    try { await PolycarpNAS.put('Uploads/deep/er/blob.bin', 'replace me'); } catch (e) { dup = e.code; }
    return { put, same, ticks, name: got.name, hash: await hex(bytes), dup };
  });
  const stored = fsMap.get('/dav/Uploads/deep/er/blob.bin');
  check('put then get: 2 MB binary round trip byte for byte', rt.same && rt.put.size === 2097152 && rt.put.path === 'Uploads/deep/er/blob.bin', rt);
  check('put stored the same bytes on the server', stored && crypto.createHash('sha256').update(stored.data).digest('hex') === rt.hash);
  check('get reports progress and returns a named file', rt.ticks > 1 && rt.name === 'blob.bin', rt);
  check('put never replaces an existing file by default', rt.dup === 'exists' && stored.data.length === 2097152, rt.dup);
  const ex = await ev(async () => [await PolycarpNAS.exists('Books/Zebra.pdf'), await PolycarpNAS.exists('Books/nothing.pdf'), await PolycarpNAS.exists('A/B')]);
  check('exists() true, false, folder true', JSON.stringify(ex) === '[true,false,true]', ex);

  // ---------- saveUrl and saveBlob ----------
  const saved = await ev(async (WEB) => {
    const out = [];
    let ticks = 0;
    const p = () => ticks++;
    out.push(await PolycarpNAS.saveUrl(WEB + '/book.epub', { onProgress: p }));
    out.push(await PolycarpNAS.saveUrl(WEB + '/book.epub'));
    out.push(await PolycarpNAS.saveUrl(WEB + '/book.epub'));
    out.push(await PolycarpNAS.saveUrl(WEB + '/pdf/2401.12345'));
    out.push(await PolycarpNAS.saveUrl(WEB + '/ebooks/1342.epub3.images'));
    out.push(await PolycarpNAS.saveUrl(WEB + '/utf8'));
    out.push(await PolycarpNAS.saveUrl(WEB + '/evil'));
    out.push(await PolycarpNAS.saveUrl(WEB + '/pdf/2401.12345', { folder: 'Papers/arXiv', name: 'Attention paper' }));
    out.push(await PolycarpNAS.saveBlob(new Blob(['hello'], { type: 'text/plain' }), { name: 'notes' }));
    out.push(await PolycarpNAS.saveBlob(new Blob(['hello'], { type: 'text/plain' }), { name: 'notes' }));
    let missing = null;
    try { await PolycarpNAS.saveUrl(WEB + '/missing'); } catch (e) { missing = e.message; }
    return { out, ticks, missing };
  }, WEB);
  const sp = saved.out.map((r) => r.path);
  check('saveUrl uses Content-Disposition and never overwrites: " (2)", " (3)"',
    sp[0] === 'Polycarp/Downloads/Pride & Prejudice.epub' && sp[1] === 'Polycarp/Downloads/Pride & Prejudice (2).epub' && sp[2] === 'Polycarp/Downloads/Pride & Prejudice (3).epub', sp);
  check('saveUrl stored the downloaded bytes', fsMap.get('/dav/Polycarp/Downloads/Pride & Prejudice (2).epub')?.data.equals(epubBytes) && saved.out[0].size === epubBytes.length);
  check('saveUrl adds .pdf from the content type for an arXiv style URL', sp[3] === 'Polycarp/Downloads/2401.12345.pdf', sp[3]);
  check('saveUrl follows redirects and names from the final URL', sp[4] === 'Polycarp/Downloads/pg1342-images-3.epub', sp[4]);
  check('saveUrl reads RFC 5987 filename*', sp[5] === 'Polycarp/Downloads/Les Misérables.epub', sp[5]);
  check('saveUrl strips path tricks from a hostile name', sp[6] === 'Polycarp/Downloads/etc passwd.txt' && !fsMap.has('/etc/passwd'), sp[6]);
  check('saveUrl honors folder and given name', sp[7] === 'Papers/arXiv/Attention paper.pdf', sp[7]);
  check('saveBlob names and numbers the same way', sp[8] === 'Polycarp/Downloads/notes.txt' && sp[9] === 'Polycarp/Downloads/notes (2).txt', sp.slice(8));
  check('saveUrl reports download progress', saved.ticks > 1, saved.ticks);
  errorTexts.push(saved.missing || '');
  check('saveUrl explains a failed download', /status 404/.test(saved.missing || ''), saved.missing);

  // ---------- index and search ----------
  const idx = await ev(async () => { let ticks = 0; const r = await PolycarpNAS.index({ onProgress: () => ticks++ }); return { r, ticks, files: await PolycarpNAS.cachedFiles(), info: await PolycarpNAS.indexInfo(), cfg: await PolycarpNAS.getConfig() }; });
  const paths = idx.files.map((f) => f.path);
  check('index walks the tree and caches files in IndexedDB', idx.r.files >= 20 && paths.includes('Books/Series/Book.One.epub') && paths.includes('Papers/Café Résumé (draft).pdf') && idx.ticks > 3, idx.r);
  check('index skips @eaDir, #recycle, .Trashes and dotfiles', !paths.some((p) => /(^|\/)[@#.]/.test(p)), paths.filter((p) => /(^|\/)[@#.]/.test(p)));
  check('index records lastIndexed and index info', typeof idx.cfg.lastIndexed === 'number' && idx.info && idx.info.files === idx.r.files);
  const limited = await ev(() => PolycarpNAS.index({ limit: 5 }));
  check('index honors limit and says it stopped early', limited.files === 5 && limited.truncated === true, limited);
  const shallow = await ev(async () => { await PolycarpNAS.index({ depth: 1 }); return (await PolycarpNAS.cachedFiles()).filter((f) => !f.dir).map((f) => f.path); });
  check('index honors depth', shallow.includes('Books/Zebra.pdf') && shallow.every((p) => p.split('/').length <= 2), shallow);
  await ev(() => PolycarpNAS.index());

  const s = await ev(async () => ({
    pride: await PolycarpNAS.search('pride'),
    emile: await PolycarpNAS.search('EMILE germinal'),
    cafe: await PolycarpNAS.search('cafe resume'),
    hobbit: await PolycarpNAS.search('hobbit'),
    dune: await PolycarpNAS.search('dune'),
    attention: await PolycarpNAS.search('attention need'),
    walk: await PolycarpNAS.search('nature'),
    none: await PolycarpNAS.search('zzzz nothing'),
    src: await PolycarpNAS.searchSource.search('pride', { limit: 1 }),
    meta: { id: PolycarpNAS.searchSource.id, name: PolycarpNAS.searchSource.name, kind: PolycarpNAS.searchSource.kind, blurb: PolycarpNAS.searchSource.blurb },
  }));
  const p0 = s.pride.find((r) => r.nasPath === 'Books/Pride_and_Prejudice.epub') || {};
  check('search result shape', p0.id === 'nas:Books/Pride_and_Prejudice.epub' && p0.source === 'nas' && p0.title === 'Pride and Prejudice' && p0.kind === 'book' &&
    p0.readUrl === null && p0.nasPath === 'Books/Pride_and_Prejudice.epub' && p0.snippet === '/Books' && p0.size === 2000 && Array.isArray(p0.files) &&
    p0.url === `${DAV}/Books/Pride_and_Prejudice.epub`, p0);
  const ptitles = s.pride.map((r) => r.title);
  check('search ranks name matches before path-only matches', ptitles.length === 5 && ptitles.indexOf('reading-list') === 4 && !ptitles.some((t) => /old|trash|hidden/.test(t)), ptitles);
  check('search folds accents and case', s.emile.length === 1 && s.emile[0].title === 'Émile Zola - Germinal', s.emile);
  check('search: pdf is a paper', s.cafe.length === 1 && s.cafe[0].kind === 'paper' && s.cafe[0].title === 'Café Résumé (draft)', s.cafe);
  check('search: a folder of mp3 tracks is one audiobook with its files', s.hobbit.length === 1 && s.hobbit[0].kind === 'audiobook' && s.hobbit[0].files.length === 2 && s.hobbit[0].title === 'The Hobbit', s.hobbit);
  check('search: m4b is an audiobook, mkv a video', s.dune[0]?.kind === 'audiobook' && s.walk[0]?.kind === 'video', [s.dune[0], s.walk[0]]);
  check('search: underscores turn to spaces in titles', s.attention[0]?.title === 'Attention Is All You Need', s.attention[0]);
  check('search: no match gives no results', s.none.length === 0);
  check('searchSource has id, name, kind and search()', s.meta.id === 'nas' && s.meta.name === 'Your NAS' && s.meta.kind === 'nas' && s.meta.blurb && s.src.length === 1 && s.src[0].id === s.pride[0].id, s.meta);

  // ---------- backup ----------
  const bk = await ev(async (PW) => {
    await PolycarpNAS.setConfig({ remember: true });
    const local = JSON.stringify(await chrome.storage.local.get(null));
    const session = JSON.stringify(await chrome.storage.session.get(null));
    const made = await PolycarpBackup.make();
    const r = await PolycarpNAS.backupNow();
    return { r, localHasPw: local.includes(PW), sessionHasPw: session.includes(PW), madeHasPw: JSON.stringify(made).includes(PW), made, cfg: await PolycarpNAS.getConfig(), name: PolycarpBackup.fileName(new Date()) };
  }, PW);
  check('remember on: password moves to chrome.storage.local', bk.localHasPw && !bk.sessionHasPw);
  check('PolycarpBackup.make() keeps the Settings format', bk.made.app === 'polycarp' && typeof bk.made.version === 'string' && typeof bk.made.at === 'string' &&
    bk.made.data && bk.made.data['polycarp.nas'] && bk.made.library && Array.isArray(bk.made.library.items) && Array.isArray(bk.made.library.notes), Object.keys(bk.made));
  check('backup never holds the NAS password', !bk.madeHasPw);
  const todayKey = '/dav/Polycarp/Backups/' + bk.name;
  let parsed = null;
  try { parsed = JSON.parse(fsMap.get(todayKey).data.toString('utf8')); } catch { /* checked below */ }
  check('backupNow writes a valid backup to Polycarp/Backups/polycarp-backup-YYYY-MM-DD.json', bk.r.path === 'Polycarp/Backups/' + bk.name && parsed && parsed.app === 'polycarp' && parsed.data && !JSON.stringify(parsed).includes(PW), bk.r);
  const dated = [...fsMap.keys()].filter((k) => /^\/dav\/Polycarp\/Backups\/polycarp-backup-\d{4}-\d{2}-\d{2}\.json$/.test(k)).sort();
  check('backupNow keeps only the newest 14', dated.length === 14 && dated[0].endsWith('2026-10-03.json') && dated.includes(todayKey), dated);
  check('backupNow deleted only the two oldest of its own files', JSON.stringify([...deletes].sort()) === JSON.stringify(['/dav/Polycarp/Backups/polycarp-backup-2026-10-01.json', '/dav/Polycarp/Backups/polycarp-backup-2026-10-02.json']), deletes);
  check('backupNow leaves the user\'s similar files alone', ['/dav/Polycarp/Backups/polycarp-backup-notes.json', '/dav/Polycarp/Backups/my-backup-2026-01-01.json', '/dav/Polycarp/Backups/polycarp-backup-2026-01-01.json.bak', '/dav/Polycarp/polycarp-backup-2020-01-01.json'].every((k) => fsMap.has(k)));
  check('backupNow records lastBackup', bk.cfg.lastBackup && bk.cfg.lastBackup.ok === true && bk.cfg.lastBackup.path === bk.r.path, bk.cfg.lastBackup);
  const off = await ev(async (PW) => { await PolycarpNAS.setConfig({ remember: false }); return JSON.stringify(await chrome.storage.local.get(null)).includes(PW); }, PW);
  check('remember off again: password leaves chrome.storage.local', off === false);

  // ---------- service worker ----------
  const swr = await sw.evaluate(async ({ WEB }) => {
    const out = { domParser: typeof DOMParser, xhr: typeof XMLHttpRequest, window: typeof window, loaded: !!globalThis.PolycarpNAS };
    if (!globalThis.PolycarpNAS) return out;
    out.put = await PolycarpNAS.put('SW/hello.txt', 'hello from the worker');
    out.list = (await PolycarpNAS.list('SW')).map((e) => e.name);
    out.save1 = await PolycarpNAS.saveUrl(WEB + '/book.epub', { folder: 'SW' });
    out.save2 = await PolycarpNAS.saveUrl(WEB + '/book.epub', { folder: 'SW' });
    out.list2 = (await PolycarpNAS.list('SW')).map((e) => e.name);
    out.got = await (await PolycarpNAS.get('SW/hello.txt')).text();
    out.search = (await PolycarpNAS.search('pride')).length;
    await PolycarpNAS.setAutoBackup(true);
    out.alarm = !!(await chrome.alarms.get(PolycarpNAS.ALARM));
    out.backup = await PolycarpNAS.onAlarm({ name: PolycarpNAS.ALARM });
    out.skip = await PolycarpNAS.onAlarm({ name: 'polycarp-badge' });
    await PolycarpNAS.setAutoBackup(false);
    out.alarmOff = !(await chrome.alarms.get(PolycarpNAS.ALARM));
    return out;
  }, { WEB });
  check('service worker has no DOMParser, XMLHttpRequest or window, and loads PolycarpNAS', swr.domParser === 'undefined' && swr.xhr === 'undefined' && swr.window === 'undefined' && swr.loaded, swr);
  check('service worker: put', swr.put && swr.put.path === 'SW/hello.txt' && fsMap.get('/dav/SW/hello.txt')?.data.toString() === 'hello from the worker', swr.put);
  check('service worker: list parses PROPFIND without DOMParser', JSON.stringify(swr.list) === '["hello.txt"]', swr.list);
  check('service worker: saveUrl with no overwrite naming', swr.save1?.path === 'SW/Pride & Prejudice.epub' && swr.save2?.path === 'SW/Pride & Prejudice (2).epub' && swr.list2.length === 3, [swr.save1, swr.save2, swr.list2]);
  check('service worker: get and search', swr.got === 'hello from the worker' && swr.search > 0, swr);
  check('service worker: setAutoBackup schedules the alarm, onAlarm backs up, others are ignored', swr.alarm && swr.backup && swr.backup.path && swr.skip === null && swr.alarmOff, swr);
  const dated2 = [...fsMap.keys()].filter((k) => /^\/dav\/Polycarp\/Backups\/polycarp-backup-\d{4}-\d{2}-\d{2}\.json$/.test(k));
  check('service worker backup still keeps 14 and deletes nothing new', dated2.length === 14 && deletes.length === 2, { n: dated2.length, deletes });

  // ---------- password never in errors, forget ----------
  const leaks = errorTexts.filter((t) => String(t).includes(PW) || String(t).includes(BAD_PW));
  check('no error text includes the password', leaks.length === 0 && errorTexts.length >= 10, leaks);
  check('remove() is not exposed', await ev(() => typeof PolycarpNAS.remove === 'undefined' && typeof PolycarpNAS.delete === 'undefined'));

  const gone = await ev(async () => {
    await PolycarpNAS.forget();
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return { nas: 'polycarp.nas' in local, pass: 'polycarp.nasPass' in local || 'polycarp.nasPass' in session, search: await PolycarpNAS.search('pride'), cached: (await PolycarpNAS.cachedFiles()).length, t: await PolycarpNAS.test() };
  });
  check('forget() clears config, password and index', !gone.nas && !gone.pass && gone.search.length === 0 && gone.cached === 0 && gone.t.code === 'config', gone);
  check('dev page loaded without script errors', pageErrors.length === 0, pageErrors);
} catch (e) {
  check('spec ran to the end', false, e.stack || String(e));
} finally {
  await ctx.close().catch(() => {});
  dav.close(); web.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
