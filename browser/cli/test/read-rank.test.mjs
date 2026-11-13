// The line under a ranked interactive read (cli/src/output-cap.ts rankNote): which slice, what was left out, the exact
// call for more. No browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rankedSlice, rankNote } from "../src/output-cap.ts";

const counts = (o) => ({ total: 343, covered: 0, first: 2, inView: 41, near: 12, far: 288, offset: 0, ...o });

test("a first slice names its tiers and the exact call for the next one", () => {
	const note = rankNote(counts({ covered: 1 }), 50);
	assert.match(note, /Controls 1-50 of 343, nearest first \(2 focused or in a dialog, 41 in view, 12 within a screen, 288 further away\)/);
	assert.match(note, /1 covered by something on top are left out/);
	assert.match(note, /read_page \{"filter":"interactive","offset":50\}/);
	assert.match(note, /get_page_text reads it/);
});

test("a small page says all, with no continuation and no empty tiers", () => {
	const note = rankNote({ total: 6, covered: 0, first: 0, inView: 6, near: 0, far: 0, offset: 0 }, 6);
	assert.match(note, /All 6 controls \(6 in view\)/);
	assert.doesNotMatch(note, /offset|covered|dialog|further/);
});

test("the last slice and a slice past the end say so", () => {
	assert.match(rankNote(counts({ offset: 300 }), 43), /Controls 301-343 of 343/);
	assert.doesNotMatch(rankNote(counts({ offset: 300 }), 43), /"offset"/);
	assert.match(rankNote(counts({ offset: 400 }), 0), /No controls from 401 on \(343 in all\)/);
});

test("a ranked read's note says what text came: none asked, cut at the cap, or whole", () => {
	assert.match(rankNote(counts(), 50), /No page text here: get_page_text reads it\./);
	const cut = rankNote(counts(), 50, { maxTextChars: 2000, cut: true });
	assert.doesNotMatch(cut, /No page text/);
	assert.match(cut, /The text stopped at 2,000 characters: get_page_text reads all of it\./);
	assert.doesNotMatch(rankNote(counts(), 50, { maxTextChars: 2000, cut: false }), /No page text|text stopped/);
});

test("the next slice's call names the read it continues", () => {
	assert.match(rankNote(counts({ snapshot: "rab12c" }), 50), /read_page \{"filter":"interactive","offset":50,"snapshot":"rab12c"\}/);
});

// PR 201 first-F2: a later slice keeps the first read's positions. Controls that left the page leave a gap; the next
// offset is where the window of positions ended, never offset plus what was shown (which repeated controls).
test("a later slice after removals ends at the window's last position and says what left", () => {
	const nodes = Array.from({ length: 48 }, (_, i) => `n${i}`);
	// Positions 50-100 asked for (one more than shown), 3 of them gone.
	const positions = Array.from({ length: 51 }, (_, i) => 50 + i).filter((p) => ![54, 55, 56].includes(p));
	const r = counts({ offset: 50, snapshot: "rab12c", next: 101, positions });
	const { nodes: kept, next } = rankedSlice(r, nodes, 50);
	assert.equal(next, 100);
	assert.equal(kept.length, 47, "position 100 belongs to the next slice");
	const note = rankNote(r, kept.length, undefined, { next });
	assert.match(note, /Controls 51-100 of 343/);
	assert.match(note, /3 of them left the page since that read\./);
	assert.match(note, /"offset":100,"snapshot":"rab12c"/);
	// A first read: one more than shown means more follow, from where the list stopped.
	assert.deepEqual(rankedSlice(counts({ next: 51 }), Array.from({ length: 51 }, (_, i) => i), 50).next, 50);
	// A read from an extension without next or positions: offset plus what was shown, as before.
	assert.equal(rankedSlice(counts({ offset: 50 }), Array.from({ length: 51 }, (_, i) => i), 50).next, 100);
});

// PR 201 second-F6: the note names only tools the session has.
test("a ranked read's note in a session without find or get_page_text names neither", () => {
	const has = (t) => t === "read_page";
	const note = rankNote(counts(), 50, { maxTextChars: 0, cut: false }, { has });
	assert.match(note, /More: read_page \{"filter":"interactive","offset":50\}\./);
	assert.doesNotMatch(note, /find|get_page_text/);
	assert.match(note, /No page text here\./);
	assert.doesNotMatch(rankNote(counts(), 50, { maxTextChars: 2000, cut: true }, { has }), /get_page_text/);
});
