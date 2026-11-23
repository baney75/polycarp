// Build the PDF fixtures that need a layout engine, with headless Chromium.
// Run: node tests/fixtures/make_pdf_fixtures.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../pw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BASE_CSS = `
  @page { size: Letter; }
  body { margin: 0; font-family: "Times New Roman", Times, serif; font-size: 12pt; color: #000; }
  .p { margin: 0 0 14pt 0; }
  .tight { margin-bottom: 0; }
  .ln { display: block; white-space: nowrap; text-align: justify; text-align-last: justify; }
  .last { text-align-last: left; }
  .ind { padding-left: 2em; }
  h1 { font-size: 24pt; margin: 0 0 16pt 0; }
  h2 { font-size: 18pt; margin: 0 0 12pt 0; }
  .pagebreak { break-before: page; }
`;

function para(lines, { cls = 'p', indentFirst = false, justifyLast = false } = {}) {
  return `<div class="${cls}">` + lines.map((t, i) => {
    const c = ['ln'];
    if (i === lines.length - 1 && !justifyLast) c.push('last');
    if (i === 0 && indentFirst) c.push('ind');
    return `<span class="${c.join(' ')}">${t}</span>`;
  }).join('') + '</div>';
}

const SINGLE = `<!doctype html><html><head><meta charset="utf-8"><title>Polycarp Fixture One</title>
<style>${BASE_CSS}</style></head><body>
<h1>Reading Without Friction</h1>
${para([
  'Many readers lose their place when a long paragraph runs across the page,',
  'and the eye has to jump back to the start of each new line. A good exam-',
  'ple of this problem is a dense report with narrow margins and small type,',
  'where every line looks the same and nothing marks where an idea begins.',
  'Polycarp rebuilds the text so the reader sees whole paragraphs.',
])}
${para([
  'Indented paragraphs are common in printed books, where no blank line',
  'sits between paragraphs and only the first line moves in from the margin.',
  'Readers learn this well-known rule quickly, and after a page or two the',
  'indent is enough to show that a fresh thought has started. The well-',
  'known habit carries over into many reports and letters as well.',
], { cls: 'p tight', indentFirst: true, justifyLast: true })}
${para([
  'Short lines also end paragraphs. When a line stops well before the',
  'right margin and the next line begins with a capital letter, a new',
  'paragraph has begun.',
], { cls: 'p tight', indentFirst: true })}
${para([
  'That is the third rule, and it works for ragged text as well as for',
  'justified text when the gap is large.',
])}
<div class="pagebreak"></div>
<h2>A Second Look</h2>
${para([
  'The second page repeats the running header and adds a page number at',
  'the foot. Both must vanish from the rebuilt text, because they are not',
  'part of the argument. This line ends with a broken word, the infor-',
  'mation, that must be joined back together by the importer.',
])}
${para(['A final paragraph closes the fixture with PDFEND as its marker.'])}
</body></html>`;

const COLUMNS = `<!doctype html><html><head><meta charset="utf-8"><title>Two Column Fixture</title>
<style>${BASE_CSS}
  body { font-size: 11pt; }
  .cols { column-count: 2; column-gap: 0.4in; column-fill: auto; height: 8in; }
  .colbreak { break-before: column; }
</style></head><body>
<h1>Two Column Field Notes</h1>
<div class="cols">
${para([
  'Alpha one begins the left column with',
  'a plain sentence that wraps across a',
  'few lines before it finally comes to',
  'an end here.',
])}
${para([
  'Alpha two carries on in the left column',
  'and keeps going until the column runs',
  'out of room, so that the reader keeps',
], { cls: 'p tight', justifyLast: true })}
<div class="colbreak"></div>
${para([
  'going into the right column without a',
  'break, which tests the flow join.',
])}
${para([
  'Omega one is the first new paragraph',
  'in the right column and must come after',
  'every alpha paragraph in reading order.',
])}
${para(['Omega two ends the page with COLEND.'])}
</div>
</body></html>`;

const lorem = (n) => `This is paragraph ${n} of the outline fixture. It has enough words to wrap across more than one line on the page, so the importer has to join the lines back into a single paragraph before the reader shows it. Nothing here is special apart from the marker OUTPARA${n}.`;

const OUTLINE = `<!doctype html><html><head><meta charset="utf-8"><title>Outline Fixture</title>
<style>${BASE_CSS} p { margin: 0 0 12pt 0; line-height: 1.3; }</style></head><body>
<h1>Chapter One: Arrival</h1><p>${lorem(1)}</p><p>${lorem(2)}</p>
<h1 class="pagebreak">Chapter Two: The Middle</h1><p>${lorem(3)}</p><p>${lorem(4)}</p>
<h1 class="pagebreak">Chapter Three: Departure</h1><p>${lorem(5)}</p><p>${lorem(6)}</p>
</body></html>`;

// A natural two-column paper: justified, auto-hyphenated, indented paragraphs,
// headings inside columns, a bold run-in lead, text flowing across columns and
// pages. Seeded so the output is the same on every run.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const VOCAB = 'reading attention focus paragraph comfortable margin structure typography readable letters contrast spacing information understanding distraction concentration'.split(' ');
const SMALL = ['the', 'a', 'of', 'and', 'to', 'in', 'is', 'with', 'for', 'on'];
const sentence = () => {
  const n = 8 + Math.floor(rnd() * 14);
  const w = [];
  for (let i = 0; i < n; i++) w.push(i % 3 === 0 ? VOCAB[Math.floor(rnd() * VOCAB.length)] : SMALL[Math.floor(rnd() * SMALL.length)]);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
};
let paperBody = '<h1>A Study of Calm Reading</h1><div class="cols">';
let pk = 0;
for (let sec = 1; sec <= 4; sec++) {
  paperBody += `<h2>Section ${sec} Results</h2>`;
  for (let i = 0; i < 4; i++) {
    const n = 3 + Math.floor(rnd() * 4);
    const s = [];
    for (let j = 0; j < n; j++) s.push(sentence());
    pk++;
    paperBody += `<p>P${pk}START ${s.join(' ')} P${pk}END.</p>`;
  }
  pk++;
  paperBody += `<p><b>Key point.</b> P${pk}START ${sentence()} ${sentence()} P${pk}END.</p>`;
}
paperBody += '</div>';
const PAPER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Calm Reading Study</title><style>
  body { font: 10pt/1.25 "Times New Roman", serif; margin: 0; }
  .cols { column-count: 2; column-gap: 0.3in; text-align: justify; hyphens: auto; }
  p { margin: 0; text-indent: 1.2em; }
  h1 { font-size: 20pt; text-align: center; }
  h2 { font-size: 12pt; }
</style></head><body>${paperBody}</body></html>`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();

async function make(file, html, opts) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: path.join(HERE, file), format: 'Letter', printBackground: false, ...opts });
  console.log('wrote', file);
}

await make('fx-single.pdf', SINGLE, {
  margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' },
  displayHeaderFooter: true,
  headerTemplate: '<div style="font-size:9pt;font-family:Times New Roman;width:100%;text-align:center;">Polycarp Test Journal, Vol. 4</div>',
  footerTemplate: '<div style="font-size:9pt;font-family:Times New Roman;width:100%;text-align:center;"><span class="pageNumber"></span></div>',
});
await make('fx-columns.pdf', COLUMNS, { margin: { top: '0.8in', bottom: '0.8in', left: '1in', right: '1in' } });
await make('fx-paper.pdf', PAPER, {
  margin: { top: '0.8in', bottom: '0.8in', left: '0.8in', right: '0.8in' },
  displayHeaderFooter: true,
  headerTemplate: '<div style="font-size:8pt;width:100%;text-align:right;padding-right:0.8in;">Calm Reading Study, draft</div>',
  footerTemplate: '<div style="font-size:8pt;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
});
let outlineOk = true;
try {
  await make('fx-outline.pdf', OUTLINE, { margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' }, outline: true, tagged: true });
} catch (e) {
  outlineOk = false;
  console.log('outline PDF not supported by this Playwright:', e.message);
}
await browser.close();
if (!outlineOk) process.exitCode = 2;
