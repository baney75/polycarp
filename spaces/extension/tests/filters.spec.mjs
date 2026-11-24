// Feed filters end to end (src/content/filters.js): feed pages served at their real addresses through Playwright
// routes, with rules written to the extension's storage. A matching post
// collapses to a bar that says why, Show reveals it for good, a post that matches nothing is untouched, a hide selector
// hides its element but never the page, and a rule change reaches an open page without a reload.
// Run: node tests/filters.spec.mjs   (screenshots to tests/out/)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { XFEED } from './fixtures/filters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-filters-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body });
await ctx.route('https://x.com/**', (r) => r.fulfill(html(XFEED)));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
  return fn();
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sleep(800);
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
  const setRules = (rules) => sw.evaluate((r) => chrome.storage.local.set({ 'polycarp.filters.local': r }), rules);
  const tabOf = (prefix) => sw.evaluate(async (u) => { const t = (await chrome.tabs.query({})).find((x) => (x.url || '').startsWith(u)); return t ? t.id : null; }, prefix);
  const state = (tabId) => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'polycarp:state' }, { frameId: 0 }).catch(() => null), tabId);

  // ---------- X: an open page takes rules as they change ----------
  const xp = await ctx.newPage();
  const errors = [];
  xp.on('pageerror', (e) => errors.push(String(e)));
  await xp.goto('https://x.com/home');
  const xTab = await until(() => tabOf('https://x.com/'));
  await until(async () => (await state(xTab))?.active);
  const tweets = () => xp.evaluate(() => [...document.querySelectorAll('article[data-testid=tweet]')].map((a) => {
    const b = a.querySelector(':scope > polycarp-filter-bar');
    return { who: a.querySelector('[data-testid=User-Name] span').textContent, collapsed: a.classList.contains('polycarp-filtered'),
      bar: b ? b.shadowRoot.textContent : '', barH: b ? Math.round(b.getBoundingClientRect().height) : 0, h: Math.round(a.getBoundingClientRect().height),
      textShown: a.querySelector('[data-testid=tweetText]').getClientRects().length > 0 };
  }));
  const before = Object.fromEntries((await tweets()).map((t) => [t.who, t]));
  ok(Object.values(before).every((t) => !t.collapsed && t.textShown), 'X: with no rules every post is shown');

  const X_RULE = { id: 'x1', enabled: true, sites: ['x.com'], words: ['crypto'], patterns: ['(a+)+'], accounts: ['spammer'],
    kinds: ['reposts', 'promoted'], hide: ['[data-testid=sidebarColumn]', 'body', 'html'] };
  const OTHER = [
    { id: 'y1', sites: ['youtube.com'], kinds: ['shorts', 'promoted'] },
    { id: 'r1', sites: ['reddit.com'], words: ['nba'], accounts: ['r/politics', 'u/spez'] },
    { id: 'm1', sites: ['mastodon.social'], accounts: ['bob'] }
  ];
  await setRules([X_RULE, ...OTHER]);
  const xs = await until(async () => { const t = Object.fromEntries((await tweets()).map((v) => [v.who, v])); return t.alice.collapsed && t.shop.collapsed ? t : null; });
  ok(xs && /Hidden: crypto/.test(xs.alice.bar) && /Show/.test(xs.alice.bar) && !xs.alice.textShown, `X: a post with the word collapses to a bar that says why (${xs && xs.alice.bar})`);
  ok(xs && xs.alice.barH > 0 && xs.alice.barH <= 36 && xs.alice.h < before.alice.h, `X: the bar is one slim line and the post shrinks to it (bar ${xs && xs.alice.barH}px, post ${xs && xs.alice.h}px from ${before.alice.h}px)`);
  ok(xs && /Hidden: @spammer/.test(xs.spammer.bar), 'X: a post by a filtered account collapses');
  ok(xs && /Hidden: Repost/.test(xs.dan.bar), 'X: a repost collapses by kind');
  ok(xs && /Hidden: Promoted/.test(xs.shop.bar), 'X: a promoted post collapses by kind');
  ok(xs && !xs.bob.collapsed && xs.bob.textShown && xs.bob.h === before.bob.h, `X: a post that matches nothing is untouched (${xs && xs.bob.h} = ${before.bob.h})`);
  const page1 = await xp.evaluate(() => ({ side: getComputedStyle(document.querySelector('[data-testid=sidebarColumn]')).display,
    body: getComputedStyle(document.body).display, html: getComputedStyle(document.documentElement).display }));
  ok(page1.side === 'none', 'X: a hide selector hides its element');
  ok(page1.body !== 'none' && page1.html !== 'none', 'X: a hide selector never hides the page body or html');
  const st = await state(xTab);
  ok(st && st.filters && st.filters.refused === 1 && st.filters.site === 'x', `X: the risky pattern is refused and the rest works (${JSON.stringify(st && st.filters)})`);
  await xp.screenshot({ path: path.join(OUT, 'filters-x.png') });

  await xp.locator('article[data-testid=tweet]').first().locator('polycarp-filter-bar button').click();
  let t = Object.fromEntries((await tweets()).map((v) => [v.who, v]));
  ok(!t.alice.collapsed && t.alice.textShown && !t.alice.bar, 'X: Show reveals the post with one click');

  // X drops a post that scrolls away and builds a new one when it comes back: the new one stays revealed.
  await xp.evaluate(() => { const a = document.querySelector('article[data-testid=tweet]'); const copy = a.cloneNode(true);
    copy.querySelector(':scope > polycarp-filter-bar')?.remove(); copy.classList.remove('polycarp-filtered'); a.replaceWith(copy); });
  await sleep(300);
  t = Object.fromEntries((await tweets()).map((v) => [v.who, v]));
  ok(!t.alice.collapsed && t.alice.textShown && !t.alice.bar, 'X: a revealed post the site builds again stays revealed');
  ok(await xp.evaluate(() => { const c = document.querySelector('article[data-testid=tweet]').cloneNode(true); c.classList.remove('polycarp-filtered');
    c.querySelector('[data-testid=User-Name] a[href*=status]').setAttribute('href', '/alice/status/2'); document.getElementById('tl').append(c); return true; })
    && await until(async () => (await tweets()).filter((v) => v.who === 'alice').some((v) => v.collapsed)), 'X: another post by the same account still collapses');
  await xp.evaluate(() => document.querySelector('a[href="/alice/status/2"]').closest('article').remove());

  await xp.evaluate(() => addPost('zed', 'More crypto talk from the feed'));
  ok(await until(async () => (await tweets()).find((v) => v.who === 'zed')?.collapsed), 'X: a post that arrives later (endless scroll) collapses too');

  await setRules([{ ...X_RULE, words: ['crypto', 'gardening'] }, ...OTHER]);
  t = await until(async () => { const v = Object.fromEntries((await tweets()).map((x) => [x.who, x])); return v.carol.collapsed ? v : null; });
  ok(t && /Hidden: gardening/.test(t.carol.bar), 'X: a rule change reaches the open page without a reload');
  ok(t && !t.alice.collapsed && t.alice.textShown, 'X: a revealed post stays revealed through a rule change');

  await setRules([{ ...X_RULE, enabled: false }, ...OTHER]);
  t = await until(async () => { const v = await tweets(); return v.every((x) => !x.collapsed) ? v : null; });
  ok(t && t.every((x) => x.textShown), 'X: turning the rule off shows every post again');
  ok(await xp.evaluate(() => getComputedStyle(document.querySelector('[data-testid=sidebarColumn]')).display !== 'none'), 'X: and the hidden element comes back');

  await setRules([X_RULE, ...OTHER]);
  await until(async () => (await tweets()).find((v) => v.who === 'spammer').collapsed);
  await sw.evaluate(async () => { const s = await Polycarp.getSettings(); s.pausedUntil = Date.now() + 3600e3; await Polycarp.setSettings(s); });
  ok(await until(async () => (await tweets()).every((x) => !x.collapsed)), 'X: pausing Polycarp pauses its filters too');
  await sw.evaluate(async () => { const s = await Polycarp.getSettings(); s.pausedUntil = 0; await Polycarp.setSettings(s); });
  ok(await until(async () => (await tweets()).find((v) => v.who === 'spammer').collapsed), 'X: resuming brings them back');
  ok(errors.length === 0 && (await xp.evaluate(() => window.errors.length)) === 0, 'X: no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  console.log('FAIL crashed: ' + (e && e.stack || e));
  fails++;
} finally {
  await ctx.close();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
