// Tests for src/shared/memory.js. Run: node --test tests/memory.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
vm.runInThisContext(fs.readFileSync(path.join(root, "src/shared/memory.js"), "utf8"), { filename: "memory.js" });
const M = globalThis.PolycarpMemory;
const BORING = fs.readFileSync(path.join(here, "fixtures/boring.txt"), "utf8");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const STOP = new Set("a an the of to in on at for and or but is are was were be by with as it its that this these those from".split(" "));

// ---------- Tiers and grading ----------

test("TIERS lists five Leitner tiers plus Mastered", () => {
  assert.deepEqual(M.TIERS.map(t => t.days), [1, 3, 7, 16, 35, 90]);
  assert.deepEqual(M.TIERS.map(t => t.name), ["Fresh", "Warm", "Settling", "Strong", "Long-term", "Mastered"]);
});

test("newCard starts at tier 1, due in one day", () => {
  const c = M.newCard({ type: "cloze", prompt: "p _____", answer: "x", source: { title: "T", url: "u", docKey: "d", section: 2 } }, NOW);
  assert.equal(c.tier, 1);
  assert.equal(c.due, NOW + DAY);
  assert.equal(c.created, NOW);
  assert.equal(c.reviews, 0);
  assert.equal(c.lapses, 0);
  assert.equal(c.source.section, 2);
  assert.ok(c.id);
  assert.equal(M.newCard({ type: "bogus" }, NOW).type, "cloze");
});

test("got moves up a tier with at most 10 percent jitter, deterministic by id", () => {
  const c = M.newCard({ id: "card-1", prompt: "p", answer: "a" }, NOW);
  const g = M.grade(c, "got", NOW);
  assert.equal(g.tier, 2);
  assert.ok(g.due >= NOW + 3 * DAY * 0.9 && g.due <= NOW + 3 * DAY * 1.1, "due within jitter");
  assert.equal(M.grade(c, "got", NOW).due, g.due, "same card, same jitter");
  assert.equal(g.reviews, 1);
  assert.equal(g.last, NOW);
  assert.equal(c.tier, 1, "input card unchanged");
  assert.equal(c.reviews, 0);
});

test("fuzzy keeps the tier, half interval with a one day floor", () => {
  const c = M.newCard({ id: "f" }, NOW);
  const f1 = M.grade(c, "fuzzy", NOW);
  assert.equal(f1.tier, 1);
  assert.equal(f1.due, NOW + DAY);
  const t3 = Object.assign({}, c, { tier: 3 });
  const f3 = M.grade(t3, "fuzzy", NOW);
  assert.equal(f3.tier, 3);
  assert.equal(f3.due, NOW + 3.5 * DAY);
});

test("missed drops two stages (never below 1), retry in 10 minutes, counts a lapse", () => {
  const c = Object.assign(M.newCard({ id: "m" }, NOW), { tier: 4, lapses: 2 });
  const m = M.grade(c, "missed", NOW);
  assert.equal(m.tier, 2);
  assert.equal(M.grade(Object.assign({}, c, { tier: 2 }), "missed", NOW).tier, 1);
  assert.ok(!m.leech, "three lapses is not a leech yet");
  assert.equal(M.grade(m, "missed", NOW).leech, true, "the fourth lapse flags the card for a rewrite");
  assert.equal(m.due, NOW + 10 * 60 * 1000);
  assert.equal(m.lapses, 3);
  assert.throws(() => M.grade(c, "maybe", NOW));
});

test("passing tier 5 makes a card Mastered, reviewed every 90 days", () => {
  let c = M.newCard({ id: "climb" }, NOW);
  let t = NOW;
  for (let i = 0; i < 5; i++) { t = c.due; c = M.grade(c, "got", t); }
  assert.equal(c.tier, 6);
  assert.equal(M.tierInfo(c.tier).name, "Mastered");
  assert.ok(c.due - t >= 90 * DAY * 0.9 && c.due - t <= 90 * DAY * 1.1);
  const again = M.grade(c, "got", c.due);
  assert.equal(again.tier, 6, "stays mastered");
});

test("due, counts and nextDue", () => {
  const a = Object.assign(M.newCard({ id: "a" }, NOW), { due: NOW - 5, tier: 2 });
  const b = Object.assign(M.newCard({ id: "b" }, NOW), { due: NOW - 50, tier: 1 });
  const c = Object.assign(M.newCard({ id: "c" }, NOW), { due: NOW + DAY, tier: 6 });
  const d = M.due([a, b, c], NOW);
  assert.deepEqual(d.map(x => x.id), ["b", "a"], "oldest due first");
  assert.deepEqual(M.counts([a, b, c], NOW), { due: 2, total: 3, byTier: { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 1 } });
  assert.equal(M.nextDue([a, b, c]), NOW - 50);
  assert.equal(M.nextDue([]), null);
});

// ---------- Text analysis ----------

test("sentence splitter handles abbreviations, initials, decimals, quotes and ellipses", () => {
  const text = 'Dr. Smith paid $3.50 for coffee. The U.S. Army was there, e.g. at the gate. ' +
    'Mr. J. R. Tolkien wrote "The Hobbit." Then he rested... and slept. Was it late? Yes! ' +
    "It cost 2.5 percent more, i.e. a lot.";
  assert.deepEqual(M.sentences(text), [
    "Dr. Smith paid $3.50 for coffee.",
    "The U.S. Army was there, e.g. at the gate.",
    'Mr. J. R. Tolkien wrote "The Hobbit."',
    "Then he rested... and slept.",
    "Was it late?",
    "Yes!",
    "It cost 2.5 percent more, i.e. a lot."
  ]);
  assert.deepEqual(M.sentences("They moved to the U.S. The next year was hard. See Fig. 3 for details."), [
    "They moved to the U.S.", "The next year was hard.", "See Fig. 3 for details."
  ]);
  assert.deepEqual(M.sentences("Section Two\nThe pump runs at 4.5 meters per second. It stops at night."), [
    "Section Two", "The pump runs at 4.5 meters per second.", "It stops at night."
  ]);
  assert.deepEqual(M.sentences("Wait for it… Then go."), ["Wait for it…", "Then go."]);
  assert.equal(M.sentences("").length, 0);
});

test("fixture splits into a sensible number of sentences", () => {
  const s = M.sentences(BORING);
  assert.ok(s.length >= 65 && s.length <= 80, "got " + s.length);
  assert.ok(s.some(x => x.includes("because E. coli indicates recent fecal contamination")), "E. coli kept whole");
  assert.ok(s.some(x => x.includes("0.3 NTU in at least 95 percent")), "decimal kept whole");
});

test("keySentences returns document order, skips short sentences, has scores", () => {
  const stats = M.docStats(BORING);
  const ks = M.keySentences(BORING, 6, stats);
  assert.equal(ks.length, 6);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i].index > ks[i - 1].index, "document order");
  for (const k of ks) {
    const wc = M.wordCount(k.text);
    assert.ok(wc >= 8 && wc <= 45, "length " + wc);
    assert.equal(typeof k.score, "number");
  }
  assert.deepEqual(M.keySentences("Yes. No. Maybe so. Go now.", 3), []);
  const mixed = "Short one. This sentence is long enough to be considered by the ranking step today. Tiny.";
  assert.deepEqual(M.keySentences(mixed, 3).map(k => k.text), ["This sentence is long enough to be considered by the ranking step today."]);
});

test("keyIdeas returns the top sentences as strings", () => {
  const ideas = M.keyIdeas(BORING, 3);
  assert.equal(ideas.length, 3);
  for (const s of ideas) assert.equal(typeof s, "string");
});

test("makeCloze never blanks a stopword and returns the hint format", () => {
  const stats = M.docStats(BORING);
  let made = 0;
  for (const s of M.sentences(BORING)) {
    const c = M.makeCloze(s, stats);
    if (!c) continue;
    made++;
    const words = c.answer.split(/\s+/);
    assert.ok(!STOP.has(words[0].toLowerCase()) && !STOP.has(words[words.length - 1].toLowerCase()), "stopword edge: " + c.answer);
    assert.ok(words.length >= 1 && words.length <= 4, c.answer);
    assert.equal(c.prompt.split("_____").length, 2, "one blank");
    assert.equal(c.prompt.replace("_____", c.answer), s, "prompt plus answer is the sentence");
    assert.ok(!c.prompt.startsWith("_____") || /\b(is|are)\s+(a|an|the|defined)\b|\bmeans\b|\brefers to\b/.test(s), "first word only for a defined term: " + s);
    // Hint: per word, first character then underscores (digits shown as #), then the lengths.
    const lens = words.map(w => Array.from(w).length).join(" ");
    assert.ok(c.hint.endsWith("(" + lens + ")"), c.hint);
    const first = c.answer.charAt(0);
    assert.ok(c.hint.startsWith(/\d/.test(first) ? "#" : first), c.hint);
  }
  assert.ok(made > 40, "most sentences yield a cloze, got " + made);
  const one = M.makeCloze("Phosphate is a mineral salt that farmers spread on fields every spring.", null);
  assert.ok(one);
  assert.match(one.hint, /^\S_+( \S_+)* \(\d+( \d+)*\)$/);
  assert.equal(M.makeCloze("It is what it is.", null), null);
  assert.equal(M.makeCloze("", null), null);
});

test("checkpoint makes a cloze plus a gist and dedupes with seen", () => {
  const paras = BORING.split(/\n\s*\n/).slice(1);
  const stats = M.docStats(BORING);
  const seen = new Set();
  const source = { title: "Water rules", url: "https://example.test/water", docKey: "doc-1", section: 4 };
  const first = M.checkpoint(paras[3], stats, { seen, source, now: NOW });
  assert.equal(first.length, 2);
  assert.equal(first[0].type, "cloze");
  assert.equal(first[1].type, "gist");
  assert.equal(first[1].prompt, "In one line, what was this part about?");
  assert.equal(first[0].source.docKey, "doc-1");
  assert.equal(first[0].due, NOW + DAY);
  const again = M.checkpoint(paras[3], stats, { seen, source, now: NOW });
  const before = new Set(first.map(c => M.normalize(c.answer)));
  for (const c of again) assert.ok(!before.has(M.normalize(c.answer)), "duplicate " + c.answer);
  assert.ok(again.every(c => c.type === "cloze"), "gist not repeated");
  assert.equal(M.checkpoint(paras[3], stats, { max: 0 }).length, 0);
  assert.ok(M.checkpoint(paras[3], stats, { max: 3, gist: false }).every(c => c.type === "cloze"));
  assert.deepEqual(M.checkpoint("Too short. Really.", null, {}), []);
});

test("boring fixture yields sensible clozes (prints 5 samples)", () => {
  const stats = M.docStats(BORING);
  const paras = BORING.split(/\n\s*\n/).slice(1);
  const seen = new Set();
  const clozes = [];
  for (const p of paras) for (const c of M.checkpoint(p, stats, { seen, now: NOW, max: 2 })) if (c.type === "cloze") clozes.push(c);
  assert.ok(clozes.length >= paras.length - 2, "nearly every section gets a cloze, got " + clozes.length);
  const answers = clozes.map(c => M.normalize(c.answer));
  assert.equal(new Set(answers).size, answers.length, "no duplicate answers across the doc");
  for (const c of clozes) assert.ok(c.context.includes(c.answer));
  const pick = [0, 3, 6, 9, 12].map(i => clozes[Math.min(i, clozes.length - 1)]);
  console.log("\nSample clozes from tests/fixtures/boring.txt:");
  pick.forEach((c, i) => console.log("  " + (i + 1) + ". " + c.prompt + "\n     answer: " + c.answer + "   hint: " + c.hint));
});

test("non-Latin text does not throw", () => {
  const samples = [
    "这是第一句话，用来测试。这是第二句话！第三句话在这里？",
    "日本語の文章です。これは二番目の文です。",
    "Это первое предложение о воде и её очистке на станции. Второе предложение рассказывает о фильтрах и хлоре в системе.",
    "هذه جملة أولى عن معالجة المياه في المدينة الكبيرة اليوم. وهذه جملة ثانية عن الفلاتر والكلور في النظام.",
    "यह पानी के उपचार के बारे में पहला वाक्य है जो काफी लंबा है। यह दूसरा वाक्य है जो फिल्टर के बारे में बताता है।",
    "Ünïcödé façade naïve café résumé coöperate. Ελληνικά κείμενα εδώ για δοκιμή του συστήματος σήμερα το πρωί."
  ];
  for (const t of samples) {
    const stats = M.docStats(t);
    const s = M.sentences(t);
    assert.ok(Array.isArray(s));
    M.keySentences(t, 2, stats);
    M.keyIdeas(t, 2);
    for (const x of s) M.makeCloze(x, stats);
    M.checkpoint(t, stats, { max: 2 });
  }
  assert.equal(M.sentences(samples[0]).length, 3);
  assert.equal(M.sentences(samples[1]).length, 2);
});

// ---------- On-device AI adapter ----------

test("ai adapter returns null with no globals present", async () => {
  assert.equal(globalThis.Summarizer, undefined);
  assert.equal(globalThis.LanguageModel, undefined);
  assert.deepEqual(await M.ai.available(), { summarizer: false, prompt: false });
  assert.equal(await M.ai.keyIdeas(BORING, 3), null);
  assert.equal(await M.ai.questions(BORING, 3), null);
});

test("ai adapter never triggers a download and drops ungrounded answers", async () => {
  let created = 0;
  globalThis.Summarizer = { availability: async () => "downloadable", create: async () => { created++; } };
  globalThis.LanguageModel = {
    availability: async () => "available",
    create: async () => ({
      prompt: async (_text, opts) => {
        assert.ok(opts && opts.responseConstraint, "uses a JSON schema");
        return JSON.stringify([
          { q: "What forms larger clumps called floc?", a: "flocculation" },
          { q: "Who invented water?", a: "Benjamin Franklin" },
          { q: "What turbidity limit applies?", a: "0.3 NTU" }
        ]);
      },
      destroy() {}
    })
  };
  try {
    assert.deepEqual(await M.ai.available(), { summarizer: false, prompt: true });
    assert.equal(await M.ai.keyIdeas(BORING, 3), null);
    assert.equal(created, 0, "downloadable model never created");
    const qs = await M.ai.questions(BORING, 3);
    assert.deepEqual(qs.map(x => x.a), ["flocculation", "0.3 NTU"]);
    globalThis.LanguageModel.create = async () => { throw new Error("boom"); };
    assert.equal(await M.ai.questions(BORING, 3), null);
    globalThis.Summarizer = {
      availability: async () => "available",
      create: async opts => {
        assert.equal(opts.type, "key-points");
        return { summarize: async () => "* First point.\n* Second point.\n* Third point.", destroy() {} };
      }
    };
    assert.deepEqual(await M.ai.keyIdeas(BORING, 2), ["First point.", "Second point."]);
  } finally {
    delete globalThis.Summarizer;
    delete globalThis.LanguageModel;
  }
});

// ---------- Storage ----------

function fakeChrome() {
  const data = {};
  let writes = 0;
  const local = {
    async get(key) {
      await new Promise(r => setTimeout(r, Math.random() * 3));
      return key in data ? { [key]: JSON.parse(JSON.stringify(data[key])) } : {};
    },
    async set(obj) {
      await new Promise(r => setTimeout(r, Math.random() * 3));
      writes++;
      for (const k in obj) data[k] = JSON.parse(JSON.stringify(obj[k]));
    }
  };
  return { chrome: { storage: { local } }, data, writes: () => writes };
}

test("storage is a no-op without chrome.storage", async () => {
  assert.deepEqual(await M.load(), []);
});

test("storage dedupes, survives concurrent writes, updates and removes", async () => {
  const fake = fakeChrome();
  globalThis.chrome = fake.chrome;
  try {
    const cards = Array.from({ length: 20 }, (_, i) => M.newCard({ id: "c" + i, prompt: "Prompt " + i + " _____", answer: "a" + i }, NOW + i));
    await Promise.all(cards.map(c => M.add(c)));
    assert.equal((await M.load()).length, 20, "no lost updates");
    assert.equal(await M.add(M.newCard({ prompt: "prompt 3   _____!", answer: "A3" }, NOW)), null, "normalized duplicate rejected");
    const long = M.newCard({ prompt: "Rivers carry most of the _____ back to the sea in spring", answer: "water" }, NOW);
    assert.ok(await M.add(long), "new card added");
    assert.equal(await M.add(M.newCard({ prompt: "Rivers carry most of the _____ back to the sea in the spring", answer: "Water" }, NOW)), null, "near duplicate rejected");
    assert.ok(await M.add(M.newCard({ prompt: "Clouds release _____ as rain", answer: "water" }, NOW)), "same answer, different idea kept");
    assert.equal(await M.add(M.newCard({ type: "quote", prompt: "Recall this passage.", answer: "To be or not to be." }, NOW)) !== null, true);
    assert.equal(await M.add(M.newCard({ type: "quote", prompt: "Say it in your own words.", answer: "To be, or not to be!" }, NOW)), null, "the same quote saved twice is one card");
    const graded = M.grade(cards[0], "got", NOW);
    await M.update(graded);
    await M.remove("c1");
    const after = await M.load();
    assert.equal(after.length, 22);
    assert.equal(after.find(c => c.id === "c0").tier, 2);
    assert.equal(fake.data["polycarp.memory"].schema, 1);
  } finally {
    delete globalThis.chrome;
  }
});

test("storage caps at 5000, dropping the oldest mastered first", async () => {
  const fake = fakeChrome();
  globalThis.chrome = fake.chrome;
  try {
    const cards = [];
    for (let i = 0; i < 5003; i++) {
      const c = M.newCard({ id: "k" + i, prompt: "q" + i, answer: "a" + i }, NOW + i * 1000);
      if (i >= 100 && i < 105) c.tier = 6;
      cards.push(c);
    }
    const kept = await M.save(cards);
    assert.equal(kept.length, 5000);
    const ids = new Set(kept.map(c => c.id));
    assert.ok(!ids.has("k100") && !ids.has("k101") && !ids.has("k102"), "oldest mastered dropped");
    assert.ok(ids.has("k103") && ids.has("k0"), "others kept");
  } finally {
    delete globalThis.chrome;
  }
});

test("sentences: a 100,000-word block splits in linear time", () => {
  // One unbroken block, the shape of a long plain-text book. This took about 4 s when the
  // splitter sliced the whole text before every period.
  const para = "The sun warms the sea and lifts water into the air as vapor. Dr. Lee measured it at 3.5 km. ";
  const big = para.repeat(5600);
  const t0 = performance.now();
  const out = M.sentences(big);
  const ms = performance.now() - t0;
  assert.ok(out.length >= 11000, "split into sentences: " + out.length);
  assert.ok(ms < 800, "took " + Math.round(ms) + " ms");
});
