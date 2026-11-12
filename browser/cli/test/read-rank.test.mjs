// The line under a ranked interactive read (cli/src/output-cap.ts rankNote): which slice, what was left out, the exact
// call for more. No browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rankNote } from "../src/output-cap.ts";

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
