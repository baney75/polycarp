// The "in use by an agent" veil: when it shows, when its button is off, when it fades and when it
// goes at once (src/browser/veil-state.ts), and what the page-side code may and may not do
// (src/browser/veil-page.ts). The drawing itself is checked in cli/test/e2e-bridge.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MOTE, VEIL_CSS, veilPage } from "../src/browser/veil-page.ts";
import { isVeilTag, newVeilTag } from "../src/browser/veil-shared.ts";
import { EMPTY_VEIL, nextWake, pointerCue, VEIL_IDLE_MS, veilStep, veilViewFor } from "../src/browser/veil-state.ts";

const view = { agent: "Claude", detail: "demo-shop", color: "blue" };
const S = "bridge-claude-demo";

/** Run events in order; returns the final state and every effect, in order. */
function run(events, start = EMPTY_VEIL) {
	let state = start;
	const effects = [];
	let wakeAt;
	for (const e of events) {
		const step = veilStep(state, e);
		state = step.state;
		effects.push(...step.effects);
		wakeAt = step.wakeAt;
	}
	return { state, effects, wakeAt };
}

const begin = (at, extra = {}) => ({ type: "begin", tabId: 1, sessionId: S, view, input: false, at, ...extra });
const end = (at, extra = {}) => ({ type: "end", tabId: 1, sessionId: S, view, input: false, at, ...extra });

test("the first call on a tab shows the veil once; later calls draw nothing new", () => {
	const { effects, state } = run([begin(0), end(100), begin(2000), end(2300), begin(4000), end(4100)]);
	assert.deepEqual(effects, [{ kind: "show", tabId: 1, view, interactive: true, concealed: false }]);
	assert.equal(state.tabs[1].busy, 0);
});

test("the navigate that opens a tab shows the veil there when it ends", () => {
	const { effects } = run([end(50, { tabId: 9 })]);
	assert.deepEqual(effects, [{ kind: "show", tabId: 9, view, interactive: true, concealed: false }]);
});

test("an input call turns the button off before it runs and back on after; nested calls keep it off", () => {
	const shown = run([begin(0), end(10)]).state;
	const { effects } = run(
		[begin(20, { input: true }), begin(25, { input: true }), end(30, { input: true }), end(40, { input: true })],
		shown,
	);
	assert.deepEqual(effects, [
		{ kind: "interactive", tabId: 1, on: false },
		{ kind: "interactive", tabId: 1, on: true },
	]);
});

test("a first call that sends input draws the veil with its button already off", () => {
	const { effects } = run([begin(0, { input: true })]);
	assert.deepEqual(effects, [{ kind: "show", tabId: 1, view, interactive: false, concealed: false }]);
});

test(`it fades ${VEIL_IDLE_MS / 1000} s after the last call ends, never while one runs, never between close calls`, () => {
	assert.ok(VEIL_IDLE_MS >= 10_000, "short enough to blink between two tool calls while the model thinks");
	let { state, wakeAt } = run([begin(0), end(500)]);
	assert.equal(wakeAt, 500 + VEIL_IDLE_MS);
	// Calls 8 s apart: no tick in between fades it.
	for (let t = 8500; t < 60_000; t += 8000) {
		({ state } = run([{ type: "tick", at: t }, begin(t), end(t + 200)], state));
		assert.ok(state.tabs[1], `faded between calls at ${t} ms`);
	}
	// One long call: still there long past the idle time.
	({ state } = run([begin(70_000), { type: "tick", at: 70_000 + 3 * VEIL_IDLE_MS }], state));
	assert.ok(state.tabs[1], "faded while a call was running");
	assert.equal(nextWake(state), undefined);
	const quiet = run([end(200_000), { type: "tick", at: 200_000 + VEIL_IDLE_MS - 1 }], state);
	assert.ok(quiet.state.tabs[1]);
	const gone = run([{ type: "tick", at: 200_000 + VEIL_IDLE_MS }], quiet.state);
	assert.deepEqual(gone.effects, [{ kind: "hide", tabId: 1, fade: true }]);
	assert.equal(gone.state.tabs[1], undefined);
});

test("release, take over, a closed tab, an ended session and a client that left remove it at once, without a fade", () => {
	const two = run([begin(0), end(1), begin(2, { tabId: 2 }), end(3, { tabId: 2 })]).state;
	assert.deepEqual(run([{ type: "drop", tabId: 2 }], two).effects, [{ kind: "hide", tabId: 2, fade: false }]);
	assert.deepEqual(run([{ type: "dropSession", sessionId: S }], two).effects, [
		{ kind: "hide", tabId: 1, fade: false },
		{ kind: "hide", tabId: 2, fade: false },
	]);
	assert.deepEqual(run([{ type: "dropSession", sessionId: "bridge-other" }], two).effects, []);
	assert.deepEqual(run([{ type: "dropAll" }], two).effects.length, 2);
	// Nothing to drop: no effect.
	assert.deepEqual(run([{ type: "drop", tabId: 7 }], two).effects, []);
});

test("a screenshot conceals it for the capture; a screencast for as long as it runs; both nest", () => {
	const shown = run([begin(0), end(1)]).state;
	const shot = run(
		[
			{ type: "conceal", tabId: 1, reason: "shot", on: true },
			{ type: "conceal", tabId: 1, reason: "shot", on: true },
			{ type: "conceal", tabId: 1, reason: "shot", on: false },
			{ type: "conceal", tabId: 1, reason: "cast", on: true },
			{ type: "conceal", tabId: 1, reason: "shot", on: false },
			{ type: "conceal", tabId: 1, reason: "cast", on: false },
		],
		shown,
	);
	assert.deepEqual(shot.effects, [
		{ kind: "conceal", tabId: 1, on: true },
		{ kind: "conceal", tabId: 1, on: false },
	]);
	// A cast running before the first call: the veil is drawn concealed.
	const casting = run([{ type: "conceal", tabId: 3, reason: "cast", on: true }, begin(5, { tabId: 3 })]);
	assert.deepEqual(casting.effects, [{ kind: "show", tabId: 3, view, interactive: true, concealed: true }]);
});

test("a new document in the tab is drawn again with the same state; another session's call redraws the pill", () => {
	const shown = run([begin(0, { input: true })]).state;
	assert.deepEqual(run([{ type: "navigated", tabId: 1 }], shown).effects, [
		{ kind: "show", tabId: 1, view, interactive: false, concealed: false },
	]);
	assert.deepEqual(run([{ type: "navigated", tabId: 5 }], shown).effects, []);
	const other = { agent: "Codex", detail: "api", color: "green" };
	const moved = run([end(10, { input: true }), begin(20, { sessionId: "bridge-codex", view: other })], shown);
	assert.deepEqual(moved.effects, [
		{ kind: "interactive", tabId: 1, on: true },
		{ kind: "show", tabId: 1, view: other, interactive: true, concealed: false },
	]);
});

test("veilStep never changes the state it was given", () => {
	const shown = run([begin(0), end(1)]).state;
	const before = JSON.stringify(shown);
	veilStep(shown, { type: "dropAll" });
	veilStep(shown, begin(5, { input: true }));
	veilStep(shown, { type: "conceal", tabId: 1, reason: "shot", on: true });
	assert.equal(JSON.stringify(shown), before);
});

test("the pill says the agent and what the group title says after it", () => {
	assert.deepEqual(veilViewFor({ label: "claude · demo-shop", color: "cyan", agent: "claude" }), {
		agent: "Claude",
		detail: "demo-shop",
		color: "cyan",
	});
	assert.deepEqual(veilViewFor({ label: "codex", color: "red", agent: "codex", agentLabel: "fix login" }), {
		agent: "Codex",
		detail: "fix login",
		color: "red",
	});
	assert.deepEqual(veilViewFor({ label: "omp", color: "blue" }).agent, "Omp");
});

test("veil tags are random custom element names, and only those reach page code", () => {
	const seen = new Set(Array.from({ length: 200 }, () => newVeilTag()));
	assert.ok(seen.size > 190);
	for (const tag of seen) assert.ok(isVeilTag(tag), tag);
	for (const bad of ["", "polycarp-veil", "abc", 'abcde-fghijk"); alert(1', "ABCDE-FGHIJK", 3]) assert.equal(isVeilTag(bad), false);
});

test("the page side is self-contained, uses a closed shadow root, sets no attribute on its host and no page global", () => {
	const src = veilPage.toString();
	assert.match(src, /attachShadow\(\{\s*mode:\s*"closed"\s*\}\)/);
	// Chrome sends only the function's text: nothing it calls may come from the module around it.
	for (const name of ["VEIL_CSS", "GROUP_COLORS", "import("]) assert.ok(!src.includes(name), `veilPage uses ${name}`);
	assert.doesNotMatch(src, /host\.(setAttribute|style|className|id\b|dataset|classList)/, "the host carries an attribute");
	assert.doesNotMatch(src, /\bwindow\.|document\.defaultView/, "page globals");
	assert.match(src, /e\.isTrusted/, "the button acts only on the user's own click");
	assert.match(src, /tabIndex\s*=\s*-1/, "the agent's Tab key could reach the button");
	// The host's styles are important :host rules, which win over the page's own important rules.
	for (const rule of ["pointer-events: none !important", "position: fixed !important", "z-index: 2147483647 !important", "contain: strict !important"])
		assert.ok(VEIL_CSS.includes(rule), rule);
	for (const media of ["prefers-reduced-motion: reduce", "prefers-reduced-transparency: reduce", "forced-colors: active", "@media print"])
		assert.ok(VEIL_CSS.includes(media), media);
	// Only the button takes pointer events.
	assert.equal(VEIL_CSS.match(/pointer-events: auto/g)?.length, 1);
});

test("the readers that list the page's elements leave the veil's element out", () => {
	const page = readFileSync(new URL("../src/browser/page.ts", import.meta.url), "utf8");
	assert.match(page, /function pageInspect\(veil: string\)[\s\S]*?el\.localName !== veil/);
	assert.match(page, /export async function pageHtml[\s\S]*?veilTag\(tabId\)[\s\S]*?out\.replace\(veil\.outerHTML, ""\)/);
});

test("the pointer moves only on a tab with a veil, only when the setting is on, and only to a real point", () => {
	const { state } = run([begin(0), end(100)]);
	const click = { action: "click", x: 40, y: 60 };
	assert.deepEqual(pointerCue(state, 1, click, true), click);
	assert.equal(pointerCue(state, 1, click, false), undefined, "the setting is off");
	assert.equal(pointerCue(state, 2, click, true), undefined, "a tab that isn't in use has no veil, so no pointer");
	assert.equal(pointerCue(EMPTY_VEIL, 1, click, true), undefined);
	for (const bad of [{ x: Number.NaN, y: 1 }, { x: 1, y: Infinity }, { x: 1 }, { x: "4", y: 2 }])
		assert.equal(pointerCue(state, 1, { action: "hover", ...bad }, true), undefined, JSON.stringify(bad));
	// No point: the page finds the focused field.
	assert.deepEqual(pointerCue(state, 1, { action: "type" }, true), { action: "type" });
	assert.deepEqual(pointerCue(state, 1, { action: "scroll-page" }, true), { action: "scroll-page" });
	assert.deepEqual(pointerCue(state, 1, { action: "drag", x: 1, y: 2, to: { x: 30, y: 40 } }, true), {
		action: "drag",
		x: 1,
		y: 2,
		to: { x: 30, y: 40 },
	});
	assert.deepEqual(pointerCue(state, 1, { action: "drag", x: 1, y: 2, to: { x: Number.NaN, y: 4 } }, true), {
		action: "drag",
		x: 1,
		y: 2,
	});
	// After the fade the tab has no veil, and the pointer stays away.
	const faded = run([begin(0), end(100), { type: "tick", at: 100 + VEIL_IDLE_MS + 1 }]).state;
	assert.equal(pointerCue(faded, 1, click, true), undefined);
});

test("the pointer character is plain inline SVG, takes no clicks and holds still when motion is off", () => {
	const tags = new Set();
	const walk = (n) => {
		tags.add(n.tag);
		for (const k of Object.keys(n.attrs)) assert.doesNotMatch(k, /^on|href|style/i, `${n.tag} ${k}`);
		for (const kid of n.kids ?? []) walk(kid);
	};
	walk(MOTE);
	for (const t of tags) assert.ok(["svg", "g", "path", "ellipse", "circle"].includes(t), t);
	// Its tip is the point the input lands on: (3, 3) of 32, drawn at 28 px, so 2.625 px in from the corner.
	assert.match(MOTE.kids[0].kids[1].attrs.d, /^M3 3 /);
	assert.match(VEIL_CSS, /\.mote \{[^}]*width: 28px;[^}]*margin: -2\.625px 0 0 -2\.625px;/);
	assert.ok(!veilPage.toString().includes("MOTE"), "the page gets the drawing in the command");
	assert.match(VEIL_CSS, /prefers-reduced-motion: reduce\) \{\s*\.mote, \.mote \* \{ transition: none !important; animation: none !important; \}/);
	assert.match(VEIL_CSS, /\.veil\.nomote \.mote \{ display: none; \}/);
	assert.doesNotMatch(VEIL_CSS, /\.mote[^{]*\{[^}]*pointer-events/);
});
