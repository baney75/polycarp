// Search in the Hub: what a query finds, the index staying right as mail changes, and a benchmark over 100,000
// made-up messages that must answer each query in under 50 ms.
// Run: node --test tests/hub-search.test.mjs   (HUB_BENCH=0 skips the benchmark)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["src/hub/model.js", "src/hub/store.js", "src/hub/search.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}
const S = globalThis.PolycarpHubStore;
const X = globalThis.PolycarpHubSearch;

const ada = { name: "Ada Arden", addr: "ada@example.com" };
const bo = { name: "Bo Blake", addr: "bo@work.example" };
const me = { name: "Me", addr: "me@home.example" };
const mk = (id, extra) => Object.assign({ remoteId: id, messageId: `<${id}@x>`, from: ada, to: [me], subject: "Plans", date: 1000, text: "" }, extra);

async function filled() {
  S.useMemoryStore();
  await S.upsert("home", [
    mk("1", { subject: "The shed roof", text: "Rain is coming on Thursday.", date: 100 }),
    mk("2", { subject: "Re: The shed roof", inReplyTo: "<1@x>", references: ["<1@x>"], from: me, to: [ada], text: "I can fix it Friday.", date: 200, folder: "sent", unread: false }),
    mk("3", { subject: "Budget sheet", from: bo, text: "Totals are on the second tab. Café receipts too.", date: 300, flagged: true, attachments: [{ id: "a", name: "totals.csv" }] }),
    mk("4", { subject: "Garden Almanac: frost", from: { name: "Garden Almanac", addr: "news@almanac.example" }, text: "Frost dates for the roof garden.", date: 400, unread: false })
  ]);
  return X.live(S);
}
const subjects = async (L, q) => {
  const hits = await L.query(q);
  const out = [];
  for (const h of hits) out.push((await S.thread(h.threadId)).summary.subject);
  return out;
};

test("words are found anywhere, newest thread first, each thread once", async () => {
  const L = await filled();
  assert.deepEqual(await subjects(L, "roof "), ["Garden Almanac: frost", "The shed roof"]);
  assert.deepEqual(await subjects(L, "friday"), ["The shed roof"], "a word in a reply finds its thread");
  assert.deepEqual(await subjects(L, "shed rain "), ["The shed roof"], "every word must match");
  assert.deepEqual(await subjects(L, "shed frost "), []);
  assert.deepEqual(await subjects(L, "cafe "), ["Budget sheet"], "accents don't matter");
  assert.deepEqual(await subjects(L, "TOTALS"), ["Budget sheet"], "case doesn't matter");
  const shed = await L.query("shed ");
  assert.equal(shed.length, 1);
  assert.deepEqual([shed[0].hits, shed[0].date], [2, 200], "a thread shows once, dated by its newest match");
});

test("the word being typed matches as a prefix; a finished word must match whole", async () => {
  const L = await filled();
  assert.deepEqual(await subjects(L, "thurs"), ["The shed roof"]);
  assert.deepEqual(await subjects(L, "thurs "), []);
  assert.deepEqual(await subjects(L, "\"thurs\""), [], "quoted words are whole words");
});

test("fields and filters narrow the search", async () => {
  const L = await filled();
  assert.deepEqual(await subjects(L, "from:bo"), ["Budget sheet"]);
  assert.deepEqual(await subjects(L, "from:bo@work.example"), ["Budget sheet"]);
  assert.deepEqual(await subjects(L, "from:arden roof "), ["The shed roof"]);
  assert.deepEqual(await subjects(L, "to:ada"), ["The shed roof"]);
  assert.deepEqual(await subjects(L, "subject:roof "), ["The shed roof"], "the almanac has roof only in its text");
  assert.deepEqual(await subjects(L, "subject:\"shed roof\""), ["The shed roof"]);
  assert.deepEqual(await subjects(L, "is:flagged"), ["Budget sheet"]);
  assert.deepEqual(await subjects(L, "has:attachment"), ["Budget sheet"]);
  assert.deepEqual(await subjects(L, "in:sent"), ["The shed roof"]);
  assert.deepEqual(await subjects(L, "is:unread roof "), ["The shed roof"]);
  assert.deepEqual(X.parse("is:nonsense frog").bad, ["is:nonsense"]);
});

test("the index follows the store: new mail, changes, removal and a removed account", async () => {
  const L = await filled();
  assert.deepEqual(await subjects(L, "is:flagged"), ["Budget sheet"]);
  await S.upsert("home", [mk("5", { subject: "Porch light", text: "The bulb went out.", date: 500 })]);
  assert.deepEqual(await subjects(L, "bulb"), ["Porch light"]);
  await S.update(["home:3"], { flagged: false });
  assert.deepEqual(await subjects(L, "is:flagged"), []);
  await S.remove(["home:5"]);
  assert.deepEqual(await subjects(L, "bulb"), []);
  await S.putAccount({ id: "home", kind: "fake" });
  await S.removeAccount("home");
  assert.deepEqual(await subjects(L, "roof "), []);
});

test("dropping most threads compacts the index and keeps answers right", () => {
  const ix = X.create();
  const msgs = [];
  for (let i = 0; i < 3000; i++) msgs.push({ id: "m" + i, threadId: "t" + i, date: i, folder: "inbox", subject: i % 2 ? "odd one" : "even one", text: "n" + i });
  ix.setThreads([], msgs);
  ix.setThreads(Array.from({ length: 2500 }, (_, i) => "t" + i), []);
  assert.equal(ix.size, 500);
  assert.equal(ix.query("odd ", { limit: 1000 }).length, 250);
  assert.equal(ix.query("even ", { limit: 1000 }).length, 250);
  assert.deepEqual(ix.query("n2999 ").map((h) => h.threadId), ["t2999"]);
  assert.deepEqual(ix.query("n10 "), []);
});

// Made-up mail with a vocabulary shaped like real text: a few words in nearly every message, most words rare.
function bigCorpus(n, seed) {
  let s = seed;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const V = 40000;
  const vocab = Array.from({ length: V }, (_, i) => "w" + i.toString(36));
  const zipf = () => vocab[Math.min(V - 1, Math.floor(Math.exp(r() * Math.log(V))) - 1)];
  const people = Array.from({ length: 2000 }, (_, i) => ({ name: "Person " + vocab[i * 7], addr: "p" + i + "@mail" + (i % 50) + ".example" }));
  const out = [];
  for (let i = 0; i < n; i++) {
    const text = Array.from({ length: 60 + Math.floor(r() * 120) }, zipf).join(" ");
    out.push({ id: "m" + i, threadId: "t" + Math.floor(i / 3), date: i, folder: r() < 0.8 ? "inbox" : "archive", unread: r() < 0.3, flagged: r() < 0.05,
      from: people[Math.floor(r() * people.length)], to: [people[Math.floor(r() * people.length)]], subject: [zipf(), zipf(), zipf()].join(" "), text });
  }
  return out;
}

test("search over 100,000 messages answers in under 50 ms", { skip: process.env.HUB_BENCH === "0" }, () => {
  const msgs = bigCorpus(100000, 99);
  const ix = X.create();
  const t0 = performance.now();
  ix.setThreads([], msgs);
  const build = performance.now() - t0;
  assert.equal(ix.size, 100000);
  const queries = ["w0", "w1 w2", "w3 w5 w8", "w1", "w", "w1z", "from:p17", "from:p1", "to:person", "subject:w4", "is:unread w2", "in:archive", "is:flagged has:attachment", "w0 w1 w2 w3 w4", "w9zz", "person w0 "];
  const rows = [];
  for (const q of queries) {
    ix.query(q);
    const times = [];
    for (let k = 0; k < 5; k++) { const a = performance.now(); ix.query(q); times.push(performance.now() - a); }
    times.sort((a, b) => a - b);
    rows.push([q, times[2], ix.query(q, { limit: 1e9 }).length]);
  }
  const worst = Math.max(...rows.map((x) => x[1]));
  console.log(`# built 100,000 messages, ${ix.tokens} words, in ${build.toFixed(0)} ms; worst median query ${worst.toFixed(1)} ms`);
  for (const [q, ms, hits] of rows) console.log(`#   ${q.padEnd(28)} ${ms.toFixed(1).padStart(6)} ms ${String(hits).padStart(6)} threads`);
  for (const [q, ms] of rows) assert.ok(ms < 50, `"${q}" took ${ms.toFixed(1)} ms`);
});
