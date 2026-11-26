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

test("an address with capitals is found by from: in any case", () => {
  // The store lowercases addresses; the index doesn't count on it.
  const ix = X.create();
  ix.setThreads([], [{ id: "c", threadId: "tc", date: 1, folder: "inbox", from: { name: "John Smith", addr: "John.Smith@Company.example" }, to: [me], subject: "Caps", text: "" }]);
  assert.deepEqual(ix.query("from:John.Smith@Company.example ").map((h) => h.threadId), ["tc"]);
});

test("a word new since the last prefix search is found by its start", () => {
  const ix = X.create();
  ix.setThreads([], [{ id: "a", threadId: "ta", date: 1, folder: "inbox", from: ada, to: [me], subject: "alpha beta", text: "" }]);
  assert.equal(ix.query("alp").length, 1);
  ix.setThreads([], [{ id: "b", threadId: "tb", date: 2, folder: "inbox", from: ada, to: [me], subject: "alpine zebra", text: "" }]);
  assert.deepEqual(ix.query("alp").map((h) => h.threadId), ["tb", "ta"]);
  assert.deepEqual(ix.query("zeb").map((h) => h.threadId), ["tb"]);
});

// A store that only lists messages, for the index's own build.
const listing = (msgs) => ({ allMessages: async () => msgs, onChange() {}, thread: async () => null });

test("the first build gives the page back between chunks, and queries wait for it whole", async () => {
  const msgs = bigCorpus(10000, 7);
  const L = X.live(listing(msgs));
  assert.equal(L.building, false, "nothing builds before it is asked");
  let ticks = 0;
  const iv = setInterval(() => ticks++, 0);
  let a, b;
  try {
    const warm = L.warm();
    assert.equal(L.building, true);
    [a, b] = await Promise.all([L.query("w0", { limit: 1e9 }), L.query("w0", { limit: 1e9 })]);
    await warm;
  } finally {
    clearInterval(iv);
  }
  assert.ok(ticks >= 3, "timers ran while it built: " + ticks);
  assert.equal(L.building, false);
  assert.equal(L.index.size, 10000);
  assert.ok(a.length > 0 && a.length === b.length && a.length === L.index.query("w0", { limit: 1e9 }).length, "both queries saw the whole index");
});

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
  // The first prefix query after mail with a new word, with no warm-up.
  ix.setThreads([], [{ id: "new", threadId: "tnew", date: 1e6, folder: "inbox", from: { addr: "n@x.example" }, to: [], subject: "qqnewword", text: "" }]);
  const a = performance.now();
  const got = ix.query("qqnew");
  rows.push(["(first prefix after new mail)", performance.now() - a, got.length]);
  assert.equal(got.length, 1);
  const worst = Math.max(...rows.map((x) => x[1]));
  console.log(`# built 100,000 messages, ${ix.tokens} words, in ${build.toFixed(0)} ms; worst median query ${worst.toFixed(1)} ms`);
  for (const [q, ms, hits] of rows) console.log(`#   ${q.padEnd(28)} ${ms.toFixed(1).padStart(6)} ms ${String(hits).padStart(6)} threads`);
  for (const [q, ms] of rows) assert.ok(ms < 50, `"${q}" took ${ms.toFixed(1)} ms`);
});

test("the page's first build of 100,000 messages never holds the page more than one chunk", { skip: process.env.HUB_BENCH === "0" }, async () => {
  const L = X.live(listing(bigCorpus(100000, 99)));
  const real = L.index.setThreads;
  const slices = [];
  L.index.setThreads = (t, m) => { const a = performance.now(); real(t, m); slices.push(performance.now() - a); };
  const a = performance.now();
  await L.warm();
  const total = performance.now() - a;
  const worst = Math.max(...slices);
  console.log(`# first build: ${slices.length} chunks in ${total.toFixed(0)} ms, longest ${worst.toFixed(0)} ms`);
  assert.ok(slices.length >= 50, "built in chunks");
  // Relative to the whole build, so a loaded machine slows both alike.
  assert.ok(worst < total / 10, `a chunk held the page ${worst.toFixed(0)} ms of ${total.toFixed(0)}`);
});
