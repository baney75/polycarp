// Which editing commands a pressed chord carries. Chromium runs select-all, undo and the
// word and line moves from the platform's bindings, so a synthetic Meta+a selects nothing unless
// the key event names the command (Input.dispatchKeyEvent's `commands`).
import assert from "node:assert/strict";
import test from "node:test";
import { editingCommands, isClipboardChord } from "../src/browser/key-commands.ts";

const mac = (mods, main) => editingCommands(mods, main, true);
const other = (mods, main) => editingCommands(mods, main, false);

test("select-all, undo and redo chords carry their command on macOS and elsewhere", () => {
	assert.deepEqual(mac(["Meta"], "a"), ["selectAll"]);
	assert.deepEqual(other(["Control"], "a"), ["selectAll"]);
	assert.deepEqual(mac(["Meta"], "z"), ["undo"]);
	assert.deepEqual(other(["Control"], "z"), ["undo"]);
	assert.deepEqual(mac(["Meta", "Shift"], "z"), ["redo"]);
	assert.deepEqual(other(["Control", "Shift"], "Z"), ["redo"]);
	assert.deepEqual(other(["Control"], "y"), ["redo"]);
});

test("copy, cut and paste never get a command: they would touch the user's system clipboard", () => {
	for (const [mods, key] of [
		[["Meta"], "v"],
		[["Control"], "v"],
		[["Meta"], "c"],
		[["Control"], "c"],
		[["Meta"], "x"],
		[["Control"], "x"],
		[["Meta", "Shift"], "v"],
		[["Control", "Shift"], "v"],
	]) {
		assert.deepEqual(mac(mods, key), [], `${mods.join("+")}+${key} on a Mac`);
		assert.deepEqual(other(mods, key), [], `${mods.join("+")}+${key} elsewhere`);
	}
});

test("Control+a on a Mac and Meta+a elsewhere still select all: agents write either", () => {
	assert.deepEqual(mac(["Control"], "a"), ["selectAll"]);
	assert.deepEqual(other(["Meta"], "a"), ["selectAll"]);
});

test("plain keys, Alt chords and unrelated chords stay plain key events", () => {
	assert.deepEqual(mac([], "a"), []);
	assert.deepEqual(mac([], "Enter"), []);
	assert.deepEqual(mac(["Shift"], "ArrowLeft"), []);
	assert.deepEqual(other(["Shift"], "ArrowLeft"), []);
	assert.deepEqual(mac(["Meta"], "p"), []);
	assert.deepEqual(mac(["Meta", "Shift"], "p"), []);
	assert.deepEqual(mac(["Meta", "Alt"], "a"), []);
	assert.deepEqual(mac(["Meta", "Control"], "a"), []);
	assert.deepEqual(mac(["Meta"], "y"), []);
	assert.deepEqual(other(["Control"], "Tab"), []);
});

test("word and line moves follow the platform", () => {
	assert.deepEqual(mac(["Alt"], "ArrowLeft"), ["moveWordLeft"]);
	assert.deepEqual(mac(["Alt", "Shift"], "ArrowRight"), ["moveWordRightAndModifySelection"]);
	assert.deepEqual(mac(["Meta"], "ArrowLeft"), ["moveToBeginningOfLine"]);
	assert.deepEqual(mac(["Meta", "Shift"], "ArrowRight"), ["moveToEndOfLineAndModifySelection"]);
	assert.deepEqual(mac(["Meta"], "ArrowUp"), ["moveToBeginningOfDocument"]);
	assert.deepEqual(mac(["Meta"], "ArrowDown"), ["moveToEndOfDocument"]);
	assert.deepEqual(mac(["Alt"], "Backspace"), ["deleteWordBackward"]);
	assert.deepEqual(mac(["Meta"], "Backspace"), ["deleteToBeginningOfLine"]);
	assert.deepEqual(other(["Control"], "ArrowLeft"), ["moveWordLeft"]);
	assert.deepEqual(other(["Control", "Shift"], "ArrowRight"), ["moveWordRightAndModifySelection"]);
	assert.deepEqual(other(["Control"], "Home"), ["moveToBeginningOfDocument"]);
	assert.deepEqual(other(["Control", "Shift"], "End"), ["moveToEndOfDocumentAndModifySelection"]);
	assert.deepEqual(other(["Control"], "Backspace"), ["deleteWordBackward"]);
	assert.deepEqual(other(["Control"], "Delete"), ["deleteWordForward"]);
	// Alt+Left on Windows/Linux is history navigation, not a text move.
	assert.deepEqual(other(["Alt"], "ArrowLeft"), []);
});

test("clipboard chords are refused on every platform, in every spelling", () => {
	const refused = [
		[["Control"], "c"], [["Control"], "x"], [["Control"], "v"], [["Control"], "V"],
		[["Meta"], "c"], [["Meta"], "x"], [["Meta"], "v"],
		[["Control", "Shift"], "v"], [["Meta", "Shift"], "v"], [["Control", "Shift"], "V"],
		[["Shift"], "Insert"], [["Control"], "Insert"], [["Shift"], "Delete"],
	];
	for (const [mods, key] of refused) assert.equal(isClipboardChord(mods, key), true, `${mods.join("+")}+${key}`);
});

test("other chords are not clipboard chords", () => {
	const fine = [
		[[], "v"], [[], "c"], [["Shift"], "v"], [["Control"], "a"], [["Control"], "z"], [["Meta"], "p"],
		[["Control", "Shift"], "c"], [["Control", "Alt"], "v"], [[], "Insert"], [[], "Delete"],
		[["Control"], "Delete"], [["Shift"], "ArrowLeft"], [["Alt"], "Insert"], [["Control", "Shift"], "Insert"],
	];
	for (const [mods, key] of fine) assert.equal(isClipboardChord(mods, key), false, `${mods.join("+")}+${key}`);
});
