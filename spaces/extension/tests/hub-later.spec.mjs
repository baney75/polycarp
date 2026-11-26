// Later in Polycarp Mail, in Chromium on the made-up account: H snoozes a conversation out of the inbox and it comes
// back under "Back now"; W asks for a conversation back when no one replies; both undo, and both stay in this profile.
// Run: node tests/hub-later.spec.mjs   (SHOTS=<dir> also saves the picker and Back now at 1280 and 390 px)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-later-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + JSON.stringify(detail)}`); if (!ok) fails++; };
const errors = [];
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (!(v = await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return v; };
const shot = async (p, name) => {
  if (!process.env.SHOTS) return;
  await p.screenshot({ path: path.join(process.env.SHOTS, name + '-1280.png') });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({ path: path.join(process.env.SHOTS, name + '-390.png') });
  await p.setViewportSize({ width: 1280, height: 800 });
};

const thread = (p, id) => p.evaluate((i) => globalThis.PolycarpHubStore.thread(i), id);
const has = (p, id) => p.$(`#rows [data-thread="${id}"]`).then(Boolean);
const groupOf = (p, id) => p.evaluate((i) => document.querySelector(`#rows [data-thread="${i}"]`)?.closest('[role="group"]').querySelector('.group').textContent, id);
const tagOf = (p, id) => p.evaluate((i) => document.querySelector(`#rows [data-thread="${i}"] .tag`)?.textContent || '', id);
// Sets a field on every message of a thread, as time passing would leave it.
const setAll = (p, id, patch) => p.evaluate(async ([i, pa]) => { const S = globalThis.PolycarpHubStore; const g = await S.thread(i); await S.update(g.messages.map((m) => m.id), pa); }, [id, patch]);
const selectRow = async (p, id) => { await p.click(`#rows [data-thread="${id}"]`); await p.keyboard.press('Escape'); await p.waitForSelector('body:not(.reading)'); };

try {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(URL);
  await p.click('#tryFake');
  await p.waitForSelector('#rows [data-thread]');

  // H on the first conversation: the picker opens on its first choice, and 2 picks tomorrow morning.
  const first = await p.getAttribute('#rows [data-thread]', 'data-thread');
  await p.evaluate(() => document.getElementById('rows').focus());
  await p.keyboard.press('h');
  await p.waitForSelector('#later[open]');
  const picker = await p.evaluate(() => ({ title: document.getElementById('laterTitle').textContent, focus: document.activeElement.textContent, n: document.getElementById('laterChoices').children.length }));
  check(picker.title === 'Snooze until' && /^1 /.test(picker.focus) && picker.n >= 3, 'H opens the snooze picker with its first choice in focus', picker);
  await p.keyboard.press('e');
  check(await p.isVisible('#later') && (await thread(p, first)).summary.folder === 'inbox', 'list keys do nothing while the picker is open', null);
  await shot(p, 'later-picker');
  // "Later today" is left out late in the day, so the key for tomorrow morning is read from the picker.
  const key = await p.evaluate(() => [...document.getElementById('laterChoices').children].find((c) => /Tomorrow morning/.test(c.textContent)).textContent.trim()[0]);
  await p.keyboard.press(key);
  await p.waitForSelector('#later', { state: 'hidden' });
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  const snoozed = await until(async () => { const g = await thread(p, first); return g.messages.every((m) => m.snoozeUntil === tomorrow.getTime()) && g; }) || await thread(p, first);
  check(snoozed.messages.every((m) => m.snoozeUntil === tomorrow.getTime()), 'every message is snoozed until tomorrow at 8', snoozed.messages.map((m) => m.snoozeUntil));
  check(/^Snoozed until/.test(await p.textContent('#toastText')) && !(await until(async () => !(await has(p, first)))) === false, 'it leaves the inbox and the toast says until when', await p.textContent('#toastText'));
  check((await thread(p, first)).messages.every((m) => m.folder !== 'archive'), 'a snooze never tells the account to move it', null);

  // Z puts it back.
  await p.keyboard.press('z');
  check(!!(await until(() => has(p, first))) && (await thread(p, first)).summary.snoozeUntil === 0, 'Z brings it back to the inbox', null);

  // A picked time must be in the future; then it shows in Snoozed with when it comes back.
  await selectRow(p, first);
  await p.keyboard.press('h');
  await p.waitForSelector('#later[open]');
  await p.fill('#laterAt', '2001-01-01T09:00');
  await p.click('#laterSet');
  check(await p.isVisible('#later') && await p.getAttribute('#laterAt', 'aria-invalid') === 'true' && /after now/.test(await p.textContent('#laterErr')), 'a time in the past is refused and named', await p.textContent('#laterErr'));
  await p.fill('#laterAt', `${new Date().getFullYear() + 1}-03-04T09:30`);
  await p.click('#laterSet');
  await p.waitForSelector('#later', { state: 'hidden' });
  const want = new Date(new Date().getFullYear() + 1, 2, 4, 9, 30).getTime();
  check(!!(await until(async () => (await thread(p, first)).summary.snoozeUntil === want)), 'a picked day and time snoozes until then', (await thread(p, first)).summary.snoozeUntil);
  await p.keyboard.press('g'); await p.keyboard.press('h');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Snoozed');
  check(await until(() => has(p, first)) && /^Until /.test(await tagOf(p, first)), 'G then H lists it in Snoozed with when it comes back', await tagOf(p, first));

  // Time passes: it is back at the top of the inbox, and opening it ends that.
  await p.keyboard.press('g'); await p.keyboard.press('i');
  await setAll(p, first, { snoozeUntil: Date.now() - 1000 });
  check(await until(async () => (await groupOf(p, first)) === 'Back now'), 'when the snooze ends it leads the inbox under Back now', await groupOf(p, first));
  check(/^Snoozed until/.test(await tagOf(p, first)) && await p.evaluate(() => document.querySelector('#rows .group').textContent) === 'Back now', 'its row says it was snoozed, and Back now is the first group', await tagOf(p, first));
  await shot(p, 'later-back');
  await p.click(`#rows [data-thread="${first}"]`);
  check(!!(await until(async () => (await thread(p, first)).summary.snoozeUntil === 0)), 'opening it clears the snooze', null);
  await p.keyboard.press('Escape');
  check(!!(await until(async () => (await groupOf(p, first)) !== 'Back now')), 'and it leaves Back now', await groupOf(p, first));

  // New mail wakes a snoozed conversation at once.
  const other = await p.evaluate(() => [...document.querySelectorAll('#rows [data-thread]')][1].dataset.thread);
  await setAll(p, other, { snoozeUntil: Date.now() + 864e5 });
  await until(async () => !(await has(p, other)));
  const last = (await thread(p, other)).messages.at(-1);
  await p.evaluate((l) => globalThis.PolycarpHubStore.upsert('made-up', [{ remoteId: 'wake-1', messageId: '<wake-1@x>', inReplyTo: l.messageId, from: l.from, to: [{ addr: 'me@home.example' }], subject: 'Re: ' + l.subject, folder: 'inbox', unread: true, date: Date.now() }]), last);
  check(!!(await until(() => has(p, other))) && (await thread(p, other)).summary.snoozeUntil === 0, 'a new message in it brings it back', (await thread(p, other)).summary);

  // Only inbox mail snoozes; a reminder needs you to have written last.
  const theirs = await p.evaluate(async () => (await globalThis.PolycarpHubStore.threads({ folder: 'inbox', limit: 50 })).find((t) => t.lastDate > t.sentAt && !t.snoozeUntil).id);
  await selectRow(p, theirs);
  await p.keyboard.press('w');
  check(/where you wrote last/.test(await p.textContent('#toastText')) && !(await p.isVisible('#later')), 'W on a conversation they wrote last says why not', await p.textContent('#toastText'));

  // W on one you wrote last: back in the inbox if no one answers.
  const yours = await p.evaluate(async () => {
    const S = globalThis.PolycarpHubStore;
    await S.upsert('made-up', [{ remoteId: 'mine-1', messageId: '<mine-1@x>', folder: 'sent', unread: false, from: { addr: 'me@home.example' }, to: [{ name: 'Cleo Corran', addr: 'cleo.corran@example.com' }], subject: 'Quote for the fence', date: Date.now() - 2 * 36e5 }]);
    return (await S.message('made-up:mine-1')).threadId;
  });
  await p.keyboard.press('g'); await p.keyboard.press('s');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Sent');
  await selectRow(p, yours);
  await p.keyboard.press('h');
  check(/Only mail in the inbox/.test(await p.textContent('#toastText')), 'H outside the inbox says only inbox mail snoozes', await p.textContent('#toastText'));
  await p.keyboard.press('w');
  await p.waitForSelector('#later[open]');
  check(await p.textContent('#laterTitle') === 'Remind me if no one replies', 'W opens the reminder picker', await p.textContent('#laterTitle'));
  await p.keyboard.press('1');
  await p.waitForSelector('#later', { state: 'hidden' });
  await until(async () => (await thread(p, yours)).summary.remindAt > 0);
  const day = (await thread(p, yours)).summary.remindAt - Date.now();
  check(day > 864e5 - 6e4 && day <= 864e5 && /if no one replies$/.test(await p.textContent('#toastText')), '1 asks for it back in a day', day);
  check(/^Back .* if no reply$/.test(await until(() => tagOf(p, yours))), 'Sent shows when it comes back', await tagOf(p, yours));
  await p.keyboard.press('g'); await p.keyboard.press('i');
  await setAll(p, yours, { remindAt: Date.now() - 1000 });
  check(await until(async () => (await groupOf(p, yours)) === 'Back now') && /^No reply since/.test(await tagOf(p, yours)), 'with no reply by then it is back under Back now', await tagOf(p, yours));
  await p.evaluate(() => document.getElementById('rows').focus());
  await p.keyboard.press('Home');
  check(await p.getAttribute('#rows .sel', 'data-thread') === yours, 'Home selects it, first under Back now, without opening it', null);
  await p.keyboard.press('e');
  check(!!(await until(async () => !(await has(p, yours)))) && (await thread(p, yours)).summary.remindAt === 0 && /Done with it/.test(await p.textContent('#toastText')), 'E puts it away without moving your mail', await p.textContent('#toastText'));
  check((await thread(p, yours)).messages.every((m) => m.folder === 'sent' || m.folder !== 'archive'), 'nothing was archived', null);
  await p.keyboard.press('z');
  check(!!(await until(async () => (await groupOf(p, yours)) === 'Back now')), 'Z brings the reminder back', await groupOf(p, yours));

  // A slow inbox load that ends after a switch to Drafts doesn't draw the inbox under the Drafts name.
  await p.evaluate(() => {
    const S = globalThis.PolycarpHubStore;
    globalThis.__threads = S.threads;
    S.threads = async (q) => { const r = await globalThis.__threads(q); if (q.folder === 'inbox') await new Promise((ok) => setTimeout(ok, 800)); return r; };
  });
  await setAll(p, yours, { flagged: false });
  await new Promise((r) => setTimeout(r, 300));
  await p.keyboard.press('g'); await p.keyboard.press('d');
  await new Promise((r) => setTimeout(r, 1500));
  const drafts = await p.evaluate(() => ({ where: document.getElementById('where').textContent, threads: document.querySelectorAll('#rows [data-thread]').length }));
  check(drafts.where === 'Drafts' && drafts.threads === 0, 'a slower load begun before a switch is dropped', drafts);
  await p.evaluate(() => { globalThis.PolycarpHubStore.threads = globalThis.__threads; });
  check(errors.length === 0, 'no page errors', errors);

  // The page looks again each minute, so a snooze ends without a reload or new mail.
  const q = await ctx.newPage();
  await q.clock.install();
  q.on('pageerror', (e) => errors.push(String(e)));
  await q.goto(URL);
  await q.waitForSelector('#rows [data-thread]');
  const ticks = await q.evaluate(() => [...document.querySelectorAll('#rows [data-thread]')].find((o) => !o.closest('[role="group"]').querySelector('.group').textContent.startsWith('Back')).dataset.thread);
  await q.evaluate(async ([i, at]) => { const S = globalThis.PolycarpHubStore; const g = await S.thread(i); await S.update(g.messages.map((m) => m.id), { snoozeUntil: at }); }, [ticks, Date.now() + 30000]);
  await until(async () => !(await q.$(`#rows [data-thread="${ticks}"]`)));
  await q.clock.fastForward(61000);
  check(await until(async () => (await groupOf(q, ticks)) === 'Back now', 6000), 'the minute check brings a snooze back when its time comes', await groupOf(q, ticks));
  check(errors.length === 0, 'no page errors on the second page', errors);
} catch (e) {
  check(false, 'the run finished', String(e && e.stack || e));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
