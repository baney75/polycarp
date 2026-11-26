// Polycarp Mail in Chromium on the made-up account: the empty state, the list with people first and bundles folded,
// the keys, opening and archiving with undo, the command bar, HTML mail shown as inert text, and the narrow layout.
// Run: node tests/hub.spec.mjs   (SHOTS=<dir> also saves screenshots at 390 and 1280 px, light and dark)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const ID = 'kdaddaaobomjfjcgjeabgbenfddkcfcl'; // fixed by the manifest key
const URL = `chrome-extension://${ID}/src/pages/hub.html`;

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-mail-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + JSON.stringify(detail)}`); if (!ok) fails++; };
const errors = [];

const rows = (p) => p.$$eval('#rows [role="option"]', (os) => os.map((o) => ({ id: o.id, label: o.getAttribute('aria-label'), unread: o.classList.contains('unread'), bundle: o.dataset.bundle || '' })));
const active = (p) => p.$eval('#rows', (r) => r.getAttribute('aria-activedescendant'));
const where = (p) => p.textContent('#where');

try {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(URL);
  await p.waitForSelector('#empty:not([hidden])');
  check(await p.isVisible('#tryFake'), 'with no account, the page offers made-up mail', null);
  if (process.env.SHOTS) await p.screenshot({ path: path.join(process.env.SHOTS, 'mail-empty-1280.png') });

  await p.click('#tryFake');
  await p.waitForSelector('#rows [role="option"]');
  let list = await rows(p);
  const groups = await p.$$eval('#rows .group', (hs) => hs.map((h) => h.textContent));
  check(groups[0] === 'Needs you', 'unread mail from people comes first', groups);
  check(list.some((r) => r.bundle === 'newsletters') && list.some((r) => r.bundle === 'receipts'), 'newsletters and receipts fold into bundle lines', list.filter((r) => r.bundle).map((r) => r.bundle));
  check(list.every((r) => r.label && r.label.length > 3), 'every row has a spoken name', list.filter((r) => !r.label));
  check(list.length < 120, 'the inbox shows fewer rows than threads because bundles fold', list.length);

  // Keys move the selection; Return opens; opening marks the conversation read.
  await p.focus('#rows');
  const first = await active(p);
  await p.keyboard.press('j');
  const second = await active(p);
  await p.keyboard.press('k');
  check(first && second && first !== second && (await active(p)) === first, 'J and K move the selection and back', { first, second });
  await p.keyboard.press('End');
  await p.waitForFunction(() => document.querySelector('.list').scrollTop > 200);
  const head = await p.evaluate(() => { const w = document.querySelector('.where').getBoundingClientRect(), l = document.querySelector('.list').getBoundingClientRect(); return { top: w.top - l.top, h: w.height }; });
  check(head.top >= 0 && head.top < 4 && head.h > 0, 'the view name stays in sight when the list scrolls', head);
  await p.keyboard.press('Home');
  const target = list[0];
  await p.keyboard.press('Enter');
  await p.waitForSelector('#subject');
  const subject = await p.textContent('#subject');
  check(target.label.includes(subject), 'Return opens the selected conversation', { label: target.label, subject });
  await p.waitForFunction((id) => !document.getElementById(id)?.classList.contains('unread'), target.id);
  check(true, 'opening a conversation marks it read', null);
  if (process.env.SHOTS) for (const scheme of ['light', 'dark']) { await p.emulateMedia({ colorScheme: scheme }); await p.waitForTimeout(400); await p.screenshot({ path: path.join(process.env.SHOTS, `mail-1280-${scheme}.png`) }); }
  await p.emulateMedia({ colorScheme: 'light' });

  // Archive with E, undo with Z.
  await p.focus('#rows');
  await p.keyboard.press('e');
  await p.waitForFunction((id) => !document.getElementById(id), target.id);
  check((await p.textContent('#toastText')) === 'Archived' && await p.isVisible('#toastUndo'), 'E archives and offers an undo', await p.textContent('#toastText'));
  await p.keyboard.press('z');
  await p.waitForFunction((id) => !!document.getElementById(id), target.id);
  check(true, 'Z puts it back in the inbox', null);

  // A bundle line opens the bundle; Escape goes back to the inbox.
  await p.click('#rows [data-bundle="newsletters"]');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Newsletters');
  const nl = await rows(p);
  check(nl.length > 0 && nl.every((r) => !r.bundle), 'a bundle opens as its own list', nl.length);
  check(await p.isVisible('#up'), 'a bundle view has a way back', null);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Inbox');
  check(true, 'Escape goes back to the inbox', null);

  // The command bar opens with Meta+K, finds a command and runs it.
  await p.keyboard.press('Meta+k');
  await p.waitForSelector('#cmd[open]');
  await p.fill('#cmdIn', 'archive');
  await p.waitForFunction(() => document.querySelectorAll('#cmdList li').length < 6);
  const opts = await p.$$eval('#cmdList li span', (s) => s.map((x) => x.textContent));
  check(opts[0] === 'Go to Archive', 'the command bar finds Go to Archive', opts);
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Archive');
  check(!(await p.$('#cmd[open]')), 'Return runs the command and closes the bar', null);
  await p.keyboard.press('g');
  await p.keyboard.press('i');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Inbox');
  check(true, 'G then I goes to the inbox', null);
  await p.click('#rows [data-bundle="newsletters"]');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Newsletters' && document.querySelector('#rows .row.sel'));
  await p.focus('#up');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Inbox');
  await new Promise((r) => setTimeout(r, 300));
  check(!(await p.$('#subject')), 'Return on a focused button presses it, not the highlighted row', null);

  // Sent: your own mail never moves to the inbox. A thread of only your mail is the newest in Sent.
  await p.evaluate(() => globalThis.PolycarpHubStore.upsert('made-up', [{ remoteId: 'mine', messageId: '<mine@x>', from: { name: 'Me', addr: 'me@home.example' },
    to: [{ addr: 'ada.arden@example.com' }], subject: 'Only mine', date: Date.now() - 1000, folder: 'sent', unread: false, text: 'Mine alone.' }]));
  await p.keyboard.press('g');
  await p.keyboard.press('s');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Sent');
  await p.waitForSelector('#rows [aria-label*="Only mine"]');
  await p.click('#rows [aria-label*="Only mine"]');
  await p.waitForFunction(() => document.getElementById('subject')?.textContent === 'Only mine');
  const sentActs = await p.$$eval('#pane .acts button', (bs) => bs.map((b) => b.getAttribute('aria-label')));
  const sentBefore = await p.evaluate(async () => (await globalThis.PolycarpHubStore.allMessages()).filter((m) => m.folder === 'sent').length);
  await p.keyboard.press('i');
  await new Promise((r) => setTimeout(r, 400));
  const sentAfter = await p.evaluate(async () => (await globalThis.PolycarpHubStore.allMessages()).filter((m) => m.folder === 'sent').length);
  check(!sentActs.includes('Move to the inbox') && sentAfter === sentBefore, 'a conversation in Sent offers no move to the inbox, and I moves nothing', { sentActs, sentBefore, sentAfter });
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Inbox');

  // A conversation opened from search, outside the list: S flags that one, not the highlighted row.
  const away = await p.evaluate(async () => {
    const S = globalThis.PolycarpHubStore;
    const [id] = await S.upsert('made-up', [{ remoteId: 'filed', messageId: '<filed@x>', from: { name: 'Ada Arden', addr: 'ada.arden@example.com' },
      to: [{ addr: 'me@home.example' }], subject: 'Filed away', date: Date.now() - 5000, folder: 'archive', unread: false, text: 'Kept for later.' }]);
    return { id, subject: 'Filed away' };
  });
  const rowBefore = await p.evaluate(() => document.querySelector('#rows .row.sel')?.dataset.thread);
  await p.keyboard.press('Meta+k');
  await p.fill('#cmdIn', away.subject);
  // The conversation's own row, "Name: subject", not the line that lists every match.
  await p.waitForFunction((s) => Array.from(document.querySelectorAll('#cmdList li span')).some((x) => x.textContent.endsWith(': ' + s)), away.subject);
  const at = await p.$$eval('#cmdList li span:first-child', (s, want) => s.findIndex((x) => x.textContent.endsWith(': ' + want)), away.subject);
  await p.click(`#c-${at}`);
  await p.waitForFunction((s) => document.getElementById('subject')?.textContent === s, away.subject);
  await p.keyboard.press('s');
  const flagged = (id) => p.evaluate(async (i) => !!(await globalThis.PolycarpHubStore.thread(i))?.summary.flagged, id);
  let awayFlag = false;
  for (let i = 0; i < 30 && !awayFlag; i++) { await new Promise((r) => setTimeout(r, 100)); awayFlag = await flagged(away.id); }
  const rowFlag = await flagged(rowBefore);
  check(awayFlag && !rowFlag, 'S flags the conversation opened from search, not the highlighted row', { awayFlag, rowFlag, rowBefore });
  await p.keyboard.press('Escape');

  // Search: / opens the bar, matches come from the index over every message, Return shows them all as a list.
  await p.keyboard.press('/');
  await p.waitForSelector('#cmd[open]');
  await p.fill('#cmdIn', 'from:almanac');
  await p.waitForFunction(() => /every match/.test(document.querySelector('#cmdList li span')?.textContent || ''));
  const sopts = await p.$$eval('#cmdList li span:first-child', (s) => s.map((x) => x.textContent));
  check(sopts.length > 1 && sopts.slice(1).every((s) => s.startsWith('Garden Almanac:')), 'the bar shows matching mail under the search line', sopts);
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Search: from:almanac');
  const found = await rows(p);
  check(found.length > 1 && found.every((r) => /Garden Almanac/.test(r.label)), 'Return lists every match, bundled mail included', found.length);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Inbox');

  // HTML-only mail: shown as text, nothing in it runs or loads.
  await p.evaluate(async () => {
    window.__ran = 0;
    await globalThis.PolycarpHubStore.upsert('made-up', [{
      remoteId: 'hostile', messageId: '<hostile@x>', from: { name: 'Sender', addr: 'sender@example.com' }, to: [{ addr: 'me@home.example' }],
      subject: 'HTML only', date: Date.now() + 1000, folder: 'inbox', unread: true,
      html: '<style>p{color:red}</style><p>Plain words</p><img src="https://pixel.example/t.gif" onerror="window.__ran=1"><script>window.__ran=2</script><a href="javascript:window.__ran=3">x</a>'
    }]);
  });
  const reqs = [];
  p.on('request', (r) => { if (r.url().includes('pixel.example')) reqs.push(r.url()); });
  await p.waitForSelector('#rows [aria-label*="HTML only"]');
  await p.click('#rows [aria-label*="HTML only"]');
  await p.waitForFunction(() => document.getElementById('subject')?.textContent === 'HTML only');
  const body = await p.$eval('#pane .body', (b) => ({ text: b.textContent, kids: b.children.length }));
  const ran = await p.evaluate(() => window.__ran);
  check(body.text.includes('Plain words') && !body.text.includes('__ran') && body.kids === 0 && ran === 0 && reqs.length === 0, 'HTML-only mail shows as text, with nothing run or loaded', { body, ran, reqs });

  // It all comes back after a reload.
  await p.reload();
  await p.waitForSelector('#rows [role="option"]');
  check((await rows(p)).length > 0, 'the mail is still there after a reload', null);

  // Narrow: the list fills the page; a conversation opens over it and Back returns.
  await p.setViewportSize({ width: 390, height: 844 });
  const narrow = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, main: getComputedStyle(document.getElementById('pane')).display }));
  check(narrow.scroll <= 390 && narrow.main === 'none', 'at 390 px the list fills the page with no sideways scroll', narrow);
  if (process.env.SHOTS) for (const scheme of ['light', 'dark']) { await p.emulateMedia({ colorScheme: scheme }); await p.waitForTimeout(400); await p.screenshot({ path: path.join(process.env.SHOTS, `mail-list-390-${scheme}.png`) }); }
  await p.click('#rows .row');
  await p.waitForSelector('#subject');
  const open = await p.evaluate(() => ({ list: getComputedStyle(document.querySelector('.list')).display, focus: document.activeElement.id, scroll: document.documentElement.scrollWidth }));
  check(open.list === 'none' && open.focus === 'subject' && open.scroll <= 390, 'at 390 px a conversation fills the page and takes focus', open);
  if (process.env.SHOTS) for (const scheme of ['light', 'dark']) { await p.emulateMedia({ colorScheme: scheme }); await p.waitForTimeout(400); await p.screenshot({ path: path.join(process.env.SHOTS, `mail-thread-390-${scheme}.png`) }); }
  await p.click('#pane .back');
  await p.waitForFunction(() => getComputedStyle(document.querySelector('.list')).display !== 'none');
  check(true, 'Back returns to the list', null);
  check(errors.length === 0, 'no page errors', errors);
} catch (e) {
  check(false, 'the run finished', String(e && e.stack || e));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
