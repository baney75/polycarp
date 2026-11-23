// Tests for the Library data layer and its Obsidian and Notion sync.
// Run: node --test tests/library.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
for (const f of ["lib/jszip.min.js", "src/shared/memory.js", "src/shared/library.js",
  "src/shared/sync-obsidian.js", "src/shared/sync-notion.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: path.basename(f) });
}
const L = globalThis.PolycarpLibrary;
const O = globalThis.PolycarpObsidian;
const N = globalThis.PolycarpNotion;

function fresh() { L.useMemoryStore(); }

// ---------- Fixtures ----------

const PHOTO_A = `Photosynthesis is the process green plants use to turn light into chemical energy.
Inside the leaves, chlorophyll in the chloroplasts absorbs sunlight, mostly red and blue light.
The plant takes in carbon dioxide through small pores and draws water up from its roots.
Using the energy of the absorbed light, the chloroplasts build glucose from carbon dioxide and water, and release oxygen.
The glucose feeds the plant and is stored as starch. Without chlorophyll, leaves could not capture light, and the glucose supply would stop.`;

const PHOTO_B = `In the light dependent reactions, chlorophyll molecules absorb light and split water, releasing oxygen as a byproduct.
The captured light energy is stored in ATP and NADPH inside the chloroplasts.
Then the light independent reactions fix carbon dioxide into sugars, building glucose one carbon at a time.
Chlorophyll gives leaves their green color because it reflects green light.
Plants grown in dim light make less glucose, since chlorophyll cannot absorb enough light to drive the reactions.`;

const FRENCH_A = `The French Revolution began in 1789 when the Estates General met at Versailles.
King Louis XVI faced a bankrupt treasury and a hungry, angry population in Paris.
Queen Marie Antoinette became a symbol of royal excess, and pamphlets blamed her for the crisis.
On 14 July a crowd stormed the Bastille, a royal fortress and prison.
The revolution abolished feudal privileges and issued the Declaration of the Rights of Man.`;

const FRENCH_B = `During the Reign of Terror, the revolutionary government executed thousands of suspected enemies.
Maximilien Robespierre led the Committee of Public Safety as fear spread through Paris.
Marie Antoinette was tried by the revolutionary tribunal and sent to the guillotine in October 1793.
The revolution turned on its own leaders, and Robespierre himself was executed in 1794.
The monarchy had already fallen, and the republic struggled to survive war and revolt.`;

const BREAD = `Baking bread starts with flour, yeast, salt and warm milk mixed into a shaggy dough.
Kneading develops gluten, the stretchy protein network that traps gas from the yeast.
The dough rises slowly in a warm kitchen until it doubles in size.
Bakers shape the loaf, let it proof again, and score the top with a sharp blade.
A hot oven gives the crust its color, while steam keeps the loaf soft as it bakes.`;

async function addFive() {
  const a = await L.addItem({ kind: "doc", title: "How plants make food", text: PHOTO_A, url: "https://bio.example.org/plants" });
  const b = await L.addItem({ kind: "doc", title: "Light and dark reactions", text: PHOTO_B, url: "https://school.example.com/chem/reactions" });
  const c = await L.addItem({ kind: "doc", title: "The fall of the monarchy", text: FRENCH_A, url: "https://history.example.net/1789" });
  const d = await L.addItem({ kind: "doc", title: "The Terror", text: FRENCH_B, url: "https://past.example.edu/terror" });
  const e = await L.addItem({ kind: "doc", title: "Bread basics", text: BREAD, url: "https://kitchen.example.co/bread" });
  return { a, b, c, d, e };
}

// ---------- Text helpers ----------

test("tokenize lowercases, drops possessives and keeps numbers", () => {
  assert.deepEqual(L.tokenize("The cat's Running, quickly! Don’t stop 42 times."), ["the", "cat", "running", "quickly", "don't", "stop", "42", "times"]);
  assert.deepEqual(L.tokenize(""), []);
  assert.ok(L.STOP.has("the") && L.STOP.has("because") && !L.STOP.has("chlorophyll"));
});

test("stem folds plurals, -ing and -ed but leaves short and special words alone", () => {
  const cases = {
    cats: "cat", studies: "study", boxes: "box", churches: "church", glasses: "glass", processes: "process",
    running: "run", jumped: "jump", stopped: "stop", baking: "bak", baked: "bak",
    is: "is", gas: "gas", bus: "bus", this: "this", ring: "ring", red: "red", sing: "sing", bed: "bed",
    analysis: "analysis", species: "species", news: "news", speed: "speed", class: "class", virus: "virus"
  };
  for (const [w, s] of Object.entries(cases)) assert.equal(L.stem(w), s, w);
});

test("terms ranks content words and skips stopwords", () => {
  const t = L.terms(PHOTO_A);
  assert.ok(t.length > 5 && t.length <= 40);
  const words = t.map(x => x[0]);
  assert.ok(words.includes("chlorophyll") && words.includes("light") && words.includes("glucose"));
  assert.ok(!words.includes("the") && !words.includes("and"));
  assert.ok(t[0][1] >= t[t.length - 1][1], "sorted by weight");
});

test("names finds multi word names and repeated capitalized words", () => {
  const n = L.names("In 1770, Marie Antoinette married the dauphin. The queen Marie Antoinette lived at Versailles. " +
    "Later, Versailles grew. People loved Versailles. Then she wrote letters.");
  const phrases = n.map(x => x[0]);
  assert.ok(phrases.includes("Marie Antoinette"));
  assert.ok(phrases.includes("Versailles"));
  assert.ok(!phrases.includes("Later") && !phrases.includes("Then") && !phrases.includes("People"));
});

test("cosine on sparse vectors", () => {
  assert.equal(L.cosine({ a: 1 }, { a: 2 }), 1);
  assert.equal(L.cosine({ a: 1 }, { b: 1 }), 0);
  assert.ok(Math.abs(L.cosine([["a", 1], ["b", 1]], { a: 1 }) - Math.SQRT1_2) < 1e-9);
});

test("normalizeUrl drops hash, trailing slash and tracking, lowercases host", () => {
  assert.equal(L.normalizeUrl("HTTPS://WWW.Example.com/a/b/?utm_source=x&id=3&fbclid=9&gclid=2#top"), "https://www.example.com/a/b?id=3");
  assert.equal(L.normalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(L.normalizeUrl("https://example.com/Path/"), "https://example.com/Path");
});

test("wikilinks and tagsIn", () => {
  assert.deepEqual(L.wikilinks("see [[Foo]] and [[Bar Baz|the bar]]"), [{ target: "Foo", alias: "" }, { target: "Bar Baz", alias: "the bar" }]);
  assert.deepEqual(L.tagsIn("# Heading\nhello #biology and #cell-parts, x#no, #42"), ["biology", "cell-parts"]);
});

// ---------- Items ----------

test("addItem fills the item shape", async () => {
  fresh();
  const it = await L.addItem({ kind: "doc", title: "How plants make food", text: PHOTO_A, url: "https://www.Bio.example.org/plants", source: "pdf" });
  assert.match(it.id, /^i_/);
  assert.equal(it.kind, "doc");
  assert.equal(it.source, "pdf");
  assert.equal(it.domain, "bio.example.org");
  assert.ok(it.words > 50);
  assert.ok(it.excerpt.length > 40 && it.excerpt.length <= 241);
  assert.ok(it.excerpt.startsWith("Photosynthesis is"));
  assert.ok(it.terms.length > 0 && it.terms.length <= 40);
  assert.ok(Array.isArray(it.names));
  assert.deepEqual(await L.getItem(it.id), it);
  const big = await L.addItem({ text: "x ".repeat(200000) });
  assert.equal(big.text.length, 300000);
});

test("updateItem recomputes terms when text changes", async () => {
  fresh();
  const it = await L.addItem({ title: "Notes", text: BREAD });
  const up = await L.updateItem(it.id, { text: PHOTO_A });
  assert.ok(up.terms.some(t => t[0] === "chlorophyll"));
  assert.ok(!up.terms.some(t => t[0] === "dough"));
  assert.ok(up.updated > it.updated || up.updated >= it.updated);
  const t2 = await L.updateItem(it.id, { tags: ["Biology"] });
  assert.deepEqual(t2.tags, ["biology"]);
});

test("photosynthesis pair relates by topic, and neither relates to baking", async () => {
  fresh();
  const { a, b, e } = await addFive();
  const ra = await L.related(a.id);
  const hit = ra.find(r => r.item.id === b.id);
  assert.ok(hit, "photosynthesis texts relate");
  assert.equal(hit.kind, "topic");
  assert.ok(hit.score >= 0.12 && hit.score <= 1);
  assert.match(hit.why, /^Both cover /);
  const shared = ["chlorophyll", "light", "glucose", "carbon", "oxygen", "leaves", "chloroplasts", "water"];
  assert.ok(shared.some(w => hit.why.includes(w)), hit.why);
  assert.ok(!ra.some(r => r.item.id === e.id), "baking is not related to photosynthesis A");
  const rb = await L.related(b.id);
  assert.ok(!rb.some(r => r.item.id === e.id), "baking is not related to photosynthesis B");
  const re = await L.related(e.id);
  assert.ok(!re.some(r => r.item.id === a.id || r.item.id === b.id));
  assert.ok(!ra.some(r => r.item.id === a.id), "never the item itself");
  for (let i = 1; i < ra.length; i++) assert.ok(ra[i - 1].score >= ra[i].score);
});

test("French Revolution pair relates, and reindex counts every item", async () => {
  fresh();
  const { c, d } = await addFive();
  const rc = await L.related(c.id);
  assert.ok(rc.some(r => r.item.id === d.id));
  const info = await L.reindex();
  assert.equal(info.n, 5);
});

test("a shared name links two items", async () => {
  fresh();
  const x = await L.addItem({ title: "Court fashion", text: "Rose Bertin dressed the queen. Marie Antoinette loved tall wigs and silk gowns. Milliners copied every pouf she wore, and Marie Antoinette set the style for a decade of hats." });
  const y = await L.addItem({ title: "Austrian childhood", text: "Before France, Marie Antoinette grew up in Vienna among many siblings. Her mother ruled an empire, and tutors struggled to keep the girl at her lessons." });
  const rx = await L.related(x.id);
  const hit = rx.find(r => r.item.id === y.id);
  assert.ok(hit);
  assert.equal(hit.kind, "name");
  assert.equal(hit.why, "Both mention Marie Antoinette");
});

test("a wiki link and its backlink", async () => {
  fresh();
  const { a, e } = await addFive();
  const n = await L.addItem({ kind: "note", title: "Kitchen science", text: "Yeast is alive. See [[bread basics]] and [[How plants|plants]]. #science" });
  assert.deepEqual(n.tags, ["science"]);
  const rn = await L.related(n.id);
  const toBread = rn.find(r => r.item.id === e.id);
  assert.equal(toBread.kind, "wiki");
  assert.equal(toBread.score, 1);
  assert.equal(toBread.why, "You linked it in a note");
  assert.equal(rn.find(r => r.item.id === a.id).kind, "wiki", "title prefix resolves");
  const re = await L.related(e.id);
  const back = re.find(r => r.item.id === n.id);
  assert.equal(back.kind, "backlink");
  assert.equal(back.why, "Linked from a note in Kitchen science");
  // A note attached to an item links too.
  await L.addNote({ itemId: a.id, text: "Compare with [[The Terror]]" });
  const items = await L.allItems();
  const terror = items.find(i => i.title === "The Terror");
  const ra = await L.related(a.id);
  assert.equal(ra.find(r => r.item.id === terror.id).kind, "wiki");
  const rt = await L.related(terror.id);
  assert.equal(rt.find(r => r.item.id === a.id).why, "Linked from a note in How plants make food");
});

test("same domain or author is a weak source link", async () => {
  fresh();
  const x = await L.addItem({ title: "One", text: "Alpha beta gamma.", url: "https://www.nytimes.com/a" });
  const y = await L.addItem({ title: "Two", text: "Delta epsilon zeta.", url: "https://nytimes.com/b" });
  const z = await L.addItem({ title: "Three", text: "Eta theta iota.", author: "Jane Roe" });
  const w = await L.addItem({ title: "Four", text: "Kappa lambda mu.", author: "jane roe" });
  const rx = await L.related(x.id);
  assert.deepEqual(rx.map(r => [r.kind, r.why, r.score]), [["source", "Also from nytimes.com", 0.15]]);
  const rz = await L.related(z.id);
  assert.equal(rz[0].item.id, w.id);
  assert.equal(rz[0].why, "Also by jane roe");
  assert.equal(rx[0].item.id, y.id);
});

test("saveLink dedupes by normalized URL and fills in new fields", async () => {
  fresh();
  const one = await L.saveLink({ url: "https://Example.com/post/?utm_medium=x#c1", title: "" });
  assert.equal(one.kind, "link");
  assert.equal(one.source, "web");
  const two = await L.saveLink({ url: "https://example.com/post", title: "A good post", text: "Body text of the post, long enough to be prose for the excerpt here." });
  assert.equal(two.id, one.id);
  assert.equal(two.title, "A good post");
  assert.ok(two.excerpt.startsWith("Body text"));
  assert.equal((await L.allItems()).length, 1);
  assert.equal((await L.itemByUrl("https://example.com/post/#x")).id, one.id);
});

test("upsertDoc, importReaderDocs are idempotent", async () => {
  fresh();
  const entries = [
    { key: "doc:1", title: "Cells", author: "R. Hooke", kind: "pdf", url: "", doc: { sections: [{ title: "One", html: "<h1>Cells</h1><p>Cells are the <b>units</b> of life &amp; growth.</p>" }, { title: "Two", html: "<p>Membranes wrap them.</p>" }] } },
    { key: "doc:2", title: "Bread", kind: "epub", doc: { sections: [{ html: "<p>Flour and water.</p>" }] } }
  ];
  const first = await L.importReaderDocs(entries);
  assert.equal(first.length, 2);
  assert.ok(first[0].text.includes("Cells are the units of life & growth."));
  assert.ok(!first[0].text.includes("<"));
  assert.equal(first[0].source, "pdf");
  const again = await L.importReaderDocs(entries);
  assert.equal((await L.allItems()).length, 2);
  assert.equal(again[0].updated, first[0].updated, "no write when nothing changed");
  const up = await L.upsertDoc({ docKey: "doc:1", title: "Cells, revised", text: "New text about cells." });
  assert.equal(up.id, first[0].id);
  assert.equal(up.title, "Cells, revised");
  assert.equal((await L.itemByDocKey("doc:1")).text, "New text about cells.");
});

test("addAudio stores the blob and titles from the file name", async () => {
  fresh();
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" });
  blob.name = "my_lecture-notes.mp3";
  const it = await L.addAudio(blob, { duration: 754 });
  assert.equal(it.kind, "audio");
  assert.equal(it.title, "my lecture notes");
  assert.equal(it.mime, "audio/mpeg");
  assert.equal(it.size, 4);
  assert.equal(it.duration, 754);
  const back = await L.getBlob(it.blobId);
  assert.equal(back.size, 4);
  const named = await L.addAudio(new Blob(["x"]), { title: "Talk", mime: "audio/wav" });
  assert.equal(named.title, "Talk");
});

test("notes: highlight kind, order by anchor, update and remove", async () => {
  fresh();
  const it = await L.addItem({ title: "Doc", text: PHOTO_A });
  const n3 = await L.addNote({ itemId: it.id, text: "later", anchor: { block: 9 } });
  const n1 = await L.addNote({ itemId: it.id, quote: "chlorophyll absorbs light", text: "key", anchor: { block: 2 }, color: "yellow" });
  const n2 = await L.addNote({ itemId: it.id, text: "middle", anchor: { block: 5 } });
  assert.match(n1.id, /^n_/);
  assert.equal(n1.kind, "highlight");
  assert.equal(n2.kind, "note");
  assert.deepEqual((await L.notesFor(it.id)).map(n => n.id), [n1.id, n2.id, n3.id]);
  const u = await L.updateNote(n2.id, { quote: "now a quote" });
  assert.equal(u.kind, "highlight");
  await L.removeNote(n3.id);
  assert.equal((await L.notesFor(it.id)).length, 2);
  assert.equal((await L.allNotes()).length, 2);
});

test("removeItem cascades to notes and blob", async () => {
  fresh();
  const blob = new Blob(["abc"], { type: "audio/ogg" });
  const it = await L.addAudio(blob, { title: "Clip" });
  await L.addNote({ itemId: it.id, text: "at the start", anchor: { time: 3 } });
  const other = await L.addItem({ title: "Keep me", text: "Stays." });
  await L.addNote({ itemId: other.id, text: "keep" });
  await L.removeItem(it.id);
  assert.equal(await L.getItem(it.id), null);
  assert.equal(await L.getBlob(it.blobId), null);
  assert.deepEqual(await L.notesFor(it.id), []);
  assert.equal((await L.allNotes()).length, 1);
  assert.ok(await L.getItem(other.id));
});

test("graph is undirected, deduped and capped at 6 edges per node", async () => {
  fresh();
  const ids = [];
  const words = ["Apple", "Bridge", "Candle", "Desert", "Engine", "Forest", "Garden", "Harbor", "Island"];
  for (let i = 0; i < 9; i++) ids.push((await L.addItem({ title: words[i], text: "", url: "https://same.example.com/p" + i })).id);
  const g = await L.graph({ minScore: 0.15 });
  assert.equal(g.nodes.length, 9);
  for (const n of g.nodes) {
    assert.ok("id" in n && "title" in n && "kind" in n && "degree" in n);
    assert.ok(n.degree <= 6, "cap");
  }
  const keys = new Set();
  for (const e of g.edges) {
    assert.notEqual(e.a, e.b);
    const k = [e.a, e.b].sort().join("|");
    assert.ok(!keys.has(k), "deduped");
    keys.add(k);
    assert.equal(e.kind, "source");
    assert.ok(e.score >= 0.15);
  }
  const deg = {};
  for (const e of g.edges) { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; }
  for (const n of g.nodes) assert.equal(n.degree, deg[n.id] || 0);
  assert.equal(Math.max(...g.nodes.map(n => n.degree)), 6);
  const none = await L.graph({ minScore: 0.5 });
  assert.equal(none.edges.length, 0);
});

test("search ranks title, then term, then text matches, and finds notes", async () => {
  fresh();
  const t = await L.addItem({ title: "Glucose and you", text: "A short piece on diet." });
  const { a, e } = await addFive();
  const s = await L.search("glucose");
  assert.equal(s.items[0].id, t.id, "title match first");
  assert.ok(s.items.some(i => i.id === a.id));
  assert.ok(!s.items.some(i => i.id === e.id));
  const contains = await L.addItem({ title: "Misc", text: "Long text " + "filler words here ".repeat(40) + "mentions glucose once." });
  const s2 = await L.search("glucose");
  assert.equal(s2.items[s2.items.length - 1].id, contains.id, "text contains ranks last");
  await L.addNote({ itemId: e.id, text: "Try rye flour next time" });
  const s3 = await L.search("rye flour");
  assert.equal(s3.notes.length, 1);
});

test("ideasFor matches cards by docKey or normalized URL", () => {
  const item = { docKey: "k1", url: "https://example.com/a/" };
  const cards = [
    { id: 1, source: { docKey: "k1" } },
    { id: 2, source: { url: "https://example.com/a?utm_source=z" } },
    { id: 3, source: { docKey: "k2", url: "https://example.com/b" } },
    { id: 4, source: {} }
  ];
  assert.deepEqual(L.ideasFor(item, cards).map(c => c.id), [1, 2]);
});

test("onChange hears every write", async () => {
  fresh();
  const seen = [];
  const off = L.onChange(ev => seen.push(ev.type));
  const it = await L.addItem({ title: "x" });
  await L.updateItem(it.id, { title: "y" });
  const n = await L.addNote({ itemId: it.id, text: "hi" });
  await L.removeNote(n.id);
  await L.removeItem(it.id);
  off();
  await L.addItem({ title: "z" });
  assert.deepEqual(seen, ["item:add", "item:update", "note:add", "note:remove", "item:remove"]);
});

// ---------- Obsidian ----------

test("basenames strip illegal characters and number collisions stably", () => {
  const items = [
    { id: "i_b", title: "What? A: test/case", created: 2 },
    { id: "i_a", title: "What  A  test case", created: 1 },
    { id: "i_c", title: "what a test case", created: 3 },
    { id: "i_d", title: "Polycarp Library", created: 4 },
    { id: "i_e", title: "", created: 5 }
  ];
  const m = O.basenames(items);
  assert.equal(m.i_a, "What A test case");
  assert.equal(m.i_b, "What A test case 2");
  assert.equal(m.i_c, "what a test case 3");
  assert.equal(m.i_d, "Polycarp Library 2", "the index note keeps its name");
  assert.equal(m.i_e, "Untitled");
  assert.deepEqual(O.basenames(items.slice().reverse()), m, "order of input does not matter");
});

test("toMarkdown writes frontmatter, sections and wikilinks to basenames", () => {
  const item = {
    id: "i_1", kind: "doc", title: "How plants make food", author: "Ann Lee", url: "https://bio.example.org/plants",
    source: "pdf", tags: ["biology"], created: new Date(2026, 10, 1, 21).getTime(), updated: new Date(2026, 10, 20, 22).getTime(), excerpt: "Photosynthesis is the process."
  };
  const other = { id: "i_2", title: "Light: and dark?" };
  const names = O.basenames([item, other]);
  const md = O.toMarkdown(item, {
    names,
    notes: [
      { quote: "chlorophyll absorbs light", text: "Key point", anchor: { page: 12 } },
      { quote: "a second quote", text: "", anchor: { time: 754 } },
      { text: "My own thought", anchor: {} }
    ],
    related: [{ item: other, why: "Both cover chlorophyll and light" }],
    ideas: [{ type: "cloze", prompt: "Plants store glucose as _____.", answer: "starch" }, { type: "qa", prompt: "What absorbs light?", answer: "Chlorophyll" }]
  });
  assert.equal(md.path, "Polycarp/How plants make food.md");
  const b = md.body;
  assert.ok(b.startsWith('---\npolycarp-id: "i_1"\ntype: doc\ntitle: "How plants make food"\nauthor: "Ann Lee"\nurl: "https://bio.example.org/plants"\nsource: pdf\ntags:\n  - polycarp\n  - biology\ncreated: 2026-11-01\nupdated: 2026-11-20\n---\n'), b);
  assert.ok(b.includes("# How plants make food"));
  assert.ok(b.includes("[Open the original](https://bio.example.org/plants)"));
  assert.ok(b.includes("> Photosynthesis is the process."));
  assert.ok(b.includes("## Key ideas\n\n- Plants store glucose as starch.\n- What absorbs light?: Chlorophyll"));
  assert.ok(b.includes("> chlorophyll absorbs light\n> (page 12)\n\nKey point"));
  assert.ok(b.includes("> (12:34)"));
  assert.ok(b.includes("## Notes\n\nMy own thought"));
  assert.ok(b.includes("## Related\n\n- [[Light and dark]]: Both cover chlorophyll and light"));
  const bare = O.toMarkdown({ id: "i_3", kind: "link", title: "Bare", tags: [] }, {});
  assert.ok(!bare.body.includes("## "), "empty sections skipped");
  const audio = O.toMarkdown({ id: "i_4", kind: "audio", title: "Talk", duration: 90.4, tags: [] }, {});
  assert.ok(audio.body.includes("duration: 90"));
  const note = O.toMarkdown({ id: "i_5", kind: "note", title: "Idea", text: "Read [[Bare]] again." }, {});
  assert.ok(note.body.endsWith("---\n\nRead [[Bare]] again.\n"));
  const idx = O.indexNote([item, other, { id: "i_5", kind: "note", title: "Idea" }], names);
  assert.equal(idx.path, "Polycarp/Polycarp Library.md");
  assert.ok(idx.body.includes("## Documents\n\n- [[How plants make food]] by Ann Lee"));
  assert.ok(idx.body.includes("## Notes\n\n- [[Idea]]"));
});

test("obsidianUrl drops .md and encodes both parts", () => {
  assert.equal(O.obsidianUrl("My Vault", "Polycarp/A & B.md"), "obsidian://open?vault=My%20Vault&file=Polycarp%2FA%20%26%20B");
});

// A minimal in-memory stand-in for a FileSystemDirectoryHandle.
function fakeDir(name = "vault") {
  const files = new Map();
  const dirs = new Map();
  const writes = [];
  const h = {
    kind: "directory", name, files, dirs, writes,
    async getDirectoryHandle(n, opts) {
      if (!dirs.has(n)) {
        if (!(opts && opts.create)) { const e = new Error("missing"); e.name = "NotFoundError"; throw e; }
        dirs.set(n, fakeDir(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n, opts) {
      const key = n.toLowerCase();
      if (!files.has(key)) {
        if (!(opts && opts.create)) { const e = new Error("missing"); e.name = "NotFoundError"; throw e; }
        files.set(key, { name: n, text: "" });
      }
      const rec = files.get(key);
      return {
        kind: "file", name: rec.name,
        async getFile() { return { async text() { return rec.text; } }; },
        async createWritable() {
          let buf = "";
          return { async write(d) { buf += d; }, async close() { rec.text = buf; writes.push(h.name + "/" + rec.name); } };
        }
      };
    }
  };
  return h;
}

test("writeVault writes under Polycarp/, skips unchanged files and never overwrites a user file", async () => {
  const dir = fakeDir();
  const polycarpDir = await dir.getDirectoryHandle("Polycarp", { create: true });
  polycarpDir.files.set("bread basics.md", { name: "Bread basics.md", text: "# My own bread notes\nDo not touch." });
  polycarpDir.files.set("bread basics 2.md", { name: "Bread basics 2.md", text: "---\npolycarp-id: \"someone-else\"\n---\nalso mine" });
  const items = [
    { id: "i_1", kind: "doc", title: "Bread basics", created: 1, updated: 1, tags: [] },
    { id: "i_2", kind: "doc", title: "Yeast", created: 2, updated: 2, tags: [] }
  ];
  const names = O.basenames(items);
  const files = [
    O.toMarkdown(items[0], { names }),
    O.toMarkdown(items[1], { names, related: [{ item: items[0], why: "Both cover yeast" }] }),
    O.indexNote(items, names),
    { path: "Other/evil.md", body: "x" },
    { path: "Polycarp/../escape.md", body: "x" }
  ];
  const progress = [];
  const r1 = await O.writeVault(dir, files, { onProgress: p => progress.push(p.done) });
  assert.equal(r1.written, 3);
  assert.equal(r1.renamed, 1);
  assert.deepEqual(r1.renames, [{ from: "Polycarp/Bread basics.md", to: "Polycarp/Bread basics 3.md" }]);
  assert.equal(polycarpDir.files.get("bread basics.md").text, "# My own bread notes\nDo not touch.", "user file untouched");
  assert.equal(polycarpDir.files.get("bread basics 2.md").text, "---\npolycarp-id: \"someone-else\"\n---\nalso mine");
  assert.ok(polycarpDir.files.get("bread basics 3.md").text.includes('polycarp-id: "i_1"'));
  assert.ok(polycarpDir.files.get("yeast.md").text.includes("[[Bread basics 3]]: Both cover yeast"), "links follow the rename");
  assert.ok(polycarpDir.files.get("polycarp library.md").text.includes("[[Bread basics 3]]"));
  assert.deepEqual([...dir.dirs.keys()], ["Polycarp"], "nothing outside Polycarp/");
  assert.equal(dir.files.size, 0);
  assert.ok(dir.writes.length === 0 && polycarpDir.writes.every(w => w.startsWith("Polycarp/")));
  assert.deepEqual(progress, [1, 2, 3]);

  const before = polycarpDir.writes.length;
  const r2 = await O.writeVault(dir, files, {});
  assert.equal(r2.written, 0);
  assert.equal(r2.skipped, 5, "three unchanged plus two refused paths");
  assert.equal(polycarpDir.writes.length, before);

  items[1].updated = 99;
  const changed = [O.toMarkdown(items[1], { names })];
  const r3 = await O.writeVault(dir, changed, {});
  assert.equal(r3.written, 1);
});

test("zip packs files with JSZip", async () => {
  const blob = await O.zip([{ path: "Polycarp/A.md", body: "hello" }, { path: "Polycarp/B.md", body: "world" }]);
  assert.ok(blob.size > 0);
  const z = await globalThis.JSZip.loadAsync(await blob.arrayBuffer());
  assert.equal(await z.file("Polycarp/A.md").async("string"), "hello");
});

test("folder handle is saved in the library meta store and permission is requested", async () => {
  fresh();
  await O.saveHandle({ name: "vault" });
  assert.deepEqual(await O.loadHandle(), { name: "vault" });
  const asked = [];
  const h = { async queryPermission(o) { asked.push(["q", o.mode]); return "prompt"; }, async requestPermission(o) { asked.push(["r", o.mode]); return "granted"; } };
  assert.equal(await O.ensurePermission(h), true);
  assert.deepEqual(asked, [["q", "readwrite"], ["r", "readwrite"]]);
  assert.equal(await O.ensurePermission({ async queryPermission() { return "denied"; }, async requestPermission() { return "denied"; } }), false);
});

// ---------- Notion ----------

// A small fake of the Notion API that records every call.
function fakeNotion() {
  let seq = 0;
  const nid = () => "0000" + String(++seq).padStart(4, "0") + "-aaaa-bbbb-cccc-000000000000";
  const dbs = new Map(), pages = new Map(), blocks = new Map(), children = new Map();
  const calls = [];
  const queue429 = [];
  const toResp = (props) => {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) {
      const type = Object.keys(v)[0];
      let val = v[type];
      if (type === "title" || type === "rich_text") val = val.map(r => Object.assign({}, r, { plain_text: r.text.content }));
      out[k] = { id: k, type, [type]: val };
    }
    return out;
  };
  const pageResp = (p) => ({ object: "page", id: p.id, archived: false, url: "https://notion.so/" + p.id, parent: p.parent, properties: toResp(p.properties) });
  function route(method, url, body) {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v1/, "");
    let m;
    if (method === "GET" && p === "/users/me") return [200, { object: "user", id: "bot", type: "bot", name: "Polycarp" }];
    if (method === "POST" && p === "/search") return [200, { results: [{ object: "page", id: "page-1", url: "https://notion.so/page-1", properties: { title: { type: "title", title: [{ plain_text: "Reading" }] } } }], has_more: false }];
    if (method === "POST" && p === "/databases") {
      const id = nid();
      const props = {};
      for (const [k, v] of Object.entries(body.properties)) props[k] = Object.assign({ type: Object.keys(v)[0] }, v);
      dbs.set(id, { id, properties: props, parent: body.parent });
      return [200, { object: "database", id, properties: props }];
    }
    if ((m = /^\/databases\/([^/]+)$/.exec(p))) {
      const db = dbs.get(m[1]);
      if (!db) return [404, { object: "error", status: 404, code: "object_not_found", message: "Could not find database" }];
      if (method === "PATCH") for (const [k, v] of Object.entries(body.properties)) {
        if (v.name && Object.keys(v).length === 1) { db.properties[v.name] = db.properties[k]; delete db.properties[k]; } else db.properties[k] = Object.assign({ type: Object.keys(v)[0] }, v);
      }
      return [200, { object: "database", id: db.id, properties: db.properties }];
    }
    if ((m = /^\/databases\/([^/]+)\/query$/.exec(p))) {
      const list = [...pages.values()].filter(x => x.parent.database_id === m[1]).map(pageResp);
      return [200, { results: list, has_more: false, next_cursor: null }];
    }
    if (method === "POST" && p === "/pages") {
      const id = nid();
      pages.set(id, { id, parent: body.parent, properties: JSON.parse(JSON.stringify(body.properties)) });
      children.set(id, []);
      for (const b of body.children || []) { const bid = nid(); blocks.set(bid, Object.assign({ id: bid, archived: false }, b)); children.get(id).push(bid); }
      return [200, pageResp(pages.get(id))];
    }
    if ((m = /^\/pages\/([^/]+)$/.exec(p))) {
      const pg = pages.get(m[1]);
      if (!pg) return [404, { object: "error", status: 404, code: "object_not_found", message: "Could not find page" }];
      if (method === "PATCH") Object.assign(pg.properties, JSON.parse(JSON.stringify(body.properties)));
      return [200, pageResp(pg)];
    }
    if ((m = /^\/blocks\/([^/]+)\/children$/.exec(p))) {
      const list = children.get(m[1]) || [];
      if (method === "PATCH") {
        for (const b of body.children) { const bid = nid(); blocks.set(bid, Object.assign({ id: bid, archived: false }, b)); list.push(bid); }
        return [200, { results: [] }];
      }
      return [200, { results: list.map(id => blocks.get(id)).filter(b => !b.archived), has_more: false, next_cursor: null }];
    }
    if (method === "DELETE" && (m = /^\/blocks\/([^/]+)$/.exec(p))) {
      const b = blocks.get(m[1]);
      b.archived = true;
      return [200, b];
    }
    return [400, { object: "error", status: 400, code: "invalid_request_url", message: "No route " + method + " " + p }];
  }
  async function fetch(url, init) {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: new URL(url).pathname.replace(/^\/v1/, ""), body, headers: init.headers });
    if (queue429.length) {
      const sec = queue429.shift();
      return new Response(JSON.stringify({ object: "error", status: 429, code: "rate_limited", message: "Slow down" }), { status: 429, headers: { "Retry-After": String(sec) } });
    }
    const [status, data] = route(init.method, url, body);
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }
  return { fetch, calls, dbs, pages, blocks, children, queue429 };
}

function notionClient(fake, sleeps) {
  return N.create({ token: "secret_test", fetch: fake.fetch, sleep: async (ms) => { sleeps.push(ms); } });
}

test("Notion requests carry the version header and run at least 340 ms apart", async () => {
  const fake = fakeNotion();
  const sleeps = [];
  const c = notionClient(fake, sleeps);
  await Promise.all([c.me(), c.me(), c.me()]);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0].headers["Notion-Version"], "2022-06-28");
  assert.equal(fake.calls[0].headers.Authorization, "Bearer secret_test");
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every(ms => ms > 300 && ms <= 340));
  const pages = await c.searchPages("read");
  assert.deepEqual(pages, [{ id: "page-1", title: "Reading", url: "https://notion.so/page-1" }]);
});

test("Notion retries a 429 after Retry-After and surfaces error status and code", async () => {
  const fake = fakeNotion();
  const sleeps = [];
  const c = notionClient(fake, sleeps);
  fake.queue429.push(2);
  const me = await c.me();
  assert.equal(me.name, "Polycarp");
  assert.equal(fake.calls.length, 2);
  assert.ok(sleeps.includes(2000), "waited Retry-After seconds");
  await assert.rejects(c.request("GET", "/databases/nope"), (e) => e.status === 404 && e.code === "object_not_found");
});

test("ensureDatabase creates the database, then patches in the Related relation", async () => {
  const fake = fakeNotion();
  const c = notionClient(fake, []);
  const id = await c.ensureDatabase("page-1");
  const [post, patch] = fake.calls;
  assert.equal(post.method, "POST");
  assert.equal(post.path, "/databases");
  assert.deepEqual(post.body.parent, { type: "page_id", page_id: "page-1" });
  assert.equal(post.body.title[0].text.content, "Polycarp Library");
  assert.deepEqual(Object.keys(post.body.properties), ["Name", "Type", "URL", "Author", "Tags", "Polycarp ID", "Updated", "Sync"]);
  assert.deepEqual(post.body.properties.Type.select.options.map(o => o.name), ["Document", "Link", "Audio", "Note"]);
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, "/databases/" + id);
  assert.deepEqual(patch.body.properties.Related, { relation: { database_id: id, type: "single_property", single_property: {} } });
  // Reuse: the database exists, one property went missing.
  delete fake.dbs.get(id).properties.Author;
  fake.calls.length = 0;
  const again = await c.ensureDatabase("page-1", id);
  assert.equal(again, id);
  assert.deepEqual(fake.calls.map(x => x.method + " " + x.path), ["GET /databases/" + id, "PATCH /databases/" + id]);
  assert.deepEqual(Object.keys(fake.calls[1].body.properties), ["Author"]);
  fake.calls.length = 0;
  const gone = await c.ensureDatabase("page-1", "missing-db");
  assert.notEqual(gone, "missing-db");
  assert.equal(fake.calls[1].path, "/databases");
});

test("blocksFor builds sections and splits rich text at 2000 characters", () => {
  const long = "a".repeat(4500);
  const blocks = N.blocksFor(
    { kind: "doc", excerpt: long },
    [{ quote: "q1", text: "n1", anchor: { page: 3 } }, { text: "# Big\n## Small\n- one\n- two\nPlain line\nmore" }],
    [{ type: "cloze", prompt: "Plants make _____.", answer: "glucose" }]
  );
  assert.equal(blocks[0].type, "quote");
  assert.deepEqual(blocks[0].quote.rich_text.map(r => r.text.content.length), [2000, 2000, 500]);
  const types = blocks.map(b => b.type);
  assert.deepEqual(types, ["quote", "heading_2", "bulleted_list_item", "heading_2", "quote", "paragraph", "heading_2", "heading_2", "heading_3", "bulleted_list_item", "bulleted_list_item", "paragraph"]);
  assert.equal(blocks[2].bulleted_list_item.rich_text[0].text.content, "Plants make glucose.");
  assert.equal(blocks[5].paragraph.rich_text[0].text.content, "page 3");
  assert.equal(blocks[11].paragraph.rich_text[0].text.content, "Plain line\nmore");
  for (const b of blocks) for (const r of b[b.type].rich_text) assert.ok(r.text.content.length <= 2000);
  assert.deepEqual(N.chunks("a" + "😀".repeat(1500)).map(s => s.length), [1999, 1002], "never splits a surrogate pair");
  assert.deepEqual(N.blocksFor({ kind: "doc" }, [], []), []);
});

test("syncItems creates pages, skips unchanged bodies, rewrites changed ones and sets Related", async () => {
  fresh();
  const fake = fakeNotion();
  const c = notionClient(fake, []);
  const dbId = await c.ensureDatabase("page-1");
  const { a, b } = await addFive();
  await L.addNote({ itemId: a.id, quote: "chlorophyll absorbs light", text: "first", anchor: { block: 1 } });
  await L.updateItem(a.id, { tags: ["Biology", "plants"] });
  const items = [await L.getItem(a.id), await L.getItem(b.id)];
  const opts = { notesFor: L.notesFor, relatedFor: (id) => L.related(id), ideasFor: () => [] };

  fake.calls.length = 0;
  const r1 = await c.syncItems(dbId, items, opts);
  assert.deepEqual([r1.created, r1.updated, r1.unchanged, r1.errors.length], [2, 0, 0, 0]);
  const createCall = fake.calls.find(x => x.method === "POST" && x.path === "/pages");
  const props = createCall.body.properties;
  assert.equal(props.Name.title[0].text.content, "How plants make food");
  assert.equal(props.Type.select.name, "Document");
  assert.equal(props.URL.url, "https://bio.example.org/plants");
  assert.deepEqual(props.Tags.multi_select, [{ name: "biology" }, { name: "plants" }]);
  assert.equal(props["Polycarp ID"].rich_text[0].text.content, a.id);
  assert.ok(props.Updated.date.start.endsWith("Z"));
  assert.match(props.Sync.rich_text[0].text.content, /^[0-9a-f]{8}\.[0-9a-f]{8}$/);
  assert.equal(createCall.body.parent.database_id, dbId);
  assert.ok(createCall.body.children.some(bl => bl.type === "heading_2" && bl.heading_2.rich_text[0].text.content === "Highlights"));
  const relCalls = fake.calls.filter(x => x.method === "PATCH" && x.path.startsWith("/pages/") && x.body.properties.Related);
  assert.equal(relCalls.length, 2, "each page points at the other");
  assert.equal(relCalls[0].body.properties.Related.relation[0].id, r1.pageIds[b.id]);

  // No change: nothing rewritten.
  fake.calls.length = 0;
  const r2 = await c.syncItems(dbId, items, Object.assign({ pageIds: r1.pageIds }, opts));
  assert.deepEqual([r2.created, r2.updated, r2.unchanged], [0, 0, 2]);
  assert.ok(!fake.calls.some(x => x.method === "DELETE" || x.path.endsWith("/children") || x.method === "PATCH"), fake.calls.map(x => x.method + " " + x.path).join(", "));

  // A changed note rewrites only that page's body.
  const [note] = await L.notesFor(a.id);
  await L.updateNote(note.id, { text: "second thoughts" });
  fake.calls.length = 0;
  const r3 = await c.syncItems(dbId, items, opts);
  assert.deepEqual([r3.created, r3.updated, r3.unchanged], [0, 1, 1], "found pages by Polycarp ID without pageIds");
  const pageA = r1.pageIds[a.id];
  assert.ok(fake.calls.some(x => x.method === "DELETE"), "old children archived");
  assert.ok(fake.calls.some(x => x.method === "PATCH" && x.path === "/blocks/" + pageA + "/children"));
  assert.ok(!fake.calls.some(x => x.path === "/blocks/" + r1.pageIds[b.id] + "/children"), "unchanged page untouched");
  const live = fake.children.get(pageA).map(id => fake.blocks.get(id)).filter(bl => !bl.archived);
  assert.ok(live.some(bl => bl.type === "paragraph" && bl.paragraph.rich_text.some(r => r.text.content === "second thoughts")));
  assert.ok(!fake.calls.some(x => x.method === "DELETE" && x.path === "/pages/" + pageA), "pages never deleted");
});

test("syncItems appends long bodies in chunks of 100 blocks", async () => {
  const fake = fakeNotion();
  const c = notionClient(fake, []);
  const dbId = await c.ensureDatabase("page-1");
  const notes = [];
  for (let i = 0; i < 250; i++) notes.push({ text: "Note number " + i });
  const item = { id: "i_big", kind: "doc", title: "Big", tags: [], updated: 1, excerpt: "" };
  fake.calls.length = 0;
  const r = await c.syncItems(dbId, [item], { notesFor: () => notes });
  assert.equal(r.created, 1);
  const create = fake.calls.find(x => x.path === "/pages");
  assert.equal(create.body.children.length, 100);
  const appends = fake.calls.filter(x => x.method === "PATCH" && x.path.endsWith("/children"));
  assert.deepEqual(appends.map(x => x.body.children.length), [100, 51]);
  assert.equal(fake.children.get(r.pageIds.i_big).length, 251);
});

test("backup: exportData and importData carry items and notes across a wiped library", async () => {
  fresh();
  const a = await L.upsertDoc({ docKey: "f:a", title: "Photosynthesis", sourceKind: "pdf", text: PHOTO_A });
  await L.saveLink({ url: "https://example.org/b", title: "Light reactions", text: PHOTO_B });
  await L.addNote({ itemId: a.id, quote: "chlorophyll", text: "Why leaves are green", anchor: { block: 1 } });
  const dump = JSON.parse(JSON.stringify(await L.exportData()));
  assert.equal(dump.items.length, 2);
  assert.equal(dump.notes.length, 1);
  fresh();
  assert.equal((await L.allItems()).length, 0);
  const r = await L.importData(dump);
  assert.deepEqual(r, { items: 2, notes: 1 });
  assert.equal((await L.allItems()).length, 2);
  assert.equal((await L.notesFor(a.id))[0].text, "Why leaves are green");
  // Junk records are skipped, not stored.
  const junk = await L.importData({ items: [{ id: 5 }, { id: "x", kind: "virus" }], notes: [{ id: "n" }] });
  assert.deepEqual(junk, { items: 0, notes: 0 });
});

test("search: #tag filters by tag, through note-items and item notes", async () => {
  fresh();
  const a = await L.upsertDoc({ docKey: "f:a", title: "Photosynthesis", sourceKind: "pdf", text: PHOTO_A });
  await L.upsertDoc({ docKey: "f:b", title: "Revolution", sourceKind: "pdf", text: FRENCH_A });
  const n = await L.addItem({ kind: "note", title: "Plants", text: "Leaves and light. #botany" });
  await L.addNote({ itemId: a.id, quote: "", text: "Ties into #botany too", anchor: {} });
  const r = await L.search("#botany");
  assert.deepEqual(r.items.map(i => i.id).sort(), [a.id, n.id].sort());
  assert.equal(r.notes.length, 1);
  assert.equal((await L.search("#nothing")).items.length, 0);
});
