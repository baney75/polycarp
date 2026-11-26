// Which bundle a thread goes in, read from headers alone, and how the inbox groups threads.
// Run: node --test tests/hub-organize.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["src/hub/model.js", "src/hub/store.js", "src/hub/fake.js", "src/hub/organize.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}
const O = globalThis.PolycarpHubOrganize;
const S = globalThis.PolycarpHubStore;
const F = globalThis.PolycarpHubFake;

const t = (extra) => Object.assign({ subject: "Plans", from: { addr: "ada@example.com" }, headers: {}, unread: 0, lastDate: 0, replied: false }, extra);

test("each bundle is read from its headers", () => {
  assert.equal(O.bundleOf(t()), "");
  assert.equal(O.bundleOf(t({ headers: { contentType: "text/calendar; method=REQUEST" } })), "calendar");
  assert.equal(O.bundleOf(t({ subject: "[polycarp] Build failed", from: { addr: "notifications@code.example" }, headers: { listId: "<polycarp.code.example>" } })), "code");
  assert.equal(O.bundleOf(t({ headers: { listUnsubscribe: "<https://news.example/u>" } })), "newsletters");
  assert.equal(O.bundleOf(t({ headers: { precedence: "bulk" } })), "newsletters");
  assert.equal(O.bundleOf(t({ headers: { autoSubmitted: "auto-generated" } })), "receipts");
  assert.equal(O.bundleOf(t({ headers: { autoSubmitted: "auto-replied" } })), "", "a vacation reply is a person's");
});

test("a list with no project tag, or a project tag from a person, is not code", () => {
  assert.equal(O.bundleOf(t({ subject: "Weekly notes", from: { addr: "notifications@code.example" }, headers: { listId: "<x>" } })), "newsletters");
  assert.equal(O.bundleOf(t({ subject: "[polycarp] question", from: { addr: "ada@example.com" }, headers: { listId: "<x>" } })), "newsletters");
});

test("a thread you wrote in stays with people", () => {
  assert.equal(O.bundleOf(t({ replied: true, headers: { listUnsubscribe: "<https://news.example/u>" } })), "");
});

test("unread people come first, then days, each day closing with its bundle counts", () => {
  const now = new Date(2026, 10, 20, 15).getTime();
  const day = 864e5;
  const list = [
    t({ id: "a", unread: 1, lastDate: now - 1000 }),
    t({ id: "b", lastDate: now - 2000 }),
    t({ id: "n1", unread: 1, lastDate: now - 3000, headers: { listId: "<l>" } }),
    t({ id: "n2", lastDate: now - 4000, headers: { listId: "<l>" } }),
    t({ id: "r", lastDate: now - day, headers: { autoSubmitted: "auto-generated" } }),
    t({ id: "d", lastDate: now - 2 * day }),
    t({ id: "c", lastDate: now - 3 * day }),
    t({ id: "old", lastDate: now - 30 * day })
  ];
  const g = O.groups(list, now, true);
  assert.deepEqual(g.map((x) => x.name), ["Needs you", "Today", "Yesterday", "This week", "Earlier"]);
  assert.deepEqual(g[0].threads.map((x) => x.id), ["a"]);
  assert.deepEqual(g[1].threads.map((x) => x.id), ["b"]);
  assert.deepEqual(g[1].bundles, [{ id: "newsletters", name: "Newsletters", count: 2, unread: 1 }]);
  assert.deepEqual(g[2].threads, []);
  assert.deepEqual(g[2].bundles.map((x) => x.id), ["receipts"]);
  assert.deepEqual(g[3].threads.map((x) => x.id), ["d", "c"]);
  assert.deepEqual(g[4].threads.map((x) => x.id), ["old"]);
});

test("unfolded, nothing is pulled up or bundled", () => {
  const now = new Date(2026, 10, 20, 15).getTime();
  const g = O.groups([t({ id: "a", unread: 1, lastDate: now }), t({ id: "n", lastDate: now - 1, headers: { listId: "<l>" } })], now, false);
  assert.deepEqual(g.map((x) => x.name), ["Today"]);
  assert.deepEqual(g[0].threads.map((x) => x.id), ["a", "n"]);
  assert.deepEqual(g[0].bundles, []);
});

test("the made-up mail fills every bundle, and a thread with a reply from you is marked replied", async () => {
  S.useMemoryStore();
  await S.upsert("home", F.corpus({ seed: 3, size: 240 }));
  const all = await S.allThreads();
  const seen = new Set(all.map(O.bundleOf));
  for (const b of O.BUNDLES) assert.ok(seen.has(b.id), "no thread in " + b.id);
  assert.ok(all.some((x) => x.replied && x.folder === "inbox"), "no inbox thread with a reply from you");
  assert.ok(all.filter((x) => x.replied).every((x) => O.bundleOf(x) === ""));
});
