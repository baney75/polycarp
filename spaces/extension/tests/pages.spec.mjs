// End-to-end check of Polycarp's pages (welcome, review, settings, popup, reader landing) and the
// content script on a real http page, in the unpacked extension. Also runs the web-design-bar
// design check on every page at 390 and 1280, light and dark.
// Run: node tests/pages.spec.mjs   (writes screenshots and design-check.json to tests/out/)
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHECK = path.join(os.homedir(), '.claude/skills/web-design-bar/scripts/design_check.js');
const checkSrc = fs.existsSync(CHECK) ? fs.readFileSync(CHECK, 'utf8') : null;

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Sample article</title></head>
<body style="font-family:Georgia;max-width:40em;margin:2em auto"><h1>The water cycle</h1>
<p>Water moves between the oceans, the air and the land in a loop that never stops. The sun warms the sea and lifts water into the air as vapor.</p>
<p style="text-align:justify;font-style:italic;font-size:11px">As the vapor rises it cools and gathers into clouds, and when the drops grow heavy they fall back as rain or snow.</p>
<p>Rivers carry much of that water back to the sea, and the loop begins again.</p>
<div id="ce" contenteditable="true"><p>First paragraph inside the editor box.</p></div>
<div id="ce2" contenteditable="true"></div>
<div id="late"><p>This block turns into an editor after the page loads.</p></div></body></html>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(ARTICLE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}/`;

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-pw-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const design = {};

async function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}
async function check(page, name, width) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, `${name}-${width}-${scheme}.png`), fullPage: true });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(over <= 1, `${name} ${width} ${scheme}: no sideways scroll (${over}px over)`);
    if (checkSrc) design[`${name}-${width}-${scheme}`] = JSON.parse(await page.evaluate(checkSrc));
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const X = (p) => `chrome-extension://${id}/${p}`;

  // Install opens the welcome page.
  await new Promise((r) => setTimeout(r, 1000));
  ok(ctx.pages().some((p) => p.url().includes('welcome.html')), 'install opens the welcome page');
  for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();

  // ---------- Welcome ----------
  const page = await ctx.newPage();
  let errors = await watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(X('src/pages/welcome.html'));
  await page.waitForSelector('#evidence li');
  const w = await page.evaluate(() => ({
    rows: document.querySelectorAll('#evidence li').length,
    links: document.querySelectorAll('#evidence cite a[href^="https://doi.org/"]').length,
    levels: [...document.querySelectorAll('#evidence .lvl')].map((x) => x.className.split(' ')[1]),
    chips: document.querySelectorAll('#profiles .chip').length,
    pressed: document.querySelector('#profiles .chip[aria-pressed="true"]')?.dataset.id,
    anchors: document.querySelectorAll('#sampleText polycarp-b').length,
    ver: document.getElementById('ver').textContent,
    text: document.body.innerText
  }));
  ok(w.rows === 14 && w.links === 17, `evidence lists ${w.rows} features with ${w.links} DOI links`);
  ok(w.levels.includes('weak') && w.levels.includes('strong'), 'evidence shows both strong and weak levels');
  ok(w.chips === 5 && w.pressed === 'everyday', `profile chips render, default ${w.pressed}`);
  ok(w.anchors > 10, `live sample has bold anchors (${w.anchors})`);
  ok(w.ver === JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version, 'what is new shows the version');
  ok(!/photographic memory/i.test(w.text.replace(/Photographic memory\.\s/, '')) || /does not promise/i.test(w.text), 'photographic memory appears only as a non-promise');
  ok(!/[\u2013\u2014]/.test(w.text), 'welcome copy has no en or em dashes');

  await page.click('#profiles .chip[data-id="dyslexia"]');
  await page.waitForTimeout(200);
  const d = await page.evaluate(async () => ({
    stored: (await chrome.storage.local.get('polycarp.settings'))['polycarp.settings'].profile,
    font: getComputedStyle(document.getElementById('sampleText')).fontFamily,
    tint: document.getElementById('sample').style.getPropertyValue('--tint')
  }));
  ok(d.stored === 'dyslexia', 'picking Clear saves the dyslexia profile');
  ok(/Lexend/.test(d.font) && /F7D154/i.test(d.tint), `sample switches to Lexend with a cream tint (${d.tint})`);
  await page.click('#profiles .chip[data-id="everyday"]');
  await check(page, 'welcome', 1280);
  await page.goto(X('src/pages/welcome.html#science'));
  await page.waitForTimeout(300);
  const top = await page.evaluate(() => document.getElementById('science').getBoundingClientRect().top);
  ok(top >= 0 && top < 120, `#science link lands on the section (top ${Math.round(top)})`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(X('src/pages/welcome.html'));
  await page.waitForSelector('#evidence li');
  await check(page, 'welcome', 390);
  ok(errors.length === 0, 'welcome: no page errors ' + errors.join(' | '));

  // ---------- Review ----------
  const rv = await ctx.newPage();
  errors = await watch(rv);
  await rv.setViewportSize({ width: 1280, height: 900 });
  await rv.goto(X('src/pages/review.html'));
  await rv.waitForSelector('#headline');
  ok(/empty/i.test(await rv.textContent('#headline')), 'review shows the empty garden first');
  await check(rv, 'review-empty', 1280);
  await rv.evaluate(async () => {
    const M = PolycarpMemory, now = Date.now();
    const mk = (f) => Object.assign(M.newCard(f, now - 2 * 864e5), { due: now - 1000 });
    await M.addMany([
      mk({ type: 'cloze', prompt: 'The sun lifts water into the air as _____.', answer: 'vapor', context: 'The sun warms the sea and lifts water into the air as vapor.', source: { title: 'Water', docKey: 'a' } }),
      mk({ type: 'cloze', prompt: 'Rivers carry water back to the _____.', answer: 'sea', source: { title: 'Water', docKey: 'a' } }),
      mk({ type: 'gist', prompt: 'What keeps the water cycle going?', answer: 'The sun warms the sea and the water loops back by rivers.', source: { title: 'Notes', docKey: 'b' } })
    ]);
  });
  await rv.reload();
  await rv.waitForSelector('#go');
  ok(/3 ideas are ready/.test(await rv.textContent('#headline')), 'review counts 3 due ideas');
  await rv.click('#go');
  let graded = 0;
  for (let i = 0; i < 6 && !(await rv.isVisible('#done')); i++) {
    await rv.waitForSelector('#card #ans, #done:not([hidden])');
    if (await rv.isVisible('#done')) break;
    const isCloze = await rv.evaluate(() => document.getElementById('ans').tagName === 'INPUT');
    if (isCloze) {
      const prompt = await rv.textContent('#card .prompt');
      await rv.fill('#ans', /vapor|air/.test(prompt) ? 'vapour' : 'ocean');
      await rv.press('#ans', 'Enter');
      const close = await rv.locator('#card [data-r="got"]').count();
      if (close) { await rv.keyboard.press('3'); await rv.locator('#card [data-r="close"]').click(); }
    } else {
      await rv.fill('#ans', 'the sun and rivers');
      await rv.press('#ans', 'Enter');
      await rv.waitForSelector('#card [data-r]');
      await rv.keyboard.press('2');
      ok(await rv.inputValue('#ans') === 'the sun and rivers', 'after Enter, the grade keys grade instead of typing into the answer');
    }
    graded++;
    await rv.waitForSelector('#next');
    if (graded === 1) await check(rv, 'review-card', 1280);
    await rv.click('#next');
  }
  await rv.waitForSelector('#done:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok(await rv.isVisible('#done'), `review session finishes after ${graded} answers`);
  const after = await rv.evaluate(async () => (await PolycarpMemory.load()).map((c) => ({ t: c.tier, due: c.due - Date.now(), r: c.reviews })));
  ok(after.every((c) => c.r === 1 && c.due > 0), 'every reviewed idea is rescheduled into the future');
  ok(errors.length === 0, 'review: no page errors ' + errors.join(' | '));
  await rv.setViewportSize({ width: 390, height: 844 });
  await rv.goto(X('src/pages/review.html'));
  await rv.waitForSelector('#headline');
  await check(rv, 'review', 390);

  // A card missed again and again is offered a rewording; saving it resets its slips.
  await rv.setViewportSize({ width: 1280, height: 900 });
  const leechIds = await rv.evaluate(async () => {
    const M = PolycarpMemory, now = Date.now();
    for (const c of await M.load()) await M.remove(c.id);
    const mk = (f) => Object.assign(M.newCard(f, now - 9 * 864e5), { due: now - 1000, tier: 2, lapses: 3, reviews: 6 });
    const a = mk({ type: 'gist', prompt: 'Why do rivers flow to the sea?', answer: 'Gravity pulls water downhill.', source: { title: 'Rivers', docKey: 'r' } });
    const b = mk({ type: 'gist', prompt: 'What is a watershed?', answer: 'Land that drains into one river.', source: { title: 'Rivers', docKey: 'r' } });
    await M.addMany([a, b]);
    return (await M.load()).map((c) => c.id);
  });
  await rv.goto(X('src/pages/review.html'));
  await rv.waitForSelector('#go');
  await rv.click('#go');
  const reworded = [];
  for (let i = 0; i < 2; i++) {
    await rv.waitForSelector('#card #ans');
    await rv.fill('#ans', 'no idea');
    await rv.press('#ans', 'Enter');
    await rv.waitForSelector('#card [data-r="missed"]');
    await rv.click('#card [data-r="missed"]');
    const box = await rv.waitForSelector('#card .leech', { timeout: 3000 }).catch(() => null);
    ok(!!box, `a fourth slip offers to reword the card (${i + 1})`);
    if (!box) break;
    if (i === 0) {
      await rv.click('#card .leech button:has-text("Reword it")');
      await rv.fill('#card form.reword textarea', 'Which force moves river water toward the sea?');
      await rv.click('#card form.reword button');
      await rv.waitForFunction(() => /Saved/.test(document.querySelector('#card .leech p').textContent));
      reworded.push(await rv.textContent('#card .leech p'));
    } else {
      await rv.click('#card .leech button:has-text("Let it go")');
      await rv.waitForFunction(() => /Let go/.test(document.querySelector('#card .leech p').textContent));
    }
    if (await rv.isVisible('#next')) await rv.click('#next');
  }
  const leechAfter = await rv.evaluate(async () => (await PolycarpMemory.load()).map((c) => ({ id: c.id, prompt: c.prompt, lapses: c.lapses, leech: !!c.leech })));
  const kept = leechAfter.find((c) => c.prompt.startsWith('Which force'));
  ok(!!kept && kept.lapses === 0 && !kept.leech, 'rewording a slipping card saves the new prompt and clears its slips ' + JSON.stringify(leechAfter));
  ok(leechAfter.length === 1 && leechIds.length === 2, 'letting a slipping card go deletes it');
  ok(errors.length === 0, 'review leech: no page errors ' + errors.join(' | '));

  // ---------- Settings ----------
  const st = await ctx.newPage();
  errors = await watch(st);
  await st.setViewportSize({ width: 1280, height: 900 });
  await st.goto(X('src/pages/settings.html'));
  await st.waitForSelector('#profiles .chip');
  await st.click('#profiles .chip[data-id="calm"]');
  await st.waitForTimeout(200);
  ok(/Visual snow/.test(await st.textContent('#blurb')), 'settings profile pick updates the blurb');
  await st.click('#profiles .chip[data-id="everyday"]');
  await check(st, 'settings', 1280);
  await st.setViewportSize({ width: 390, height: 844 });
  await st.reload();
  await st.waitForSelector('#profiles .chip');
  await check(st, 'settings', 390);
  ok(errors.length === 0, 'settings: no page errors ' + errors.join(' | '));

  // ---------- Popup ----------
  const pp = await ctx.newPage();
  errors = await watch(pp);
  await pp.setViewportSize({ width: 360, height: 640 });
  await pp.goto(X('src/popup/popup.html'));
  await pp.waitForSelector('#profiles .chip, #profiles button');
  await check(pp, 'popup', 360);
  // Shutting Polycarp off is two clicks, and the popup says plainly that it is resting.
  const pstate = () => pp.evaluate(async () => { const s = await Polycarp.getSettings(); return { enabled: s.enabled, paused: Polycarp.paused(s) }; });
  await pp.click('#power');
  ok(await pp.isVisible('#powerMenu'), 'popup power button opens the pause menu');
  await pp.click('#powerMenu [data-p="hour"]');
  await pp.waitForSelector('#status:not([hidden])');
  ok(/^Paused until /.test(await pp.textContent('#statusText')) && (await pstate()).paused, 'pause for an hour shows "Paused until" and pauses Polycarp');
  await check(pp, 'popup-paused', 360);
  await pp.click('#statusBtn');
  await pp.waitForSelector('#status[hidden]', { state: 'attached' });
  ok(!(await pstate()).paused, 'Resume now ends the pause');
  await pp.click('#power');
  await pp.click('#powerMenu [data-p="off"]');
  await pp.waitForSelector('#status:not([hidden])');
  ok(/off everywhere/.test(await pp.textContent('#statusText')) && (await pstate()).enabled === false, 'turn off everywhere says so and turns Polycarp off');
  await pp.click('#statusBtn');
  await pp.waitForSelector('#status[hidden]', { state: 'attached' });
  ok((await pstate()).enabled === true, 'Turn on brings Polycarp back');
  await pp.click('#power');
  await pp.keyboard.press('Escape');
  ok(await pp.isHidden('#powerMenu'), 'Escape closes the pause menu');
  ok(errors.length === 0, 'popup: no page errors ' + errors.join(' | '));

  // ---------- Reader landing ----------
  const rd = await ctx.newPage();
  errors = await watch(rd);
  for (const width of [1280, 390]) {
    await rd.setViewportSize({ width, height: width > 500 ? 900 : 844 });
    await rd.goto(X('src/reader/reader.html'));
    await rd.waitForSelector('body[data-state="landing"]');
    await check(rd, 'reader-landing', width);
  }
  ok(errors.length === 0, 'reader landing: no page errors ' + errors.join(' | '));

  // ---------- Content script on a real page ----------
  const web = await ctx.newPage();
  errors = await watch(web);
  await web.setViewportSize({ width: 1280, height: 900 });
  await web.goto(site);
  await web.waitForSelector('polycarp-b', { timeout: 8000 }).catch(() => {});
  const c = await web.evaluate(() => ({
    anchors: document.querySelectorAll('polycarp-b').length,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 60)
  }));
  ok(c.anchors > 20, `content script adds bold anchors on a web page (${c.anchors})`);
  ok(c.text.startsWith('The water cycle Water moves'), 'page text reads the same after the change');
  // Rich text editors (Gmail compose, Notion): typed text must arrive exactly as typed, with no Polycarp markup.
  await web.click('#ce2');
  await web.keyboard.type('Hello there friends, this is a message I am writing');
  await web.waitForTimeout(700);
  const typed = await web.evaluate(() => ({ html: document.getElementById('ce2').innerHTML, text: document.getElementById('ce2').innerText, pre: document.getElementById('ce').innerHTML }));
  ok(typed.text === 'Hello there friends, this is a message I am writing', 'typing in an editor keeps the text in order ' + JSON.stringify(typed.text));
  ok(!/polycarp/i.test(typed.html) && !/polycarp/i.test(typed.pre), 'no Polycarp markup inside editors');
  // A block styled first and made editable later gets its plain text back on focus.
  const lateStyled = await web.evaluate(() => document.querySelectorAll('#late polycarp-b').length);
  await web.evaluate(() => document.getElementById('late').setAttribute('contenteditable', 'true'));
  await web.click('#late p');
  await web.keyboard.press('End');
  await web.keyboard.type(' Added');
  await web.waitForTimeout(700);
  const late = await web.evaluate(() => ({ html: document.getElementById('late').innerHTML, text: document.getElementById('late').innerText.trim() }));
  ok(lateStyled > 0 && !/polycarp/i.test(late.html) && late.text === 'This block turns into an editor after the page loads. Added', 'an editor that turns on late is handed back plain text ' + JSON.stringify(late) + ' styled=' + lateStyled);
  await web.screenshot({ path: path.join(OUT, 'site-1280.png') });
  ok(errors.length === 0, 'web page: no errors from Polycarp ' + errors.join(' | '));
} catch (e) {
  console.log('FAIL threw ' + (e.stack || e));
  fails++;
} finally {
  if (checkSrc) fs.writeFileSync(path.join(OUT, 'design-check.json'), JSON.stringify(design, null, 2));
  await ctx.close();
  server.close();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
