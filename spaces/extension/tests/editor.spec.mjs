// The page editor in a real browser (src/content/editor.js): pointing at a part by mouse or keyboard, each tool, undo,
// "all like it", this page or the whole site, and what it refuses. Every press is a real one, found through the closed
// shadow root over the debugging protocol. Run: node tests/editor.spec.mjs
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
const PAGE = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Reef Daily</title><style>body{font:17px/1.6 Georgia,serif;margin:0 auto;max-width:720px;padding:24px;color:#222;background:#fff} .promo{background:#eef;padding:12px}</style></head><body>
<header><h1 id="title">The reef that came back</h1></header>
<p class="lede" id="lede">Ten years after the bleaching, divers are counting more fish than before it.</p>
<section class="promo"><p>Subscribe for 99 cents</p></section>
<p class="body">The survey covered forty sites along the northern wall.</p>
<section class="promo"><p>Try our app</p></section>
<p class="body">No one expected the count to double.</p>
<form id="form"><label id="label">Email <input id="email" value="me"></label><button id="send" type="button" onclick="window.sent=1">Send</button></form>
<div style="height:1200px"></div></body></html>`;

const MOVES = `<!doctype html><html lang="en"><head><title>Moves</title><style>.card{border:1px solid #ccc;padding:8px;margin:8px}</style></head><body><div id="list">
<aside class="card alpha"><p class="card__Ab12c card__title">Alpha words</p></aside><aside class="card beta">Beta words</aside><aside class="card gamma">Gamma words</aside><aside class="card delta">Delta words</aside></div>
<form><input id="email"></form><button id="ask" onclick="document.querySelector('dialog').showModal()">Ask</button><dialog><p id="inside" class="say">In the dialog</p><button>Yes</button></dialog><div style="height:2000px"></div></body></html>`;

const { chromium } = await loadPlaywright();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-editor-')), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
await ctx.route('https://*.test/**', (r) => r.fulfill(r.request().url().endsWith('.svg') ? { status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>' }
  : { status: 200, contentType: 'text/html; charset=utf-8', body: r.request().url().includes('/moves') ? MOVES : PAGE }));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); }
  return fn();
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sleep(800);
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('https://reef.test/a');
  await page.evaluate(() => { window.keys = []; document.addEventListener('keydown', (e) => window.keys.push(e.key)); document.addEventListener('click', () => { window.clicks = (window.clicks || 0) + 1; }); });
  const cdp = await ctx.newCDPSession(page);
  const locals = () => sw.evaluate(() => chrome.storage.local.get('polycarp.edits.local').then((g) => g['polycarp.edits.local'] || []));
  const toggle = () => sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'https://reef.test/*' }); return editPage(t); });
  // A node inside the editor's closed root, or null.
  async function inside(sel) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (n) => (n.localName === 'polycarp-edits' && n.shadowRoots ? n.shadowRoots[0] : [...(n.children || [])].reduce((a, c) => a || find(c), null));
    const shadow = find(root);
    if (!shadow) return null;
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector: sel });
    return nodeId || null;
  }
  async function box(sel) {
    const id = await inside(sel);
    if (!id) return null;
    const m = await cdp.send('DOM.getBoxModel', { nodeId: id }).catch(() => null);
    if (!m) return null;
    const q = m.model.border;
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2, w: q[2] - q[0], h: q[5] - q[1], left: q[0], right: q[2], bottom: q[5] };
  }
  async function read(sel, fn = 'return this.textContent') {
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: await inside(sel) });
    return (await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(){${fn}}`, returnByValue: true })).result.value;
  }
  const press = async (sel) => { const b = await until(() => box(sel)); await page.mouse.click(b.x, b.y); };
  const act = (name) => press(`[data-do=${name}]`);
  const tool = (name) => press(`[data-tool=${name}]`);
  const point = async (sel) => { await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel); const b = await page.locator(sel).first().boundingBox(); await page.mouse.click(b.x + Math.min(40, b.width / 2), b.y + b.height / 2); };
  const pick = async (sel, v) => { const { object } = await cdp.send('DOM.resolveNode', { nodeId: await inside(sel) }); await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(v){this.value=v;this.dispatchEvent(new Event("change",{bubbles:true}))}', arguments: [{ value: v }] }); };
  const shown = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).display !== 'none', sel);
  const text = (sel) => page.evaluate((s) => document.querySelector(s).textContent, sel);

  ok(await toggle(), 'the editor opens on a page');
  ok(await until(() => inside('.bar')) && await page.evaluate(() => !document.querySelector('polycarp-edits').shadowRoot), 'closed to the page');
  ok(/Click a part/.test(await read('.what')), 'says what to do first');

  // ---------- Pointing ----------
  await point('#send');
  ok(await page.evaluate(() => !window.sent && !window.clicks), "a click while editing never reaches the page's own button");
  ok(/^Button/.test(await read('.what')), `names the part (${await read('.what')})`);
  await point('#email');
  await tool('text');
  ok(/smaller part/.test(await read('.tool')), 'a field is not reworded');
  await point('#title');
  ok(/^Heading The reef/.test(await read('.what')), `the part under the pointer is chosen (${await read('.what')})`);
  await page.screenshot({ path: path.join(out, 'editor-1280.png') });
  await page.keyboard.press('ArrowUp');
  ok(/^Header/.test(await read('.what')), 'Arrow Up goes to the part around it');
  await page.keyboard.press('ArrowRight');
  ok(/^Paragraph Ten years/.test(await read('.what')), 'Arrow Right goes to the next part');

  // ---------- The tools ----------
  await tool('text');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Divers count more fish.');
  ok((await page.evaluate(() => window.keys.length)) === 0, "the page's own shortcuts hear no key typed here");
  await act('text');
  ok(await until(async () => (await text('#lede')) === 'Divers count more fish.'), 'Text: the words change');
  await tool('style');
  await press('[data-do=larger]');
  ok(await until(() => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#lede')).fontSize) > 18)), 'Style: larger');
  await press('[data-do=bold]');
  ok(await until(() => page.evaluate(() => getComputedStyle(document.querySelector('#lede')).fontWeight === '700')), 'Style: bold');
  let mine = (await locals())[0];
  ok(mine.changes.length === 2 && mine.changes[1].style['font-weight'] === '700' && mine.changes[1].style['font-size'], `small adjustments stay one change (${mine.changes.length})`);
  ok(mine.paths[0] === '/a' && mine.sites[0] === 'reef.test', 'kept for this page by default');
  await tool('note');
  await page.keyboard.type('Check the numbers');
  await act('note');
  ok(await until(() => page.evaluate(() => { const n = document.querySelector('#lede').nextElementSibling; return n && n.localName === 'polycarp-note'; })), 'Note: shown under the part');
  await act('undo');
  ok(await until(() => page.evaluate(() => !document.querySelector('polycarp-note'))), 'Undo takes the note back');

  await page.evaluate(() => scrollTo(0, 0));
  await point('.body');
  await tool('move');
  await act('before');
  const where = () => page.evaluate(() => { const m = document.querySelector('polycarp-moved'); return m ? `${(m.previousElementSibling || {}).id || ''}|${(m.nextElementSibling || {}).className || (m.nextElementSibling || {}).id}|${document.querySelectorAll('polycarp-moved').length}` : ''; });
  ok(await until(async () => (await where()) === 'lede|promo|1'), `Move: up past the part above (${await where()})`);
  await act('before');
  ok(await until(async () => / *\|lede\|1$/.test(await where())), `Move: and up again from where it shows (${await where()})`);
  const spot = await page.evaluate(() => { const b = document.querySelector('polycarp-moved').firstElementChild.getBoundingClientRect(); return { x: b.x + 10, y: b.y + 8 }; });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.mouse.click(spot.x, spot.y);
  ok(/^(Paragraph|Section|Part|Text|Box)/i.test(await read('.what')), `a moved part is chosen where it shows (${await read('.what')})`);
  await tool('move');
  await act('after');
  ok(await until(async () => (await where()) === 'lede|promo|1'), `Move: and back down (${await where()})`);
  await point('#label');
  await tool('move');
  await act('after');
  ok(await until(async () => /form field/.test(await read('.say'))) && !JSON.stringify(await locals()).includes('#label'), 'a part that holds a field is not moved, and nothing is kept');

  await point('.promo');
  for (let i = 0; i < 2 && !/^Section/.test(await read('.what')); i++) await act('wider');
  ok(/^Section/.test(await read('.what')), 'Wider goes to the part around it');
  await pick('[data-scope=which]', 'all');
  await sleep(250);
  ok(/All 2 like it/.test(await read('[data-scope=which]', 'return this.selectedOptions[0].textContent')), `says how many are like it (${await read('[data-scope=which]', 'return this.innerHTML')})`);
  await pick('[data-scope=where]', 'site');
  await act('hide');
  ok(await until(() => page.evaluate(() => [...document.querySelectorAll('.promo')].every((e) => getComputedStyle(e).display === 'none'))), 'Hide: all like it');
  ok((await locals()).some((e) => !e.paths.length && e.changes[0].do === 'hide'), 'kept for the whole site when asked');

  // ---------- Moving past what was moved ----------
  const open = async (url) => { await page.goto(url); await toggle(); await until(() => inside('.bar')); };
  // What a person sees, top to bottom.
  const order = () => page.evaluate(() => [...document.querySelectorAll('#list > *')].flatMap((e) => (e.localName === 'polycarp-moved' ? [e.firstElementChild] : [e])).filter((e) => e && e.offsetWidth).map((e) => e.textContent.trim()[0]).join(''));
  const said = (re) => until(async () => re.test(await read('.say')));
  const shows = async (want, msg) => ok(await until(async () => (await order()) === want), `${msg} (${await order()})`);
  await open('https://reef.test/moves');
  await point('.gamma');
  await tool('move');
  await act('before');
  await shows('AGBD', 'Move: a part with only a class goes up');
  await act('before');
  await shows('GABD', 'and up again');
  await act('after');
  await shows('AGBD', 'and back down');
  await act('after');
  await shows('ABGD', 'past the place it left');
  const atMoves = async () => ((await locals()).find((e) => e.paths[0] === '/moves') || { changes: [] }).changes;
  ok((await atMoves()).length === 1 && !JSON.stringify(await atMoves()).includes('polycarp'), `its moves stay one change (${JSON.stringify(await atMoves())})`);
  await point('.delta');
  await tool('move');
  await act('before');
  await shows('ABGD', 'a part that shows beside a moved one stays');
  ok(await said(/can't pass a part that was moved/), 'and says why');
  await point('.beta');
  await tool('move');
  await act('before');
  ok(await said(/moved beside this one/) && (await order()) === 'ABGD', 'a part another one was moved beside stays');
  await point('.alpha');
  await page.keyboard.press('ArrowUp');
  await tool('move');
  await act('after');
  await shows('BAGD', 'a second part moves');
  const local = (edit) => sw.evaluate(async (e) => { const k = 'polycarp.edits.local', all = (await chrome.storage.local.get(k))[k] || []; await chrome.storage.local.set({ [k]: all.filter((x) => x.id !== e.id).concat(e.changes.length ? e : []) }); }, edit);
  const site = (await locals()).find((e) => !e.paths.length);
  await local({ ...site, changes: [] }); // put back below

  // ---------- Undo, after a reload and beside another change ----------
  await open('https://reef.test/moves');
  await shows('BAGD', 'a reload keeps what was moved');
  await until(async () => !(await read('[data-do=undo]', 'return this.disabled')));
  await act('undo');
  await shows('ABGD', 'Undo takes back what was done before the reload');
  await act('undo');
  ok(await until(async () => !(await atMoves()).length) && await until(() => read('[data-do=undo]', 'return this.disabled')), 'with nothing left to take back, Undo is off');
  await point('.alpha');
  await page.keyboard.press('ArrowUp');
  await act('hide');
  await shows('BGD', 'Hide');
  ok(await page.evaluate(() => document.activeElement.localName === 'polycarp-edits'), 'the panel keeps the keyboard');
  await sw.evaluate(async () => { const k = 'polycarp.edits.local', all = (await chrome.storage.local.get(k))[k], e = all.find((x) => x.paths[0] === '/moves'); e.changes.push({ do: 'hide', at: '.delta' }); await chrome.storage.local.set({ [k]: all }); });
  await act('undo');
  await shows('ABG', 'Undo leaves a change made meanwhile');
  await act('undo');
  await shows('ABGD', 'until it is its turn');
  await point('.alpha p');
  await act('hide');
  ok(await until(async () => ((await atMoves())[0] || {}).at === 'p.card__title'), `a part goes by the name its author gave it (${JSON.stringify(await atMoves())})`);
  await act('undo');
  await until(async () => !(await atMoves()).length);
  await point('.delta');
  await tool('note');
  await page.keyboard.type('Keep');
  await act('note');
  await until(() => page.evaluate(() => document.querySelector('polycarp-note')));
  await tool('move');
  await act('before');
  ok(await said(/note hangs on/) && await page.evaluate(() => !!document.querySelector('polycarp-note')), 'a part with a note keeps it');
  await act('undo');
  await until(() => page.evaluate(() => !document.querySelector('polycarp-note')));

  // ---------- What another edit holds ----------
  const other = { id: 'other', name: 'Other', enabled: true, sites: ['reef.test'], paths: ['/moves'], changes: [{ do: 'move', at: '.gamma', to: '.alpha', where: 'before' }], css: '' };
  await local(other);
  await shows('GABD', 'another edit moves a part');
  await page.evaluate(() => scrollTo(0, 0));
  const g = await page.evaluate(() => { const b = document.querySelector('polycarp-moved').firstElementChild.getBoundingClientRect(); return { x: b.x + 20, y: b.y + 15 }; });
  await page.mouse.click(g.x, g.y);
  await tool('move');
  await act('after');
  ok(await said(/already moves this part/), `its part is not moved a second time (${await read('.say')})`);
  await local({ ...other, changes: [] });
  await point('.beta');
  await act('hide');
  await until(async () => (await atMoves()).length);
  await local({ ...(await locals()).find((e) => e.paths[0] === '/moves'), enabled: false });
  await shows('ABGD', 'the changes are turned off elsewhere');
  await point('.delta');
  await act('hide');
  ok(await said(/are off/) && await read('[data-do=undo]', 'return !this.disabled') && (await locals()).find((e) => e.paths[0] === '/moves').enabled === false, 'a change made then does not turn them on');
  await act('undo');
  await sleep(300);
  ok((await atMoves()).length === 1 && /are off/.test(await read('.say')), 'nor does Undo take any');
  await local({ ...(await locals()).find((e) => e.paths[0] === '/moves'), changes: [] });

  // ---------- Pages that hold on ----------
  await page.evaluate(() => { const i = document.querySelector('#email'); window.heard = 0; document.addEventListener('focusin', () => i.focus()); document.addEventListener('focusout', (e) => e.relatedTarget !== i && i.focus()); i.focus(); window.heard = 0; for (const t of ['beforeinput', 'input', 'paste', 'keyup', 'mousedown']) document.addEventListener(t, () => { window.heard++; }, true); });
  await point('.alpha');
  await tool('note');
  await page.keyboard.type('Mine');
  ok((await read('.tool textarea', 'return this.value')) === 'Mine' && (await page.evaluate(() => document.querySelector('#email').value + window.heard)) === '0', "a page's focus trap and typing handlers hear nothing");
  await point('.beta');
  await tool('style');
  const color = (v) => read('[data-color=color]', `this.focus(); this.value = '${v}'; this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))`);
  for (const v of ['#111111', '#770000', '#ff0000']) { await color(v); await sleep(250); }
  await color('#00ff00');
  await point('.delta');
  const ink = (sel) => page.evaluate((x) => getComputedStyle(document.querySelector(x)).color, sel);
  ok(await until(async () => (await ink('.beta')) === 'rgb(0, 255, 0)') && (await ink('.delta')) !== 'rgb(0, 255, 0)', 'a color goes to the part it was picked for');
  await point('.delta');
  await tool('style');
  await color('#0000ff');
  await page.mouse.click(1200, 700);
  ok(await until(async () => (await ink('.delta')) === 'rgb(0, 0, 255)'), 'even when nothing is chosen next');
  await act('undo');
  await act('undo');
  ok(await until(async () => (await ink('.beta')) === 'rgb(0, 0, 0)'), `and is one step to undo, however many were tried (${await ink('.beta')})`);
  await open('https://reef.test/moves?q=1');
  await point('.beta');
  ok(/^Every page at \/moves$/.test(await read('[data-scope=where]', 'return this.options[0].textContent')), 'a page with a query says what it changes');
  await toggle();
  await page.click('#ask');
  await toggle();
  await until(() => inside('.bar'));
  await point('#inside');
  await act('hide');
  ok(await until(async () => !(await shown('#inside'))), 'a part of an open dialog is changed');
  await act('undo');
  await until(() => shown('#inside'));
  await point('#inside');
  await page.keyboard.press('ArrowUp');
  await act('hide');
  await sleep(300);
  ok(await page.evaluate(() => document.querySelector('dialog').offsetWidth > 0) && await box('.bar'), 'the dialog that holds the panel is not');
  await act('done');
  ok(await until(() => page.evaluate(() => !document.querySelector('polycarp-edits') && document.querySelector('dialog').open)), 'and the dialog stays open');
  await page.goto('https://reef.test/drawing.svg');
  ok((await toggle()) === false, 'a page it cannot edit is refused');

  await open('https://reef.test/moves');
  await page.evaluate(() => document.dispatchEvent(new Event('polycarp:edits-handover')));
  ok(await page.evaluate(() => !document.querySelector('polycarp-edits')), 'an updated extension finds no old panel');

  // ---------- Touch ----------
  await open('https://reef.test/moves');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const at = await page.locator('.beta').boundingBox();
  await cdp.send('Input.synthesizeTapGesture', { x: at.x + 30, y: at.y + 15, gestureSourceType: 'touch' });
  ok(await until(async () => /Beta/.test(await read('.what'))), `a tap chooses a part (${await read('.what')})`);
  await cdp.send('Input.synthesizeScrollGesture', { x: 600, y: 400, yDistance: -300, gestureSourceType: 'touch' });
  ok(await until(() => page.evaluate(() => scrollY > 100)), 'a finger scrolls the page');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await toggle();

  // ---------- Closing, another page, phone width ----------
  await local(site);
  await open('https://reef.test/a');
  await page.keyboard.press('Escape');
  ok(await until(() => page.evaluate(() => !document.querySelector('polycarp-edits'))), 'Escape closes it');
  await page.evaluate(() => document.querySelector('#send').click());
  ok(await page.evaluate(() => window.sent === 1), 'the page works as before');
  await page.goto('https://reef.test/b');
  ok(await until(async () => !(await shown('.promo'))) && /^Ten years/.test(await text('#lede')), "another page has the site's change and not the first page's");
  await toggle();
  await until(() => inside('.bar'));
  ok(await toggle() && await until(() => page.evaluate(() => !document.querySelector('polycarp-edits'))), 'asked for again, it closes');
  await toggle();
  await until(() => inside('.bar'));
  await page.evaluate(() => document.querySelector('polycarp-edits').remove());
  await page.evaluate(() => { const h = document.documentElement; h.style.transform = 'translate(0)'; document.body.insertAdjacentHTML('beforeend', '<div id="cover" style="position:absolute;inset:0;height:3000px;z-index:2147483647"></div>'); scrollTo(0, 300); });
  ok(await toggle() && await until(() => inside('.bar')), 'a page that takes it away has it back when asked');
  const bar = await box('.bar');
  ok(bar.bottom <= 800 && await page.evaluate(([x, y]) => document.elementFromPoint(x, y).localName === 'polycarp-edits', [bar.x, bar.y]), `no page moves or covers it (${Math.round(bar.bottom)})`);
  await page.evaluate(() => { document.querySelector('#cover').remove(); document.documentElement.style.transform = ''; });
  await point('#title');
  const kept = JSON.stringify(await locals());
  await page.evaluate(() => document.querySelector('#title').remove());
  await act('hide');
  ok(/gone from the page/.test(await until(() => read('.say'))) && JSON.stringify(await locals()) === kept, 'a part the page took away is not changed');
  await toggle();
  await page.goto('https://reef.test/c');
  await page.setViewportSize({ width: 390, height: 780 });
  await toggle();
  await until(() => inside('.bar'));
  await point('#title');
  await tool('style');
  const b = await box('.bar');
  ok(b.left >= 0 && b.right <= 390 && b.bottom <= 780 && await page.evaluate(() => document.documentElement.scrollWidth <= 390), `fits a phone-wide window (${Math.round(b.w)} wide)`);
  ok(await read('.bar', 'return [...this.querySelectorAll("button")].filter((x) => x.offsetWidth).every((x) => x.offsetHeight >= 40)'), 'every button is at least 40px tall');
  await page.screenshot({ path: path.join(out, 'editor-390.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await toggle();
  await toggle();
  await until(() => inside('.bar'));
  await point('#title');
  await sleep(200);
  await page.screenshot({ path: path.join(out, 'editor-390-dark.png') });
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  console.log('FAIL crashed: ' + (e && e.stack || e));
  fails++;
} finally { await ctx.close(); }
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
