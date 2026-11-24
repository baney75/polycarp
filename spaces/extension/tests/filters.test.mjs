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
    "(a|a){00000000000000000000001,}", ".*.{00000000000000000000001,}z", ".*.*.*z", "a+b*"];
  for (const p of risky) assert.ok(F.riskyPattern(p), p);
  const safe = ["\\(a|b\\)+", "[(a+)]+", "(a)(b+)", "(cat|dog)?s", "(ab)+c", "colou?r", "\\d{2,4}", "moon+", "\\bcrypto\\w*",
    "giveaway|raffle", "[a*+]+x"];
  for (const p of safe) assert.equal(F.riskyPattern(p), "", p);
  assert.match(F.riskyPattern("(a+)+"), /nests/);
  assert.match(F.riskyPattern("(a|a)+"), /choice/);
  assert.match(F.riskyPattern(".*.*"), /open-ended/);
  // Quantifier parsing: a brace that is not a count is a literal.
  assert.deepEqual(F.quantifierAt("a{2,}", 1), { length: 4, unbounded: true });
  assert.deepEqual(F.quantifierAt("a{2,5}", 1), { length: 5, unbounded: false });
  assert.equal(F.quantifierAt("a{x}", 1), null);
  assert.equal(F.riskyPattern("(a{x})+"), "", "a literal brace is no repeat");
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
});

test("accounts: @name, u/name, a profile link and the bare name are one account; r/name is a subreddit", () => {
  assert.equal(F.normalizeHandle("@Elon"), "elon");
  assert.equal(F.normalizeHandle("u/Spez"), "spez");
  assert.equal(F.normalizeHandle("/user/abc/"), "abc");
  assert.equal(F.normalizeHandle("https://x.com/Jack"), "jack");
  assert.equal(F.normalizeHandle("r/Politics"), "r/politics");
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
  const g = F.normalizeRule({ words: "crypto", sites: [1, null], kinds: "shorts", enabled: "yes" });
  assert.deepEqual([g.words, g.sites, g.kinds, g.enabled], [[], [], [], true]);
  const many = F.normalizeRule({ words: Array.from({ length: 150 }, (_, i) => "w" + i).concat(["W0"]) });
  assert.equal(many.words.length, F.MAX_TERMS, "at most 100 words a rule");
  assert.equal(F.compile([g], "x.com").size, 0, "an empty rule is no rule");
});

test("a long post costs one bounded scan, and a word past the limit is not read", () => {
  const c = F.compile([rule({ words: ["needle"] })], "x.com");
  assert.ok(!c.test({ text: "hay ".repeat(5000) + "needle" }), "past 10,000 characters");
  const t0 = performance.now();
  const big = F.compile([rule({ words: Array.from({ length: 100 }, (_, i) => "word" + i), patterns: ["\\bcrypto\\w*"] })], "x.com");
  for (let i = 0; i < 2000; i++) big.test({ text: "an ordinary post about gardening and the weather today ".repeat(20) });
  assert.ok(performance.now() - t0 < 1500, "2,000 long posts against 100 words in well under the budget");
  assert.equal(F.summary(rule({ words: ["a"], accounts: ["b"], kinds: ["shorts"] })), "Words: a · Accounts: @b · Kinds: Shorts");
});
