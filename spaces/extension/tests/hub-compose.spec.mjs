// Writing in Polycarp Mail on the made-up account, with a fake clock: drafts kept as you type and after a reload,
// undo send, a reply that joins its conversation, an agent's draft marked and never sent on its own, and discard.
// Run: node tests/hub-compose.spec.mjs   (SHOTS=<dir> also saves screenshots)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-compose-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + JSON.stringify(detail)}`); if (!ok) fails++; };
const errors = [];
const sentWith = (p, subject) => p.evaluate(async (s) => (await globalThis.PolycarpHubStore.allMessages()).filter((m) => m.folder === 'sent' && m.subject === s).length, subject);
const drafts = (p) => p.evaluate(async () => (await globalThis.PolycarpHubStore.drafts()).map((d) => ({ subject: d.subject, text: d.text, by: d.by })));
const shot = async (p, name) => { if (process.env.SHOTS) for (const scheme of ['light', 'dark']) { await p.emulateMedia({ colorScheme: scheme }); await p.waitForTimeout(400); await p.screenshot({ path: path.join(process.env.SHOTS, `${name}-${scheme}.png`) }); } await p.emulateMedia({ colorScheme: 'light' }); };

try {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.clock.install();
  await p.goto(URL);
  await p.waitForSelector('#tryFake:not([hidden])');
  await p.click('#tryFake');
  await p.waitForSelector('#rows [role="option"]');

  // New mail: C opens it, typing is kept as a draft, and keys typed into it stay text.
  await p.focus('#rows');
  await p.keyboard.press('c');
  await p.waitForSelector('form.compose');
  check((await p.evaluate(() => document.activeElement.name)) === 'to', 'C opens new mail with the cursor in To', null);
  await p.keyboard.type('ada@example.com');
  await p.fill('form.compose [name=subject]', 'Garden plan');
  await p.focus('form.compose [name=text]');
  await p.keyboard.type('jkez Bring the seeds.');
  await p.clock.runFor(600);
  await p.waitForSelector('form.compose .saved:has-text("Draft saved")');
  check((await p.textContent('#toastText')) !== 'Archived' && (await drafts(p))[0]?.text === 'jkez Bring the seeds.', 'what you type is saved as a draft, and J K E Z typed there stay text', await drafts(p));
  await shot(p, 'compose-1280');

  // A reload keeps the draft; G then D lists it, Return opens it with what was typed.
  await p.reload();
  await p.waitForSelector('#rows [role="option"]');
  await p.focus('#rows');
  await p.keyboard.press('g');
  await p.keyboard.press('d');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Drafts');
  const label = await p.getAttribute('#rows [role="option"]', 'aria-label');
  check(/^Draft, To ada@example\.com, Garden plan/.test(label), 'G then D lists the draft after a reload', label);
  await p.keyboard.press('Enter');
  await p.waitForSelector('form.compose');
  check((await p.inputValue('form.compose [name=text]')) === 'jkez Bring the seeds.', 'a draft opens again with its text', null);

  // Send waits; Z takes it back to the form; Send again goes after the wait.
  await p.focus('form.compose [name=text]');
  await p.keyboard.press('Meta+Enter');
  await p.waitForSelector('#toast:not([hidden])');
  check((await p.textContent('#toastText')) === 'Sending in 10 seconds' && !(await p.$('form.compose')), 'Command Return starts a send you can take back', await p.textContent('#toastText'));
  await p.keyboard.press('z');
  await p.waitForSelector('form.compose');
  await p.clock.runFor(11000);
  check((await sentWith(p, 'Garden plan')) === 0 && (await drafts(p)).length === 1, 'Z takes the send back and nothing leaves', await drafts(p));
  await p.click('form.compose button[type=submit]');
  await p.clock.runFor(9000);
  check((await sentWith(p, 'Garden plan')) === 0, 'nothing leaves before the wait ends', null);
  await p.clock.runFor(2000);
  await p.waitForFunction(() => document.getElementById('toastText').textContent === 'Sent');
  check((await sentWith(p, 'Garden plan')) === 1 && (await drafts(p)).length === 0, 'after the wait it is sent and leaves Drafts', await drafts(p));

  // Reply: R under a conversation from a person, to that person, joining the conversation.
  await p.keyboard.press('g');
  await p.keyboard.press('i');
  await p.waitForFunction(() => document.getElementById('where').textContent === 'Inbox');
  await p.focus('#rows');
  await p.keyboard.press('Enter');
  await p.waitForSelector('#subject');
  const before = await p.$$eval('#pane .msg', (m) => m.length);
  const sender = await p.$eval('#pane .msg:last-of-type .mh b', (b) => b.textContent);
  await p.focus('#rows');
  await p.keyboard.press('r');
  await p.waitForSelector('#pane .thread form.compose');
  const to = await p.inputValue('form.compose [name=to]');
  check(to.length > 3 && (await p.evaluate(() => document.activeElement.name)) === 'text', 'R opens a reply under the conversation, addressed, with the cursor in the text', { to, sender });
  await p.keyboard.type('Thank you, that works.');
  await p.clock.runFor(700);
  await p.waitForSelector('#pane form.compose .saved:has-text("Draft saved")');
  const kept = await p.evaluate(() => ({ text: document.querySelector('#pane form.compose [name=text]')?.value, primary: Array.from(document.querySelectorAll('#pane .btn.primary')).filter((b) => b.offsetParent).length }));
  check(kept.text === 'Thank you, that works.' && kept.primary === 1, 'a reply survives its own autosave, with Send the only filled button', kept);
  await shot(p, 'reply-1280');
  await p.keyboard.press('Control+Enter');
  await p.clock.runFor(11000);
  await p.waitForFunction((n) => document.querySelectorAll('#pane .msg').length === n + 1, before);
  const last = await p.$eval('#pane .msg:last-of-type', (m) => ({ from: m.querySelector('.mh b').textContent, body: m.querySelector('.body').textContent }));
  check(last.from === 'Me' && last.body === 'Thank you, that works.', 'the reply joins the conversation', last);

  // An agent's draft is marked, opens with a notice, and is not sent by anything but Send.
  await p.evaluate(() => globalThis.PolycarpHubStore.saveDraft({ account: 'made-up', to: 'bo@example.com', subject: 'From a helper', text: 'Draft text', by: 'agent:test' }));
  await p.clock.runFor(70000);
  await p.focus('#rows');
  await p.keyboard.press('g');
  await p.keyboard.press('d');
  await p.waitForSelector('#rows [aria-label^="Draft by an agent"]');
  await p.click('#rows [aria-label^="Draft by an agent"]');
  await p.waitForSelector('form.compose .agent');
  check((await sentWith(p, 'From a helper')) === 0, 'an agent draft is marked, says so when opened, and a minute later is still unsent', null);
  await shot(p, 'agent-draft-1280');

  // Discard removes it; Escape closes and keeps the draft.
  await p.click('form.compose .btn.quiet');
  await p.waitForFunction(() => document.getElementById('toastText').textContent === 'Draft discarded');
  check((await drafts(p)).length === 0, 'Discard removes the draft', await drafts(p));
  await p.keyboard.press('c');
  await p.waitForSelector('form.compose');
  await p.keyboard.type('cy@example.com');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('form.compose'));
  await p.waitForFunction(async () => (await globalThis.PolycarpHubStore.drafts()).some((d) => d.to.length)).catch(() => {});
  const esc = await p.evaluate(async () => (await globalThis.PolycarpHubStore.drafts()).map((d) => d.to.map((a) => a.addr).join()));
  check(esc.length === 1 && esc[0] === 'cy@example.com', 'Escape closes the form and keeps what was typed', esc);
  const noOne = await p.evaluate(async () => { const S = globalThis.PolycarpHubStore; const d = await S.saveDraft({ account: 'made-up', subject: 'Nobody' }); return d.id; });
  await p.click(`#rows [data-draft="${noOne}"]`).catch(() => {});
  await p.waitForSelector('form.compose');
  await p.click('form.compose button[type=submit]');
  await p.waitForFunction(() => document.getElementById('toastText').textContent === 'Add someone to send it to.');
  check(!!(await p.$('form.compose')), 'a draft with no one to send to stays open and says why', null);

  // Closing during the wait asks first; reloaded anyway, the send waits out its time and goes once.
  await p.keyboard.press('Escape');
  const asked = [];
  const onDialog = (d) => { asked.push(d.type()); d.accept().catch(() => {}); };
  p.on('dialog', onDialog);
  await p.focus('#rows');
  await p.keyboard.press('c');
  await p.waitForSelector('form.compose');
  await p.keyboard.type('di@example.com');
  await p.fill('form.compose [name=subject]', 'Left early');
  await p.focus('form.compose [name=text]');
  await p.keyboard.press('Meta+Enter');
  await p.waitForFunction(() => document.getElementById('toastText').textContent === 'Sending in 10 seconds');
  await p.clock.runFor(3000);
  await p.reload();
  await p.waitForSelector('#rows [role="option"]');
  await p.waitForFunction(() => /still waiting to go/.test(document.getElementById('toastText').textContent));
  check(asked.includes('beforeunload'), 'closing the page during the wait asks first', asked);
  check((await sentWith(p, 'Left early')) === 0, 'after a reload the send still waits out its time', null);
  await p.clock.runFor(8000);
  await p.waitForFunction(() => document.getElementById('toastText').textContent === 'Sent');
  const left = await drafts(p);
  check((await sentWith(p, 'Left early')) === 1 && !left.some((d) => d.subject === 'Left early'), 'then it goes, once, and leaves Drafts', left);
  p.off('dialog', onDialog);

  // A slow inbox load that ends after a switch to Drafts doesn't draw the inbox under the Drafts name.
  await p.evaluate(() => {
    const S = globalThis.PolycarpHubStore;
    globalThis.__threads = S.threads;
    S.threads = async (q) => { const r = await globalThis.__threads(q); if (q.folder === 'inbox') await new Promise((ok) => setTimeout(ok, 800)); return r; };
  });
  await p.evaluate(async () => { const S = globalThis.PolycarpHubStore; const t = (await globalThis.__threads({ folder: 'inbox', limit: 1 }))[0]; const g = await S.thread(t.id); await S.update(g.messages.map((m) => m.id), { flagged: !t.flagged }); });
  await new Promise((r) => setTimeout(r, 300));
  await p.focus('#rows');
  await p.keyboard.press('g');
  await p.keyboard.press('d');
  await new Promise((r) => setTimeout(r, 1500));
  const switched = await p.evaluate(() => ({ where: document.getElementById('where').textContent, threads: document.querySelectorAll('#rows [data-thread]').length }));
  check(switched.where === 'Drafts' && switched.threads === 0, 'a slower load begun before a switch is dropped', switched);
  await p.evaluate(() => { globalThis.PolycarpHubStore.threads = globalThis.__threads; });

  // Narrow: new mail fills the page without sideways scroll.
  await p.keyboard.press('Escape');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.focus('#rows');
  await p.keyboard.press('c');
  await p.waitForSelector('form.compose');
  const narrow = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, list: getComputedStyle(document.querySelector('.list')).display }));
  check(narrow.scroll <= 390 && narrow.list === 'none', 'at 390 px new mail fills the page with no sideways scroll', narrow);
  await shot(p, 'compose-390');
  check(errors.length === 0, 'no page errors', errors);
} catch (e) {
  check(false, 'the run finished', String(e && e.stack || e));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
