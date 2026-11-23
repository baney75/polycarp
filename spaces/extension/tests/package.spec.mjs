// Loads the extension as Polycarp ships it (scripts/stage.sh, the same step scripts/bundle.sh runs into
// Polycarp.app/Contents/Resources/extension), not the source folder, and checks that it installs, carries the
// app's version, opens its pages and restyles a web page.
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ver = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const APP_VERSION = '0.0.0-test.1+local.package';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-pkg-')), 'extension');
execFileSync('sh', [path.join(root, 'scripts/stage.sh'), dir, APP_VERSION], { stdio: 'inherit' });
const listing = execFileSync('find', ['.', '-type', 'f'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.slice(2));
ok(listing.includes('manifest.json'), 'manifest.json sits at the root');
ok(listing.includes('LICENSE'), 'the GPL license ships');
ok(listing.includes('newtab/newtab.html') && listing.includes('src/shared/theme.css'), 'the new tab and the theme ship');
ok(!listing.some((f) => /(^|\/)(dev-|\.DS_Store)|^(tests|scripts|docs)\/|^[^/]+\.md$/.test(f)), 'no tests, scripts, docs, notes, dev pages or OS files');
const shipped = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
ok(shipped.version === ver && shipped.version_name === APP_VERSION, `version ${shipped.version}, version_name ${shipped.version_name}`);

const server = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><title>t</title><p>Reading should feel like walking downhill and nothing else.</p>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const { chromium } = await loadPlaywright();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-pkgp-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
});
const errors = [];
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const id = sw.url().split('/')[2];
  ok(!!id, 'service worker starts from the staged copy');
  const swVer = await sw.evaluate(() => chrome.runtime.getManifest().version_name);
  ok(swVer === APP_VERSION, `installed version is ${swVer}`);
  for (const p of ['src/pages/library.html', 'src/pages/review.html', 'src/pages/settings.html', 'src/reader/reader.html', 'src/popup/popup.html']) {
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(p + ': ' + e));
    await pg.goto(`chrome-extension://${id}/${p}`);
    await pg.waitForTimeout(600);
    ok(await pg.evaluate(() => document.body.innerText.trim().length > 20), `${p} renders`);
    await pg.close();
  }
  const web = await ctx.newPage();
  await web.goto(`http://127.0.0.1:${server.address().port}/`);
  await web.waitForSelector('polycarp-b', { timeout: 8000 }).catch(() => {});
  ok(await web.evaluate(() => document.querySelectorAll('polycarp-b').length > 5), 'content script restyles a web page');
  // The app's update path: the app writes a new copy with a new version_name; the running extension
  // sees it on disk and reloads into it, but not while a Polycarp page (here the Reader) is open.
  // chrome.runtime.reload is recorded, not run: headless Chromium does not bring a command-line
  // extension back after a reload, so the browser's own reload is the part this cannot show.
  await sw.evaluate(() => { globalThis.__reloads = 0; chrome.runtime.reload = () => { globalThis.__reloads++; }; });
  ok(await sw.evaluate(() => checkDisk().then(() => __reloads)) === 0, 'no reload while the copy on disk is the one running');
  const next = { ...shipped, version_name: APP_VERSION + '.next' };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(next, null, 2));
  for (const pg of ctx.pages()) if (pg.url().startsWith('chrome-extension://')) await pg.close();
  const reader = await ctx.newPage(); await reader.goto(`chrome-extension://${id}/src/reader/reader.html`);
  const nt = await ctx.newPage(); await nt.goto(`chrome-extension://${id}/newtab/newtab.html`);
  ok(await sw.evaluate(() => checkDisk().then(() => __reloads)) === 0, 'an open Reader holds the update back');
  await reader.close();
  await new Promise((r) => setTimeout(r, 1500)); // the tab-closed listener retries after 500 ms
  ok(await sw.evaluate(() => __reloads) === 1, 'reloads into the new copy once the Reader closes, with a new tab still open');
  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
} catch (e) {
  ok(false, 'threw ' + (e.stack || e));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
