// Feed filters end to end (src/content/filters.js): X, YouTube Shorts, new and old Reddit and Mastodon pages served
// at their real addresses through Playwright routes, with rules written to the extension's storage. A matching post
// collapses to a bar that says why, Show reveals it for good, a post that matches nothing is untouched, a hide selector
// hides its element but never the page, and a rule change reaches an open page without a reload.
// Run: node tests/filters.spec.mjs   (screenshots to tests/out/)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { XFEED, YTHOME, REDDIT, OLDREDDIT, MASTODON, HN, BSKY, LINKEDIN } from './fixtures/filters.mjs';

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
await ctx.route('https://www.youtube.com/**', (r) => r.fulfill(html(YTHOME)));
await ctx.route('https://www.reddit.com/**', (r) => r.fulfill(html(REDDIT)));
await ctx.route('https://old.reddit.com/**', (r) => r.fulfill(html(OLDREDDIT)));
await ctx.route('https://mastodon.social/**', (r) => r.fulfill(html(MASTODON)));
await ctx.route('https://news.ycombinator.com/**', (r) => r.fulfill(html(HN)));
await ctx.route('https://bsky.app/**', (r) => r.fulfill(html(BSKY)));
await ctx.route('https://www.linkedin.com/**', (r) => r.fulfill(html(LINKEDIN)));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
  return fn();
}
// What the page shows for each post: collapsed (with the bar's words) or not, and whether its text is visible.
const view = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => {
  const target = el.closest('.polycarp-filtered') || el;
  const bar = target.querySelector(':scope > polycarp-filter-bar, :scope > td > polycarp-filter-bar');
  return { id: el.id, collapsed: target.classList.contains('polycarp-filtered'), bar: bar ? bar.shadowRoot.textContent : '',
    h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) };
}), sel);
const byId = (list) => Object.fromEntries(list.map((v) => [v.id, v]));

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
    { id: 'm1', sites: ['mastodon.social'], accounts: ['bob'] },
    { id: 'h1', sites: ['news.ycombinator.com'], words: ['crypto'], accounts: ['tptacek'] },
    { id: 'b1', sites: ['bsky.app'], accounts: ['bob.bsky.social'], kinds: ['reposts'] },
    { id: 'l1', sites: ['linkedin.com'], kinds: ['promoted'] }
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

  // ---------- YouTube: Shorts is the format, not the word ----------
  const yp = await ctx.newPage();
  await yp.goto('https://www.youtube.com/');
  const yt = await until(async () => { const v = byId(await view(yp, 'ytd-rich-item-renderer[id^=v], #shelf, #ad1')); return v.v2?.collapsed && v.shelf?.collapsed && v.ad1?.collapsed ? v : null; });
  ok(yt && /Hidden: Shorts/.test(yt.v2.bar), 'YouTube: a Shorts tile collapses');
  ok(yt && /Hidden: Shorts/.test(yt.shelf.bar), 'YouTube: the Shorts shelf collapses');
  ok(yt && /Hidden: Promoted/.test(yt.ad1.bar), 'YouTube: an ad in the feed collapses as promoted');
  ok(yt && !yt.v1.collapsed && !yt.v3.collapsed, 'YouTube: "running shorts" in a title is not a Short, and other videos are untouched');
  ok(yt && yt.v2.w === yt.v1.w, `YouTube: a collapsed tile keeps its place in the grid (${yt && yt.v2.w} = ${yt && yt.v1.w})`);
  await yp.screenshot({ path: path.join(OUT, 'filters-youtube.png') });

  // ---------- Reddit, new and old ----------
  const rp = await ctx.newPage();
  await rp.goto('https://www.reddit.com/');
  const rd = await until(async () => { const v = byId(await view(rp, 'article')); return v.a1?.collapsed && v.a2?.collapsed && v.a4?.collapsed ? v : null; });
  ok(rd && /@spez/.test(rd.a1.bar) && /@r\/politics/.test(rd.a2.bar) && /nba/i.test(rd.a4.bar), 'Reddit: posts by a user, in a subreddit and with a word collapse, the article around each');
  ok(rd && !rd.a3.collapsed, 'Reddit: a post that matches nothing is untouched');
  // Reddit's feed, like X's, builds a post again when it scrolls back: Show holds for the new copy.
  await rp.locator('#a1 polycarp-filter-bar button').click();
  await rp.evaluate(() => { const a = document.getElementById('a1'); const c = a.cloneNode(true);
    c.querySelector(':scope > polycarp-filter-bar')?.remove(); c.classList.remove('polycarp-filtered'); a.replaceWith(c); });
  await sleep(300);
  const rd2 = byId(await view(rp, 'article'));
  ok(!rd2.a1.collapsed && rd2.a2.collapsed, 'Reddit: a revealed post the feed builds again stays revealed, and the others stay hidden');
  const op = await ctx.newPage();
  await op.goto('https://old.reddit.com/');
  const od = await until(async () => { const v = byId(await view(op, 'div.thing')); return v.t1?.collapsed && v.t3?.collapsed ? v : null; });
  ok(od && !od.t2.collapsed, 'Old Reddit: the same rule collapses its posts and leaves the rest');

  // ---------- Mastodon: a boost is not the booster's post ----------
  const mp = await ctx.newPage();
  await mp.goto('https://mastodon.social/home');
  const md = await until(async () => { const v = byId(await view(mp, 'article')); return v.m2?.collapsed ? v : null; });
  ok(md && /@bob/.test(md.m2.bar), "Mastodon: bob's own post collapses");
  ok(md && !md.m1.collapsed && !md.m3.collapsed && !md.m4.collapsed, 'Mastodon: a mention of bob and a post bob boosted are not his');
  await setRules([X_RULE, ...OTHER, { id: 'm2', sites: ['mastodon.social'], kinds: ['reposts'] }]);
  ok(await until(async () => /Hidden: Repost/.test(byId(await view(mp, 'article')).m3.bar)), 'Mastodon: a reposts rule collapses the boost');
  await mp.screenshot({ path: path.join(OUT, 'filters-mastodon.png') });

  // ---------- Hacker News, Bluesky, LinkedIn ----------
  const hp = await ctx.newPage();
  await hp.goto('https://news.ycombinator.com/');
  const hd = await until(async () => { const v = byId(await view(hp, 'tr')); return v['1']?.collapsed && v['3']?.collapsed ? v : null; });
  ok(hd && /crypto/.test(hd['1'].bar) && /@tptacek/.test(hd['3'].bar) && !hd['2'].collapsed, 'Hacker News: a title word and a poster collapse their story; another stays');
  ok(hd && hd['1s'].h === 0 && hd['1p'].h === 0 && hd['2s'].h > 0, 'Hacker News: the byline and spacer rows go with the story');
  await hp.screenshot({ path: path.join(OUT, 'filters-hn.png') });
  const bp = await ctx.newPage();
  await bp.goto('https://bsky.app/');
  const bd = await until(async () => { const v = byId(await view(bp, '[data-testid^=feedItem-by-]')); return v.b2?.collapsed && v.b3?.collapsed ? v : null; });
  ok(bd && !bd.b1.collapsed && /@bob/.test(bd.b2.bar), "Bluesky: bob's post collapses; a post mentioning him does not");
  ok(bd && /Repost/.test(bd.b3.bar), 'Bluesky: a repost collapses by kind');
  const lp = await ctx.newPage();
  await lp.goto('https://www.linkedin.com/feed/');
  const ld = await until(async () => { const v = byId(await view(lp, '.feed-shared-update-v2')); return v.l2?.collapsed ? v : null; });
  ok(ld && /Promoted/.test(ld.l2.bar) && !ld.l1.collapsed && !ld.l3.collapsed, 'LinkedIn: a promoted post collapses; others stay');
} catch (e) {
  console.log('FAIL crashed: ' + (e && e.stack || e));
  fails++;
} finally {
  await ctx.close();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
