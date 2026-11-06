// The parent process maps to a browser name. Run with --experimental-strip-types so the TypeScript source loads directly: a
// failed import is a failed test, not a skipped one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserFromExecutable } from "../src/parent-browser.ts";

test("a Mac app path maps to the browser's name", () => {
	assert.equal(browserFromExecutable("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "Chrome");
	assert.equal(browserFromExecutable("/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"), "Chrome Beta");
	assert.equal(browserFromExecutable("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"), "Brave");
});

test("the real binary /proc/<pid>/exe resolves to on Linux maps too, wrapper scripts and all", () => {
	// Packages put the real binary in a folder of its own; the wrapper in /usr/bin is not what /proc says.
	assert.equal(browserFromExecutable("/opt/google/chrome/chrome"), "Chrome");
	assert.equal(browserFromExecutable("/opt/google/chrome-beta/chrome"), "Chrome Beta", "Beta's binary is plainly `chrome`; its folder says which");
	assert.equal(browserFromExecutable("/opt/microsoft/msedge/msedge"), "Edge");
	assert.equal(browserFromExecutable("/opt/vivaldi/vivaldi-bin"), "Vivaldi");
	assert.equal(browserFromExecutable("/opt/brave.com/brave/brave"), "Brave");
	assert.equal(browserFromExecutable("/usr/lib/chromium/chromium"), "Chromium");
	assert.equal(browserFromExecutable("/opt/opera/opera"), "Opera");
	assert.equal(browserFromExecutable("/usr/bin/microsoft-edge-stable"), "Edge");
	assert.equal(browserFromExecutable("/usr/bin/google-chrome-beta"), "Chrome Beta");
});

test("something that isn't a browser maps to nothing", () => {
	assert.equal(browserFromExecutable("/bin/zsh"), undefined);
	assert.equal(browserFromExecutable("/usr/bin/node"), undefined);
});
