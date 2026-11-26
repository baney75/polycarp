// Later in the Hub: where a snooze can end, when a conversation is back, new mail waking it, and the search filters
// the page finds them with.
// Run: node --test tests/hub-later.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["src/hub/model.js", "src/hub/search.js", "src/hub/later.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}
const M = globalThis.PolycarpHubModel;
const X = globalThis.PolycarpHubSearch;
const L = globalThis.PolycarpHubLater;

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi || 0).getTime();
const choices = (now) => Object.fromEntries(L.snoozeChoices(now).map((c) => [c.id, c]));

test("a snooze ends later today, tomorrow morning, on Saturday or on Monday, in local time", () => {
  const wed = at(2026, 11, 25, 10); // a Wednesday
  const c = choices(wed);
  assert.deepEqual(Object.keys(c), ["later", "tomorrow", "weekend", "week"]);
  assert.equal(c.later.at, at(2026, 11, 25, 13));
  assert.equal(c.tomorrow.at, at(2026, 11, 26, 8));
  assert.equal(c.weekend.at, at(2026, 11, 28, 8));
  assert.equal(c.weekend.label, "This weekend");
  assert.equal(c.week.at, at(2026, 11, 30, 8));
  assert.ok(!("later" in choices(at(2026, 11, 25, 22))), "late in the evening, later today is gone");
  const sat = choices(at(2026, 11, 28, 9));
  assert.equal(sat.weekend.label, "Next weekend");
  assert.equal(sat.weekend.at, at(2026, 12, 5, 8));
  assert.equal(sat.week.at, at(2026, 11, 30, 8));
  assert.equal(choices(at(2026, 11, 30, 9)).week.at, at(2026, 12, 7, 8), "on a Monday, next week is the Monday after");
  assert.equal(choices(at(2026, 12, 31, 9)).tomorrow.at, at(2027, 1, 1, 8), "across the year");
});

test("a reminder waits a day, three days or a week", () => {
  assert.deepEqual(L.remindChoices(1000).map((c) => c.at), [1000 + 864e5, 1000 + 3 * 864e5, 1000 + 7 * 864e5]);
});

test("a picked time counts only when it reads as a day and time after now", () => {
  const now = at(2026, 11, 25, 10);
  assert.equal(L.picked("2026-11-25T10:30", now), at(2026, 11, 25, 10, 30));
  assert.equal(L.picked("2026-11-25T10:00", now), 0);
  assert.equal(L.picked("2026-11-24T23:00", now), 0);
  for (const bad of ["", "tomorrow", "2026-11-25", "2026-11-25T10:30:00", null]) assert.equal(L.picked(bad, now), 0, String(bad));
});

const msg = (id, date, extra) => Object.assign(M.normalize("home", Object.assign({ remoteId: id, messageId: "<" + id + "@x>", from: { addr: "ada@example.com" }, to: [{ addr: "me@home.example" }], subject: "Plans", date }, extra)), { threadId: "t" });

test("a snooze set on every message holds until a newer message arrives", () => {
  const a = msg("1", 10, { snoozeUntil: 500 });
  const b = msg("2", 20, { snoozeUntil: 500 });
  assert.equal(M.summarize("t", [a, b]).snoozeUntil, 500);
  const t = M.summarize("t", [a, b, msg("3", 30)]);
  assert.equal(t.snoozeUntil, 0, "new mail wakes it");
  assert.ok(!L.sleeping(t, 100));
  const r = M.summarize("t", [msg("1", 10, { remindAt: 900 }), msg("2", 20, { folder: "sent", from: { addr: "me@home.example" }, remindAt: 900 })]);
  assert.equal(r.remindAt, 900);
  assert.equal(M.summarize("t", [msg("1", 10, { remindAt: 900 }), msg("2", 20, { folder: "sent", remindAt: 900 }), msg("3", 30)]).remindAt, 0, "a reply ends the wait");
});

test("back now: a snooze that ended in the inbox, or a reminder that came with no reply", () => {
  const base = { folder: "inbox", snoozeUntil: 0, remindAt: 0, sentAt: 0, lastDate: 50 };
  const t = (o) => Object.assign({}, base, o);
  assert.ok(L.sleeping(t({ snoozeUntil: 200 }), 100));
  assert.ok(!L.back(t({ snoozeUntil: 200 }), 100), "still snoozed");
  assert.ok(L.back(t({ snoozeUntil: 100 }), 100), "the moment it ends");
  assert.ok(!L.back(t({ snoozeUntil: 100, folder: "archive" }), 150), "archived since, it stays put away");
  const mine = { folder: "sent", sentAt: 50, lastDate: 50, remindAt: 100 };
  assert.ok(L.yoursLast(t(mine)));
  assert.ok(L.back(t(mine), 100));
  assert.ok(!L.back(t(mine), 99), "not yet");
  assert.ok(!L.back(t(Object.assign({}, mine, { lastDate: 60 })), 100), "someone answered");
  assert.ok(!L.yoursLast(t({ sentAt: 40, lastDate: 50 })));
  const fmt = (ms) => "T" + ms;
  assert.equal(L.why(t(mine), 100, fmt), "No reply since T50");
  assert.equal(L.why(t({ snoozeUntil: 90 }), 100, fmt), "Snoozed until T90");
  assert.equal(L.why(t({}), 100, fmt), "");
});

test("search finds snoozed, waiting and due mail by the clock", () => {
  const now = Date.now();
  const ix = X.create();
  ix.setThreads([], [
    Object.assign(msg("1", 10, { snoozeUntil: now + 6e4 }), { threadId: "a" }),
    Object.assign(msg("2", 10, { snoozeUntil: now - 6e4 }), { threadId: "b" }),
    Object.assign(msg("3", 10, { remindAt: now + 6e4, folder: "sent" }), { threadId: "c" }),
    Object.assign(msg("4", 10, { remindAt: now - 6e4, folder: "sent" }), { threadId: "d" }),
    Object.assign(msg("5", 10), { threadId: "e" })
  ]);
  const q = (s) => ix.query(s).map((h) => h.threadId).sort();
  assert.deepEqual(q("is:snoozed"), ["a"]);
  assert.deepEqual(q("is:waiting"), ["c"]);
  assert.deepEqual(q("is:due"), ["b", "d"]);
  assert.deepEqual(X.parse("is:waiting is:due").bad, []);

  // New mail in a snoozed or waiting thread ends it for search too: its older messages still carry the time, the
  // newest doesn't. Read in two pages, newest first, as the index builds, and again after the thread changes.
  const f = X.create();
  const older = (id, at, more) => Object.assign(msg(id, at, more), { threadId: "f" });
  f.setThreads([], [older("6", 30)]);
  f.setThreads([], [older("7", 10, { snoozeUntil: now + 6e4, remindAt: now - 6e4 }), older("8", 20, { snoozeUntil: now - 6e4, remindAt: now + 6e4 })]);
  const fq = (s) => f.query(s).map((h) => h.threadId);
  for (const s of ["is:snoozed", "is:waiting", "is:due"]) assert.deepEqual(fq(s), [], s);
  f.setThreads(["f"], [older("7", 10, { snoozeUntil: now + 6e4 }), older("8", 20, { snoozeUntil: now + 6e4 })]);
  assert.deepEqual(fq("is:snoozed"), ["f"], "and a snooze on the newest holds");
});
