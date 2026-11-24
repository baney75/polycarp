// Tests for src/shared/filters.js: which posts a feed filter rule hides. Run: node --test tests/filters.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(fs.readFileSync(path.join(here, "../src/shared/filters.js"), "utf8"), { filename: "filters.js" });
const F = globalThis.PolycarpFilters;

const rule = (r) => F.normalizeRule({ id: "r", ...r });
// Whether a post with this text (and these authors and kinds) is hidden by one rule.
const hits = (r, text, accounts = [], kinds = []) => !!F.compile([rule(r)], "example.com").test({ text, accounts: () => accounts, kinds: () => kinds });

test("words match in any case, as whole words, and phrases across any spacing", () => {
  assert.ok(hits({ words: ["crypto"] }, "CRYPTO is up again"));
  assert.ok(hits({ words: ["Crypto"] }, "i like crypto."));
  assert.ok(!hits({ words: ["ai"] }, "she said so"), "ai is not in said");
  assert.ok(hits({ words: ["ai"] }, "new AI model (ai) out"));
  assert.ok(!hits({ words: ["cat"] }, "concatenate"));
  assert.ok(hits({ words: ["machine learning"] }, "Machine\n   Learning wins"));
  assert.ok(!hits({ words: ["machine learning"] }, "machine-learning"), "a hyphen is not a space");
  assert.ok(hits({ words: ["café"] }, "Le CAFÉ ouvre"));
  assert.ok(!hits({ words: ["caf"] }, "café"), "a letter beyond ASCII is still a letter");
  assert.ok(hits({ words: ["#ai"] }, "love #AI today"), "a symbol side needs no edge");
  assert.ok(!hits({ words: ["#ai"] }, "#aid for all"), "the letter side still does");
  assert.ok(hits({ words: ["c++"] }, "Learning C++ now"));
  assert.ok(!hits({ words: ["a.b"] }, "axb"), "regex characters in a word are plain");
  assert.ok(hits({ words: ["a.b"] }, "see a.b here"));
  assert.ok(!hits({ words: ["   "] }, "anything"), "a blank word hides nothing");
});

test("words in scripts written without spaces match mid-sentence; a side in a spaced script keeps its word edge", () => {
  assert.ok(hits({ words: ["比特币"] }, "今天比特币大涨"), "Han");
  assert.ok(hits({ words: ["サッカー"] }, "サッカーの試合"), "Katakana ending in the long-vowel mark");
  assert.ok(hits({ words: ["ビットコイン"] }, "今日はビットコインが上がった"), "Katakana inside Hiragana");
  assert.ok(hits({ words: ["ひらがな"] }, "これはひらがなです"), "Hiragana");
  assert.ok(hits({ words: ["บิตคอยน์"] }, "วันนี้บิตคอยน์ขึ้นอีกแล้ว"), "Thai");
  assert.ok(hits({ words: ["ລາວ"] }, "ປະເທດລາວງາມ"), "Lao");
  assert.ok(hits({ words: ["ខ្មែរ"] }, "ភាសាខ្មែរល្អ"), "Khmer");
  assert.ok(hits({ words: ["မြန်မာ"] }, "ပြည်မြန်မာနိုင်ငံ"), "Myanmar");
  assert.ok(hits({ words: ["비트코인"] }, "오늘 비트코인이 올랐다"), "Hangul with a particle written onto the word");
  assert.ok(hits({ words: ["AI芯片"] }, "发布了AI芯片"), "Latin head after Han");
  assert.ok(hits({ words: ["芯片AI"] }, "新芯片AI发布"), "Latin tail before Han");
  assert.ok(hits({ words: ["ETF"] }, "比特币ETF获批"));
  assert.ok(hits({ words: ["AI"] }, "ข่าวAIวันนี้"), "Latin inside Thai");
  assert.ok(!hits({ words: ["AI芯片"] }, "发布了SAI芯片"), "a Latin letter before it is still a word edge");
  assert.ok(!hits({ words: ["ETF"] }, "比特币ETFs获批"));
  assert.ok(hits({ words: ["AI芯片"] }, "new AI芯片发布"));
  assert.ok(!hits({ words: ["AI芯片"] }, "SAI芯片发布"), "the leading English edge stays");
  assert.ok(hits({ words: ["芯片AI"] }, "新芯片AI model"));
  assert.ok(!hits({ words: ["芯片AI"] }, "新芯片AIM"), "the trailing English edge stays");
  assert.ok(!hits({ words: ["ai"] }, "she said so"), "ai is still not in said");
});

test("a combining mark is part of its word, and words and posts are compared in NFC", () => {
  assert.ok(!hits({ words: ["रत"] }, "भारत"), "a vowel sign before the word is a letter of the word before it");
  assert.ok(!hits({ words: ["राम"] }, "रामायण"), "a vowel sign after the word makes a longer word");
  assert.ok(hits({ words: ["भारत"] }, "मेरा भारत महान"));
  assert.ok(hits({ words: ["राम"] }, "राम आए"));
  assert.ok(hits({ words: ["भारती"] }, "नाम भारती है"), "a word that ends in a vowel sign");
  assert.ok(!hits({ words: ["भारती"] }, "भारतीय"), "and keeps its edge");
  assert.ok(!hits({ words: ["كتب"] }, "كتبَت"), "Arabic harakat after the word");
  assert.ok(hits({ words: ["cafe\u0301"] }, "Le café ouvre"), "a decomposed word finds the composed text");
  assert.ok(hits({ words: ["café"] }, "Le cafe\u0301 ouvre"), "and the other way round");
  assert.ok(!hits({ words: ["cafe"] }, "Le cafe\u0301 ouvre"), "a combining accent does not end the word");
  assert.deepEqual(rule({ words: ["cafe\u0301"] }).words, ["café"]);
  assert.ok(hits({ words: ["บิตคอยน์"] }, "วันนี้บิตคอยน์ขึ้นอีกแล้ว"), "Thai marks still sit in an unspaced script");
});

test("patterns: any case, the same answer every time, and Unicode classes work", () => {
  assert.ok(hits({ patterns: ["airdrops?"] }, "Free AIRDROP now"));
  assert.ok(hits({ patterns: ["giveaway|raffle"] }, "weekly Raffle"));
  assert.ok(hits({ patterns: ["\\p{Script=Han}{3}"] }, "今天比特币"), "Unicode mode when the source allows it");
  assert.ok(hits({ patterns: ["\\-x"] }, "a-x"), "a source only valid outside Unicode mode still works");
  const c = F.compile([rule({ patterns: ["moon"] })], "x.com");
  const post = { text: "to the moon" };
  assert.ok(c.test(post) && c.test(post), "no state kept between posts");
  assert.equal(c.test(post).reason, "/moon/");
});

test("risky patterns are refused with a reason, safe ones are kept", () => {
  const risky = ["(a+)+", "(\\w*)*$", "(x{2,})+", "((a+))+$", "((\\w+\\s?))+$", "(x(y(z*)))*", "(a|a)+$", "(\\w|\\d)+x$",
    "(?:cat|dog){2,}", "(a|aa){1,100}$", "(\\w|\\d){1,60}x", "((a|a))+$", "(a+){0000000000000000000001,}$",
    "(a|a){00000000000000000000001,}", ".*.{00000000000000000000001,}z", ".*.*.*z", "a+b*",
    // From the review: a ? is a repeat too, a bounded count is no safer than none, and nothing hides in a lazy marker.
    "(\\d\\d?)+$", "(a?){25}a{25}", "\\w{0,99}\\w{0,99}\\w{0,99}x", "(a?){20}", "(a?){14}", "(?:\\d\\d??)+$",
    "\\w{0,20}\\w{0,20}\\w{0,20}\\w{0,20}x", "a?a?a?a?a?a?a?a?a?a?\\w+x", "((a|a)s)+", "((cat|dog)s)+", "(?=.*a).*b",
    // Back-references and lookbehind are refused whole.
    "(a)\\1", "(a+)\\1x", "(?<n>a)\\k<n>", "(?<=a)b", "(?<!a)b"];
  for (const p of risky) assert.ok(F.riskyPattern(p), p);
  const safe = ["\\(a|b\\)+", "[(a+)]+", "(a)(b+)", "(cat|dog)?s", "(ab)+c", "colou?r", "\\d{2,4}", "moon+", "\\bcrypto\\w*",
    "giveaway|raffle", "[a*+]+x", "\\bcrypto\\b", "giveaway|airdrop", "^RT ", "https?://\\S+", "(https?://)?(www\\.)?x\\.com",
    "(\\d{1,3}\\.){3}\\d{1,3}", "(a|b){2,9}", "(?<n>ab)c", "(?:ab)+?c", "\\p{Script=Han}{3}", "[\\1]x", "\\0", "a{20}"];
  for (const p of safe) assert.equal(F.riskyPattern(p), "", p);
  assert.match(F.riskyPattern("(a+)+"), /nests/);
  assert.match(F.riskyPattern("(\\d\\d?)+$"), /nests/);
  assert.match(F.riskyPattern("(a|a)+"), /choice/);
  assert.match(F.riskyPattern("((cat|dog)s)+"), /choice/, "refused on purpose, and the reason names this shape");
  assert.match(F.riskyPattern(".*.*"), /too many ways/);
  assert.match(F.riskyPattern("\\w{0,99}"), /above 20/);
  assert.match(F.riskyPattern("a{21}"), /above 20/);
  assert.match(F.riskyPattern("(a)\\1"), /refers back/);
  assert.match(F.riskyPattern("(?<=a)b"), /looks behind/);
  // Quantifier parsing: ?, a lazy marker and counts; a brace that is not a count is a literal.
  assert.deepEqual(F.quantifierAt("a{2,}", 1), { length: 4, min: 2, max: Infinity, unbounded: true });
  assert.deepEqual(F.quantifierAt("a{2,5}", 1), { length: 5, min: 2, max: 5, unbounded: false });
  assert.deepEqual(F.quantifierAt("a{3}?", 1), { length: 4, min: 3, max: 3, unbounded: false });
  assert.deepEqual(F.quantifierAt("a?", 1), { length: 1, min: 0, max: 1, unbounded: false });
  assert.deepEqual(F.quantifierAt("a+?", 1), { length: 2, min: 1, max: Infinity, unbounded: true });
  assert.equal(F.quantifierAt("a{x}", 1), null);
  assert.equal(F.riskyPattern("(a{x})+"), "", "a literal brace is no repeat");
  for (const p of ["(", ")", "\\", "[", "(?", "(?<", "a{", "*", "(a|", "a)b(c"]) assert.equal(typeof F.riskyPattern(p), "string", "never throws: " + p);
});

test("the review's freezing patterns never run on a post, and ordinary patterns still hide what they should", () => {
  const cases = [["(\\d\\d?)+$", "1".repeat(40) + "x"], ["(a?){25}a{25}", "a".repeat(25)], ["\\w{0,99}\\w{0,99}\\w{0,99}x", "w".repeat(10000)]];
  for (const [p, text] of cases) {
    const c = F.compile([rule({ id: "r", patterns: [p] })], "x.com");
    assert.equal(c.refused.length, 1, p);
    assert.match(c.refused[0].why, /freeze/, p);
    const t0 = performance.now();
    assert.equal(c.test({ text }), null, p);
    assert.ok(performance.now() - t0 < 1000, "finishes at once: " + p);
  }
  assert.ok(hits({ patterns: ["\\bcrypto\\b"] }, "All about Crypto today"));
  assert.ok(!hits({ patterns: ["\\bcrypto\\b"] }, "cryptography class"));
  assert.ok(hits({ patterns: ["giveaway|airdrop"] }, "Huge AIRDROP now"));
  assert.ok(hits({ patterns: ["^RT "] }, "RT @someone: hello"));
  assert.ok(!hits({ patterns: ["^RT "] }, "an ART show"));
  assert.ok(hits({ patterns: ["(\\d{1,3}\\.){3}\\d{1,3}"] }, "server at 10.0.0.1 is down"));
});

test("a pattern reads a post's first 2,000 characters, and one that runs slow is switched off for the page", () => {
  assert.ok(!hits({ patterns: ["needle"] }, "hay ".repeat(600) + "needle"), "past 2,000 characters");
  assert.ok(hits({ words: ["needle"] }, "hay ".repeat(600) + "needle"), "a word still reads the first 10,000");
  assert.ok(!hits({ patterns: ["\\bbit\\b"] }, "a ".repeat(998) + " bitcoin"), "a word cut at the limit is dropped whole");
  let clock = 0;
  const c = F.compile([rule({ id: "slow", patterns: ["moon"], words: ["sun"] })], "x.com", { now: () => (clock += 1000) });
  assert.equal(c.test({ text: "to the moon" }).reason, "/moon/", "the slow run still answers");
  assert.equal(c.refused.length, 1);
  assert.deepEqual([c.refused[0].rule, c.refused[0].what, c.refused[0].value], ["slow", "pattern", "moon"]);
  assert.match(c.refused[0].why, /took 1000 ms on one post, so it is off on this page/);
  assert.equal(c.test({ text: "to the moon" }), null, "then it is off");
  assert.ok(c.test({ text: "the sun" }), "the rest of the rule still works");
  let fast = 0;
  const d = F.compile([rule({ patterns: ["moon"] })], "x.com", { now: () => (fast += 1) });
  for (let i = 0; i < 5; i++) assert.ok(d.test({ text: "to the moon" }));
  assert.equal(d.refused.length, 0, "a fast pattern stays on");
});

test("a refused or broken pattern skips only itself and says why; the rest of the rule still works", () => {
  const c = F.compile([rule({ id: "r1", words: ["nba"], patterns: ["(a+)+", "[", "x".repeat(201), "moon"] })], "x.com");
  assert.deepEqual(c.refused.map((r) => [r.rule, r.what, r.why.split(" ")[0]]), [["r1", "pattern", "nests"], ["r1", "pattern", "is"], ["r1", "pattern", "is"]]);
  assert.match(c.refused[0].why, /freeze/);
  assert.match(c.refused[1].why, /can read/);
  assert.match(c.refused[2].why, /200/);
  assert.ok(c.test({ text: "nba tonight" }));
  assert.ok(c.test({ text: "to the moon" }));
  assert.ok(!c.test({ text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaab" }));
  assert.equal(F.refusals([rule({ patterns: ["(a|a)+"] })]).length, 1, "the Settings page lists refusals on any site");
  assert.equal(F.refusals([{ id: "d", enabled: false, patterns: ["["] }]).length, 1, "and on a rule that is off");
  assert.equal(F.refusals([{ id: "d", enabled: false, sites: ["x.com"], hide: ["a}b"] }]).length, 1);
  assert.deepEqual(F.refusals("nope"), []);
});

test("accounts: @name, u/name, a profile link and the bare name are one account; r/name is a subreddit", () => {
  assert.equal(F.normalizeHandle("@Elon"), "elon");
  assert.equal(F.normalizeHandle("u/Spez"), "spez");
  assert.equal(F.normalizeHandle("/user/abc/"), "abc");
  assert.equal(F.normalizeHandle("https://x.com/Jack"), "jack");
  assert.equal(F.normalizeHandle("r/Politics"), "r/politics");
  // Profile links as people copy them: a share-sheet query, a tab after the name, www.
  assert.equal(F.normalizeHandle("https://x.com/Jack?s=21&t=abc"), "jack");
  assert.equal(F.normalizeHandle("https://x.com/Jack/with_replies"), "jack");
  assert.equal(F.normalizeHandle("https://www.x.com/jack"), "jack");
  assert.equal(F.normalizeHandle("https://x.com/jack#top"), "jack");
  assert.equal(F.normalizeHandle("https://www.youtube.com/@Name/videos"), "name");
  assert.equal(F.normalizeHandle("https://www.reddit.com/r/Politics/comments/abc/title/"), "r/politics");
  assert.equal(F.normalizeHandle("https://www.reddit.com/user/Spez/submitted"), "spez");
  assert.equal(F.normalizeHandle("https://www.linkedin.com/in/Some-Name/"), "some-name");
  assert.equal(F.normalizeHandle("https://bsky.app/profile/Alice.bsky.social"), "alice.bsky.social");
  assert.equal(F.normalizeHandle("https://mastodon.social/@Bob"), "bob");
  assert.equal(F.normalizeHandle("@bob@mastodon.social"), "bob@mastodon.social");
  for (const h of ["jack", "r/politics", "alice.bsky.social"]) assert.equal(F.normalizeHandle(F.normalizeHandle(h)), h, "normalizing twice changes nothing");
  assert.ok(hits({ accounts: ["https://x.com/Jack?s=21"] }, "", ["jack"]), "a pasted link hides that author's posts");
  assert.ok(hits({ accounts: ["@Spammer"] }, "nothing about it", ["spammer"]));
  assert.ok(!hits({ accounts: ["@Spammer"] }, "spammer in the text", ["someone"]), "an account matches the author, not the text");
  assert.ok(hits({ accounts: ["r/politics"] }, "", ["alice", "r/politics"]));
  assert.ok(hits({ accounts: ["bob"] }, "", ["@Bob"]), "the post's handles are normalized too");
  let read = 0;
  F.compile([rule({ words: ["x"] })], "a.com").test({ text: "y", accounts: () => { read++; return []; } });
  assert.equal(read, 0, "a words-only rule never asks for the post's accounts");
  const c = F.compile([rule({ accounts: ["bob"] })], "a.com");
  assert.equal(c.test({ text: "", accounts: () => ["bob"] }).reason, "@bob");
});

test("kinds: a post's kind hides it when the rule names that kind, and only known kinds are kept", () => {
  assert.ok(hits({ kinds: ["shorts"] }, "a cat", [], ["shorts"]));
  assert.ok(!hits({ kinds: ["shorts"] }, "best running shorts", [], []), "the word is not the kind");
  assert.ok(hits({ kinds: ["promoted", "reposts"] }, "", [], ["reposts"]));
  assert.deepEqual(rule({ kinds: ["Shorts", "ads", "reposts", 3] }).kinds, ["shorts", "reposts"]);
  assert.deepEqual(rule({ kinds: ["live", "stories", "polls", "shorts"] }).kinds, ["shorts"], "unknown kinds never crowd out a known one");
  const c = F.compile([rule({ kinds: ["promoted"] })], "x.com");
  assert.equal(c.test({ text: "", kinds: () => ["promoted"] }).reason, "Promoted");
  assert.ok(c.needKinds && !c.needAccounts);
  let asked = 0;
  F.compile([rule({ words: ["x"] })], "a.com").test({ text: "x", kinds: () => { asked++; return []; } });
  assert.equal(asked, 0, "a words-only rule never asks for kinds");
});

test("sites scope a rule to a host and its subdomains; no sites means every site; off rules hide nothing", () => {
  const r = rule({ sites: ["https://www.X.com/home", "*.reddit.com"], words: ["crypto"] });
  assert.deepEqual(r.sites, ["x.com", "reddit.com"]);
  const on = (host) => !!F.compile([r], host).test({ text: "crypto" });
  assert.ok(on("x.com") && on("mobile.x.com") && on("old.reddit.com") && on("www.x.com"));
  assert.ok(!on("notx.com") && !on("example.com"));
  assert.ok(F.compile([rule({ words: ["crypto"] })], "anything.org").test({ text: "crypto" }));
  assert.ok(!F.compile([rule({ words: ["crypto"], enabled: false })], "x.com").test({ text: "crypto" }));
  for (const off of [false, 0, "false"]) assert.equal(rule({ enabled: off }).enabled, false, "off: " + JSON.stringify(off));
  for (const on of [true, undefined, "yes", 1]) assert.equal(rule({ enabled: on }).enabled, true, "on: " + JSON.stringify(on));
});

test("hide selectors: only with sites, refused when unreadable or able to break out of a rule", () => {
  assert.deepEqual(rule({ hide: [".promo"] }).hide, [], "no sites: no hide");
  const ok = (s) => !/nope/.test(s);
  const c = F.compile([rule({ id: "h", sites: ["x.com"], hide: [".promo", "a:nope(", "x}body{display:none", "  "] })], "x.com", { checkSelector: ok });
  assert.deepEqual(c.hide, [".promo"]);
  assert.deepEqual(c.refused.map((r) => r.value), ["a:nope(", "x}body{display:none"]);
  assert.deepEqual(F.compile([rule({ sites: ["x.com"], hide: [".promo"] })], "example.com").hide, [], "another site gets none");
});

test("merge: app rules first, marked as from Polycarp; garbage becomes an empty rule and never throws", () => {
  const m = F.merge([{ id: "a1", words: ["nba"], source: "local" }], [{ id: "l1", accounts: ["@Bob"] }, null, "x"]);
  assert.deepEqual(m.map((r) => [r.id, r.source]), [["a1", "app"], ["l1", "local"], ["", "local"], ["", "local"]]);
  assert.deepEqual(m[1].accounts, ["bob"]);
  assert.deepEqual(F.merge(undefined, { not: "a list" }), []);
  const g = F.normalizeRule({ words: "crypto", sites: [1, null], kinds: "shorts", enabled: "yes", patterns: 7, accounts: { a: 1 } });
  assert.deepEqual([g.words, g.sites, g.kinds, g.enabled, g.patterns, g.accounts], [["crypto"], [], ["shorts"], true, [], []],
    "one string is a list of one; anything else that is not a list is none");
  const many = F.normalizeRule({ words: Array.from({ length: 150 }, (_, i) => "w" + i).concat(["W0"]) });
  assert.equal(many.words.length, F.MAX_TERMS, "at most 100 words a rule");
  assert.equal(F.compile([F.normalizeRule({ words: [1], sites: "x" })], "x.com").size, 0, "an empty rule is no rule");
});

test("compile normalizes every rule it is given, whatever its shape", () => {
  const c = F.compile([{ sites: "x.com", words: "crypto" }], "x.com");
  assert.ok(c.test({ text: "crypto news" }), "strings are lists of one, and nothing throws");
  assert.doesNotThrow(() => F.compile([{ sites: [], words: ["a"] }], "x.com").test({ text: "a" }), "no patterns list");
  const blank = { enabled: true, sites: [], words: ["  "], patterns: [], accounts: [], kinds: [], hide: [] };
  assert.equal(F.compile([blank], "x.com").test({ text: "anything" }), null, "a blank word hides nothing");
  const body = { enabled: true, sites: [], words: [], patterns: [], accounts: [], kinds: [], hide: ["body"] };
  assert.deepEqual(F.compile([body], "x.com").hide, [], "a hide selector with no site is dropped");
  assert.equal(F.compile([{ id: "s", sites: [], words: ["x"], source: "app" }], "x.com").test({ text: "x" }).rule.source, "app", "source survives");
  assert.doesNotThrow(() => F.compile([null, 3, "x", { sites: 5, words: null, patterns: "(" }], "x.com"));
});

test("a long post costs one bounded scan, and a word past the limit is not read", () => {
  const c = F.compile([rule({ words: ["needle"] })], "x.com");
  assert.ok(!c.test({ text: "hay ".repeat(5000) + "needle" }), "past 10,000 characters");
  // A word the 10,000-character cut runs through is dropped whole: "bit" alone would read as a word.
  const cut = "a ".repeat(4998) + " bitcoin";
  assert.equal(cut.indexOf("bitcoin"), F.MAX_TEXT - 3);
  assert.ok(!hits({ words: ["bit"] }, cut), "the front of a cut word is not that word");
  assert.ok(hits({ words: ["bit"] }, "a ".repeat(4998) + " bit coin"), "a whole word at the cut still counts");
  assert.ok(hits({ words: ["比特"] }, "比".repeat(F.MAX_TEXT - 2) + "比特币"), "an unspaced script keeps its text at the cut");
  assert.equal(F.clip("ab cd", 4), "ab ");
  assert.equal(F.clip("ab cd", 3), "ab ");
  assert.equal(F.clip("abcd", 2), "");
  assert.equal(F.clip("ab 😀😀", 4), "ab ", "never splits a surrogate pair");
  // A post that matches nothing costs one scan for all the plain words and one run per pattern, however many words.
  const big = F.compile([rule({ words: Array.from({ length: 100 }, (_, i) => "word" + i), patterns: ["\\bcrypto\\w*"] })], "x.com");
  const realTest = RegExp.prototype.test;
  let runs = 0;
  RegExp.prototype.test = function (s) { runs++; return realTest.call(this, s); };
  try {
    for (let i = 0; i < 2000; i++) big.test({ text: "an ordinary post about gardening and the weather today ".repeat(20) });
  } finally {
    RegExp.prototype.test = realTest;
  }
  assert.equal(runs, 2 * 2000, "2,000 posts against 100 words and a pattern: two runs each");
  assert.equal(F.summary(rule({ words: ["a"], accounts: ["b"], kinds: ["shorts"] })), "Words: a · Accounts: @b · Kinds: Shorts");
});

test("review round 2: \\p{1,} and \\u{1,} without the u flag are repeats, and are checked as the browser reads them", () => {
  for (const p of ["(\\p{1,})+$", "(\\u{1,})+$", "(\\P{1,})+x"]) {
    const c = F.compilePattern(p);
    assert.ok(c.why && /freeze/.test(c.why), p + " is refused: " + JSON.stringify(c.why));
  }
  for (const p of ["\\p{L}+", "\\u{1F600}", "\\p{Script=Greek}+"]) assert.ok(F.compilePattern(p).re, p + " still compiles");
  const c = F.compile([rule({ id: "p", patterns: ["(\\p{1,})+$"] })], "x.com");
  assert.equal(c.refused.length, 1);
  const t0 = performance.now();
  assert.equal(c.test({ text: "p".repeat(30) + "x" }), null);
  assert.ok(performance.now() - t0 < 1000, "returns at once");
});

test("review round 2: a selector the browser would close for us is refused, so it cannot swallow the next one", () => {
  const ok = () => true;
  const bad = ["a:not(.ad", '[aria-label="Promo', ".x\\", "a]", "a)"];
  const good = [".promo", 'a[title="it\\"s"]', "a:not(.ad)", "[data-x='a(b']"];
  const c = F.compile([rule({ id: "h", sites: ["x.com"], hide: [...bad, ...good] })], "x.com", { checkSelector: ok });
  assert.deepEqual(c.hide, good);
  assert.deepEqual(c.refused.map((r) => r.value), bad);
});

test("review round 2: a profile link without its scheme is the same account", () => {
  assert.equal(F.normalizeHandle("x.com/Jack"), "jack");
  assert.equal(F.normalizeHandle("www.reddit.com/r/Politics"), "r/politics");
  assert.equal(F.normalizeHandle("bsky.app/profile/alice.bsky.social"), "alice.bsky.social");
  assert.equal(F.normalizeHandle("alice.bsky.social"), "alice.bsky.social");
  assert.equal(F.normalizeHandle("@jack.smith"), "jack.smith");
});
