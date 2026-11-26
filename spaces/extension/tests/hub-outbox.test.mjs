// Drafts in the Hub's store and undo send, on the memory store with the made-up account and a hand-wound clock.
// Run: node --test tests/hub-outbox.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["src/hub/model.js", "src/hub/store.js", "src/hub/adapter.js", "src/hub/fake.js", "src/hub/outbox.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}
const S = globalThis.PolycarpHubStore;
const A = globalThis.PolycarpHubAdapter;
const F = globalThis.PolycarpHubFake;
const X = globalThis.PolycarpHubOutbox;

// A clock the test winds: timers run only when tick() is called.
function clock() {
  let n = 0;
  const due = new Map();
  const waits = [];
  return {
    waits,
    setTimer: (f, ms) => { due.set(++n, f); waits.push(ms); return n; },
    clearTimer: (id) => { due.delete(id); },
    async tick() { const fs = Array.from(due.values()); due.clear(); for (const f of fs) await f(); },
    get count() { return due.size; }
  };
}
async function setup(fail) {
  S.useMemoryStore();
  const ad = F.create({ seed: 2, size: 40, fail: fail || [] });
  await S.putAccount({ id: "home", kind: "fake" });
  await A.pull("home", ad, S);
  const c = clock();
  const sent = [], failed = [];
  const box = X.create({ adapterFor: (id) => (id === "home" ? ad : null), setTimer: c.setTimer, clearTimer: c.clearTimer, onSent: (d) => sent.push(d.id), onFail: (d, e) => failed.push(e.message) });
  return { ad, c, box, sent, failed };
}

test("a draft keeps its addresses, text and who wrote it", async () => {
  S.useMemoryStore();
  const d = await S.saveDraft({ account: "home", to: '"Ada Arden" <ada@example.com>, bo@example.com', subject: "Hi", text: "Hello", by: "agent:helper" });
  assert.deepEqual(d.to.map((a) => a.addr), ["ada@example.com", "bo@example.com"]);
  const again = await S.saveDraft(Object.assign({}, d, { text: "Hello again", by: "" }));
  assert.equal(again.id, d.id);
  assert.equal(again.by, "agent:helper", "editing an agent's draft keeps the mark");
  assert.equal((await S.drafts("home")).length, 1);
  await S.deleteDraft(d.id);
  assert.equal((await S.drafts()).length, 0);
  await assert.rejects(S.saveDraft({ to: "a@x" }), /needs an account/);
});

test("a send waits, then goes, and the draft leaves only then", async () => {
  const { ad, c, box, sent } = await setup();
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", subject: "Lunch", text: "Noon?" });
  const r = await box.send(d.id);
  assert.ok(r.ok && r.sendAt > Date.now());
  assert.equal(ad.sent.length, 0, "nothing leaves before the wait ends");
  assert.ok(await S.draft(d.id));
  await c.tick();
  assert.equal(ad.sent.length, 1);
  assert.equal(ad.sent[0].subject, "Lunch");
  assert.equal(await S.draft(d.id), undefined);
  assert.deepEqual(sent, [d.id]);
  const mine = (await S.allMessages()).filter((m) => m.folder === "sent" && m.subject === "Lunch");
  assert.equal(mine.length, 1, "the sent copy is pulled into the store");
});

test("undo takes a waiting send back and leaves the draft", async () => {
  const { ad, c, box } = await setup();
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", text: "Wait" });
  await box.send(d.id);
  assert.equal(box.undo(d.id), true);
  await c.tick();
  assert.equal(ad.sent.length, 0);
  assert.ok(await S.draft(d.id));
  assert.equal(box.undo(d.id), false, "nothing left to take back");
});

test("a reply goes through reply and joins the thread", async () => {
  const { ad, c, box } = await setup();
  const parent = (await S.allMessages()).find((m) => m.folder === "inbox" && !m.headers.listId);
  const d = await S.saveDraft({ account: "home", to: [parent.from], subject: "Re: " + parent.subject, text: "Yes", replyTo: parent.remoteId, threadId: parent.threadId });
  await box.send(d.id);
  await c.tick();
  assert.equal(ad.sent[0].inReplyTo, parent.messageId);
  const t = await S.thread(parent.threadId);
  assert.ok(t.messages.some((m) => m.folder === "sent" && m.text === "Yes"));
  assert.equal(t.summary.replied, true);
});

test("a refused send stays a draft and says why", async () => {
  const { c, box, failed } = await setup(["send"]);
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", text: "x" });
  await box.send(d.id);
  await c.tick();
  assert.ok(await S.draft(d.id));
  assert.match(failed[0], /refused send/);
});

test("a draft with no one to send to, or no account to send from, does not start", async () => {
  const { c, box } = await setup();
  const none = await S.saveDraft({ account: "home", text: "x" });
  assert.deepEqual(await box.send(none.id), { ok: false, why: "Add someone to send it to." });
  const away = await S.saveDraft({ account: "gone", to: "a@example.com" });
  assert.equal((await box.send(away.id)).ok, false);
  const d = await S.saveDraft({ account: "home", to: "a@example.com" });
  await box.send(d.id);
  assert.equal((await box.send(d.id)).ok, false, "a second press does not send twice");
  assert.equal(c.count, 1);
});

test("removing an account takes its drafts", async () => {
  S.useMemoryStore();
  await S.putAccount({ id: "home", kind: "fake" });
  await S.saveDraft({ account: "home", to: "a@example.com" });
  await S.saveDraft({ account: "work", to: "a@example.com" });
  await S.removeAccount("home");
  assert.deepEqual((await S.drafts()).map((d) => d.account), ["work"]);
});

test("made-up mail is all in the past, so a reply sent now is the newest", () => {
  const now = Date.UTC(2026, 10, 20, 15);
  for (const seed of [1, 2, 3, 7]) assert.ok(F.corpus({ seed, size: 300, now }).every((m) => m.date < now), "seed " + seed);
});

// A lock shared by two "pages", like navigator.locks: one holder per name at a time.
function mutex() {
  const tails = new Map();
  return (name, fn) => {
    const prev = tails.get(name) || Promise.resolve();
    const run = prev.then(() => fn());
    tails.set(name, run.catch(() => {}));
    return run;
  };
}
function page(ad, lock, now) {
  const c = clock();
  const sent = [], failed = [];
  const box = X.create({ adapterFor: (id) => (id === "home" ? ad : null), setTimer: c.setTimer, clearTimer: c.clearTimer, lock, now: now || (() => Date.now()), onSent: (d) => sent.push(d.id), onFail: (d, e) => failed.push(e.message) });
  return { c, box, sent, failed };
}

test("a send waiting when the page closed goes once when Mail opens again", async () => {
  const { ad, box } = await setup();
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", subject: "Closed", text: "Bye" });
  const r = await box.send(d.id);
  assert.equal((await S.draft(d.id)).sendAt, r.sendAt, "the send time is kept on the draft");
  // The page closes: its timer never fires. A new page opens after the wait.
  const later = page(ad, mutex(), () => r.sendAt + 1);
  const got = await later.box.resume();
  assert.deepEqual(got, { sent: [d.id], waiting: [] });
  assert.equal(ad.sent.length, 1);
  assert.equal(await S.draft(d.id), undefined);
  assert.deepEqual(await later.box.resume(), { sent: [], waiting: [] }, "a second open sends nothing");
  assert.equal(ad.sent.length, 1);
});

test("a send still inside its wait is armed again for what is left, and can be taken back", async () => {
  const { ad, box } = await setup();
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", text: "Soon" });
  const r = await box.send(d.id);
  const p = page(ad, mutex(), () => r.sendAt - 4000);
  assert.deepEqual(await p.box.resume(), { sent: [], waiting: [d.id] });
  assert.equal(ad.sent.length, 0, "nothing goes before its time");
  assert.equal(p.box.waiting(d.id), true);
  assert.deepEqual(p.c.waits, [4000], "it waits only what is left");
  assert.equal(p.box.undo(d.id), true);
  await p.c.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ad.sent.length, 0);
  assert.equal((await S.draft(d.id)).sendAt, 0, "undo is kept on the draft");
  const q = page(ad, mutex(), () => r.sendAt + 1);
  assert.deepEqual(await q.box.resume(), { sent: [], waiting: [] }, "an undone send stays undone after another reload");
});

test("two open pages send a message once", async () => {
  const { ad } = await setup();
  const lock = mutex();
  const a = page(ad, lock), b = page(ad, lock);
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", text: "Once" });
  await a.box.send(d.id);
  // The second page opened during the wait and armed the same send.
  assert.deepEqual((await b.box.resume()).waiting, [d.id]);
  await Promise.all([a.c.tick(), b.c.tick()]);
  assert.equal(ad.sent.length, 1);
  assert.equal(a.sent.length + b.sent.length, 1);
});

test("undo in one page stops the send armed in another", async () => {
  const { ad } = await setup();
  const lock = mutex();
  const a = page(ad, lock), b = page(ad, lock);
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", text: "Stop" });
  await a.box.send(d.id);
  await b.box.resume();
  assert.equal(a.box.undo(d.id), true);
  await new Promise((r) => setTimeout(r, 10));
  await b.c.tick();
  assert.equal(ad.sent.length, 0);
  assert.ok(await S.draft(d.id));
});

test("editing a draft during the wait takes the send back", async () => {
  const { ad, c, box } = await setup();
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", text: "First" });
  await box.send(d.id);
  await S.saveDraft(Object.assign({}, await S.draft(d.id), { text: "Second thoughts" }));
  await c.tick();
  assert.equal(ad.sent.length, 0);
  assert.equal((await S.draft(d.id)).text, "Second thoughts");
});

test("a refused send clears its time, so a reload does not try again", async () => {
  const { ad, c, box, failed } = await setup(["send"]);
  const d = await S.saveDraft({ account: "home", to: "ada@example.com", text: "No" });
  const r = await box.send(d.id);
  await c.tick();
  assert.equal(failed.length, 1);
  assert.equal((await S.draft(d.id)).sendAt, 0);
  const p = page(ad, mutex(), () => r.sendAt + 1);
  assert.deepEqual(await p.box.resume(), { sent: [], waiting: [] });
});
