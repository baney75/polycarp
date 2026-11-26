// Leaving a list from the Hub: which header gets one click, which gets a draft or a page, the hostile ones that get
// nothing, and the exact request one click sends.
// Run: node --test tests/hub-unsubscribe.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
vm.runInThisContext(fs.readFileSync(path.join(root, "src/hub/unsubscribe.js"), "utf8"), { filename: "unsubscribe.js" });
const U = globalThis.PolycarpHubUnsubscribe;

const SIGNED = "mx.home.example; dkim=pass header.d=almanac.example; spf=pass";
const mail = (h, from) => ({ from: { addr: from || "news@almanac.example" }, headers: Object.assign({ listUnsubscribePost: "List-Unsubscribe=One-Click", authResults: SIGNED }, h) });

test("a signed list with List-Unsubscribe-Post gets one click to its https address", () => {
  const p = U.plan(mail({ listUnsubscribe: "<mailto:leave@almanac.example>, <https://almanac.example/u?id=1>" }));
  assert.deepEqual(p, { kind: "post", url: "https://almanac.example/u?id=1", body: "List-Unsubscribe=One-Click", signer: "almanac.example" });
  const sub = U.plan(mail({ listUnsubscribe: "<https://lists.esp.example/x>", authResults: "mx; dkim=pass header.d=almanac.example" }, "news@mail.almanac.example"));
  assert.equal(sub.kind, "post", "a sender under the signing domain is aligned; the address may be another host");
  assert.equal(U.plan(mail({ listUnsubscribe: "<https://almanac.example/u>", listUnsubscribePost: "  list-unsubscribe=one-click " })).kind, "post");
});

test("without a signature from the sender's domain, or without the Post header, nothing is sent for you", () => {
  const h = { listUnsubscribe: "<https://almanac.example/u>, <mailto:leave@almanac.example?subject=stop>" };
  for (const auth of ["", "mx; dkim=fail header.d=almanac.example", "mx; dkim=pass header.d=other.example", "mx; dkim=pass header.d=example",
    "mx; spf=pass header.d=almanac.example", "mx; dkim=pass header.d=evil-almanac.example", "mx; dkim=none; x=dkim=pass header.d=almanac.example"]) {
    assert.equal(U.plan(mail(Object.assign({ authResults: auth }, h))).kind, "mail", auth);
  }
  for (const post of ["", "List-Unsubscribe=One-Click&also=1", "List-Unsubscribe=Yes"]) {
    assert.equal(U.plan(mail(Object.assign({ listUnsubscribePost: post }, h))).kind, "mail", post);
  }
  assert.equal(U.plan(mail(h, "news@evilalmanac.example")).kind, "mail", "a signature for almanac.example doesn't cover evilalmanac.example");
  assert.deepEqual(U.plan(mail(Object.assign({ authResults: "" }, h))), { kind: "mail", to: "leave@almanac.example", subject: "stop", body: "" });
  assert.deepEqual(U.plan(mail({ listUnsubscribe: "<https://almanac.example/u>", authResults: "" })), { kind: "page", url: "https://almanac.example/u" });
});

test("hostile addresses are never posted to or opened", () => {
  const bad = [
    "http://almanac.example/u", "javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "ftp://almanac.example/u",
    "https://user:pw@almanac.example/u", "https://almanac.example:8443/u", "https://localhost/u", "https://LOCALHOST./u",
    "https://127.0.0.1/u", "https://2130706433/u", "https://0x7f.1/u", "https://10.0.0.8/u", "https://192.168.1.1/u",
    "https://169.254.169.254/latest", "https://[::1]/u", "https://[::ffff:127.0.0.1]/u", "https://router/u",
    "https://printer.local/u", "https://nas.home.arpa/u", "https://wiki.corp/u", "https://box.internal/u", "https://x.test/u",
    "https://" + "a".repeat(2100) + ".example/u"
  ];
  for (const u of bad) assert.equal(U.plan(mail({ listUnsubscribe: "<" + u + ">" })), null, u);
  assert.equal(U.plan(mail({ listUnsubscribe: "https://almanac.example/u" })), null, "no angle brackets, no entry");
  assert.equal(U.plan(mail({ listUnsubscribe: "" })), null);
  assert.equal(U.plan({ from: { addr: "a@b.example" } }), null);
  for (const m of ["mailto:", "mailto:not-an-address", "mailto:a@b,c@d.example", "mailto:%ZZ@x.example", "mailto:a@b"]) {
    assert.equal(U.plan(mail({ listUnsubscribe: "<" + m + ">" })), null, m);
  }
  const folded = U.plan(mail({ listUnsubscribe: "<https://almanac.example/\r\n u?id=2>" }));
  assert.equal(folded.url, "https://almanac.example/u?id=2", "a folded header joins up");
});

test("one click sends a plain form POST with no cookies, sign-in or referrer", async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push([url, init]); return { ok: true, status: 204 }; };
  const r = await U.send({ kind: "post", url: "https://almanac.example/u?id=1", body: "ignored" }, fake);
  assert.deepEqual(r, { ok: true, status: 204 });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, "https://almanac.example/u?id=1");
  assert.equal(init.method, "POST");
  assert.equal(init.body, "List-Unsubscribe=One-Click", "the body is always the standard one");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(init.mode, undefined);
});

test("an answer that can't be read still counts as sent; a refusal says so; a bad plan sends nothing", async () => {
  const calls = [];
  const corsBlocked = async (url, init) => { calls.push(init.mode); if (!init.mode) throw new TypeError("Failed to fetch"); return { ok: false, status: 0 }; };
  assert.deepEqual(await U.send({ kind: "post", url: "https://almanac.example/u" }, corsBlocked), { ok: true, status: 0 });
  assert.deepEqual(calls, [undefined, "no-cors"]);
  assert.deepEqual(await U.send({ kind: "post", url: "https://almanac.example/u" }, async () => ({ ok: false, status: 410 })), { ok: false, status: 410 });
  const never = async () => { throw new Error("should not be called"); };
  await assert.rejects(U.send({ kind: "post", url: "https://127.0.0.1/u" }, never), /not a one-click/);
  await assert.rejects(U.send({ kind: "page", url: "https://almanac.example/u" }, never), /not a one-click/);
  await assert.rejects(U.send({ kind: "post", url: "https://almanac.example/u" }, async () => { throw new Error("offline"); }), /offline/);
});
