// The dialog guard (src/browser/dialog-guard.ts, docs/decisions.md D48): one pure decide() over facts, one serialized
// reconcile(). Table tests name the review finding each row covers; a randomized run checks the two invariants after
// every step. Fake timers, no browser.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
	decide,
	deps,
	dialogAnswerArrive,
	dialogAnswerEnd,
	dialogAsk,
	dialogUnheard,
	reconcile,
	resetDialogGuard,
	siteOf,
} from "../src/browser/dialog-guard.ts";

const AGENT = "bridge-claude-shop";
const T0 = 1_000_000;

// decide(): pure, no timers.

const box = (over = {}) => ({ seq: 1, tabId: 1, owner: AGENT, site: "example.com", ...over });
const person = (over = {}) => ({ id: 5, site: "example.com", active: true, ...over });
const facts = (over = {}) => ({ dialogs: [box()], tabs: [person()], answering: new Set(), asking: new Set(), since: new Map(), ...over });
const at = (since) => new Map([[1, since]]);

const rows = [
	["no tab of the person's on the site: no Cancel, no timer", facts({ tabs: [] }), T0, { cancel: [] }],
	["their tab in front: Cancel after the grace", facts({ since: at({ present: T0, active: T0 }) }), T0 + 3_000, { cancel: [1] }],
	["their tab in front, inside the grace: wake at its end", facts({ since: at({ present: T0, active: T0 }) }), T0 + 1_000, { cancel: [], nextWakeAt: T0 + 3_000 }],
	["their tab in the background: only after a minute", facts({ tabs: [person({ active: false })], since: at({ present: T0 }) }), T0 + 59_000, { cancel: [], nextWakeAt: T0 + 60_000 }],
	["ask_user pending: the minute rule, not the grace", facts({ asking: new Set([AGENT]), since: at({ present: T0, active: T0 }) }), T0 + 10_000, { cancel: [], nextWakeAt: T0 + 60_000 }],
	["first-F4, second-G2: a handle_dialog that arrived for this box defers it", facts({ answering: new Set([1]), since: at({ present: T0, active: T0 }) }), T0 + 9_000, { cancel: [] }],
	["sol-F2: an answer for another box (a later one on the same tab) defers nothing here", facts({ answering: new Set([2]), since: at({ present: T0, active: T0 }) }), T0 + 9_000, { cancel: [1] }],
	["second-G3: a running screenshot or other call is no hold", facts({ since: at({ present: T0, active: T0 }) }), T0 + 9_000, { cancel: [1] }],
	["second-G1: the side panel's box in the person's own tab is never cancelled", facts({ dialogs: [box({ owner: "sidepanel-1" })], since: at({ present: T0, active: T0 }) }), T0 + 600_000, { cancel: [] }],
	["a tab no session owns yet (tabs_create still opening it) is not an agent's", facts({ dialogs: [box({ owner: undefined })] }), T0 + 600_000, { cancel: [] }],
	["another agent's tab on the site is not the person's", facts({ tabs: [person({ owner: "bridge-codex" })] }), T0 + 600_000, { cancel: [] }],
	["the side panel's tab is the person's", facts({ tabs: [person({ owner: "sidepanel-1" })], since: at({ present: T0, active: T0 }) }), T0 + 3_000, { cancel: [1] }],
	["sol-F4: a tab the person just took back counts from now, with no tab event", facts({ tabs: [person({ active: false })] }), T0, { cancel: [], nextWakeAt: T0 + 60_000 }],
	["sol-F1: two boxes, an answer for one: the other keeps its own deadline", facts({ dialogs: [box(), box({ seq: 2, tabId: 2 })], answering: new Set([1]), since: new Map([[1, { present: T0, active: T0 }], [2, { present: T0, active: T0 }]]) }), T0 + 3_000, { cancel: [2] }],
];

for (const [name, f, now, want] of rows)
	test(`decide: ${name}`, () => {
		const got = decide(f, now);
		assert.deepEqual(got.cancel, want.cancel);
		if ("nextWakeAt" in want) assert.equal(got.nextWakeAt, want.nextWakeAt);
	});

test("decide: the start times are facts it keeps, and drops when the condition ends", () => {
	const first = decide(facts({ tabs: [person({ active: false })] }), T0);
	assert.deepEqual(first.since.get(1), { present: T0, active: undefined });
	const later = decide(facts({ since: first.since }), T0 + 5_000);
	assert.deepEqual(later.since.get(1), { present: T0, active: T0 + 5_000 });
	assert.equal(decide(facts({ tabs: [], since: later.since }), T0 + 6_000).since.has(1), false);
});

// reconcile(): the guard with fake facts and a fake clock.

let dialogs;
let tabs;
let owners;
let notices;
let cancels;
let seq;
/** The test's own count of answers in flight, by box: a Cancel of one of these breaks invariant (b). */
let inFlight;
/** Broken invariants, kept here because the guard catches what its Cancel throws. */
let broken;

const flush = () => new Promise((r) => setImmediate(r));
const settle = async () => {
	for (let i = 0; i < 8; i++) await flush();
};
const tick = async (ms) => {
	await settle();
	mock.timers.tick(ms);
	await settle();
};
const openBox = (tabId, message = "Delete this record?") => {
	const url = tabs.find((t) => t.id === tabId)?.url;
	dialogs.set(tabId, { type: "confirm", message, url, seq: ++seq });
	void reconcile();
	return seq;
};
const arrive = (tabId) => {
	const a = dialogAnswerArrive(AGENT, undefined, tabId);
	if (a.target) inFlight.set(a.target.seq, (inFlight.get(a.target.seq) ?? 0) + 1);
	return a;
};
const end = (a) => {
	if (a.target) inFlight.set(a.target.seq, inFlight.get(a.target.seq) - 1);
	dialogAnswerEnd(a);
};

beforeEach(() => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
	resetDialogGuard();
	seq = 0;
	inFlight = new Map();
	broken = [];
	dialogs = new Map();
	tabs = [
		{ id: 1, url: "https://shop.example.com/admin", active: false },
		{ id: 2, url: "https://shop.example.com/list", active: false },
		{ id: 5, url: "https://www.example.com/cart", active: true },
	];
	owners = new Map([
		[1, AGENT],
		[2, AGENT],
	]);
	notices = [];
	cancels = [];
	Object.assign(deps, {
		dialogs: () => [...dialogs],
		cancel: async (tabId, s) => {
			if (dialogs.get(tabId)?.seq !== s) return false;
			if (inFlight.get(s) > 0) broken.push(`box ${s} cancelled while an answer for it was in flight`);
			if (cancels.includes(s)) broken.push(`box ${s} cancelled twice`);
			cancels.push(s);
			dialogs.delete(tabId);
			return true;
		},
		tabs: async () => tabs,
		owners: async () => owners,
		notice: async (owner, text) => void notices.push({ owner, text }),
		unnotice: async (owner, text) => {
			const i = notices.findIndex((n) => n.owner === owner && n.text === text);
			if (i < 0) return false;
			notices.splice(i, 1);
			return true;
		},
		log: () => undefined,
		grace: () => 3_000,
		open: () => 60_000,
	});
});
afterEach(async () => {
	resetDialogGuard(); // its timer belongs to this test's fake clock
	mock.timers.reset();
	assert.deepEqual(broken, []);
});

test("a Delete confirm with no tab of the person's on the site stays open while the agent thinks", async () => {
	tabs = tabs.filter((t) => t.id !== 5);
	openBox(1);
	await tick(20_000);
	await tick(10 * 60_000);
	assert.deepEqual(cancels, []);
});

test("their same-site tab in front: Cancel after the grace, and the agent is told once", async () => {
	openBox(1);
	await tick(2_900);
	assert.deepEqual(cancels, []);
	await tick(200);
	assert.deepEqual(cancels, [1]);
	assert.equal(notices.length, 1);
	assert.match(notices[0].text, /cancelled, because the person was using a tab on example\.com.*The page saw Cancel/);
});

test("sol-F1: an answer for box A arrives, then ends: box B still gets its Cancel on time", async () => {
	openBox(1);
	openBox(2, "Send?");
	await tick(1_000);
	const a = arrive(1);
	await tick(2_100);
	assert.deepEqual(cancels, [2], "B's deadline was lost under A's answer");
	end(a);
	await tick(0);
	assert.deepEqual(cancels, [2, 1]);
});

test("first-F4, second-G2: an answer holds its box from arrival, before its session is even open", async () => {
	openBox(1);
	await tick(0); // the guard has read who owns what
	await tick(2_000);
	const a = arrive(undefined); // no session object yet: the guard's last ownership read finds the box
	assert.equal(a.target?.seq, 1);
	await tick(30_000);
	assert.deepEqual(cancels, []);
	end(a);
	await tick(0);
	assert.deepEqual(cancels, [1]);
});

test("sol-F4: the person takes a same-site tab back from an agent, with no tab event: the minute starts then", async () => {
	tabs = tabs.filter((t) => t.id !== 5);
	tabs.push({ id: 6, url: "https://example.com/", active: false });
	owners.set(6, "bridge-codex-other");
	openBox(1);
	await tick(5 * 60_000);
	assert.deepEqual(cancels, []);
	owners.delete(6); // userTook: only the session table changed
	void reconcile();
	await tick(59_000);
	assert.deepEqual(cancels, []);
	await tick(1_100);
	assert.deepEqual(cancels, [1]);
});

test("second-G1: the side panel's box in the person's own tab is never cancelled", async () => {
	owners.set(1, "sidepanel-1");
	openBox(1);
	await tick(10 * 60_000);
	assert.deepEqual(cancels, []);
});

test("first-F1: a Cancel that fails leaves the box open and answerable, with no notice, and is tried again", async () => {
	const ok = deps.cancel;
	let fails = 1;
	deps.cancel = async (tabId, s) => {
		if (fails-- > 0) throw new Error("detached mid-send");
		return ok(tabId, s);
	};
	openBox(1);
	await tick(3_100);
	assert.deepEqual(cancels, []);
	assert.equal(notices.length, 0, "a notice for a Cancel that never happened");
	assert.equal((await dialogUnheard(AGENT, { tabIds: [1, 2] })).text, undefined, "told it was cancelled when it wasn't");
	assert.equal(arrive(undefined).target?.seq, 1, "the box can't be answered");
	resetDialogGuard();
	inFlight.clear();
	openBox(1);
	fails = 1;
	await tick(3_100);
	await tick(1_100);
	assert.deepEqual(cancels, [2], "not tried again");
});

test("first-F3, sol-F3: looks that overlap a slow Cancel send it once and tell it once", async () => {
	const ok = deps.cancel;
	let release;
	deps.cancel = (tabId, s) => new Promise((r) => (release = () => r(ok(tabId, s))));
	openBox(1);
	await tick(3_100);
	for (let i = 0; i < 3; i++) void reconcile();
	await tick(500);
	release();
	await tick(0);
	await tick(5_000);
	assert.deepEqual(cancels, [1]);
	assert.equal(notices.length, 1);
});

/** A Cancel sent at once (counted, checked) whose reply comes back only on `release`: the box stays until then. */
const slowCancel = () => {
	const c = { release: undefined, fail: undefined };
	deps.cancel = (tabId, s) => {
		if (dialogs.get(tabId)?.seq !== s) return Promise.resolve(false);
		if (cancels.includes(s)) broken.push(`box ${s} cancelled twice`);
		cancels.push(s);
		return new Promise((resolve, reject) => {
			c.release = () => {
				dialogs.delete(tabId);
				resolve(true);
			};
			c.fail = () => reject(new Error("detached mid-send"));
		});
	};
	return c;
};

test("first-F2: the notice and handle_dialog say it once, whichever comes first", async () => {
	const c = slowCancel();
	openBox(1);
	await tick(3_100);
	// handle_dialog arrives while the Cancel is on its way: it keeps its box, and hears the notice's words, once.
	const a = dialogAnswerArrive(AGENT, undefined, undefined);
	assert.equal(a.target?.seq, 1);
	const said = dialogUnheard(AGENT, { seq: a.target.seq });
	c.release();
	await tick(0);
	assert.match((await said).text, /was cancelled/);
	assert.equal(notices.length, 0, "tabs_context would say it again");
	dialogAnswerEnd(a);
	// Read by tabs_context first: handle_dialog for another box is not refused over it.
	const d = slowCancel();
	openBox(1);
	await tick(3_100);
	d.release();
	await tick(0);
	notices.length = 0;
	openBox(2, "Send?");
	assert.equal((await dialogUnheard(AGENT, { tabIds: [1, 2] })).text, undefined);
	assert.equal((await dialogUnheard(AGENT, { tabIds: [1, 2] })).text, undefined);
});

test("sol-F1, first-F2: a Cancel the page takes over 5 s to answer is sent once, and told once when it lands", async () => {
	const c = slowCancel();
	openBox(1);
	await tick(3_100);
	assert.deepEqual(cancels, [1]);
	// Well past any timeout and retry: still the one Cancel on its way.
	for (let i = 0; i < 10; i++) await tick(2_000);
	assert.deepEqual(cancels, [1], "a second Cancel went out while the first was outstanding");
	// handle_dialog meanwhile: never sent while that Cancel is out, and says it hasn't come back.
	const a = dialogAnswerArrive(AGENT, undefined, 1);
	const asked = dialogUnheard(AGENT, { seq: 1 });
	await tick(5_100);
	assert.deepEqual(await asked, { pending: true });
	dialogAnswerEnd(a);
	// It lands late: recorded and told, once.
	c.release();
	await tick(0);
	assert.equal(notices.length, 1, "a late Cancel was never told");
	assert.match(notices[0].text, /was cancelled/);
	await tick(10_000);
	assert.deepEqual(cancels, [1]);
});

test("sol-F2: each Cancel is decided on facts read after the one before it went out", async () => {
	const ok = deps.cancel;
	openBox(1);
	openBox(2, "Send?");
	// While the first Cancel is on its way, the second box's tab goes to the side panel's session.
	deps.cancel = async (tabId, s) => {
		if (s === 1) owners.set(2, "sidepanel-1");
		return ok(tabId, s);
	};
	await tick(3_100);
	assert.deepEqual(cancels, [1], "box 2 was cancelled on facts from before box 1's Cancel");
	// The same with the person's last same-site tab closing instead.
	resetDialogGuard();
	owners.set(2, AGENT);
	openBox(1);
	openBox(2, "Send?");
	let first = true;
	deps.cancel = async (tabId, s) => {
		if (first) tabs = tabs.filter((t) => t.id !== 5);
		first = false;
		return ok(tabId, s);
	};
	await tick(3_100);
	assert.equal(cancels.length, 2, `cancels: ${cancels}: the second box was cancelled after the person's tab closed`);
});

test("second-S3: a box Chrome no longer shows is dropped; other failures back off instead of a run every second", async () => {
	const forgot = [];
	deps.forget = (tabId, s) => {
		forgot.push(s);
		if (dialogs.get(tabId)?.seq === s) dialogs.delete(tabId);
	};
	let tries = 0;
	deps.cancel = async () => {
		tries++;
		throw new Error("No dialog is showing");
	};
	openBox(1);
	await tick(3_100);
	assert.deepEqual(forgot, [1]);
	assert.equal(dialogs.size, 0);
	await tick(60_000);
	assert.equal(tries, 1);
	assert.equal(notices.length, 0, "a notice for a box that was never there");
	// A failure that may pass: tried again, less and less often.
	tries = 0;
	deps.cancel = async () => {
		tries++;
		throw new Error("detached mid-send");
	};
	openBox(2);
	await tick(3_100);
	for (let i = 0; i < 60; i++) await tick(1_000);
	assert.ok(tries >= 3 && tries <= 8, `${tries} Cancels in a minute`);
});

test("a pending ask_user holds the box under the minute rule only", async () => {
	dialogAsk(AGENT, true);
	openBox(1);
	await tick(30_000);
	assert.deepEqual(cancels, []);
	await tick(30_100);
	assert.deepEqual(cancels, [1]);
	// second-S4 of the #193 review: the minute rule fired, and the notice says so, not the grace's words.
	assert.match(notices[0].text, /because it stayed open a minute while the person had a tab open on example\.com/);
	assert.doesNotMatch(notices[0].text, /cannot arrive in time while that tab is in front/);
});

test("second-S4: the reason is the one the Cancel was decided on, read before its await", async () => {
	const c = slowCancel();
	openBox(1);
	await tick(3_100);
	assert.deepEqual(cancels, [1]);
	// While the Cancel is on its way, the person switches away and a look runs: the box's start times change.
	tabs.find((t) => t.id === 5).active = false;
	await reconcile();
	c.release();
	await tick(0);
	assert.match(notices[0].text, /because the person was using a tab on example\.com/);
	assert.match(notices[0].text, /cannot arrive in time while that tab is in front/);
});

test("a box an earlier worker kept gets the same rules after a restart", async () => {
	dialogs.set(1, { type: "confirm", message: "x", url: tabs[0].url, seq: ++seq });
	resetDialogGuard();
	void reconcile(); // worker start, after the memory is back
	await tick(3_100);
	assert.deepEqual(cancels, [1]);
});

test("invariants hold over random sequences: no frozen person past a deadline, no Cancel under an answer, none twice", async () => {
	let rnd = 0x9e3779b9;
	const rand = (n) => {
		rnd = (rnd * 1664525 + 1013904223) >>> 0;
		return rnd % n;
	};
	const sites = ["https://a.example.com/", "https://www.example.com/", "https://other.org/"];
	const sessions = [AGENT, AGENT, "bridge-codex", "sidepanel-1", undefined];
	for (let run = 0; run < 120; run++) {
		resetDialogGuard();
		inFlight.clear();
		dialogs = new Map();
		cancels = [];
		notices = [];
		tabs = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, windowId: i % 2, url: sites[rand(3)], active: false }));
		owners = new Map();
		for (const t of tabs) {
			const s = sessions[rand(5)];
			if (s) owners.set(t.id, s);
		}
		const answers = [];
		let asked = false;
		/** The oracle's own start times, by box: [present, active]. */
		const oracle = new Map();
		let nextId = 10;
		for (let step = 0; step < 50; step++) {
			const t = tabs[rand(tabs.length)];
			switch (rand(9)) {
				case 0:
					if (!dialogs.has(t.id)) openBox(t.id);
					break;
				case 1:
					dialogs.delete(t.id); // the page closed it itself
					break;
				case 2:
					for (const o of tabs) if (o.windowId === t.windowId) o.active = o === t;
					break;
				case 3: {
					const s = sessions[rand(5)];
					if (s) owners.set(t.id, s);
					else owners.delete(t.id);
					break;
				}
				case 4:
					answers.push(arrive(rand(2) ? t.id : undefined));
					break;
				case 5:
					if (answers.length) end(answers.splice(rand(answers.length), 1)[0]);
					break;
				case 6: {
					// Prerender swap: the tab gets a new id, and the old page's box goes with the old page.
					const id = nextId++;
					if (owners.has(t.id)) owners.set(id, owners.get(t.id));
					owners.delete(t.id);
					dialogs.delete(t.id);
					t.id = id;
					break;
				}
				case 7:
					// Worker restart: calls in flight die with it; the boxes come back from memory.
					for (const a of answers.splice(0)) end(a);
					resetDialogGuard();
					oracle.clear();
					asked = false;
					break;
				default:
					asked = !asked;
					dialogAsk(AGENT, asked);
			}
			void reconcile();
			await tick(rand(4) * 1_500);
			assert.deepEqual(broken, [], `run ${run} step ${step}`);
			// The oracle: the same rule, written out again from the facts.
			const now = Date.now();
			for (const [tabId, d] of dialogs) {
				const owner = owners.get(tabId);
				const site = siteOf(d.url);
				const mine = tabs.filter((o) => o.id !== tabId && siteOf(o.url) === site && !owners.get(o.id)?.startsWith("bridge-"));
				const was = oracle.get(d.seq) ?? [];
				const s = [mine.length ? (was[0] ?? now) : undefined, mine.some((o) => o.active) ? (was[1] ?? now) : undefined];
				oracle.set(d.seq, s);
				if (!owner?.startsWith("bridge-") || s[0] === undefined || inFlight.get(d.seq) > 0) continue;
				const due = Math.min(s[0] + 60_000, s[1] !== undefined && !(asked && owner === AGENT) ? s[1] + 3_000 : Number.POSITIVE_INFINITY);
				assert.ok(due + 100 > now, `run ${run} step ${step}: box ${d.seq} on tab ${tabId} still open ${now - due} ms past its deadline`);
			}
		}
		for (const a of answers.splice(0)) end(a);
	}
});

test("site is the registrable domain by the Public Suffix List", () => {
	assert.equal(siteOf("https://mail.google.com/x"), "google.com");
	assert.equal(siteOf("https://www.web.de/"), "web.de");
	assert.equal(siteOf("https://mail.web.de/"), "web.de");
	assert.equal(siteOf("https://shop.abc.de/"), siteOf("https://www.abc.de/"));
	assert.equal(siteOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
	assert.notEqual(siteOf("https://alice.github.io/"), siteOf("https://bob.github.io/"));
	assert.equal(siteOf("http://127.0.0.1:8080/"), "127.0.0.1");
	assert.equal(siteOf("chrome://settings"), undefined);
});
