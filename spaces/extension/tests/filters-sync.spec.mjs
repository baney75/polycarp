// Feed filters with the Polycarp app (src/background.js, src/pages/settings-filters.js): a fake native host in the test
// profile answers {op:"filters"} like the app does. App rules reach an open page without a reload; an error keeps the
// last rules and says why on the Settings page; a missing host means no app rules and no page error; Settings adds,
// switches and deletes local rules by keyboard, shows the app's read-only, and lists refused patterns with the reason.
// Run: node tests/filters-sync.spec.mjs
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { XFEED } from './fixtures/filters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const ID = 'kdaddaaobomjfjcgjeabgbenfddkcfcl'; // fixed by the manifest key

// ---------- The fake app: answers one native message with what answer.json holds ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-fsync-'));
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-fhost-'));
const answer = path.join(hostDir, 'answer.json');
const asked = path.join(hostDir, 'asked.log');
fs.writeFileSync(path.join(hostDir, 'host.mjs'), `import fs from 'node:fs';
const chunks = [];
process.stdin.on('data', (c) => {
  chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
  fs.appendFileSync(${JSON.stringify(asked)}, buf.subarray(4, 4 + buf.readUInt32LE(0)).toString() + '\\n');
  const out = Buffer.from(fs.readFileSync(${JSON.stringify(answer)}, 'utf8'));
  const len = Buffer.alloc(4); len.writeUInt32LE(out.length);
  process.stdout.write(Buffer.concat([len, out]), () => process.exit(0));
});`);
const wrapper = path.join(hostDir, 'host.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(hostDir, 'host.mjs'))}\n`, { mode: 0o755 });
const manifestDir = path.join(profile, 'NativeMessagingHosts');
const manifestFile = path.join(manifestDir, 'com.polycarp.newtab.json');
fs.mkdirSync(manifestDir, { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify({ name: 'com.polycarp.newtab', description: 'test', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] }));
const setAnswer = (o) => fs.writeFileSync(answer, JSON.stringify(o));
const APP_RULE = { id: 'a1', enabled: true, sites: ['x.com'], words: ['crypto'], patterns: [], accounts: [], kinds: [], hide: [] };
setAnswer({ ok: true, filters: [APP_RULE] });

const { chromium } = await loadPlaywright();
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
await ctx.route('https://x.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: XFEED }));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
  return fn();
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sleep(800);
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
  const app = () => sw.evaluate(() => chrome.storage.local.get('polycarp.filters.app').then((g) => g['polycarp.filters.app'] || null));
  const tick = () => sw.evaluate(() => refreshAppFilters()); // what the 30 second alarm does

  const alarm = await sw.evaluate(() => chrome.alarms.get('polycarp-filters'));
  ok(alarm && alarm.periodInMinutes === 0.5, `Background: the app is asked every 30 seconds (${alarm && alarm.periodInMinutes})`);
  const first = await until(async () => { const a = await app(); return a && a.rules.length ? a : null; });
  ok(first && first.connected && first.rules[0].id === 'a1' && /"op":"filters"/.test(fs.readFileSync(asked, 'utf8')), 'Background: at start the app is asked {op:"filters"} and its rules are kept');

  const xp = await ctx.newPage();
  const errors = [];
  xp.on('pageerror', (e) => errors.push(String(e)));
  await xp.goto('https://x.com/home');
  const shown = (who) => xp.evaluate((w) => { const a = [...document.querySelectorAll('article')].find((x) => x.querySelector('[data-testid=User-Name] span').textContent === w); return !a.classList.contains('polycarp-filtered'); }, who);
  ok(await until(async () => !(await shown('alice'))), 'Page: a rule from the app collapses a post');

  setAnswer({ ok: true, filters: [{ ...APP_RULE, words: ['crypto', 'gardening'] }] });
  await tick();
  ok(await until(async () => !(await shown('carol'))), 'Page: a changed app rule reaches the open page without a reload');

  // A page that starts filtering asks for a fresh answer when the last is over 5 seconds old.
  setAnswer({ ok: true, filters: [{ ...APP_RULE, words: ['crypto', 'gardening', 'river'] }] });
  await sw.evaluate(() => chrome.storage.session.set({ 'polycarp.filters.appAt': 0 }));
  const xp2 = await ctx.newPage();
  await xp2.goto('https://x.com/explore');
  ok(await until(async () => (await app()).rules[0].words.includes('river')), 'Background: a page loading with a stale copy gets the app asked again');
  await xp2.close();

  setAnswer({ ok: false, error: 'filters store is locked' });
  await tick();
  const errd = await app();
  ok(errd.error === 'filters store is locked' && errd.rules.length === 1, 'Background: an error from the app keeps its last rules and records why');
  ok(!(await shown('alice')), 'Page: the last app rules keep working through the error');

  // ---------- Settings ----------
  setAnswer({ ok: true, filters: [{ ...APP_RULE, patterns: ['(a+)+'] }] });
  await tick();
  const sp = await ctx.newPage();
  await sp.goto(`chrome-extension://${ID}/src/pages/settings.html`);
  await sp.waitForSelector('#fApp li');
  const appRow = await sp.locator('#fApp li').first().textContent();
  ok(/Words: crypto/.test(appRow) && /from Polycarp/.test(appRow), `Settings: the app's rule shows, marked as from Polycarp (${appRow.trim()})`);
  ok((await sp.locator('#fApp button, #fApp input').count()) === 0, "Settings: the app's rules are read-only");
  const refused = await until(() => sp.locator('#fRefused').textContent().then((t) => /\(a\+\)\+/.test(t) && /nests one repeat/.test(t) ? t : null));
  ok(!!refused, 'Settings: a refused pattern is listed with the reason');

  await sp.locator('#fWords').focus();
  await sp.keyboard.type('walk, morning');
  await sp.keyboard.press('Tab'); await sp.keyboard.press('Tab');
  await sp.keyboard.type('x.com');
  await sp.keyboard.press('Enter');
  ok(await until(async () => !(await shown('bob'))), 'Settings: a rule added by keyboard collapses a post on the open page');
  ok(/Words: walk, morning/.test(await sp.locator('#fLocal li').first().textContent()), 'Settings: the new rule is listed as yours');
  await sp.locator('#fLocal input[data-toggle]').first().focus();
  await sp.keyboard.press('Space');
  ok(await until(() => shown('bob')), 'Settings: switching your rule off shows the post again');
  ok(await until(() => sp.evaluate(() => !!document.activeElement && document.activeElement.matches('#fLocal input[data-toggle]'))),
    'Settings: the switch keeps keyboard focus after the list redraws');
  await sp.keyboard.press('Space');
  ok(await until(async () => !(await shown('bob'))), 'Settings: Space again switches the rule back on');
  await sp.locator('#fLocal [data-del]').first().focus();
  await sp.keyboard.press('Enter');
  ok(await until(() => sp.evaluate(() => /No filters yet/.test(document.getElementById('fLocal').textContent))), 'Settings: delete removes your rule');
  await sp.screenshot({ path: path.join(here, 'out', 'filters-settings.png'), fullPage: false, clip: await sp.locator('#filtersBox').boundingBox() });

  // ---------- No Polycarp app ----------
  fs.rmSync(manifestFile);
  await tick();
  const none = await app();
  ok(none && none.rules.length === 0 && !none.error && !none.connected, `Background: with no app there are no app rules and no error (${JSON.stringify(none)})`);
  ok(await until(() => shown('alice')), 'Page: the app rule is gone once the app is');
  ok(/With the Polycarp app/.test(await sp.locator('#fAppNote').textContent()), 'Settings: says app filters show once the app is there, not an error');
  ok(errors.length === 0, 'Page: no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  console.log('FAIL crashed: ' + (e && e.stack || e));
  fails++;
} finally {
  await ctx.close();
  fs.rmSync(hostDir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
