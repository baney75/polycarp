// HTML mail behind both walls, in Chromium: every payload in tests/hostile-mail.mjs and its variants comes out of the
// cleaner with nothing that runs or loads, and when rendered nothing reaches the local server, whether the cleaner ran
// or not. A control renders the same mail with no walls and must reach the server, so this test can fail.
// Run: node tests/hub-safe-html.spec.mjs
import { loadPlaywright } from './pw.mjs';
import { corpus, variants, FORBIDDEN } from './hostile-mail.mjs';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const ID = 'kdaddaaobomjfjcgjeabgbenfddkcfcl'; // fixed by the manifest key

const hits = [];
const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'image/gif' }); res.end(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const H = `http://127.0.0.1:${server.address().port}`;
const mails = corpus(H);

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-safe-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + JSON.stringify(detail).slice(0, 900)}`); if (!ok) fails++; };
const settle = () => new Promise((r) => setTimeout(r, 1500));

try {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${ID}/src/pages/settings.html`);
  const load = async () => { for (const s of ['lib/purify.min.js', 'src/hub/safe-html.js']) await p.addScriptTag({ url: `chrome-extension://${ID}/${s}` }); };
  await load();

  // 1. The cleaner's output, for every payload and spelling.
  const all = mails.flatMap(([name, html]) => variants(html).map((v, i) => [name + ' #' + i, v]));
  const bad = await p.evaluate(({ all, F }) => {
    const out = [];
    for (const [name, html] of all) {
      const c = globalThis.PolycarpHubSafeHtml.clean(html);
      const d = new DOMParser().parseFromString('<body>' + c.html + '</body>', 'text/html');
      const why = [];
      for (const t of F.tags) if (d.getElementsByTagName(t).length) why.push('<' + t + '>');
      for (const e of d.querySelectorAll('*')) {
        for (const a of e.attributes) {
          if (new RegExp(F.attrs, 'i').test(a.name)) why.push(e.tagName + '@' + a.name);
          if (/^(href|src|xlink:href)$/i.test(a.name)) {
            const v = a.value.trim();
            if (a.name === 'href' && !/^(https?:|mailto:)/i.test(v)) why.push('href ' + v.slice(0, 40));
            if (a.name === 'src' && !/^data:image\//i.test(v)) why.push('src ' + v.slice(0, 40));
          }
          if (a.name === 'style' && /url\s*\(|@import|expression|image-set/i.test(a.value)) why.push('style ' + a.value.slice(0, 40));
        }
        if (e.tagName === 'STYLE' && /url\s*\(|@import/i.test(e.textContent)) why.push('style tag ' + e.textContent.slice(0, 40));
      }
      if (why.length) out.push({ name, why });
    }
    return out;
  }, { all, F: { tags: FORBIDDEN.tags, attrs: FORBIDDEN.attrs.source } });
  check(bad.length === 0, `the cleaner leaves nothing that runs or loads in ${all.length} hostile mails`, bad);

  // 2. Rendered: the real frame (cleaner and sandbox), the sandbox alone on raw mail, and the control with no walls.
  const render = (mode) => p.evaluate(({ all, mode }) => {
    const box = document.createElement('div');
    document.body.append(box);
    for (const [name, html] of all) {
      let f;
      if (mode === 'safe') f = globalThis.PolycarpHubSafeHtml.frame(html, name).frame;
      else {
        f = document.createElement('iframe');
        if (mode === 'sandbox') { f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); f.srcdoc = globalThis.PolycarpHubSafeHtml.frameDoc(html); }
        else f.srcdoc = '<!doctype html><body>' + html;
      }
      box.append(f);
    }
    return all.length;
  }, { all, mode });

  hits.length = 0;
  await render('safe');
  await settle();
  check(hits.length === 0, 'rendered behind both walls, no hostile mail reaches the network', hits);

  hits.length = 0;
  await p.reload();
  await load();
  await render('sandbox');
  await settle();
  check(hits.length === 0, 'the sandbox and CSP alone hold raw hostile mail, so one wall failing is not enough', hits);

  hits.length = 0;
  await p.reload();
  await load();
  await render('none');
  await settle();
  check(hits.length >= 10, 'control: the same mail with no walls does reach the server', hits.length);

  // The safe frame does show the mail: its text, its own styles and its pictures.
  await p.reload();
  await load();
  await p.evaluate(() => document.body.append(globalThis.PolycarpHubSafeHtml.frame('<style>p{color:rgb(0, 128, 0)}</style><p id="m">Visible words</p><img id="i" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">', 'probe').frame));
  await settle();
  const fr = p.frames().find((f) => f !== p.mainFrame());
  const seen = fr ? await fr.evaluate(() => ({ text: document.getElementById('m')?.textContent, color: getComputedStyle(document.getElementById('m')).color, img: document.getElementById('i').naturalWidth })).catch((e) => String(e)) : 'no frame';
  check(seen && seen.text === 'Visible words' && seen.color === 'rgb(0, 128, 0)' && seen.img === 1, 'the safe frame shows the text, the styles and the pictures in the mail', seen);

  // 3. Links and pictures.
  const links = await p.evaluate(() => {
    const S = globalThis.PolycarpHubSafeHtml;
    const c = S.clean('<a href="https://login.evil.example/bank">bank.example</a> <a href="https://www.shop.example/x">shop.example</a> <a href="mailto:a@b.example">write</a> <img src="data:image/png;base64,iVBORw0KGgo="><img src="https://t.example/p.gif">');
    const d = new DOMParser().parseFromString('<body>' + c.html + '</body>', 'text/html');
    return { notes: Array.from(d.querySelectorAll('.pc-real')).map((s) => s.textContent), a: Array.from(d.querySelectorAll('a')).map((a) => [a.title, a.target, a.rel]), imgs: Array.from(d.querySelectorAll('img')).map((i) => i.getAttribute('src') || ''), blocked: c.blocked };
  });
  check(links.notes.length === 1 && links.notes[0] === ' (goes to login.evil.example)', 'a link whose text names another site says where it really goes', links.notes);
  check(links.a.every(([t, tg, rel]) => t && tg === '_blank' && /noopener/.test(rel)), 'every link shows its address and opens outside the frame', links.a);
  check(links.imgs[0].startsWith('data:image/png') && links.imgs[1] === '' && links.blocked === 1, 'pictures in the mail stay, pictures from the web are left out and counted', links);
  const frameAttrs = await p.evaluate(() => { const f = globalThis.PolycarpHubSafeHtml.frame('<p>x</p>').frame; return { sandbox: f.getAttribute('sandbox'), csp: f.getAttribute('csp') }; });
  check(frameAttrs.sandbox === 'allow-popups allow-popups-to-escape-sandbox' && /default-src 'none'/.test(frameAttrs.csp), 'the frame has no scripts, no same origin and default-src none', frameAttrs);
} catch (e) {
  check(false, 'the run finished', String(e && e.stack || e));
}
await ctx.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
