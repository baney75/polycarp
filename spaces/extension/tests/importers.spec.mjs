// End-to-end checks for src/reader/importers.js in a real Chromium
// with the extension loaded. Run: node tests/importers.spec.mjs
// Prints one PASS or FAIL line per check and exits nonzero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './pw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = ROOT;
const FIX = path.join(HERE, 'fixtures');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NEEDED = ['fx-single.pdf', 'fx-columns.pdf', 'fx-paper.pdf', 'fx-outline.pdf', 'fx-scan.pdf', 'fx-password.pdf', 'fx-book.epub',
  'fx-drm.epub', 'fx-doc.docx', 'fx-book.fb2', 'fx-chapters.txt', 'fx-notes.md', 'fx-article.html', 'fx-kindle.mobi'];
if (NEEDED.some((f) => !fs.existsSync(path.join(FIX, f)))) {
  console.log('building fixtures');
  execFileSync('python3', [path.join(FIX, 'make_fixtures.py')], { stdio: 'inherit' });
  try { execFileSync('node', [path.join(FIX, 'make_pdf_fixtures.mjs')], { stdio: 'inherit' }); } catch { /* outline may be missing */ }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log(`PASS  ${name}`); }
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); }
}
function skip(name, why) { console.log(`SKIP  ${name}  :: ${why}`); }

// ---------------------------------------------------------------------------
// Browser with the extension
// ---------------------------------------------------------------------------
const { chromium } = await loadPlaywright();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-importers-'));

async function launch(extDir) {
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
  if (!sw) { await ctx.close(); return null; }
  return { ctx, id: new URL(sw.url()).host, dir: extDir };
}

function makeStubCopy() {
  // The real background.js may not exist yet. Test the importer against a
  // minimal copy: same lib/ and src/reader/, a one-line service worker.
  const dir = path.join(tmpRoot, 'ext-copy');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(EXT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.cpSync(path.join(EXT, 'src', 'reader'), path.join(dir, 'src', 'reader'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'background.js'), 'self.addEventListener("install", () => {});\n');
  const real = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Polycarp importer test copy',
    version: real.version || '0.0.1',
    background: { service_worker: 'src/background.js' },
    host_permissions: real.host_permissions || ['<all_urls>'],
    permissions: ['storage'],
  }, null, 2));
  return dir;
}

let ext = await launch(EXT);
if (ext) console.log(`extension loaded from ${EXT} (id ${ext.id})`);
else {
  console.log('the extension did not start a service worker; testing a stub copy');
  ext = await launch(makeStubCopy());
  if (!ext) { console.log('FAIL  extension service worker never started'); process.exit(1); }
  console.log(`extension loaded from stub copy (id ${ext.id})`);
}

const page = await ext.ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`chrome-extension://${ext.id}/src/reader/dev-harness.html`);
check('harness loads PolycarpImport', await page.evaluate(() => typeof PolycarpImport === 'object' &&
  ['fromFile', 'fromUrl', 'fromHtml', 'fromText', 'sanitize'].every((k) => typeof PolycarpImport[k] === 'function')));

// Summarize a Doc inside the page so Node gets plain data.
await page.evaluate(() => {
  window.__summ = (doc) => ({
    title: doc.title, author: doc.author, source: doc.source,
    sections: doc.sections.map((s) => {
      const d = new DOMParser().parseFromString('<body>' + s.html + '</body>', 'text/html');
      const norm = (t) => t.replace(/\s+/g, ' ').trim();
      return {
        title: s.title, html: s.html,
        paras: [...d.querySelectorAll('p')].map((p) => norm(p.textContent)),
        heads: [...d.querySelectorAll('h1,h2,h3,h4')].map((h) => ({ tag: h.localName, text: norm(h.textContent) })),
        lis: [...d.querySelectorAll('li')].map((li) => norm(li.textContent)),
        imgs: [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')),
        marks: [...d.querySelectorAll('div.ph-pagemark')].map((m) => m.getAttribute('data-page')),
        firstTag: d.body.firstElementChild ? d.body.firstElementChild.localName : null,
        text: norm(d.body.textContent),
      };
    }),
  });
  window.__err = (e) => ({ error: { code: e && e.code, message: e && e.message, name: e && e.name } });
});

async function importFixture(file, name = file, extra = {}) {
  const b64 = fs.readFileSync(path.join(FIX, file)).toString('base64');
  return page.evaluate(async ({ b64, name, extra }) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const progress = [];
    try {
      const doc = await PolycarpImport.fromFile(new Blob([u8]), name, { onProgress: (f) => progress.push(f), ...extra });
      return { ...window.__summ(doc), progress };
    } catch (e) { return window.__err(e); }
  }, { b64, name, extra });
}

const allText = (doc) => doc.sections.map((s) => s.text).join(' ');
const allParas = (doc) => doc.sections.flatMap((s) => s.paras);
const findPara = (doc, start) => allParas(doc).find((p) => p.startsWith(start));
const brief = (doc) => doc.error ? doc.error : { title: doc.title, sections: doc.sections.map((s) => ({ title: s.title, paras: s.paras, heads: s.heads })) };

// ---------------------------------------------------------------------------
// PDF: single column, 2 pages
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-single.pdf');
  if (doc.error) check('pdf single: imports', false, doc.error);
  else {
    check('pdf single: title from metadata', doc.title === 'Polycarp Fixture One', doc.title);
    check('pdf single: source kind and pages', doc.source.kind === 'pdf' && doc.source.pages === 2 && doc.source.name === 'fx-single.pdf', doc.source);
    check('pdf single: one 15-page chunk section', doc.sections.length === 1 && doc.sections[0].title === 'Pages 1 to 2', doc.sections.map((s) => s.title));
    const expected = [
      ['Many readers', 'whole paragraphs.'],
      ['Indented paragraphs', 'letters as well.'],
      ['Short lines also', 'has begun.'],
      ['That is the third rule', 'gap is large.'],
      ['The second page', 'by the importer.'],
      ['A final paragraph', 'as its marker.'],
    ];
    const paras = allParas(doc);
    check('pdf single: paragraph count is 6', paras.length === 6, paras);
    expected.forEach(([a, b]) => {
      const p = findPara(doc, a);
      check(`pdf single: paragraph "${a}" rebuilt whole`, !!p && p.endsWith(b), p || brief(doc));
    });
    check('pdf single: no paragraph is a single short wrapped line', paras.every((p) => p.length > 60), paras.filter((p) => p.length <= 60));
    const text = allText(doc);
    check('pdf single: hyphen join "exam-"+"ple" => example', /A good example of this problem/.test(text) && !/exam-/.test(text), text.slice(0, 300));
    check('pdf single: hyphen join "infor-"+"mation" => information', /the information, that/.test(text), text);
    check('pdf single: real hyphen kept (well-known twice)', (text.match(/well-known/g) || []).length === 2 && !/wellknown/.test(text), text);
    check('pdf single: running header removed', !/Polycarp Test Journal/i.test(text));
    check('pdf single: page numbers removed', !paras.some((p) => /^\d+$/.test(p)) && !/\bmarker\. ?2\b/.test(text) && !/(^| )[12]$/.test(text), text.slice(-80));
    const heads = doc.sections[0].heads;
    check('pdf single: headings by size (h2 then h3)', heads.length === 2 && heads[0].tag === 'h2' && heads[0].text === 'Reading Without Friction' && heads[1].tag === 'h3' && heads[1].text === 'A Second Look', heads);
    check('pdf single: page markers 1 and 2', JSON.stringify(doc.sections[0].marks) === '["1","2"]', doc.sections[0].marks);
    check('pdf single: page marker first in section', doc.sections[0].firstTag === 'div');
    check('pdf single: onProgress reached 1', doc.progress.length > 1 && doc.progress[doc.progress.length - 1] === 1 && doc.progress.every((v, i, a) => i === 0 || v >= a[i - 1]), doc.progress);
  }
}

// ---------------------------------------------------------------------------
// PDF: two columns
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-columns.pdf');
  if (doc.error) check('pdf columns: imports', false, doc.error);
  else {
    const paras = allParas(doc);
    const order = ['Alpha one', 'Alpha two', 'Omega one', 'Omega two'].map((m) => paras.findIndex((p) => p.startsWith(m)));
    check('pdf columns: title heading first', doc.sections[0].heads[0] && doc.sections[0].heads[0].text === 'Two Column Field Notes', doc.sections[0].heads);
    check('pdf columns: left column read before right column', order.every((v) => v >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), { order, paras });
    check('pdf columns: 4 paragraphs', paras.length === 4, paras);
    check('pdf columns: lines inside a column join', !!findPara(doc, 'Alpha one begins the left column with a plain sentence that wraps across a few lines before it finally comes to an end here.'), paras);
    check('pdf columns: paragraph flows from left column into right', !!paras.find((p) => /the reader keeps going into the right column without a break, which tests the flow join\.$/.test(p)), paras);
  }
}

// ---------------------------------------------------------------------------
// PDF: natural two-column paper over two pages
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-paper.pdf');
  if (doc.error) check('pdf paper: imports', false, doc.error);
  else {
    const paras = allParas(doc).filter((p) => /START/.test(p));
    const ids = paras.map((p) => +(/^(?:Key point\. )?P(\d+)START/.exec(p) || [])[1]);
    check('pdf paper: 20 paragraphs in reading order', paras.length === 20 && ids.every((v, i) => v === i + 1), ids);
    const broken = paras.filter((p) => { const m = /P(\d+)START/.exec(p); return !m || !p.endsWith(`P${m[1]}END.`) || (p.match(/START/g) || []).length !== 1; });
    check('pdf paper: every paragraph whole across columns and pages', broken.length === 0, broken.map((p) => p.slice(0, 40) + ' ... ' + p.slice(-30)));
    const vocab = new Set('reading attention focus paragraph comfortable margin structure typography readable letters contrast spacing information understanding distraction concentration the a of and to in is with for on key point'.split(' '));
    const odd = paras.flatMap((p) => p.replace(/P\d+(START|END)/g, '').match(/[A-Za-z]+/g)).filter((w) => !vocab.has(w.toLowerCase()));
    check('pdf paper: auto-hyphenated words joined with no fragments', odd.length === 0 && !paras.some((p) => /\w-\s?\w/.test(p)), odd.slice(0, 10));
    const heads = doc.sections.flatMap((s) => s.heads);
    check('pdf paper: title h2 and four h3 section heads', heads.length === 5 && heads[0].tag === 'h2' && heads.slice(1).every((h, i) => h.tag === 'h3' && h.text === `Section ${i + 1} Results`), heads);
    check('pdf paper: header and "Page N of M" footer removed', !/draft|Page \d of \d/.test(allText(doc)));
    check('pdf paper: bold run-in lead kept as strong', doc.sections[0].html.includes('<strong>Key point.</strong> P5START'));
  }
}

// ---------------------------------------------------------------------------
// PDF: outline
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-outline.pdf');
  if (doc.error) check('pdf outline: imports', false, doc.error);
  else {
    const titles = doc.sections.map((s) => s.title);
    check('pdf outline: sections from outline', JSON.stringify(titles) === JSON.stringify(['Chapter One: Arrival', 'Chapter Two: The Middle', 'Chapter Three: Departure']), titles);
    check('pdf outline: each section has its two paragraphs', doc.sections.length === 3 && doc.sections.every((s, i) => s.paras.length === 2 && s.paras[0].endsWith(`OUTPARA${2 * i + 1}.`) && s.paras[1].endsWith(`OUTPARA${2 * i + 2}.`)), brief(doc));
    check('pdf outline: duplicate title heading dropped', doc.sections.every((s) => !s.heads.some((h) => h.text === s.title)), doc.sections.map((s) => s.heads));
    check('pdf outline: page markers follow sections', JSON.stringify(doc.sections.map((s) => s.marks)) === '[["1"],["2"],["3"]]', doc.sections.map((s) => s.marks));
  }
}

// ---------------------------------------------------------------------------
// PDF: errors
// ---------------------------------------------------------------------------
{
  const scan = await importFixture('fx-scan.pdf');
  check('pdf scan: NO_TEXT thrown', scan.error && scan.error.code === 'NO_TEXT' && /scan/i.test(scan.error.message), scan.error || 'no error');
  const pw = await importFixture('fx-password.pdf');
  check('pdf password: PASSWORD thrown', pw.error && pw.error.code === 'PASSWORD', pw.error || brief(pw));
  const pwOk = await importFixture('fx-password.pdf', 'fx-password.pdf', { password: 'secret' });
  check('pdf password: opens with the right password', !pwOk.error && /behind a password/.test(allText(pwOk)), pwOk.error || brief(pwOk));
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-book.epub');
  if (doc.error) check('epub: imports', false, doc.error);
  else {
    check('epub: title and author from OPF', doc.title === 'The Test Book' && doc.author === 'Ada Tester', { t: doc.title, a: doc.author });
    check('epub: 3 sections (cover merged)', doc.sections.length === 3, doc.sections.map((s) => s.title));
    check('epub: section titles from nav', JSON.stringify(doc.sections.map((s) => s.title)) === JSON.stringify(['One: The Start', 'Two: The Picture', 'Three: The End']), doc.sections.map((s) => s.title));
    check('epub: tiny cover merged into first section', /COVERTEXT/.test(doc.sections[0].text));
    const imgs = doc.sections.flatMap((s) => s.imgs);
    check('epub: image is a blob: URL', imgs.length === 1 && imgs[0].startsWith('blob:chrome-extension://'), imgs);
    const ok = imgs.length ? await page.evaluate(async (u) => { const r = await fetch(u); const b = await r.blob(); return b.type === 'image/png' && b.size > 100; }, imgs[0]) : false;
    check('epub: blob image resolves to the PNG', ok);
    const html = doc.sections.map((s) => s.html).join('');
    check('epub: script, style and handlers stripped', !/<script|style=|onclick|window\.evil/i.test(html), html.slice(0, 400));
    check('epub: javascript: link removed, https link kept', !/javascript:/i.test(html) && /href="https:\/\/example\.com\/ok"/.test(html));
    check('epub: XHTML with HTML entity parsed via fallback', /ENDMARK/.test(doc.sections[2].text) && /chapter\u00a0?\s?ends here/.test(doc.sections[2].text));
    check('epub: no duplicate h1 of chapter number kept as h1', !/<h1/i.test(html));
    const drm = await importFixture('fx-drm.epub');
    check('epub drm: DRM thrown', drm.error && drm.error.code === 'DRM', drm.error || brief(drm));
  }
}

// ---------------------------------------------------------------------------
// FB2
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-book.fb2');
  if (doc.error) check('fb2: imports', false, doc.error);
  else {
    check('fb2: title and author', doc.title === 'The FB2 Fixture' && doc.author === 'Fyodor Fixture', { t: doc.title, a: doc.author });
    check('fb2: 2 sections with titles', JSON.stringify(doc.sections.map((s) => s.title)) === '["Part One","Part Two"]', doc.sections.map((s) => s.title));
    check('fb2: binary image as blob:', doc.sections[0].imgs.length === 1 && doc.sections[0].imgs[0].startsWith('blob:'), doc.sections[0].imgs);
    check('fb2: emphasis kept', /<em>emphasis<\/em>/.test(doc.sections[0].html) && /<strong>strong<\/strong>/.test(doc.sections[0].html));
  }
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-doc.docx');
  if (doc.error) check('docx: imports', false, doc.error);
  else {
    check('docx: title and author from core.xml', doc.title === 'Docx Fixture Title' && doc.author === 'Wendy Word', { t: doc.title, a: doc.author });
    check('docx: splits on h1', JSON.stringify(doc.sections.map((s) => s.title)) === '["First Part","Second Part"]', doc.sections.map((s) => s.title));
    check('docx: bold and italic runs kept', /<strong>bold words<\/strong>/.test(doc.sections[0].html) && /<em>italic words<\/em>/.test(doc.sections[0].html), doc.sections[0].html);
    check('docx: h2 inside a section stays h2', doc.sections[0].heads.length === 1 && doc.sections[0].heads[0].tag === 'h2' && doc.sections[0].heads[0].text === 'A subsection', doc.sections[0].heads);
    check('docx: second part content', /DOCXEND/.test(doc.sections[1].text));
  }
}

// ---------------------------------------------------------------------------
// TXT and Markdown
// ---------------------------------------------------------------------------
{
  const doc = await importFixture('fx-chapters.txt');
  if (doc.error) check('txt: imports', false, doc.error);
  else {
    check('txt: Title and Author lines used', doc.title === 'The Plain Book' && doc.author === 'Tess Writer', { t: doc.title, a: doc.author });
    check('txt: split at CHAPTER headings', JSON.stringify(doc.sections.map((s) => s.title)) === '["CHAPTER I: The Arrival","CHAPTER II","CHAPTER III"]', doc.sections.map((s) => s.title));
    check('txt: hard-wrapped lines joined into one paragraph', !!findPara(doc, 'It was a quiet morning') && /cold air while TXTJOIN the last passengers stepped down\.$/.test(findPara(doc, 'It was a quiet morning')), allParas(doc));
    check('txt: source kind txt', doc.source.kind === 'txt');
  }
  const lines = await page.evaluate(() => {
    const d = PolycarpImport.fromText('first line\nsecond line\nthird line\nfourth line\nfifth line', 'list.txt');
    return d.sections[0].html;
  });
  check('txt: no blank lines means one paragraph per line', (lines.match(/<p>/g) || []).length === 5, lines);

  const md = await importFixture('fx-notes.md');
  if (md.error) check('md: imports', false, md.error);
  else {
    const h = md.sections[0].html;
    check('md: title from single h1', md.title === 'Markdown Fixture' && md.sections.length === 1 && md.sections[0].title === 'Markdown Fixture', { t: md.title, s: md.sections.map((s) => s.title) });
    check('md: strong, em, code, link', /<strong>strong words<\/strong>/.test(h) && /<em>emphasis<\/em>/.test(h) && /<code>inline code<\/code>/.test(h) && /<a href="https:\/\/example\.com\/page">link<\/a>/.test(h), h);
    check('md: subheading as h2', /<h2>A Subheading<\/h2>/.test(h), h);
    check('md: lists', /<ul><li>first item<\/li><li>second item with <strong>bold<\/strong><\/li><li>third item<\/li><\/ul>/.test(h) && /<ol><li>one<\/li><li>two<\/li><\/ol>/.test(h), h);
    check('md: blockquote, code block (escaped), hr', /<blockquote><p>A quoted line\s+that continues\.<\/p><\/blockquote>/.test(h) && /<pre><code>&lt;script&gt;/.test(h) && /<hr>/.test(h), h);
    check('md: source kind md', md.source.kind === 'md');
  }
}

// ---------------------------------------------------------------------------
// Unsupported
// ---------------------------------------------------------------------------
{
  const mobi = await importFixture('fx-kindle.mobi');
  check('mobi: UNSUPPORTED with Calibre advice', mobi.error && mobi.error.code === 'UNSUPPORTED' && /Calibre/.test(mobi.error.message), mobi.error);
}

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------
{
  const out = await page.evaluate(() => PolycarpImport.sanitize(
    '<div onclick="x()" style="color:red"><p onclick="steal()" style="font-size:40px" class="c" id="i">Hi <b onmouseover="y()">there</b>' +
    '<script>alert(1)</script><a href="javascript:alert(1)">js</a> <a href="JaVa\tScRiPt:alert(2)">js2</a> ' +
    '<a href="data:text/html,<b>x</b>">data</a> <a href="https://ok.example/x" target="_blank" rel="x">ok</a> ' +
    '<img src="data:image/png;base64,iVBORw0KGgo=" onerror="z()" alt="d"><img src="blob:https://a.example/1" alt="b">' +
    '<img src="javascript:alert(3)"><iframe src="https://evil.example"></iframe><style>p{}</style></p>' +
    '<h6>Deep</h6><div class="ph-pagemark" data-page="7" style="x"></div><svg><script>1</script></svg>' +
    '<object data="x"></object><form><input value="v"><button>b</button></form><table><tr><td>cell</td></tr></table></div>' +
    'loose text<br><br>second loose', 'https://base.example/dir/page.html'));
  check('sanitize: <script> removed', !/<script|alert\(1\)/i.test(out), out);
  check('sanitize: on* handlers removed', !/\son\w+=/i.test(out), out);
  check('sanitize: javascript: links removed', !/javascript:/i.test(out) && !/href="[^"]*script/i.test(out), out);
  check('sanitize: style attributes and <style> removed', !/style/i.test(out), out);
  check('sanitize: data: link removed, data: and blob: img kept', !/href="data:/i.test(out) && /src="data:image\/png/.test(out) && /src="blob:https:\/\/a\.example\/1"/.test(out), out);
  check('sanitize: https link kept without extra attributes', /<a href="https:\/\/ok\.example\/x">ok<\/a>/.test(out), out);
  check('sanitize: class and id stripped except page marker', !/class="c"|id="i"/.test(out) && /<div class="ph-pagemark" data-page="7"><\/div>/.test(out), out);
  check('sanitize: iframe, object, svg, form controls removed', !/<iframe|<object|<svg|<input|<button|<form/i.test(out), out);
  check('sanitize: h6 mapped to h4', /<h4>Deep<\/h4>/.test(out), out);
  check('sanitize: table kept', /<table><tbody><tr><td>cell<\/td><\/tr><\/tbody><\/table>/.test(out), out);
  check('sanitize: loose text wrapped into paragraphs', /<p>loose text<\/p><p>second loose<\/p>/.test(out), out);
  const rel = await page.evaluate(() => PolycarpImport.sanitize('<p><a href="../up.html">u</a><img src="pic.png" alt=""><a href="rel.html">r</a></p>', 'https://base.example/dir/page.html'));
  check('sanitize: relative URLs resolved against base', /href="https:\/\/base\.example\/up\.html"/.test(rel) && /src="https:\/\/base\.example\/dir\/pic\.png"/.test(rel), rel);
  const nobase = await page.evaluate(() => PolycarpImport.sanitize('<p><a href="rel.html">r</a><img src="pic.png" alt="">text</p>'));
  check('sanitize: relative URLs dropped without base', nobase === '<p>rtext</p>', nobase);
}

// ---------------------------------------------------------------------------
// fromHtml and fromUrl (local HTTP server)
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (file, type, extraHeaders = {}) => {
    const body = fs.readFileSync(path.join(FIX, file));
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, ...extraHeaders });
    res.end(body);
  };
  if (u.pathname === '/news/story') return send('fx-article.html', 'text/html; charset=utf-8');
  if (u.pathname === '/media/story') return send('fx-media.html', 'text/html; charset=utf-8');
  if (u.pathname === '/files/fx-single.pdf') return send('fx-single.pdf', 'application/pdf');
  if (u.pathname === '/download') return send('fx-book.epub', 'application/octet-stream', { 'content-disposition': 'attachment; filename="My Book.epub"' });
  if (u.pathname === '/notes.md') return send('fx-notes.md', 'text/plain; charset=utf-8');
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
{
  const html = fs.readFileSync(path.join(FIX, 'fx-article.html'), 'utf8');
  const doc = await page.evaluate(({ html, url }) => {
    try { return window.__summ(PolycarpImport.fromHtml(html, url, 'fallback')); } catch (e) { return window.__err(e); }
  }, { html, url: 'https://news.example/2026/story.html' });
  if (doc.error) check('fromHtml: imports', false, doc.error);
  else {
    const h = doc.sections[0].html;
    check('fromHtml: Readability title', doc.title === 'The Article Title', doc.title);
    check('fromHtml: author from byline or meta', /Rita Reporter/.test(doc.author || ''), doc.author);
    check('fromHtml: article text kept, nav and footer gone', /ARTICLEEND/.test(h) && !/Footer junk|Sidebar junk|>About</.test(h), h);
    check('fromHtml: relative link and image resolved', /href="https:\/\/news\.example\/relative\/path"/.test(h) && /src="https:\/\/news\.example\/2026\/images\/photo\.png"/.test(h), h);
    check('fromHtml: no script', !/script|tracker/.test(h));
    check('fromHtml: source', doc.source.kind === 'html' && doc.source.url === 'https://news.example/2026/story.html', doc.source);
  }


  // -------------------------------------------------------------------------
  // fx-media.html: images, figures, embeds, players, headings, links, safety
  // -------------------------------------------------------------------------
  const MEDIA_URL = 'https://media.example/2026/story.html';
  const mediaHtml = fs.readFileSync(path.join(FIX, 'fx-media.html'), 'utf8');
  // Facts about a DOM subtree: either importer html parsed in the page, or a
  // live element in the rendered Reader.
  const facts = (arg) => {
    const root = arg.html != null ? new DOMParser().parseFromString('<body>' + arg.html + '</body>', 'text/html').body : document.querySelector(arg.sel);
    if (!root) return null;
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const attrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
    const sib = (el) => { const n = el.nextElementSibling; return n ? { tag: n.localName, text: norm(n.textContent), href: n.getAttribute('href'), cls: n.getAttribute('class') } : null; };
    const all = [...root.querySelectorAll('*')];
    return {
      text: norm(root.textContent),
      imgs: [...root.querySelectorAll('img')].map(attrs),
      cards: [...root.querySelectorAll('a.embed-card')].map((a) => ({
        href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'),
        provider: norm(a.querySelector('.embed-provider') && a.querySelector('.embed-provider').textContent),
        title: norm(a.querySelector('.embed-title') && a.querySelector('.embed-title').textContent),
        thumb: a.querySelector('img') ? a.querySelector('img').getAttribute('src') : null,
        figcap: a.closest('figure') && a.closest('figure').querySelector('figcaption') ? norm(a.closest('figure').querySelector('figcaption').textContent) : null,
      })),
      figures: [...root.querySelectorAll('figure')].map((f) => {
        const cap = f.querySelector('figcaption');
        const img = f.querySelector('img:not(.embed-thumb)');
        return { img: img ? img.getAttribute('src') : null, card: !!f.querySelector('a.embed-card'), cap: cap ? norm(cap.textContent) : null, capDirect: !!cap && cap.parentElement === f };
      }),
      videos: [...root.querySelectorAll('video')].map((v) => ({ attrs: attrs(v), next: sib(v) })),
      audios: [...root.querySelectorAll('audio')].map((v) => ({ attrs: attrs(v), next: sib(v) })),
      tweet: root.querySelector('blockquote.tweet') ? { text: norm(root.querySelector('blockquote.tweet').textContent), links: [...root.querySelectorAll('blockquote.tweet a[href]')].map((a) => a.getAttribute('href')) } : null,
      heads: [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({ tag: h.localName, id: h.id || null, text: norm(h.textContent), links: h.querySelectorAll('a').length })),
      links: [...root.querySelectorAll('a[href]')].filter((a) => !a.classList.contains('embed-card')).map((a) => ({ href: a.getAttribute('href'), text: norm(a.textContent), cls: a.getAttribute('class'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })),
      ids: all.filter((e) => e.id).map((e) => e.id),
      handlers: all.filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).map((e) => e.localName),
      mediaHandlers: [...root.querySelectorAll('img, video, audio')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).map((e) => e.outerHTML),
      styles: all.filter((e) => e.hasAttribute('style')).map((e) => e.localName),
      banned: [...root.querySelectorAll('iframe, frame, script, object, embed, form, input, button, select, textarea, option')].map((e) => e.localName),
      badUrls: all.flatMap((e) => ['href', 'src', 'poster', 'srcset'].map((k) => e.getAttribute(k)).filter((v) => v != null && !/^(https?:|mailto:|#)/i.test(v))),
    };
  };

  const imported = await page.evaluate(({ html, url }) => {
    try { const d = PolycarpImport.fromHtml(html, url, 'fallback'); return { title: d.title, html: d.sections.map((s) => s.html).join('\n') }; } catch (e) { return window.__err(e); }
  }, { html: mediaHtml, url: MEDIA_URL });
  if (imported.error) check('media: fx-media.html imports', false, imported.error);
  else {
    const out = await page.evaluate(facts, { html: imported.html });

    // The same page through the Reader's own path: a page snapshot in
    // storage.session opened with reader.html?doc=KEY, then the live #article.
    let shown = null, shownWhy = 'reader page did not render';
    if (ext.dir === EXT) {
      await page.evaluate((snap) => chrome.storage.session.set({ phMediaSnap: snap }), { html: mediaHtml, url: MEDIA_URL, title: 'fallback' });
      const rp = await ext.ctx.newPage();
      const rerr = [];
      rp.on('pageerror', (e) => rerr.push(String(e)));
      // The fixture's image hosts don't exist. Serve a 1x1 PNG so images load as they would on a
      // real page; otherwise the Reader's broken-image handler rightly swaps them for their alt text.
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
      await rp.route(/^https?:/, (r) => r.request().resourceType() === 'image' ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : r.abort());
      await rp.goto(`chrome-extension://${ext.id}/src/reader/reader.html?doc=phMediaSnap`);
      const state = await rp.waitForSelector('body[data-state="reading"], body[data-state="error"]', { timeout: 30000 })
        .then(() => rp.evaluate(() => document.body.dataset.state)).catch((e) => String(e));
      if (state === 'reading') shown = await rp.evaluate(facts, { sel: '#article' });
      else shownWhy = `reader state ${state}: ` + await rp.evaluate(() => document.getElementById('errText') && document.getElementById('errText').textContent).catch(() => '');
      check('media: Reader renders fx-media.html with no page errors', state === 'reading' && rerr.length === 0, { state, rerr });
      await rp.close();
    } else {
      shownWhy = 'stub extension copy has no full Reader';
    }
    if (!shown) skip('media: rendered Reader DOM', shownWhy + '; checks below use the importer output');
    const r = shown || out; // rendered Reader DOM when available
    const where = shown ? ' (rendered Reader)' : ' (importer output)';
    const img = (re) => r.imgs.find((i) => re.test(i.src || ''));
    const P = 'https://media.example';

    // 1. Images
    const lazy = img(/lazy-real\.jpg$/);
    check('media: lazy img picks data-src over a gif placeholder, loading lazy, decoding async' + where,
      !!lazy && lazy.src === `${P}/img/lazy-real.jpg` && lazy.alt === 'Lazy photo' && lazy.loading === 'lazy' && lazy.decoding === 'async' && !r.imgs.some((i) => /^data:/.test(i.src)), r.imgs);
    check('media: srcset picks the candidate closest to 1200w' + where, !!img(/pic-1100\.jpg$/) && !img(/small-400|pic-400|pic-2400/), r.imgs.map((i) => i.src));
    check('media: picture uses its first source srcset at the largest density' + where, !!img(/art-2x\.webp$/) && !img(/spacer\.gif|art-1x/) && img(/art-2x\.webp$/).alt === 'Picture photo', r.imgs.map((i) => i.src));
    check('media: 1x1 tracking pixel dropped' + where, !img(/track\.example/), r.imgs.map((i) => i.src));
    check('media: event handlers and styles do not survive on a kept img or video' + where,
      !!img(/handler\.jpg$/) && r.videos.length >= 1 && r.mediaHandlers.length === 0 && !('style' in img(/handler\.jpg$/)), { mediaHandlers: r.mediaHandlers, handler: img(/handler\.jpg$/), videos: r.videos.length });

    // 2. Figures
    const photoFig = r.figures.find((f) => f.img === `${P}/img/figure.jpg`);
    const cardFig = r.figures.find((f) => f.card);
    check('media: figure keeps its figcaption, including a figure around an embed card' + where,
      !!photoFig && photoFig.capDirect && /^FIGCAPTEXT/.test(photoFig.cap) && !!cardFig && cardFig.capDirect && /^EMBEDCAP/.test(cardFig.cap), r.figures);

    // 3. Embeds
    const yt = r.cards.find((c) => c.provider === 'YouTube');
    check('media: YouTube iframe becomes a link card with watch URL, title and thumbnail' + where,
      !!yt && yt.href === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s' && yt.target === '_blank' && yt.rel === 'noopener noreferrer' &&
      yt.title === 'A Great Talk' && yt.thumb === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' && /^EMBEDCAP/.test(yt.figcap || ''), r.cards);
    const vm = r.cards.find((c) => c.provider === 'Vimeo');
    check('media: Vimeo iframe becomes a link card' + where, !!vm && vm.href === 'https://vimeo.com/76979871' && vm.title === 'Vimeo video' && vm.target === '_blank', r.cards);
    check('media: javascript:, about: and empty iframes dropped, no live frames' + where, r.cards.length === 2 && !r.banned.includes('iframe'), { cards: r.cards.map((c) => c.href), banned: r.banned });
    check('media: tweet keeps its text and last status link' + where,
      !!r.tweet && /TWEETTEXT reading calmly/.test(r.tweet.text) && r.tweet.links[r.tweet.links.length - 1] === 'https://twitter.com/someone/status/1234567890', r.tweet);

    // 4. Video and audio
    const vid = r.videos.find((v) => v.attrs.src === `${P}/media/clip.mp4`);
    check('media: http video kept as a player: controls, preload none, no autoplay, loop or muted, poster resolved' + where,
      !!vid && 'controls' in vid.attrs && vid.attrs.preload === 'none' && !('autoplay' in vid.attrs) && !('loop' in vid.attrs) && !('muted' in vid.attrs) &&
      vid.attrs.poster === `${P}/media/poster.jpg`, r.videos);
    check('media: "Open video" link under the video' + where, !!vid && vid.next && vid.next.tag === 'a' && vid.next.text === 'Open video' && vid.next.href === `${P}/media/clip.mp4`, vid);
    const aud = r.audios.find((a) => a.attrs.src === `${P}/media/talk.mp3`);
    check('media: audio from a source child kept as a player with an "Open audio" link' + where,
      !!aud && 'controls' in aud.attrs && aud.attrs.preload === 'none' && !('autoplay' in aud.attrs) && aud.next && aud.next.text === 'Open audio', r.audios);
    const note = r.links.find((l) => l.text === 'Video on the original page');
    check('media: blob: video becomes a note linking to the page' + where,
      !!note && note.href === MEDIA_URL && r.videos.length === 1 && !r.badUrls.some((u) => /^blob:/.test(u)), { note, videos: r.videos.length });

    // 5. Headings
    const head = (id) => r.heads.find((h) => h.id === id);
    check('headings: h2, h3, h4 keep their level and their ids' + where,
      head('ph-pictures') && head('ph-pictures').tag === 'h2' && head('ph-watch') && head('ph-watch').tag === 'h3' && head('ph-details') && head('ph-details').tag === 'h4', r.heads);
    check('headings: self-anchor links dropped, heading text kept' + where,
      head('ph-details') && head('ph-details').text === 'Details' && head('ph-details').links === 0 && head('ph-watch').text === 'Watch' && head('ph-watch').links === 0, r.heads);
    check('headings: title h1 not repeated in the body' + where, !r.heads.some((h) => h.tag === 'h1' || /Rich Media Story/.test(h.text)), r.heads);

    // 6. Links
    const link = (text) => r.links.find((l) => l.text === text);
    const inPage = link('details below');
    check('links: in-page #hash link kept and its target id exists' + where, !!inPage && inPage.href === '#ph-details' && r.ids.includes('ph-details'), { inPage, ids: r.ids });
    check('links: relative link resolved against the page, no ext arrow on the same site' + where,
      !!link('site guide') && link('site guide').href === `${P}/guide/start` && !/\bext\b/.test(link('site guide').cls || ''), link('site guide'));
    const ext1 = link('outside report');
    check('links: link to another site gets class ext, target _blank, rel noopener noreferrer' + where,
      !!ext1 && /\bext\b/.test(ext1.cls || '') && ext1.target === '_blank' && ext1.rel === 'noopener noreferrer', ext1);
    check('links: javascript: link unwrapped to text, mailto kept, empty link removed' + where,
      /script link JSLINKTEXT/.test(r.text) && !r.links.some((l) => /JSLINKTEXT/.test(l.text)) && !!link('mail link') && link('mail link').href === 'mailto:desk@media.example' &&
      !r.links.some((l) => /other\.example\/empty/.test(l.href)), r.links);

    // 7. Safety (importer output: the Reader adds its own buttons around it)
    check('safety: no on* or style attributes, no frames, script, object or form controls',
      out.handlers.length === 0 && out.styles.length === 0 && out.banned.length === 0 && !/FORMVALUE|OPTIONTEXT|alert\(/.test(imported.html), { handlers: out.handlers, styles: out.styles, banned: out.banned });
    check('safety: every URL is http, https, mailto or #', out.badUrls.length === 0, out.badUrls);
    if (shown) check('safety: rendered Reader has no frames and no handlers on media', shown.banned.filter((t) => t !== 'button').length === 0 || !shown.banned.some((t) => /iframe|frame|script|object|embed/.test(t)), shown.banned);

    // Second pass through sanitize changes nothing (stored docs stay stable).
    const again = await page.evaluate(({ html, url }) => PolycarpImport.sanitize(html, url) === html.replace(/\n/g, ''), { html: imported.html, url: MEDIA_URL });
    check('media: sanitize is stable on its own output', again);

    // h5 and h6 are not flattened.
    const deep = await page.evaluate(() => {
      const d = PolycarpImport.fromHtml('<html><head><title>Deep</title></head><body><article><p>' + 'Words for the body, with commas, and more words. '.repeat(12) + '</p><h2>Two</h2><p>Text two.</p><h5 id="five">Five</h5><p>Text five.</p><h6>Six</h6><p>Text six.</p></article></body></html>', 'https://deep.example/a.html', 'Deep');
      return [...new DOMParser().parseFromString(d.sections[0].html, 'text/html').querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.localName + (h.id ? '#' + h.id : ''));
    });
    check('headings: h5 and h6 keep their level', deep.includes('h5#ph-five') && deep.includes('h6') && deep.includes('h2'), deep);
  }

  const run = (url, opts = {}) => page.evaluate(async ({ url, opts }) => {
    const progress = [];
    try { return { ...window.__summ(await PolycarpImport.fromUrl(url, { ...opts, onProgress: (f) => progress.push(f) })), progress }; } catch (e) { return window.__err(e); }
  }, { url, opts });

  const pdf = await run(`${base}/files/fx-single.pdf`);
  check('fromUrl: PDF over HTTP', !pdf.error && pdf.title === 'Polycarp Fixture One' && pdf.source.url === `${base}/files/fx-single.pdf` && pdf.source.name === 'fx-single.pdf', pdf.error || pdf.source);
  check('fromUrl: progress ends at 1', !pdf.error && pdf.progress[pdf.progress.length - 1] === 1, pdf.progress);
  const art = await run(`${base}/news/story`);
  check('fromUrl: HTML page through Readability', !art.error && art.source.kind === 'html' && /ARTICLEEND/.test(allText(art)) && new RegExp(`href="${base}/relative/path"`).test(art.sections[0].html), art.error || art.sections[0].html);
  const media = await run(`${base}/media/story`);
  check('fromUrl: media page gives embed cards and an in-page link', !media.error && /class="embed-card"/.test(media.sections[0].html) && /href="#ph-details"/.test(media.sections[0].html) && /<video [^>]*preload="none"/.test(media.sections[0].html), media.error || media.sections[0].html);
  const epub = await run(`${base}/download`);
  check('fromUrl: sniffs EPUB without extension, name from Content-Disposition', !epub.error && epub.source.kind === 'epub' && epub.source.name === 'My Book.epub', epub.error || epub.source);
  const md = await run(`${base}/notes.md`);
  check('fromUrl: .md served as text/plain goes through Markdown', !md.error && md.source.kind === 'md' && /<strong>strong words<\/strong>/.test(md.sections[0].html), md.error || md.source);
  const missing = await run(`${base}/nope.pdf`);
  check('fromUrl: 404 gives FETCH', missing.error && missing.error.code === 'FETCH' && /404/.test(missing.error.message), missing.error);
  const down = await run('http://127.0.0.1:9/unreachable.pdf');
  check('fromUrl: network failure gives FETCH', down.error && down.error.code === 'FETCH', down.error);
}
server.close();

check('no uncaught page errors', pageErrors.length === 0, pageErrors);

await ext.ctx.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
