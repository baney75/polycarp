// Rules in Polycarp Mail, in Chromium on the made-up account: the editor names each problem by its line and won't
// save until they're fixed, a bundle rule moves a newsletter back with people, and rules act on new mail only.
// Run: node tests/hub-rules.spec.mjs   (SHOTS=<dir> also saves the editor at 1280 and 390 px)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-rules-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + JSON.stringify(detail)}`); if (!ok) fails++; };
const errors = [];
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (!(v = await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return v; };

async function openRules(p) {
  await p.keyboard.press('Meta+k');
  await p.waitForSelector('#cmd[open]');
  await p.fill('#cmdIn', 'edit rules');
  await p.waitForFunction(() => document.querySelector('#cmdList li span')?.textContent === 'Edit rules');
  await p.keyboard.press('Enter');
  await p.waitForSelector('#rules[open]');
}
const message = (p, id) => p.evaluate((i) => globalThis.PolycarpHubStore.message(i), id);
const deliver = (p, raw) => p.evaluate((r) => globalThis.PolycarpHubStore.upsert('made-up', [Object.assign({ to: [{ addr: 'me@home.example' }], folder: 'inbox', unread: true, date: Date.now() }, r)]), raw);

try {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(URL);
  await p.click('#tryFake');
  await p.waitForSelector('#rows [data-bundle="newsletters"]');
  const nlBefore = await p.$$eval('#rows [aria-label*="Garden Almanac"]', (os) => os.length);
  check(nlBefore === 0, 'the almanac starts folded into Newsletters', nlBefore);

  // The editor opens from the command bar with the example as notes, and takes focus.
  await openRules(p);
  check(await p.evaluate(() => document.activeElement.id) === 'rulesText' && (await p.inputValue('#rulesText')).startsWith('#'), 'Edit rules opens the editor with notes to start from', null);

  // A problem is named by its line, and Save keeps the editor open.
  await p.fill('#rulesText', 'list:almanac then keep with people\nfrom:ada then shout');
  await p.click('#rulesSave');
  const errs = await p.$$eval('#rulesErr li', (ls) => ls.map((l) => l.textContent));
  check(errs.length === 1 && errs[0].startsWith('Line 2:') && /shout/.test(errs[0]) && await p.isVisible('#rules'), 'a line with a problem is named and nothing is saved', errs);
  check(await p.getAttribute('#rulesText', 'aria-invalid') === 'true' && (await p.evaluate(() => globalThis.PolycarpHubStore.getMeta('rules'))) === undefined, 'the box says it is invalid and the store has no rules', null);
  if (process.env.SHOTS) {
    await p.screenshot({ path: path.join(process.env.SHOTS, 'rules-1280.png') });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({ path: path.join(process.env.SHOTS, 'rules-390.png') });
    await p.setViewportSize({ width: 1280, height: 800 });
  }

  // Fixed and saved with Command Return: the almanac comes back to the list with people.
  const old = await p.evaluate(async () => (await globalThis.PolycarpHubStore.allMessages()).find((m) => /^ada\./.test(m.from.addr) && m.folder === 'inbox'));
  await p.fill('#rulesText', 'list:almanac then keep with people\nfrom:ada then flag, archive');
  await p.focus('#rulesText');
  await p.keyboard.press('Meta+Enter');
  await p.waitForSelector('#rules', { state: 'hidden' });
  check(/2 rules saved/.test(await p.textContent('#toastText')), 'Command Return saves and says how many rules', await p.textContent('#toastText'));
  const nlAfter = await until(() => p.$$eval('#rows [aria-label*="Garden Almanac"]', (os) => os.length));
  check(nlAfter > 0, 'a bundle rule puts the almanac back with people', nlAfter);

  // Old mail is left alone; new mail from Ada is flagged and archived through the account.
  const oldNow = await message(p, old.id);
  check(oldNow.folder === 'inbox' && oldNow.flagged === old.flagged, 'rules leave mail that was there before they were saved', { old, oldNow });
  await deliver(p, { remoteId: 'new-ada', messageId: '<new-ada@x>', from: { name: 'Ada Arden', addr: 'ada.arden@example.com' }, subject: 'Fresh news' });
  await deliver(p, { remoteId: 'new-cleo', messageId: '<new-cleo@x>', from: { name: 'Cleo Corran', addr: 'cleo.corran@example.com' }, subject: 'Other news' });
  const ada = await until(async () => { const m = await message(p, 'made-up:new-ada'); return m && m.folder === 'archive' && m.flagged && m; });
  check(!!ada, 'new mail that matches is flagged and archived', await message(p, 'made-up:new-ada'));
  const cleo = await message(p, 'made-up:new-cleo');
  check(cleo.folder === 'inbox' && !cleo.flagged, 'new mail that does not match is left alone', cleo);
  // Mail filed elsewhere is flagged but stays where it is; mail in Sent gets no rules at all.
  await deliver(p, { remoteId: 'sent-ada', messageId: '<sent-ada@x>', folder: 'sent', unread: false, from: { name: 'Ada Arden', addr: 'ada.arden@example.com' }, subject: 'A copy' });
  await deliver(p, { remoteId: 'filed-ada', messageId: '<filed-ada@x>', folder: 'lists', from: { name: 'Ada Arden', addr: 'ada.arden@example.com' }, subject: 'Filed news' });
  await until(async () => { const m = await message(p, 'made-up:filed-ada'); return m && m.flagged; });
  await new Promise((r) => setTimeout(r, 600)); // an archive would come right after the flag
  const filed = await message(p, 'made-up:filed-ada');
  check(filed.flagged && filed.folder === 'lists', 'a rule flags mail outside the inbox but archives only from the inbox', await message(p, 'made-up:filed-ada'));
  const sent = await message(p, 'made-up:sent-ada');
  check(sent.folder === 'sent' && !sent.flagged, 'mail in Sent gets no rules', sent);
  await deliver(p, { remoteId: 'late-ada', messageId: '<late-ada@x>', from: { name: 'Ada Arden', addr: 'ada.arden@example.com' }, subject: 'From last month', date: Date.now() - 30 * 86400000 });
  await new Promise((r) => setTimeout(r, 600));
  const late = await message(p, 'made-up:late-ada');
  check(late.folder === 'inbox' && !late.flagged, 'older mail that arrives late, dated before the rules, is left alone', late);

  // The rules last across a reload, and the editor shows them as saved.
  await p.reload();
  await p.waitForSelector('#rows [role="option"]');
  await openRules(p);
  check((await p.inputValue('#rulesText')) === 'list:almanac then keep with people\nfrom:ada then flag, archive', 'the rules come back as written after a reload', await p.inputValue('#rulesText'));
  await p.keyboard.press('e');
  check((await p.inputValue('#rulesText')).endsWith('e') && (await p.$$eval('#rows [role="option"]', (os) => os.length)) > 0, 'keys type into the editor and do not act on the list', null);
  const archived = () => p.evaluate(async () => (await globalThis.PolycarpHubStore.allMessages()).filter((m) => m.folder === 'archive').length);
  const before = await archived();
  await p.focus('#rulesSave');
  await p.keyboard.press('e');
  await new Promise((r) => setTimeout(r, 600));
  check(await archived() === before && await p.isVisible('#rules'), 'E on a button in the editor archives nothing', { before, after: await archived() });
  await p.click('#rulesCancel');
  check(!(await p.$('#rules[open]')), 'Cancel closes the editor', null);
  check(errors.length === 0, 'no page errors', errors);
} catch (e) {
  check(false, 'the run finished', String(e && e.stack || e));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
