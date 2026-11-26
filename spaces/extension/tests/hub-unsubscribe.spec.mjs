// Leaving a list in Polycarp Mail, in Chromium on the made-up account: the exact request shows before anything goes,
// Cancel sends nothing, one click goes through the account (made-up mail never touches the network), a list that
// asks for an email opens a draft you send, and a hostile address gets no button at all.
// Run: node tests/hub-unsubscribe.spec.mjs   (SHOTS=<dir> also saves the dialog at 1280 and 390 px)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-unsub-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
// Nothing leaves this machine: every web request is stopped here and written down.
const web = [];
await ctx.route(/^https?:/, (r) => { web.push(r.request().method() + ' ' + r.request().url()); return r.abort(); });
let fails = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + JSON.stringify(detail)}`); if (!ok) fails++; };
const errors = [];
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (!(v = await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return v; };
const meta = (p, key) => p.evaluate((k) => globalThis.PolycarpHubStore.getMeta(k), key);
const deliver = (p, raw) => p.evaluate(async (r) => {
  const S = globalThis.PolycarpHubStore;
  await S.upsert('made-up', [Object.assign({ to: [{ addr: 'me@home.example' }], folder: 'inbox', unread: true, date: Date.now(), text: 'News.' }, r)]);
  return (await S.message('made-up:' + r.remoteId)).threadId;
}, raw);

try {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(URL);
  await p.click('#tryFake');
  await p.waitForSelector('#rows [data-bundle="newsletters"]');

  // A made-up newsletter: signed, with List-Unsubscribe-Post, so one click.
  await p.click('#rows [data-bundle="newsletters"]');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Newsletters');
  await p.click('#rows [data-thread]');
  await p.waitForSelector('#pane .leave button');
  const news = await p.evaluate(async () => {
    const id = document.querySelector('#rows .sel').dataset.thread;
    const g = await globalThis.PolycarpHubStore.thread(id);
    const m = g.messages.at(-1);
    return { id, acct: m.account, host: m.from.addr.split('@')[1], list: m.headers.listId.toLowerCase() };
  });
  const key = 'unsub:' + news.acct + ':' + news.list;
  check(await p.textContent('#pane .leave button') === 'Unsubscribe', 'a list conversation offers Unsubscribe', null);

  // The request is shown first; Cancel sends nothing.
  await p.click('#pane .leave button');
  await p.waitForSelector('#leave[open]');
  const shown = await p.evaluate(() => ({ req: document.getElementById('leaveReq').textContent, what: document.getElementById('leaveWhat').textContent, go: document.getElementById('leaveGo').textContent, focus: document.activeElement.id }));
  check(shown.req === `POST https://${news.host}/unsubscribe?u=1\n\nList-Unsubscribe=One-Click`, 'the dialog shows the exact request', shown.req);
  check(shown.what.includes('signed by ' + news.host) && /no cookies, sign-in or referrer/.test(shown.what) && shown.go === 'Send the request' && shown.focus === 'leaveGo', 'it says who signed the mail and what is left out', shown);
  await p.keyboard.press('e');
  check(await p.isVisible('#leave') && (await p.evaluate((i) => globalThis.PolycarpHubStore.summary(i), news.id)).folder === 'inbox', 'list keys do nothing while it is open', null);
  if (process.env.SHOTS) {
    await p.screenshot({ path: path.join(process.env.SHOTS, 'unsub-1280.png') });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({ path: path.join(process.env.SHOTS, 'unsub-390.png') });
    await p.setViewportSize({ width: 1280, height: 800 });
  }
  await p.click('#leaveCancel');
  await p.waitForSelector('#leave', { state: 'hidden' });
  check((await meta(p, key)) === undefined && web.length === 0, 'Cancel sends nothing', web);

  // Send: the made-up account takes it, the page remembers, and the button says so.
  await p.click('#pane .leave button');
  await p.waitForSelector('#leave[open]');
  await p.click('#leaveGo');
  const left = await until(() => meta(p, key));
  check(!!left && left.url === `https://${news.host}/unsubscribe?u=1`, 'Send the request records that the list was asked', left);
  check(new RegExp('^Asked ' + news.host.replace(/\./g, '\\.') + ' to take you off the list').test(await p.textContent('#toastText')), 'the toast names who was asked', await p.textContent('#toastText'));
  check(!!(await until(() => p.evaluate(() => { const b = document.querySelector('#pane .leave button'); return b && b.disabled && /^Unsubscribe request sent/.test(b.textContent); }))), 'the button now says the request went, and is off', null);
  check(web.length === 0, 'made-up mail never touched the network', web);

  // A list that asks for an email: a draft opens for you to send.
  await deliver(p, { remoteId: 'club-1', messageId: '<club-1@x>', from: { name: 'Book Club', addr: 'club@books.example' }, subject: 'This month', headers: { listId: 'Book Club <club.books.example>', listUnsubscribe: '<mailto:leave@books.example?subject=leave%20me>' } });
  await p.keyboard.press('Escape');
  await p.keyboard.press('Meta+k');
  await p.fill('#cmdIn', 'This month');
  await p.waitForFunction(() => [...document.querySelectorAll('#cmdList li span')].some((s) => s.textContent === 'Book Club: This month'));
  const at = await p.$$eval('#cmdList li span:first-child', (s) => s.findIndex((x) => x.textContent === 'Book Club: This month'));
  await p.click(`#c-${at}`);
  await p.waitForFunction(() => document.getElementById('subject')?.textContent === 'This month');
  await p.keyboard.press('Meta+k');
  await p.fill('#cmdIn', 'unsubscribe');
  await p.keyboard.press('Enter');
  await p.waitForSelector('#leave[open]');
  check(await p.textContent('#leaveReq') === 'To: leave@books.example\nSubject: leave me' && await p.textContent('#leaveGo') === 'Write it', 'the command bar opens it, and an email list shows the message to send', await p.textContent('#leaveReq'));
  await p.click('#leaveGo');
  await p.waitForSelector('form.compose');
  check(await p.inputValue('form.compose [name=to]') === 'leave@books.example' && await p.inputValue('form.compose [name=subject]') === 'leave me', 'Write it opens a draft to the list, for you to send', null);
  check((await meta(p, 'unsub:' + news.acct + ':book club <club.books.example>')) === undefined, 'nothing is marked sent until you send it', null);

  // A hostile address gets no button, and the command bar says why.
  await p.keyboard.press('Escape');
  await deliver(p, { remoteId: 'bad-1', messageId: '<bad-1@x>', from: { name: 'Router News', addr: 'news@almanac.example' }, subject: 'Hello router', headers: { listId: 'x <x.almanac.example>', listUnsubscribe: '<https://192.168.1.1/reset>', listUnsubscribePost: 'List-Unsubscribe=One-Click', authResults: 'mx; dkim=pass header.d=almanac.example' } });
  await p.keyboard.press('Meta+k');
  await p.fill('#cmdIn', 'Hello router');
  await p.waitForFunction(() => [...document.querySelectorAll('#cmdList li span')].some((s) => s.textContent === 'Router News: Hello router'));
  const at2 = await p.$$eval('#cmdList li span:first-child', (s) => s.findIndex((x) => x.textContent === 'Router News: Hello router'));
  await p.click(`#c-${at2}`);
  await p.waitForFunction(() => document.getElementById('subject')?.textContent === 'Hello router');
  check(!(await p.$('#pane .leave')), 'an address on a home network gets no Unsubscribe', null);
  await p.keyboard.press('Meta+k');
  await p.fill('#cmdIn', 'unsubscribe');
  await p.keyboard.press('Enter');
  check(/doesn't say how to leave/.test(await until(async () => { const t = await p.textContent('#toastText'); return /leave/.test(t) && t; })) && !(await p.isVisible('#leave')), 'the command bar says it has no way to leave', await p.textContent('#toastText'));
  check(web.length === 0, 'still nothing went to the network', web);
  check(errors.length === 0, 'no page errors', errors);
} catch (e) {
  check(false, 'the run finished', String(e && e.stack || e));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
