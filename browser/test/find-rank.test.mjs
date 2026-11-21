// `find` ranking: exact and whole-word name matches above partial ones, URL-only links last.
import assert from "node:assert/strict";
import test from "node:test";
import { rankMatches } from "../src/bridge/find.ts";

const n = (role, name, extra = {}) => ({ role, name, visible: true, ...extra });
const names = (nodes) => nodes.map((x) => x.name);

test("an exact name beats a whole word, which beats a piece of a word", () => {
	const nodes = [
		n("link", "Sign in with Google"),
		n("button", "Designing"),
		n("button", "Sign in"),
		n("link", "Resign instantly"),
	];
	const found = names(rankMatches(nodes, "sign in", 10));
	assert.equal(found[0], "Sign in");
	assert.equal(found[1], "Sign in with Google");
	assert.deepEqual(found.slice(2).sort(), ["Designing", "Resign instantly"]);
});

test("a role word counts, so 'checkbox' finds checkboxes ahead of other elements", () => {
	const nodes = [n("button", "Delete"), n("checkbox", "first task"), n("checkbox", "second task")];
	assert.deepEqual(names(rankMatches(nodes, "checkbox", 10)), ["first task", "second task"]);
});

test("a link matched only by a piece of its URL is dropped when anything else matched", () => {
	const nodes = [
		n("link", "Docs", { href: "https://x.test/a#first-task-howto" }),
		n("checkbox", "first task"),
		n("link", "Other", { href: "/first" }),
	];
	assert.deepEqual(names(rankMatches(nodes, "first task", 10)), ["first task"]);
});

test("a URL-only match is still returned when nothing else matches", () => {
	const nodes = [n("link", "Docs", { href: "https://x.test/a#howto" }), n("button", "Save")];
	assert.deepEqual(names(rankMatches(nodes, "howto", 10)), ["Docs"]);
});

test("visible elements come before offscreen ones of equal rank, and the limit applies", () => {
	const nodes = [n("button", "Buy", { visible: false }), n("button", "Buy"), n("button", "Buy", { visible: true })];
	const found = rankMatches(nodes, "buy", 2);
	assert.equal(found.length, 2);
	assert.ok(found.every((x) => x.visible));
	assert.deepEqual(rankMatches(nodes, "nothing", 5), []);
});

test("whole words are found next to punctuation and non-ASCII letters", () => {
	const nodes = [n("button", "Zoomed"), n("button", "Zoom (100%)"), n("link", "Café menu")];
	assert.equal(rankMatches(nodes, "zoom", 5)[0].name, "Zoom (100%)");
	assert.equal(rankMatches(nodes, "café", 5)[0].name, "Café menu");
});
