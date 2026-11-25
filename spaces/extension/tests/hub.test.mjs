// The Hub's model, store, pull and actions on the memory store, with the made-up account.
// Run: node --test tests/hub.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["src/hub/model.js", "src/hub/store.js", "src/hub/adapter.js", "src/hub/fake.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}
const M = globalThis.PolycarpHubModel;
const S = globalThis.PolycarpHubStore;
const A = globalThis.PolycarpHubAdapter;
const F = globalThis.PolycarpHubFake;

const me = { name: "Me", addr: "me@home.example" };
const ada = { name: "Ada Arden", addr: "ada@example.com" };
const msg = (id, extra) => Object.assign({ remoteId: id, messageId: `<${id}@x>`, from: ada, to: [me], subject: "Plans", date: 1000, text: "hello" }, extra);

test("an address and its message become one shape", () => {
  assert.deepEqual(M.address('"Ada Arden" <Ada@Example.COM>'), { name: "Ada Arden", addr: "ada@example.com" });
  assert.deepEqual(M.addresses('"Arden, Ada" <a@x.example>, b@x.example').map((a) => a.addr), ["a@x.example", "b@x.example"]);
  const m = M.normalize("home", msg("1", { references: "<a@x> <b@x>", headers: { precedence: "BULK" } }));
  assert.equal(m.id, "home:1");
  assert.deepEqual(m.references, ["<a@x>", "<b@x>"]);
  assert.equal(m.headers.precedence, "bulk");
  assert.equal(m.unread, true);
  assert.equal(m.snippet, "hello");
  assert.throws(() => M.normalize("home", { subject: "no id" }), /remoteId/);
});

test("replies join their thread in any order, and strangers with the same subject don't", () => {
  const parent = M.normalize("home", msg("p"));
  const reply = M.normalize("home", msg("r", { subject: "Re: Plans", inReplyTo: "<p@x>", references: ["<p@x>"] }));
  const other = M.normalize("home", msg("o", { from: { name: "", addr: "zed@example.com" }, messageId: "<o@x>" }));
  // The reply alone, then its parent: both land on the parent's root.
  assert.equal(M.threadKey(reply, new Map()), M.threadKey(parent, new Map()));
  assert.notEqual(M.threadKey(other, new Map()), M.threadKey(parent, new Map()));
  // A provider's own thread id wins.
  const hinted = M.normalize("home", msg("h", { threadHint: "T1" }));
  assert.match(M.threadKey(hinted, new Map([["<h@x>", "home:other"]])), /^home:t/);
  // With no ids at all, the subject and the people decide.
  const a = M.normalize("home", { remoteId: "a", from: ada, to: [me], subject: "Lunch" });
  const b = M.normalize("home", { remoteId: "b", from: me, to: [ada], subject: "RE: lunch" });
  assert.equal(M.threadKey(a), M.threadKey(b));
  assert.equal(M.baseSubject("Fwd: Re: RE[2]:  Lunch  plans"), "lunch plans");
});

test("the store lists threads newest first, by folder and account, with counts", async () => {
  S.useMemoryStore();
  await S.upsert("home", [msg("1", { date: 100 }), msg("2", { date: 300, subject: "Re: Plans", inReplyTo: "<1@x>", references: ["<1@x>"], unread: false })]);
  await S.upsert("home", [msg("3", { date: 200, subject: "Other", messageId: "<3@x>", from: { name: "", addr: "zed@example.com" } })]);
  await S.upsert("work", [msg("1", { date: 250, subject: "Work thing" })]);
  const inbox = await S.threads();
  assert.deepEqual(inbox.map((t) => t.subject), ["Plans", "Work thing", "Other"]);
  assert.equal(inbox[0].count, 2);
  assert.equal(inbox[0].unread, 1);
  assert.equal(inbox[0].lastDate, 300);
  assert.deepEqual((await S.threads({ account: "work" })).map((t) => t.subject), ["Work thing"]);
  assert.deepEqual((await S.threads({ before: 300 })).map((t) => t.subject), ["Work thing", "Other"]);
  assert.equal((await S.threads({ limit: 1 })).length, 1);
  const t = await S.thread(inbox[0].id);
  assert.deepEqual(t.messages.map((m) => m.remoteId), ["1", "2"]);
});

test("threads with the same date page without a gap or a repeat", async () => {
  S.useMemoryStore();
  await S.upsert("home", Array.from({ length: 7 }, (_, i) => msg("t" + i, { messageId: `<t${i}@x>`, subject: "Same " + i, date: 5000 })));
  const seen = [];
  let page = await S.threads({ limit: 3 });
  for (let n = 0; page.length && n < 10; n++) { seen.push(...page.map((t) => t.id)); page = await S.threads({ limit: 3, before: S.after(page[page.length - 1]) }); }
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.equal((await S.threads({ before: 5000 })).length, 0);
});

test("a thread leaves the inbox only when its last inbox message does", async () => {
  S.useMemoryStore();
  await S.upsert("home", [msg("1"), msg("2", { date: 2000, inReplyTo: "<1@x>", references: ["<1@x>"] })]);
  await S.update(["home:2"], { folder: "archive" });
  assert.equal((await S.threads()).length, 1);
  await S.update(["home:1"], { folder: "archive" });
  assert.equal((await S.threads()).length, 0);
  assert.equal((await S.threads({ folder: "archive" })).length, 1);
  await assert.rejects(S.update(["home:1"], { subject: "x" }), /can't change subject/);
});

test("removing an account takes its mail and cursor with it", async () => {
  S.useMemoryStore();
  await S.putAccount({ id: "home", kind: "fake", label: "Home" });
  await S.upsert("home", [msg("1")]);
  await S.setCursor("home", 5);
  await S.removeAccount("home");
  assert.equal((await S.accounts()).length, 0);
  assert.equal((await S.allMessages()).length, 0);
  assert.equal((await S.allThreads()).length, 0);
  assert.equal(await S.cursor("home"), undefined);
  await assert.rejects(S.putAccount({ id: "Bad Id" }), /account id/);
});

test("a pull brings only what changed and moves the cursor after storing it", async () => {
  S.useMemoryStore();
  const fake = F.create({ size: 40 });
  const first = await A.pull("home", fake);
  assert.equal(first.added, 40);
  assert.equal((await S.allMessages()).length, 40);
  const again = await A.pull("home", fake);
  assert.equal(again.added, 0);
  fake.deliver(msg("new", { date: Date.UTC(2026, 10, 21) }));
  fake.drop((await fake.threads({ limit: 1 }))[0].remoteId);
  const third = await A.pull("home", fake);
  assert.equal(third.added, 1);
  assert.equal(third.removed, 1);
  assert.equal((await S.allMessages()).length, 40);
  // A pull that fails, asking or storing, leaves the cursor where it was, so nothing is skipped.
  const at = await S.cursor("home");
  fake.deliver({ subject: "no remoteId" });
  await assert.rejects(A.pull("home", fake), /remoteId/);
  assert.equal(await S.cursor("home"), at);
  const broken = F.create({ size: 5, fail: ["changesSince"] });
  await assert.rejects(A.pull("home", broken), /refused changesSince/);
  assert.equal(await S.cursor("home"), at);
});

test("a change shows at once and goes back when the account refuses it", async () => {
  S.useMemoryStore();
  const fake = F.create({ size: 20 });
  await A.pull("home", fake);
  const [t] = await S.threads();
  const ids = (await S.thread(t.id)).messages.map((m) => m.remoteId);
  await A.actions.flag("home", fake, null, ids, true);
  assert.equal((await S.thread(t.id)).summary.flagged, true);
  assert.equal((await fake.read(ids[0])).flagged, true);
  // A refused change puts back only what it changed: a read made meanwhile stays.
  const slow = F.create({ size: 20, fail: ["flag"] });
  const flagging = A.actions.flag("home", slow, null, ids, false);
  await S.update(ids.map((id) => "home:" + id), { unread: false });
  await assert.rejects(flagging, /refused flag/);
  assert.equal((await S.thread(t.id)).summary.unread, 0);
  assert.equal((await S.thread(t.id)).summary.flagged, true);
  const sulky = F.create({ size: 20, fail: ["archive"] });
  await assert.rejects(A.actions.archive("home", sulky, null, ids), /refused archive/);
  assert.equal((await S.thread(t.id)).summary.folder, t.folder);
  assert.ok((await S.threads()).some((x) => x.id === t.id));
});

test("every adapter has the whole interface", () => {
  const fake = F.create({ size: 1 });
  assert.equal(A.check(fake), fake);
  assert.throws(() => A.check({ info() {}, list() {} }), /missing threads, read, search, send/);
});

test("the made-up account is the same for a seed and invents every address", () => {
  const a = F.corpus({ seed: 3, size: 200 });
  const b = F.corpus({ seed: 3, size: 200 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 200);
  for (const m of a) {
    for (const p of [m.from, ...m.to]) assert.match(p.addr, /@([a-z]+\.)?(example\.com|[a-z]+\.example)$/, p.addr);
  }
  const kinds = new Set(a.map((m) => (m.headers.listId ? "list" : m.headers.contentType ? "calendar" : m.headers.autoSubmitted ? "receipt" : "person")));
  assert.deepEqual([...kinds].sort(), ["calendar", "list", "person", "receipt"]);
});
