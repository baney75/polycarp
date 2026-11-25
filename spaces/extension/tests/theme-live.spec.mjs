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
import { XFEED } from './fixtures/filters.mjs';

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
  const base = op === 'page' ? { question: 'Ask', verse: null, searchURL: 'https://example.com/?q={query}', bangs: [] } : { [op]: a[op] || [] };
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
  const open = async (f, scheme, unseen) => { // unseen: the page hears of no focus and no coming into view
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
        window.__seen.surface = document.documentElement.dataset.rt + ' ' + document.documentElement.dataset.themeMode;
      }).observe(document, { childList: true, subtree: true });
      document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.__seen.parsed = getComputedStyle(document.body).backgroundColor; });
    });
    if (unseen) await p.addInitScript(() => { for (const t of ['focus', 'visibilitychange']) addEventListener(t, (e) => e.stopImmediatePropagation(), true); });
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
  app(on({ ...CELLAR, light: { ...CELLAR.light, '--pc-background': '#efe0d4' } }));
  const loads = await open('src/pages/review.html', 'light', true);
  ok(await until(async () => await bg(loads) === rgb('#efe0d4'), 3000), 'a page asks as it loads');
  await loads.close();
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
  const box = settings.getByRole('checkbox', { name: /Match Polycarp's theme/ });
  ok(await box.isChecked(), 'Settings: matching Polycarp\'s theme is on until switched off');
  const held = () => B.sw.evaluate(() => Polycarp.getSettings().then((s) => [s.matchTheme, s.profile]));
  await box.focus();
  await settings.keyboard.press('Space');
  ok(await until(async () => await bg(settings) === rgb(SHIPPED.dark['--pc-background'])), 'switched off: the shipped theme at once');
  const off = await open('src/pages/search.html', 'light');
  ok((await off.evaluate(() => window.__seen)).body === SHIPPED.light['--pc-background'], 'and from the first paint of the next page');
  await off.close();
  ok(String(await held()) === 'false,everyday' && !(await box.isChecked()), 'and the reading profile stays as it was');
  ok(await settings.evaluate(() => PolycarpBackup.make().then((b) => !('polycarp.theme' in b.data) && b.data['polycarp.settings'].matchTheme === false)), 'a backup holds the choice, not the theme');
  app(on(CELLAR));
  await box.click();
  ok(await until(async () => await bg(settings) === rgb(CELLAR.dark['--pc-background'])), 'switched on: the theme again, asked for anew');

  // ---------- The Reader's surface ----------
  const surface = async (scheme) => {
    const p = await open('src/reader/reader.html', scheme);
    const seen = (await p.evaluate(() => window.__seen)).surface;
    const now = () => p.evaluate(() => document.documentElement.dataset.rt + ' ' + document.documentElement.dataset.themeMode);
    await sleep(400);
    const got = `${seen}|${await now()}`;
    return { got, now, close: () => p.close() };
  };
  const set = (patch) => B.sw.evaluate((v) => Polycarp.patchSettings(v, { keepProfile: true }), patch);
  for (const [mode, scheme, want] of [['auto', 'light', 'paper light'], ['auto', 'dark', 'night dark'], ['dark', 'light', 'night dark'], ['light', 'dark', 'paper light']]) {
    app(on({ ...CELLAR, mode }));
    await tick();
    const r = await surface(scheme);
    ok(r.got === `${want}|${want}`, `Reader on Auto, a ${mode} theme, a ${scheme} system: ${want} from the first paint (${r.got})`);
    await r.close();
  }
  const live = await surface('light');
  app(on({ ...CELLAR, mode: 'dark' }));
  await tick();
  ok(await until(async () => await live.now() === 'night dark'), 'an open Reader on Auto follows a theme that becomes dark');
  await set({ reader: { theme: 'white' } });
  ok(await until(async () => await live.now() === 'white light'), 'a paper the person picks stays theirs under a dark theme');
  await live.close();
  const again = await surface('dark');
  ok(again.got === 'white light|white light', `and is there from the first paint of the next page (${again.got})`);
  await set({ reader: { theme: 'auto' } });
  ok(await until(async () => await again.now() === 'night dark'), 'and Auto follows the theme again');
  await again.close();

  // ---------- Panels on web pages ----------
  await B.ctx.route('https://reef.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><head><title>Reef</title></head><body style="background:#fff;color:#111"><h1 id="title">The reef</h1><p id="lede">More fish than before.</p></body></html>' }));
  await B.ctx.route('https://x.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: XFEED }));
  const note = (id, at) => ({ id, sites: ['reef.test'], changes: [{ do: 'insert', at, where: 'after', blocks: [{ kind: 'text', text: 'A note' }] }] });
  app(on(CELLAR), { edits: [note('theme-note', '#title')] });
  await B.sw.evaluate(() => chrome.storage.local.set({ 'polycarp.filters.local': [{ id: 'f1', enabled: true, sites: ['x.com'], words: ['crypto'] }] }));
  await B.sw.evaluate(() => refreshAppFilters());
  // What a panel draws with: its surface color and, for one that picks, its class.
  const panels = (prefix) => B.sw.evaluate(async (u) => {
    const [t] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => {
      const out = {};
      for (const [tag, name, sel] of [['polycarp-find', 'finder', '.panel'], ['polycarp-edits', 'editor', '.bar'], ['polycarp-edits', 'notice', '.box'], ['polycarp-note', 'note', '*'], ['polycarp-filter-bar', 'filter bar', '.bar'], ['polycarp-ui', 'toasts', '.stack']]) {
        for (const host of document.querySelectorAll(tag)) {
          const el = chrome.dom.openOrClosedShadowRoot(host).querySelector(sel === '*' ? ':not(style)' : sel);
          if (el) out[name] = getComputedStyle(el).getPropertyValue('--pc-surface').trim() + ' ' + (/pc-\w+/.exec(el.className) || [''])[0];
        }
      }
      return out;
    } });
    return r.result;
  }, prefix);
  const reef = await B.ctx.newPage();
  await reef.emulateMedia({ colorScheme: 'light' });
  await reef.goto('https://reef.test/a');
  const feed = await B.ctx.newPage();
  await feed.emulateMedia({ colorScheme: 'light' });
  await feed.goto('https://x.com/home');
  await reef.bringToFront();
  await sleep(1200);
  await B.sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'https://reef.test/*' }); await openFinder(t); await editPage(t); await chrome.tabs.sendMessage(t.id, { type: 'polycarp:events', events: [{ type: 'badge', name: 'First', desc: 'A badge' }] }, { frameId: 0 }); });
  const all = async () => ({ ...await panels('https://reef.test/*'), 'filter bar': (await panels('https://x.com/*'))['filter bar'] });
  // Each panel's mode as it is today on a white page and a light system: toasts are always dark.
  const own = { finder: ['light', 'pc-light'], editor: ['light', ''], notice: ['light', ''], note: ['light', ''], 'filter bar': ['light', 'pc-light'], toasts: ['dark', 'pc-dark'] };
  async function shows(what, theme, pin) {
    const want = Object.fromEntries(Object.entries(own).map(([k, [m, c]]) => [k, theme[pin || m]['--pc-surface'] + ' ' + (pin && c ? 'pc-' + pin : c)]));
    const same = (got) => Object.keys(want).filter((k) => got[k] !== want[k]);
    let got = {};
    await until(async () => !same(got = await all()).length);
    for (const k of Object.keys(want)) ok(got[k] === want[k], `${k}: ${what} (${got[k]})`);
  }
  await shows('the theme on a web page', CELLAR);
  const ink = () => reef.evaluate(() => getComputedStyle(document.getElementById('lede')).color);
  await set({ force: { contrast: true } });
  ok(await until(async () => await ink() === rgb(CELLAR.light['--pc-strong'])), `strong text on the page is the theme's (${await ink()})`);
  app(on({ ...CELLAR, mode: 'dark' }), { edits: [note('theme-note', '#title')] });
  await tick();
  await shows('a dark theme, live, on a light page', CELLAR, 'dark');
  app(on({ ...CELLAR, mode: 'light' }), { edits: [note('theme-note', '#title')] });
  await tick();
  await shows('a light theme', CELLAR, 'light');
  app(on({ ...CELLAR, mode: 'dark' }), { edits: [note('theme-note', '#title')] });
  await tick();
  await set({ matchTheme: false });
  await shows('switched off, the shipped theme at once', SHIPPED);
  ok(await until(async () => await ink() === rgb(SHIPPED.light['--pc-strong'])), `and the page's strong text (${await ink()})`);
  await set({ force: { contrast: false } });
  await set({ matchTheme: true });
  await shows('and back on', CELLAR, 'dark');
  await reef.close(); await feed.close();
  await B.sw.evaluate(() => chrome.storage.local.remove('polycarp.filters.local'));

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
  await settings.evaluate(() => localStorage.setItem('polycarp.theme.css', ':root { --pc-background: #123456; --pc-x: url(https://example.com/a) }'));
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
