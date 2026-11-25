// The person's Polycarp theme on the extension's own pages (src/shared/theme-live.js, core.js, the new tab and the
// worker), in Chromium, with a fake app that answers native messages. Every page's background is read back in light and
// dark: the shipped one with no theme, the theme's with one, before anything is painted once it was seen, live while the
// page is open, pinned for a theme of one mode, and the shipped one again when the theme, the app or the permission goes.
// Run: node tests/theme-live.spec.mjs
import { loadPlaywright } from './pw.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CELLAR } from './fixtures/theme.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const ID = 'kdaddaaobomjfjcgjeabgbenfddkcfcl'; // fixed by the manifest key
const PAGES = ['newtab/newtab.html', 'src/popup/popup.html', 'src/reader/reader.html', 'src/pages/library.html', 'src/pages/search.html',
  'src/pages/settings.html', 'src/pages/welcome.html', 'src/pages/review.html'];

// ---------- The fake app ----------
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-thost-'));
const asked = path.join(hostDir, 'asked.log');
fs.writeFileSync(path.join(hostDir, 'host.mjs'), `import fs from 'node:fs';
const chunks = [];
process.stdin.on('data', (c) => {
  chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
  const op = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString()).op;
  fs.appendFileSync(${JSON.stringify(asked)}, op + '\\n');
  const a = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(hostDir, 'answer.json'))}, 'utf8'));
  if (a.dies) process.exit(1);
  const base = op === 'page' ? { question: 'Ask', verse: null, searchURL: 'https://example.com/?q={query}', bangs: [] } : { [op]: [] };
  const reply = op === 'theme' ? a.theme : op === 'page' ? { ...base, ...a.theme } : { ok: true, ...base };
  const out = Buffer.from(JSON.stringify(reply));
  const len = Buffer.alloc(4); len.writeUInt32LE(out.length);
  setTimeout(() => process.stdout.write(Buffer.concat([len, out]), () => process.exit(0)), a.wait || 0);
});`);
const wrapper = path.join(hostDir, 'host.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(hostDir, 'host.mjs'))}\n`, { mode: 0o755 });
const app = (theme, more = {}) => fs.writeFileSync(path.join(hostDir, 'answer.json'), JSON.stringify({ theme, ...more }));
let stamp = 0;
const on = (theme) => ({ ok: true, theme, stamp: String(++stamp) });
const OFF = { ok: true };
const ops = () => (fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8').split('\n').filter(Boolean) : []);

// ---------- Helpers ----------
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); }
  return fn();
}
const rgb = (h) => 'rgb(' + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
await import('../src/shared/core.js');
const css = fs.readFileSync(path.join(EXT, 'src/shared/theme.css'), 'utf8');
const SHIPPED = Object.fromEntries(['light', 'dark'].map((m) => [m, Object.fromEntries(Object.keys(CELLAR.light).map((k) => [k, globalThis.Polycarp.themeVars(css, m)[k.slice(5)]]))]));
const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
const { chromium } = await loadPlaywright();

async function launch(ext, profile) {
  const dir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'com.polycarp.newtab.json');
  const put = () => fs.writeFileSync(manifest, JSON.stringify({ name: 'com.polycarp.newtab', description: 'test', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] }));
  put();
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await until(() => ctx.pages().find((p) => p.url().includes('welcome')), 3000);
  for (const p of ctx.pages().slice(1)) await p.close();
  return { ctx, sw, id: new URL(sw.url()).host, manifest, put };
}
const profiles = [1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-tlive-')));
let B;

try {
  app(OFF);
  B = await launch(EXT, profiles[0]);
  const url = (f) => `chrome-extension://${B.id}/${f}`;
  const kept = () => B.sw.evaluate(() => chrome.storage.local.get('polycarp.theme').then((g) => g['polycarp.theme'] || null));
  const tick = () => B.sw.evaluate(() => Polycarp.askTheme()); // what the 30 second alarm does
  const open = async (f, scheme) => {
    const p = await B.ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(String(e)));
    p.on('console', (m) => { if (m.type() === 'error' && /Content Security|stylesheet/i.test(m.text())) p.errors.push(m.text()); });
    await p.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    // The theme as soon as there is a body (nothing is painted before one), and the background when the page is parsed:
    // both before DOMContentLoaded.
    await p.addInitScript(() => {
      window.__seen = {};
      new MutationObserver((_l, o) => {
        if (!document.body) return;
        o.disconnect();
        window.__seen.body = getComputedStyle(document.documentElement).getPropertyValue('--pc-background').trim();
      }).observe(document, { childList: true, subtree: true });
      document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.__seen.parsed = getComputedStyle(document.body).backgroundColor; });
    });
    await p.goto(url(f));
    return p;
  };

  // ---------- No theme: the shipped look, and which role each page's background is ----------
  const roles = {};
  for (const f of PAGES) {
    for (const mode of ['light', 'dark']) {
      const p = await open(f, mode);
      await sleep(250);
      const got = await bg(p);
      const names = Object.keys(SHIPPED[mode]).filter((k) => rgb(SHIPPED[mode][k]) === got);
      roles[f + mode] = names[0];
      ok(names.length && !(await p.$('#polycarp-theme')), `${f} ${mode}: with no theme the background is the shipped ${names[0]} (${got})`);
      await p.close();
    }
  }
  ok(roles[PAGES[0] + 'dark'] === '--pc-background' && await kept() === null, 'nothing is kept while there is no theme');

  // ---------- A theme: every page, light and dark, and at first paint once it was seen ----------
  app(on(CELLAR));
  const first = await open(PAGES[0], 'dark');
  ok(await until(async () => await bg(first) === rgb(CELLAR.dark['--pc-background'])), 'the new tab\'s first answer brings the theme');
  await first.close();
  ok((await until(kept)).theme.dark['--pc-accent'] === CELLAR.dark['--pc-accent'], 'and it is kept for the worker and web pages');
  app(on(CELLAR), { wait: 3000 }); // a slow app: what shows before it answers is what was kept
  for (const f of PAGES) {
    for (const mode of ['light', 'dark']) {
      const p = await open(f, mode);
      const want = rgb(CELLAR[mode][roles[f + mode]]);
      const seen = await p.evaluate(() => window.__seen);
      const got = await bg(p);
      ok(got === want, `${f} ${mode}: the theme's ${roles[f + mode]} (${got})`);
      if (f.includes('reader') && mode === 'dark') continue;
      ok(seen.body === CELLAR[mode]['--pc-background'] && seen.parsed === want, `${f} ${mode}: from the first paint, before DOMContentLoaded (${seen.body}, ${seen.parsed})`);
      if (p.errors.length) ok(false, `${f} ${mode}: no page errors: ${p.errors[0]}`);
      await p.close();
    }
  }
  // ---------- One request for a new tab ----------
  app(on(CELLAR));
  await sleep(3200);
  fs.writeFileSync(asked, '');
  const tab = await open(PAGES[0], 'light');
  await until(() => ops().includes('page'));
  await sleep(700);
  ok(ops().filter((o) => o === 'page').length === 1 && !ops().includes('theme'), `a new tab asks the app once, for the page and theme together (${ops()})`);
  ok(!/"theme"|stamp/.test(await tab.evaluate(() => localStorage.getItem('polycarpNewTabPage'))), 'the new tab\'s own cache leaves the theme to theme-live.js');

  // ---------- Live ----------
  const settings = await open('src/pages/settings.html', 'light');
  const other = await open('src/pages/library.html', 'light');
  const changed = structuredClone(CELLAR);
  changed.light['--pc-background'] = '#f0e2d0';
  changed.shared['--pc-radius'] = '22px';
  await sleep(2100);
  app(on(changed));
  fs.writeFileSync(asked, '');
  await settings.evaluate(() => dispatchEvent(new Event('focus')));
  ok(await until(async () => await bg(settings) === rgb('#f0e2d0')), 'a page that gets focus asks, and redraws without a reload');
  ok(await until(async () => await bg(other) === rgb('#f0e2d0') && await bg(tab) === rgb('#f0e2d0')), 'and so does every other open page');
  ok(await other.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pc-radius').trim()) === '22px', 'radii too');
  await settings.evaluate(() => { for (let i = 0; i < 20; i++) dispatchEvent(new Event('focus')); });
  await sleep(500);
  ok(ops().filter((o) => o === 'theme').length === 1, `twenty focus events in a row ask once (${ops().filter((o) => o === 'theme').length})`);
  await sleep(2000);
  await settings.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  ok(await until(() => ops().filter((o) => o === 'theme').length === 2), 'a page that comes into view asks again');
  ok(await B.sw.evaluate(() => chrome.action.getBadgeBackgroundColor({}).then((c) => c.slice(0, 3).join(','))) === '122,31,53', 'the badge has the theme\'s accent');

  // ---------- A theme of one mode ----------
  for (const mode of ['dark', 'light']) {
    const against = mode === 'dark' ? 'light' : 'dark';
    app(on({ ...CELLAR, mode }));
    await tick();
    await settings.emulateMedia({ colorScheme: against, reducedMotion: 'reduce' });
    ok(await until(async () => await bg(settings) === rgb(CELLAR[mode]['--pc-background'])), `a ${mode} theme is ${mode} on a ${against} system`);
    ok(await settings.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === mode, `with ${mode} form controls`);
  }

  // ---------- Switched off and on ----------
  await B.sw.evaluate(() => Polycarp.patchSettings({ matchTheme: false }, { keepProfile: true }));
  ok(await until(async () => await bg(settings) === rgb(SHIPPED.dark['--pc-background'])), 'switched off: the shipped theme at once');
  const off = await open('src/pages/search.html', 'light');
  ok((await off.evaluate(() => window.__seen)).body === SHIPPED.light['--pc-background'], 'and from the first paint of the next page');
  await off.close();
  app(on(CELLAR));
  await B.sw.evaluate(() => Polycarp.patchSettings({ matchTheme: true }, { keepProfile: true }));
  ok(await until(async () => await bg(settings) === rgb(CELLAR.dark['--pc-background'])), 'switched on: the theme again, asked for anew');

  // ---------- What is not a theme ----------
  const bad = structuredClone(CELLAR);
  bad.shared['--pc-radius'] = '1px;}body{display:none}';
  bad.shared['--pc-font-ui'] = 'x;}body{background:url(https://example.com/a)}';
  bad.shared['--pc-evil'] = '1';
  app(on(bad));
  await tick();
  ok(await until(() => settings.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pc-radius').trim() === '10px')), 'CSS in a value leaves the shipped value');
  ok(await settings.evaluate(() => getComputedStyle(document.body).display !== 'none' && !/evil|url\(|display:none/.test(document.getElementById('polycarp-theme').textContent)), 'and none of it in the page');
  bad.dark['--pc-accent'] = 'red;}*{display:none}';
  app(on(bad));
  await tick();
  ok(await until(async () => await bg(settings) === rgb(SHIPPED.dark['--pc-background'])), 'a color that is no color: the shipped theme');
  await settings.evaluate(() => localStorage.setItem('polycarp.theme.css', ':root {}body{background:url(https://example.com/a)}'));
  const odd = await open('src/pages/review.html', 'light');
  ok((await odd.evaluate(() => window.__seen)).body === SHIPPED.light['--pc-background'], 'something else in the kept rules is not drawn');
  await odd.close();

  // ---------- The theme goes ----------
  for (const [why, gone, put] of [
    ['the theme is switched off in Polycarp', () => app(OFF), () => app(on(CELLAR))],
    ['an app from before themes', () => app({ ok: false, error: 'there is no request called theme' }), () => app(on(CELLAR))],
    ['no app', () => fs.rmSync(B.manifest), () => B.put()]
  ]) {
    app(on(CELLAR)); B.put();
    await tick();
    await until(async () => await bg(settings) === rgb(CELLAR.dark['--pc-background']));
    gone();
    await tick();
    ok(await until(async () => await bg(settings) === rgb(SHIPPED.dark['--pc-background']) && !(await settings.$('#polycarp-theme'))), `${why}: the shipped theme`);
    ok(await kept() === null && await settings.evaluate(() => localStorage.getItem('polycarp.theme.css')) === null, `${why}: nothing kept`);
    put();
  }
  app(on(CELLAR));
  await tick();
  app(null, { dies: true });
  await tick();
  ok(await bg(settings) === rgb(CELLAR.dark['--pc-background']) && await kept(), 'an app that broke off: the last theme stays');
  ok(!settings.errors.length && !tab.errors.length, 'no page errors: ' + [...settings.errors, ...tab.errors]);
  await B.ctx.close();

  // ---------- The copy that asks for the connection first ----------
  const store = path.join(hostDir, 'store');
  execFileSync('bash', [path.join(EXT, 'scripts/stage.sh'), '--store', store], { stdio: 'ignore' });
  app(on(CELLAR));
  fs.writeFileSync(asked, '');
  B = await launch(store, profiles[1]);
  const alone = await open('src/pages/settings.html', 'dark');
  await alone.evaluate(() => dispatchEvent(new Event('focus')));
  await sleep(800);
  ok(await bg(alone) === rgb(SHIPPED.dark['--pc-background']) && !ops().length, `connection not granted: the shipped theme, and nobody asked (${ops()})`);
  ok(!alone.errors.length, 'and no page errors: ' + alone.errors);
} catch (e) { fails++; console.log('FAIL ' + (e && e.stack || e)); } finally {
  if (B) await B.ctx.close().catch(() => {});
  for (const d of [hostDir, ...profiles]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
