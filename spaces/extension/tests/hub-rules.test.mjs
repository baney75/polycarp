// Rules in the Hub: plain lines read into searches and actions, problems named by their line, bundle rules over the
// headers, and the store telling this page which messages are new.
// Run: node --test tests/hub-rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["src/hub/model.js", "src/hub/store.js", "src/hub/search.js", "src/hub/organize.js", "src/hub/rules.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}
const M = globalThis.PolycarpHubModel;
const S = globalThis.PolycarpHubStore;
const O = globalThis.PolycarpHubOrganize;
const R = globalThis.PolycarpHubRules;

const thread = (raw) => M.summarize("t", [Object.assign(M.normalize("home", Object.assign({ remoteId: "1", subject: "Hello", date: 1, to: [{ addr: "me@home.example" }] }, raw)), { threadId: "t" })]);
const almanac = thread({ from: { name: "Garden Almanac", addr: "news@almanac.example" }, subject: "Frost dates", headers: { listId: "Garden Almanac <almanac.example>", precedence: "bulk" } });
const boss = thread({ from: { name: "Bo Blake", addr: "bo@work.example" }, subject: "Budget review", text: "Numbers by Friday." });

test("plain lines become rules; notes and blank lines are skipped", () => {
  const { rules, errors } = R.parse("# notes\n\nlist:almanac then keep with people\nfrom:bo@work.example then flag, mark read\nsubject:\"budget review\" then bundle receipts\nfrom:shop.example then mark read and archive\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(rules.map((r) => r.line), [3, 4, 5, 6]);
  assert.deepEqual(rules[1].actions.map((a) => a.kind), ["flag", "read"]);
  assert.deepEqual(rules[2].actions, [{ kind: "bundle", bundle: "receipts" }]);
  assert.deepEqual(rules[3].actions.map((a) => a.kind), ["read", "archive"]);
  assert.equal(R.parse(R.EXAMPLE).rules.length, 0, "the example is all notes");
});

test("each problem is named with its line, and that line is left out", () => {
  const { rules, errors } = R.parse("from:bo flag\nfrom:bo then shout\nfrom:bo then bundle socks\nis:nonsense then flag\n then archive\nfrom:bo then flag");
  assert.deepEqual(errors.map((e) => e.line), [1, 2, 3, 4, 5]);
  assert.match(errors[0].why, /needs a search, then "then"/);
  assert.match(errors[1].why, /"shout" isn't something a rule can do/);
  assert.match(errors[2].why, /no bundle called socks/);
  assert.match(errors[3].why, /is:nonsense isn't a search word/);
  assert.deepEqual(rules.map((r) => r.line), [6]);
});

test("a bundle rule wins over the headers, the first match decides, and no rule leaves the headers in charge", () => {
  const { rules } = R.parse("from:almanac then keep with people\nfrom:almanac then bundle receipts\nsubject:budget then bundle code");
  const decide = (t) => R.bundleFor(rules, t);
  assert.equal(O.bundleOf(almanac), "newsletters");
  assert.equal(O.bundleOf(almanac, decide), "", "kept with people");
  assert.equal(O.bundleOf(boss, decide), "code");
  assert.equal(R.bundleFor(rules, thread({ from: { addr: "x@y.example" } })), undefined);
  const g = O.groups([Object.assign({}, almanac, { unread: 1, lastDate: 10 })], 20, true, decide);
  assert.equal(g[0].name, "Needs you", "kept with people, unread, it needs you");
});

test("rules match whole words, never the start of one", () => {
  const { rules } = R.parse("from:bo then flag\nsubject:budge then archive");
  assert.ok(rules.every((r) => r.query.terms.every((t) => !t.prefix)), "no rule term is a prefix, even the last one");
  assert.deepEqual(R.actionsFor(rules, M.normalize("home", { remoteId: "1", from: { name: "Bo Blake", addr: "bo@work.example" }, subject: "Budget review" })), { flag: true });
  assert.deepEqual(R.actionsFor(rules, M.normalize("home", { remoteId: "2", from: { name: "Bob Bloom", addr: "bob@work.example" }, subject: "Budget" })), {});
});

test("every matching rule adds its actions; bundle actions don't change the account", () => {
  const { rules } = R.parse("from:bo then flag\nsubject:budget then mark read, bundle receipts\nto:me@home.example then archive");
  const m = M.normalize("home", { remoteId: "1", from: { name: "Bo Blake", addr: "bo@work.example" }, to: [{ addr: "me@home.example" }], subject: "Budget review" });
  assert.deepEqual(R.actionsFor(rules, m), { flag: true, read: true, archive: true });
});

test("the store tells this page which messages are new, and other pages see the change without that mark", async () => {
  S.useMemoryStore();
  const seen = [];
  const off = S.onChange((ev) => seen.push(ev));
  await S.upsert("home", [{ remoteId: "1", messageId: "<1@x>", from: "a@example.com", subject: "One", date: 1 }]);
  await S.upsert("home", [{ remoteId: "1", messageId: "<1@x>", from: "a@example.com", subject: "One", date: 1, unread: false }, { remoteId: "2", messageId: "<2@x>", from: "a@example.com", subject: "Two", date: 2 }]);
  off();
  assert.deepEqual(seen.map((e) => [e.local, e.added]), [[true, ["home:1"]], [true, ["home:2"]]]);
});
