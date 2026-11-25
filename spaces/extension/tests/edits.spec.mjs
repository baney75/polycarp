// Page edits in a real browser (src/content/edits.js, src/background.js): a fake native host answers {op:"edits"} like
// the Polycarp app. Every kind of change lands, holds through a page that rebuilds itself or moves without a reload, and
// is taken back whole; form fields stay as the person left them. Run: node tests/edits.spec.mjs
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const ID = 'kdaddaaobomjfjcgjeabgbenfddkcfcl'; // fixed by the manifest key

// ---------- The fake app: answers one native message with what answer.json holds for its op ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-esync-'));
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-ehost-'));
const answer = path.join(hostDir, 'answer.json');
const asked = path.join(hostDir, 'asked.log');
fs.writeFileSync(path.join(hostDir, 'host.mjs'), `import fs from 'node:fs';
const chunks = [];
process.stdin.on('data', (c) => {
  chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
  fs.appendFileSync(${JSON.stringify(asked)}, buf.subarray(4, 4 + buf.readUInt32LE(0)).toString() + '\\n');
  const { op } = JSON.parse(buf.subarray(4));
  const out = Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(answer)}, 'utf8'))[op]));
  const len = Buffer.alloc(4); len.writeUInt32LE(out.length);
  process.stdout.write(Buffer.concat([len, out]), () => process.exit(0));
});`);
const wrapper = path.join(hostDir, 'host.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(hostDir, 'host.mjs'))}\n`, { mode: 0o755 });
const manifestDir = path.join(profile, 'NativeMessagingHosts');
const manifestFile = path.join(manifestDir, 'com.polycarp.newtab.json');
fs.mkdirSync(manifestDir, { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify({ name: 'com.polycarp.newtab', description: 'test', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] }));
const OLD_APP = { ok: false, error: 'there is no request called edits' };
const setAnswer = (edits) => fs.writeFileSync(answer, JSON.stringify({ filters: { ok: true, filters: [] }, edits: Array.isArray(edits) ? { ok: true, edits } : edits }));
setAnswer(OLD_APP);

const PAGE = `<!doctype html><html lang="en"><head><title>Shop</title><style>body{font:16px sans-serif} .ad{height:40px}</style></head><body>
<nav id="nav"><a href="/">Home</a></nav>
<main id="main"><h1 id="title">Old <em>title</em></h1><p id="price">The price is 10 dollars, 10 in all.</p><img id="pic" alt="old" src="data:,">
<section class="ad">Buy now</section><aside id="aside">Side</aside>
<form id="form"><label id="label">Name <input id="name" value="mine" placeholder="Name"></label><textarea id="area">my words</textarea><div id="editor" contenteditable>my draft</div></form></main>
<section class="pay"><button>Delete everything</button></section><footer id="foot">End</footer></body></html>`;
const EDIT = {
  id: 'shop', sites: ['shop.test'], css: '#foot{letter-spacing:3px}',
  changes: [
    { do: 'hide', at: '.ad, html, body' },
    { do: 'style', at: '#price', style: { color: 'rgb(1, 2, 3)' } },
    { do: 'hide', at: ':nonsense' },
    { do: 'text', at: '#title', text: 'New title' },
    { do: 'text', at: '#price', find: '10', text: '100' },
    { do: 'attr', at: '#pic', name: 'alt', value: 'A lamp' },
    { do: 'attr', at: '#name', name: 'title', value: 'no' },
    { do: 'text', at: '#form', text: 'gone' },
    { do: 'text', at: ':is(input, textarea, style), #editor, #label', text: 'gone' },
    { do: 'move', at: '#aside', to: '#nav', where: 'after' },
    { do: 'move', at: ':is(label, section.pay)', to: '#form', where: 'last' },
    { do: 'insert', at: ':is(style)', where: 'first', blocks: [{ kind: 'text', text: 'x' }] },
    { do: 'insert', at: '#title', where: 'after', blocks: [{ kind: 'heading', text: 'Note' }, { kind: 'text', text: '<b>plain</b>' }, { kind: 'list', items: ['one', 'two'] }, { kind: 'link', text: 'More', url: 'https://example.com/' }] }
  ]
};

// A page that arrives in two pieces: the second closes what the first left open.
const slow = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.write(`<!doctype html><html><head><title>Slow</title></head><body><main id="main"><p class="last">one</p><div id="box">a box${' '.repeat(2000)}`);
  setTimeout(() => res.end('<button>Pay</button></div><p class="last">two</p></main><nav id="nav">Nav</nav></body></html>'), 1500);
});
await new Promise((r) => slow.listen(0, '127.0.0.1', r));
const SLOW = `http://localhost:${slow.address().port}/`;

const { chromium } = await loadPlaywright();
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
await ctx.route('https://*.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));

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
  const stored = () => sw.evaluate(() => chrome.storage.local.get('polycarp.edits.app').then((g) => g['polycarp.edits.app'] || null));
  const put = (o) => sw.evaluate((v) => chrome.storage.local.set(v), o);
  const tick = () => sw.evaluate(() => refreshAppFilters());
  const told = (url) => sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u }); return chrome.tabs.sendMessage(t.id, { type: 'polycarp:edits' }, { frameId: 0 }); }, url);

  const none = await until(stored);
  ok(none && none.connected && !none.error && none.edits.length === 0, `an app from before page edits means none, and no error (${JSON.stringify(none)})`);
  ok(/"op":"edits"/.test(fs.readFileSync(asked, 'utf8')), 'the app is asked {op:"edits"}');

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('https://shop.test/a');
  const own = await page.evaluate(() => document.body.innerHTML.replace(/<\/?polycarp-[^>]*>/g, ''));
  const text = (sel) => page.evaluate((s) => document.querySelector(s).textContent, sel);
  const css = (sel, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);

  setAnswer([EDIT]);
  await tick();
  ok(await until(async () => (await text('#title')) === 'New title'), 'text: an edit reaches the open page without a reload');
  ok(await page.evaluate(() => !!document.querySelector('#title em')), "text: the page's own elements stay in place");
  ok((await text('#price')) === 'The price is 100 dollars, 100 in all.', `text: find replaces each time (${await text('#price')})`);
  ok((await css('.ad', 'display')) === 'none' && (await css('body', 'display')) !== 'none', 'hide: the part is hidden, the page itself never is');
  ok((await css('#price', 'color')) === 'rgb(1, 2, 3)' && (await css('#foot', 'letterSpacing')) === '3px', 'style and css: in force');
  ok((await page.getAttribute('#pic', 'alt')) === 'A lamp', 'attr: set');
  const moved = () => page.evaluate(() => { const m = document.querySelector('#nav').nextElementSibling, a = document.querySelector('#aside'); return m.localName === 'polycarp-moved' ? `${m.textContent}|${m.querySelector('#aside') ? 'id' : ''}|${getComputedStyle(a).display}|${a.parentNode.id}` : ''; });
  ok((await moved()) === 'Side||none|main', `move: a copy is where it goes, the page's own is hidden where it was (${await moved()})`);
  const note = await page.evaluate(() => { const n = document.querySelector('polycarp-note'); return n && { prev: n.previousElementSibling.id, open: !!n.shadowRoot, w: n.getBoundingClientRect().height }; });
  ok(note && note.prev === 'title' && !note.open && note.w > 60, `insert: a closed note after the title (${JSON.stringify(note)})`);
  ok(await page.evaluate(() => document.querySelector('#name').value === 'mine' && !document.querySelector('#name').title && document.querySelector('#area').value === 'my words' && document.querySelector('#editor').textContent === 'my draft' && !!document.querySelector('#form textarea') && /sans-serif/.test(document.querySelector('style').textContent) && !document.querySelector('style *')), 'form fields, editors and stylesheets are untouched');
  ok(await page.evaluate(() => document.querySelector('#form').lastElementChild.id === 'editor' && !!document.querySelector('form > #label > #name')), 'move: a part that holds a field or a button stays where it is');
  const rep = (await told('https://shop.test/*')).edits[0].changes;
  ok(rep[0].hits > 0 && /read that selector/.test(rep[2].note) && /form field/.test(rep[7].note), `report: what matched, and why not (${JSON.stringify(rep.map((r) => r.note || r.hits))})`);
  await page.screenshot({ path: path.join(here, 'out', 'edits-page.png') });

  // ---------- The notice, the popup and Settings ----------
  ok(await until(() => page.evaluate(() => !!document.querySelector('polycarp-edits'))) && (await page.evaluate(() => !document.querySelector('polycarp-edits').shadowRoot)), 'notice: an agent edit says so, closed to the page');
  await page.screenshot({ path: path.join(here, 'out', 'edits-notice.png') });
  const press = async (key) => { // closed to scripts, so reached as a person would: by keyboard, from the page's end
    await page.evaluate(() => { document.querySelector('#editor').focus(); });
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(() => document.activeElement && document.activeElement.localName === 'polycarp-edits')) break; }
    if (key === 'Undo') await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
  };
  await press('Keep');
  ok(await until(() => page.evaluate(() => !document.querySelector('polycarp-edits'))) && (await text('#title')) === 'New title', 'notice: Keep puts it away and leaves the edit');
  await page.reload();
  await until(async () => (await text('#title')) === 'New title');
  await sleep(300);
  ok(await page.evaluate(() => !document.querySelector('polycarp-edits')), 'notice: a kept edit is not announced again');
  setAnswer([{ ...EDIT, name: 'Shop, calmer' }]);
  await tick();
  await sleep(400);
  ok(await page.evaluate(() => !document.querySelector('polycarp-edits')), 'notice: a new name alone is not a change');
  setAnswer([{ ...EDIT, name: 'Shop, calmer', css: '#foot{letter-spacing:4px}' }]);
  await tick();
  ok(await until(() => page.evaluate(() => !!document.querySelector('polycarp-edits'))), 'notice: a changed edit is announced again');
  await press('Undo');
  ok(await until(async () => (await text('#title')) === 'Old title'), 'notice: Undo takes the edit back');
  // A page of another site: what changed nothing isn't announced, and nothing on the page or in an edit takes the box away.
  const up = (p) => p.evaluate(() => !!document.querySelector('polycarp-edits'));
  const inSight = (p) => p.evaluate(() => { const e = document.elementFromPoint(innerWidth - 60, innerHeight - 40); return !!e && e.localName === 'polycarp-edits'; });
  const shop = { ...EDIT, name: 'Shop, calmer', css: '#foot{letter-spacing:4px}' };
  const lazy = { id: 'late', name: 'Late', sites: ['late.test'], changes: [{ do: 'hide', at: '.late' }] };
  const away = { id: 'away', name: 'Away', enabled: false, sites: ['late.test'], changes: [{ do: 'hide', at: '#foot' }] };
  const app = { id: 'app', sites: ['app.test'], css: 'html{transform:translate(0)} #foot{height:3000px}', changes: [] };
  const swap = { id: 'swap', name: 'Swap', sites: ['late.test'], changes: [{ do: 'text', at: 'p', find: 'Twitter', text: 'X' }] };
  const bare = { id: 'bare', sites: ['bare.test'], css: 'html{display:none}', changes: [] };
  setAnswer([shop, lazy, away, app, swap, bare, { ...lazy, id: 'bad', changes: [{ do: 'run', at: 'p' }] }]);
  await tick();
  const p2 = await ctx.newPage();
  await p2.goto('https://late.test/');
  await sleep(900);
  ok(!(await up(p2)), 'notice: an edit that finds nothing here is not announced');
  const lateTab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://late.test/*' }))[0].id);
  const pop2 = await ctx.newPage();
  await pop2.addInitScript((id) => { const q = chrome.tabs.query; chrome.tabs.query = (o) => (o.active ? chrome.tabs.get(id).then((t) => [t]) : q.call(chrome.tabs, o)); }, lateTab);
  await pop2.goto(`chrome-extension://${ID}/src/popup/popup.html`);
  await pop2.waitForSelector('#editsList li + li + li');
  const rows = await pop2.locator('#editsList li').allTextContents();
  ok(/nothing on this page matches/.test(rows[0]), `popup: an edit that finds nothing says so (${rows[0]})`);
  ok(/off in the Polycarp app/.test(rows[1]) && (await pop2.isDisabled('#editsList li:nth-child(2) input')) && !(await pop2.isDisabled('#editsList li:nth-child(1) input')), `popup: one that is off in the app can't be turned on here (${rows[1]})`);
  ok(/nothing here to change/.test(rows[2]), `popup: one whose words aren't here says so (${rows[2]})`);
  await pop2.goto(`chrome-extension://${ID}/src/pages/settings.html`);
  ok(await until(async () => /bad.*must be/.test(await pop2.textContent('#eRefused'))) && (await pop2.locator('#eList input:disabled').count()) === 1, `settings: an edit that isn't used, with why, and one off in the app (${await pop2.textContent('#eRefused')})`);
  await pop2.close();
  await p2.evaluate(() => document.querySelector('#foot').classList.add('late'));
  ok(await until(() => up(p2), 12000), 'notice: it is, once a part of the page is one it finds');
  await p2.evaluate(() => document.querySelector('polycarp-edits').remove());
  ok(await until(() => inSight(p2)), 'notice: a page that takes the box away gets it back');
  await p2.evaluate(() => document.body.append(document.querySelector('polycarp-edits')));
  ok(await until(() => inSight(p2)), 'notice: so does one that moves it');
  await p2.goto('https://bare.test/');
  ok(await until(() => inSight(p2)), 'notice: an edit that hides the whole page does not hide it');
  // The parser is done, a script is still on its way: the edits come before DOMContentLoaded.
  await ctx.route('https://app.test/slow.js', async (r) => { await sleep(1500); await r.fulfill({ status: 200, contentType: 'text/javascript', body: "window.ours = !!document.querySelector('polycarp-edits')" }); });
  await ctx.route('https://app.test/', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>App</title><script defer src="/slow.js"></script><body><p id="foot">End</p><div style="position:fixed;inset:0;z-index:2147483647"></div>' }));
  await p2.goto('https://app.test/');
  ok(!(await p2.evaluate(() => window.ours)) && await until(() => up(p2)), 'notice: a page whose script came last is announced on too, after it ran');
  ok(await inSight(p2), 'notice: no page or edit moves or covers it');
  await p2.close();
  setAnswer([shop]);
  await tick();
  const tab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://shop.test/*' }))[0].id);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 360, height: 760 });
  await pop.addInitScript((id) => { const q = chrome.tabs.query; chrome.tabs.query = (o) => (o.active ? chrome.tabs.get(id).then((t) => [t]) : q.call(chrome.tabs, o)); }, tab);
  pop.on('pageerror', (e) => errors.push('popup: ' + e));
  await pop.goto(`chrome-extension://${ID}/src/popup/popup.html`);
  await pop.waitForSelector('#editsList li');
  ok(/Shop, calmer/.test(await pop.textContent('#editsList')) && /By your agent/.test(await pop.textContent('#editsList')) && !(await pop.isChecked('#editsList input')), 'popup: the edit for this page, off');
  await pop.locator('#editsList input').focus();
  await pop.keyboard.press('Space');
  ok(await until(async () => (await text('#title')) === 'New title'), 'popup: the switch brings the edit back on the open page');
  ok(await until(() => pop.evaluate(() => document.activeElement && document.activeElement.matches('#editsList input'))), 'popup: the switch keeps the focus');
  await pop.screenshot({ path: path.join(here, 'out', 'edits-popup.png') });
  await pop.close();
  const set = await ctx.newPage();
  set.on('pageerror', (e) => errors.push('settings: ' + e));
  await set.goto(`chrome-extension://${ID}/src/pages/settings.html`);
  await set.waitForSelector('#eList li .fsum');
  ok((await set.locator('#eList [data-del]').count()) === 0 && (await set.locator('#eList input').count()) === 1, "settings: the app's edit has a switch and no delete");
  await set.fill('#eSites', 'shop.test');
  await set.fill('#eCss', 'a{background:url(https://evil.test)}');
  await set.click('#eAdd button');
  ok(await until(async () => /Not added: css may not use url\(/.test(await set.textContent('#eNote'))), `settings: a stylesheet that loads is refused (${await set.textContent('#eNote')})`);
  await set.fill('#eCss', '#foot{word-spacing:9px}');
  await set.click('#eAdd button');
  ok(await until(async () => (await css('#foot', 'wordSpacing')) === '9px'), 'settings: a stylesheet reaches the open page');
  const mine = set.locator('#eList li', { hasText: 'shop.test' }).filter({ has: set.locator('[data-del]') }).locator('input');
  await mine.focus();
  await mine.press('Space');
  ok(await until(async () => (await css('#foot', 'wordSpacing')) === '0px'), 'settings: its switch takes it off the open page');
  ok(await until(async () => set.evaluate(() => document.activeElement.matches('[data-on]') && !document.activeElement.checked)), 'settings: the switch keeps the keyboard');
  await set.keyboard.press('Space');
  ok(await until(async () => (await css('#foot', 'wordSpacing')) === '9px'), 'settings: and puts it back');
  await set.locator('#editsBox').screenshot({ path: path.join(here, 'out', 'edits-settings.png') });
  await set.locator('#eList [data-del]').click();
  ok(await until(async () => (await css('#foot', 'wordSpacing')) === '0px'), 'settings: delete takes it away');
  await set.close();
  setAnswer([EDIT]);
  await tick();
  await page.reload();
  await until(async () => (await text('#title')) === 'New title');

  // ---------- A page that changes under the edit ----------
  await page.evaluate(() => { const p = document.createElement('p'); p.className = 'ad'; p.id = 'late'; p.textContent = 'late'; document.querySelector('#main').append(p); });
  ok((await css('#late', 'display')) === 'none', 'hide: holds for a part added later');
  await page.evaluate(() => { document.querySelector('#title').outerHTML = '<h1 id="title">Rebuilt</h1>'; });
  ok(await until(async () => (await text('#title')) === 'New title'), 'text: made again on a rebuilt part');
  await page.evaluate(() => document.querySelector('#price').append(' And 10 more.'));
  ok(await until(async () => / And 100 more\.$/.test(await text('#price'))) && /^The price is 100 dollars, 100 in all/.test(await text('#price')), `text: find never replaces its own words again (${await text('#price')})`);
  await page.evaluate(() => { document.adoptedStyleSheets = []; document.querySelector('#main').append(document.createElement('hr')); });
  ok(await until(async () => (await css('.ad', 'display')) === 'none'), 'hide: back after the page replaces its stylesheets');
  await page.evaluate(() => { window.fights = 0; new MutationObserver(() => { const t = document.querySelector('#pic'); if (t.alt !== 'old') { window.fights++; t.alt = 'old'; } }).observe(document.querySelector('#pic'), { attributes: true }); document.querySelector('#pic').alt = 'x'; });
  await sleep(2500);
  const fights = await page.evaluate(() => window.fights);
  ok(fights > 5 && fights < 60, `a page that keeps changing a part back is left alone (${fights} rounds)`);

  // ---------- A page that owns its parts (React, Vue), and one that rebuilds them ----------
  await page.evaluate(() => { document.querySelector('#aside').firstChild.nodeValue = 'New side'; });
  ok(await until(async () => /^New side\|/.test(await moved())), 'move: the copy follows the page');
  ok(await page.evaluate(() => { const a = window.held = document.querySelector('#aside'); try { document.querySelector('#main').removeChild(a); return true; } catch (e) { return false; } }), 'move: the page can take its own part away');
  ok(await until(async () => page.evaluate(() => !document.querySelector('polycarp-moved'))), 'move: and the copy goes with it');
  await page.evaluate(() => document.querySelector('#main').append(window.held));
  ok(await until(async () => /^New side\|\|none/.test(await moved())), 'move: and comes back with it');
  await page.evaluate(() => { const m = document.querySelector('#main'); m.innerHTML = m.innerHTML; });
  ok(await until(async () => /^New side\|\|none/.test(await moved())) && await page.evaluate(() => document.querySelectorAll('polycarp-moved').length === 1), 'move: one copy after the page rebuilds the part');

  // ---------- Paths, switches and taking it back ----------
  setAnswer([{ ...EDIT, changes: EDIT.changes.filter((c) => c.name !== 'alt'), paths: ['/b*'] }]);
  await page.goto('https://shop.test/a');
  await tick();
  await sleep(600);
  const clean = () => page.evaluate(() => document.body.innerHTML.replace(/<\/?polycarp-[^>]*>/g, ''));
  ok((await text('#title')) === 'Old title' && (await css('.ad', 'display')) !== 'none', 'paths: another path is left alone');
  await page.evaluate(() => history.pushState({}, '', '/b/1'));
  ok(await until(async () => (await text('#title')) === 'New title'), 'paths: a new address without a reload brings the edit');
  await page.evaluate(() => history.pushState({}, '', '/a'));
  ok(await until(async () => (await text('#title')) === 'Old title') && (await clean()) === own, 'undo: the page is as the site made it');
  await page.evaluate(() => history.pushState({}, '', '/b/2'));
  await until(async () => (await text('#title')) === 'New title');
  // The page rebuilds its parts and moves on in one go, before the edit can be looked at again.
  await page.evaluate((html) => { document.body.innerHTML = html; history.pushState({}, '', '/a'); }, own);
  ok(await until(async () => (await clean()) === own) && await page.evaluate(() => !document.querySelector('polycarp-moved, polycarp-note, [data-polycarp-moved]')), 'undo: nothing is left when the page rebuilds itself and moves on');
  await page.evaluate(() => history.pushState({}, '', '/b/3'));
  await until(async () => (await text('#title')) === 'New title');
  const fp = await sw.evaluate(() => chrome.storage.local.get('polycarp.edits.app').then((g) => PolycarpEdits.fingerprint(PolycarpEdits.check(g['polycarp.edits.app'].edits[0]).edit)));
  await put({ 'polycarp.edits.off': { shop: fp } });
  ok(await until(async () => (await text('#title')) === 'Old title') && (await clean()) === own, 'off: an app edit switched off here is taken back');
  setAnswer([{ ...EDIT, changes: [{ do: 'text', at: '#title', text: 'Changed' }] }]);
  await tick();
  ok(await until(async () => (await text('#title')) === 'Changed'), 'off: an edit its agent changed comes back on');
  const settings = await sw.evaluate(() => Polycarp.getSettings());
  await sw.evaluate((s) => Polycarp.setSettings(s), { ...settings, sites: { 'shop.test': 'off' } });
  ok(await until(async () => (await text('#title')) === 'Old title'), 'Polycarp off for the site: taken back');
  await sw.evaluate((s) => Polycarp.setSettings(s), { ...settings, autoApply: false });
  ok(await until(async () => (await text('#title')) === 'Changed'), 'restyling off by default: edits still apply');
  await sw.evaluate((s) => Polycarp.setSettings(s), settings);

  // ---------- This browser's own edits; other sites; a broken app ----------
  await put({ 'polycarp.edits.local': [{ id: 'mine', sites: ['shop.test'], changes: [{ do: 'text', at: '#foot', text: 'Mine' }] }, { id: 'bad', sites: ['shop.test'], css: 'a{background:url(https://evil.test/)}' }] });
  ok(await until(async () => (await text('#foot')) === 'Mine'), "this browser's own edit applies, a refused one does not stop it");
  const other = await ctx.newPage();
  await other.goto('https://notshop.test/a');
  await sleep(500);
  ok((await other.evaluate(() => document.querySelector('#title').textContent)) === 'Old title', 'another site is untouched');
  setAnswer({ ok: false, error: 'edits.json is not JSON' });
  await tick();
  const errd = await stored();
  ok(errd.error === 'edits.json is not JSON' && errd.edits.length === 1 && (await text('#title')) === 'Changed', 'an error from the app keeps its last edits and records why');

  // ---------- Words ----------
  const wordy = await ctx.newPage();
  wordy.on('pageerror', (e) => errors.push(String(e)));
  await wordy.goto('https://words.test/');
  const wtext = (sel) => wordy.evaluate((s) => document.querySelector(s).textContent, sel);
  await wordy.evaluate(() => { document.querySelector('#main').innerHTML = '<p id="poem">' + Array(40).fill('a 10 line').join('<br>') + '</p><a id="home"><svg><title>Home icon</title></svg> Home</a><code id="grow">costs 10</code><code id="status">Loading</code><code id="tick">0 USD</code><p id="tab" class="off">Tab</p>'; });
  const poem = await wtext('#poem');
  const WORDS = [{ id: 'words', sites: ['words.test'], changes: [{ do: 'text', at: '#main', find: '10', text: 'ten' }, { do: 'text', at: '#home', text: 'Start' }, { do: 'text', at: '#tab.on', text: 'Open tab' }, { do: 'text', at: '#status', text: 'Wait' }, { do: 'text', at: '#tick', find: 'USD', text: 'dollars' }] }];
  await put({ 'polycarp.edits.local': WORDS });
  ok(await until(async () => !/10/.test(await wtext('#poem'))), 'text: every line of a long part is changed in one pass');
  ok((await wordy.evaluate(() => document.querySelector('#home title').textContent)) === 'Home icon' && /Start/.test(await wtext('#home')), "text: an icon's title keeps its words");
  await wordy.evaluate(() => { document.querySelector('#grow').firstChild.appendData(' and 10 more'); document.querySelector('#status').firstChild.appendData('.'); });
  ok(await until(async () => (await wtext('#grow')) === 'costs ten and ten more'), `text: words the page adds to a changed line (${await wtext('#grow')})`);
  await wordy.evaluate(async () => { for (let i = 1; i <= 60; i++) { document.querySelector('#tick').firstChild.nodeValue = i + ' USD'; await new Promise((r) => setTimeout(r, 40)); } });
  ok(await until(async () => (await wtext('#tick')) === '60 dollars'), `text: a price that keeps changing is not a page fighting back (${await wtext('#tick')})`);
  await wordy.evaluate(() => { document.querySelector('#tab').className = 'on'; });
  ok(await until(async () => (await wtext('#tab')) === 'Open tab'), 'text: a part that comes to match by its class alone');
  await put({ 'polycarp.edits.local': [] });
  ok(await until(async () => (await wtext('#grow')) === 'costs 10 and 10 more') && (await wtext('#poem')) === poem && (await wtext('#tab')) === 'Tab' && (await wtext('#status')) === 'Loading.', `undo: the page's own words, with what it added (${await wtext('#grow')})`);
  await put({ 'polycarp.edits.local': [{ id: 'hide', sites: ['words.test'], changes: [{ do: 'hide', at: '.ad' }, { do: 'hide', at: '#foot' }] }] });
  const footer = () => wordy.evaluate(() => getComputedStyle(document.querySelector('#foot')).display);
  ok(await until(async () => (await footer()) === 'none'), 'hide: an edit that only hides');
  await wordy.evaluate(() => { document.adoptedStyleSheets = []; document.documentElement.dataset.theme = 'dark'; });
  ok(await until(async () => (await footer()) === 'none'), 'hide: and holds through a theme switch that replaces the stylesheets');

  // ---------- Parts that move ----------
  const parts = await ctx.newPage();
  parts.on('pageerror', (e) => errors.push(String(e)));
  await parts.goto('https://parts.test/');
  await parts.evaluate(() => {
    document.querySelector('#main').innerHTML = `<div id="left" data-polycarp-skip><h2 id="top">Top</h2><a id="link" href="#top">To top</a><b class="promo">Buy</b>
<svg width="20" height="20"><linearGradient id="g"><stop stop-color="red"/></linearGradient><rect width="20" height="20" fill="url(#g)"/></svg></div>
<div id="right"><p id="here">Here</p></div><p class="card"><button>Held</button></p><p class="card">Free</p><div id="own"><div id="shut"></div></div>`;
    document.querySelector('#shut').attachShadow({ mode: 'closed' }).innerHTML = 'shut';
  });
  const PARTS = [
    { do: 'hide', at: '#left .promo' }, { do: 'style', at: '#left', style: { color: 'rgb(9, 8, 7)' } },
    { do: 'move', at: '#left', to: '#here', where: 'after' },
    { do: 'text', at: '#left h2', text: 'New top' },
    { do: 'insert', at: '#left h2', where: 'after', blocks: [{ kind: 'text', text: 'lost' }] },
    { do: 'insert', at: '#note-me', where: 'before', blocks: [{ kind: 'text', text: 'found' }] },
    { do: 'move', at: '.card', to: '#here', where: 'before' }, { do: 'move', at: '#own', to: '#here', where: 'before' }];
  await put({ 'polycarp.edits.local': [{ id: 'parts', sites: ['parts.test'], changes: PARTS }] });
  const copy = (fn) => parts.evaluate(`(() => { const m = document.querySelector('#right > polycarp-moved'); return m && (${fn})(m); })()`);
  ok(await until(async () => (await copy('(m) => m.querySelector("h2").textContent')) === 'New top'), 'move: the copy has the words an edit put in the part');
  ok(await copy('(m) => !m.querySelector(".promo") && getComputedStyle(m.firstChild).color === "rgb(9, 8, 7)"'), "move: hide and style by the part's id reach its copy");
  ok(await copy('(m) => !m.querySelector("#g, #top") && m.querySelector("rect").getAttribute("fill") === "url(#" + m.querySelector("linearGradient").id + ")" && m.querySelector("a").hash === "#" + m.querySelector("h2").id'), 'move: what the copy names by id is in the copy');
  const why = (await told('https://parts.test/*')).edits[0].changes;
  ok(!why[4].hits && why[4].note && /button/.test(why[6].note) && /own element/.test(why[7].note) && await parts.evaluate(() => !document.querySelector('polycarp-note') && document.querySelectorAll('polycarp-moved').length === 1), `move: no note inside a part that is out of sight; a held first match and a closed shadow root stay (${JSON.stringify(why.slice(4).map((r) => r.note || r.hits))})`);
  await copy('(m) => { m.querySelector("a").focus(); }');
  await parts.evaluate(() => { document.querySelector('#link').className = 'on'; });
  ok(await until(async () => copy('(m) => m.querySelector("a").className === "on"')) && await copy('(m) => document.activeElement === m.querySelector("a")'), 'move: the copy follows a class no selector names, and keeps the focus');
  await parts.evaluate(() => { document.querySelector('#left').hidden = true; });
  ok(await until(async () => copy('(m) => m.firstChild.hidden')), 'move: a part the page closes is closed');
  await parts.evaluate(() => { const r = document.querySelector('#right'); window.saved = r.cloneNode(true); r.innerHTML += '<p>more</p>'; });
  ok(await until(async () => parts.evaluate(() => document.querySelectorAll('polycarp-moved').length === 1)), 'move: one copy after the page rebuilds what it is in');
  await parts.evaluate(() => document.querySelector('#main').insertAdjacentHTML('beforeend', '<section id="a"><p id="note-me">A</p></section><section id="b"></section>'));
  const noted = () => parts.evaluate(() => { const n = document.querySelector('polycarp-note'); return n ? n.parentNode.id : ''; });
  ok(await until(async () => (await noted()) === 'a'), 'insert: by a part that comes later');
  await parts.evaluate(() => { const p = window.gone = document.querySelector('#note-me'); p.parentNode.removeChild(p); });
  ok(await until(async () => (await noted()) === ''), 'insert: the note goes when its part goes');
  await parts.evaluate(() => { document.querySelector('#b').append(window.gone); });
  ok(await until(async () => (await noted()) === 'b'), 'insert: and comes where the part comes back');
  await parts.evaluate(() => { const h = document.querySelector('#here'); h.remove(); });
  ok(await until(async () => parts.evaluate(() => !document.querySelector('polycarp-moved, [data-polycarp-moved]'))), 'move: the part is back in its place when there is nowhere to show it');
  await parts.evaluate(() => { document.querySelector('#right').replaceWith(window.saved); });
  ok(await until(async () => parts.evaluate(() => document.querySelectorAll('polycarp-moved').length === 1)), 'move: one copy in a view the page saved and brought back');
  await put({ 'polycarp.edits.local': [] });
  ok(await until(async () => parts.evaluate(() => !document.querySelector('polycarp-moved, polycarp-note, [data-polycarp-moved]'))) && await parts.evaluate(() => document.querySelector('#left h2').textContent === 'Top'), 'undo: nothing of it is left');

  // ---------- A page that arrives in pieces ----------
  await put({ 'polycarp.edits.local': [{ id: 'slow', sites: ['localhost'], changes: [
    { do: 'hide', at: '#nav' },
    { do: 'insert', at: '#main', where: 'last', blocks: [{ kind: 'text', text: 'The end' }] },
    { do: 'move', at: '#box', to: '#nav', where: 'before' },
    { do: 'text', at: 'p.last:last-of-type', text: 'the last' }] }] });
  const late = await ctx.newPage();
  await late.goto(SLOW, { waitUntil: 'commit' });
  await sleep(700);
  const half = await late.evaluate(() => `${document.readyState} ${!!document.querySelector('#box')} ${document.querySelector('p.last').textContent} ${!!document.querySelector('polycarp-note, polycarp-moved')}`);
  ok(half === 'loading true one false', `a half loaded page is not moved around (${half})`);
  ok(await until(async () => late.evaluate(() => document.readyState === 'complete' && document.querySelector('#main').lastElementChild.localName === 'polycarp-note')), 'insert: last is last of the whole page');
  const end = await late.evaluate(() => [...document.querySelectorAll('p.last')].map((p) => p.textContent).join() + ' ' + !!document.querySelector('polycarp-moved') + ' ' + !!document.querySelector('#box button'));
  ok(end === 'one,the last false true', `text: only the last of its kind; move: a part that turned out to hold a button stays (${end})`);

  // ---------- A fast feed ----------
  await put({ 'polycarp.edits.local': [{ id: 'feed', sites: ['shop.test'], changes: [{ do: 'text', at: 'main', find: 'spoiler', text: 'x' }, { do: 'text', at: '.row b', text: 'row' }] }] });
  await sleep(300);
  await page.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const f = document.createDocumentFragment();
      for (let k = 0; k < 50; k++) { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<b>b</b> a spoiler here'; f.append(d); }
      document.querySelector('#main').append(f);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    // More than one pass acts on, all at once.
    document.querySelector('#main').insertAdjacentHTML('beforeend', '<div class="row"><b>b</b></div>'.repeat(2500));
  });
  ok(await until(async () => page.evaluate(() => !/spoiler/.test(document.querySelector('#main').textContent) && [...document.querySelectorAll('.row b')].every((b) => b.textContent === 'row')), 20000), 'a feed of 5000 rows is edited whole');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  console.log('FAIL crashed: ' + (e && e.stack || e));
  fails++;
} finally {
  await ctx.close();
  slow.close();
  fs.rmSync(hostDir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
