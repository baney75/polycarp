// The line to the Polycarp app (src/shared/bridge.js) in Chromium with a throwaway profile and a fake app at the other end
// of a real native messaging port: this browser's tabs arrive, change and go; a private window's never do; the app can go to
// a tab; and the Settings page's switches hold.
// Run: node tests/bridge.spec.mjs
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'kdaddaaobomjfjcgjeabgbenfddkcfcl'; // fixed by the manifest key
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); }
  return fn();
}

// ---------- The fake app: writes down what it hears on a port that stays open, says what it is told to say ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-bridge-'));
const heardFile = path.join(dir, 'heard.log'), sayFile = path.join(dir, 'say.json');
fs.writeFileSync(heardFile, '');
fs.writeFileSync(path.join(dir, 'host.mjs'), `import fs from 'node:fs';
const say = (o) => { const b = Buffer.from(JSON.stringify(o)); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); process.stdout.write(Buffer.concat([n, b])); };
let buf = Buffer.alloc(0), said = 0;
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0), m = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    if (!String(m.op).startsWith('browser.')) { say({ ok: false, error: 'there is no request called ' + m.op }); return; }
    fs.appendFileSync(${JSON.stringify(heardFile)}, JSON.stringify(m) + '\\n');
    if (m.op === 'browser.join') setInterval(() => {
      try { const all = JSON.parse(fs.readFileSync(${JSON.stringify(sayFile)}, 'utf8')); while (said < all.length) say(all[said++]); } catch {}
    }, 50);
  }
});
process.stdin.on('end', () => process.exit(0));`);
const wrapper = path.join(dir, 'host.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'host.mjs'))}\n`, { mode: 0o755 });
const says = [{ op: 'browser.want', sources: ['tabs', 'bookmarks', 'history', 'downloads'] }];
const say = (o) => { if (o) says.push(o); fs.writeFileSync(sayFile, JSON.stringify(says)); };
const heard = () => fs.readFileSync(heardFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// The record the app would hold.
const held = (source) => {
  let rows = new Map();
  for (const m of heard().filter((x) => x.source === source)) {
    if (m.op === 'browser.rows' && m.first) rows = new Map();
    for (const r of m.rows || []) rows.set(r.id ?? r.url, r);
    for (const g of m.gone || []) rows.delete(g);
  }
  return [...rows.values()];
};

const server = http.createServer((q, a) => a.end(`<!doctype html><title>${q.url === '/knit' ? 'Knitting' : q.url === '/secret' ? 'Secretpage' : 'Other'}</title><p>hello`));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;
const profile = path.join(dir, 'profile');
fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
fs.writeFileSync(path.join(profile, 'NativeMessagingHosts', 'com.polycarp.newtab.json'),
  JSON.stringify({ name: 'com.polycarp.newtab', description: 'test', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] }));
let ctx;
try {
  say();
  const { chromium } = await loadPlaywright();
  ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const knit = await ctx.newPage();
  await knit.goto(at('/knit'));
  ok(await until(() => held('tabs').some((r) => r.title === 'Knitting')), 'an open tab reaches the app');
  const row = held('tabs').find((r) => r.title === 'Knitting');
  ok(row && row.url === at('/knit') && row.incognito === false && Number.isInteger(row.window), 'with its address, its window and that it is not private');
  ok(heard()[0].op === 'browser.join', 'the port opens with browser.join');
  ok(['bookmarks', 'history', 'downloads'].every((s) => !heard().some((m) => m.source === s && (m.rows || []).length)), 'nothing of what the browser was not asked for');

  const other = await ctx.newPage();
  await other.goto(at('/other'));
  ok(await until(() => held('tabs').find((r) => r.title === 'Other' && r.front) && held('tabs').find((r) => r.title === 'Knitting' && !r.front)), 'which tab is in front follows');
  say({ op: 'browser.go', tab: row.id });
  ok(await until(() => held('tabs').find((r) => r.title === 'Knitting' && r.front)), 'browser.go goes to the tab');
  await other.close();
  ok(await until(() => !held('tabs').some((r) => r.title === 'Other')), 'a closed tab goes');

  say({ op: 'browser.icon', url: at('/knit') });
  const icon = await until(() => heard().find((m) => m.op === 'browser.icon'));
  ok(icon && icon.url === at('/knit') && Buffer.from(icon.png, 'base64').subarray(1, 4).toString() === 'PNG', "a site's icon is a PNG");
  say({ op: 'browser.open', url: at('/opened') });
  ok(await until(() => held('tabs').some((r) => r.url === at('/opened') && r.window === row.window && r.front)), 'browser.open opens an address in the window in front');
  say({ op: 'browser.open', window: 'new', url: at('/apart') });
  ok(await until(() => held('tabs').some((r) => r.url === at('/apart') && r.window !== row.window)), 'or in a window of its own');

  // A worker asked to make a private row refuses; headless Chromium gives extensions no private windows to open.
  const secret = await sw.evaluate(() => PolycarpBridge.tabRow({ id: 9, windowId: 1, title: 'Secretpage', url: 'https://x.example/', incognito: true }));
  ok(secret === null && !heard().some((m) => JSON.stringify(m).includes('Secretpage')), 'a private tab makes no row');

  // ---------- Settings ----------
  const set = await ctx.newPage();
  await set.goto(`chrome-extension://${ID}/src/pages/settings.html`);
  await until(() => set.locator('#b-tabs').isChecked());
  ok(await set.locator('#b-tabs').isChecked() && !(await set.locator('#b-history').isChecked()), 'Settings: tabs on, history off at first');
  await set.locator('label[for="b-tabs"]').click();
  ok(await until(() => held('tabs').length === 0), 'switched off, the app is told to drop the tabs');
  const before = heard().length;
  const more = await ctx.newPage();
  await more.goto(at('/knit'));
  await sleep(700);
  ok(heard().length === before, 'and hears of no tab after that');
  await set.bringToFront();
  await set.locator('label[for="b-tabs"]').click();
  ok(await until(() => held('tabs').some((r) => r.title === 'Knitting')), 'switched on again, they are back');
  await sw.evaluate(() => chrome.storage.local.set({ 'polycarp.bridge': { tabs: true, history: true } }));
  await sleep(600);
  ok(!heard().some((m) => m.source === 'history' && m.rows.length), 'a switch without the browser\'s permission gives nothing');
} catch (e) { fails++; console.error(e); }
finally {
  if (ctx) await ctx.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
