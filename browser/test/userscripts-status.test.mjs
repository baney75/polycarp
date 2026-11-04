// What bridge.debug reports about chrome.userScripts, and so what `tabkyra doctor` says.
// Chromium exposes the API only when the optional permission is granted AND the "Allow user
// scripts" toggle is on; each combination must map to its own cause.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyUserScripts, isUserScriptsGated, probeUserScripts, userScriptsApi } from "../src/browser/userscripts-status.ts";

/** A chrome with just what the probe touches. `api` undefined means no userScripts namespace. */
function fakeChrome({ granted = false, containsThrows, api, getterThrows } = {}) {
	const chrome = {
		permissions: {
			contains: async (q) => {
				assert.deepEqual(q, { permissions: ["userScripts"] });
				if (containsThrows) throw new Error(containsThrows);
				return granted;
			},
		},
	};
	if (getterThrows)
		Object.defineProperty(chrome, "userScripts", {
			get() {
				throw new Error(getterThrows);
			},
		});
	else if (api) chrome.userScripts = api;
	globalThis.chrome = chrome;
}

const workingApi = () => ({ execute: async () => [], configureWorld: async () => {}, getScripts: async () => [] });

test("toggle on but permission never granted (the Helium case): not_granted, not 'toggle off'", async () => {
	fakeChrome({ granted: false });
	const status = await probeUserScripts();
	assert.deepEqual(status, { permissionGranted: false, apiPresent: false, callWorks: false, error: undefined, state: "not_granted" });
});

test("granted and the API answers: ready", async () => {
	fakeChrome({ granted: true, api: workingApi() });
	const status = await probeUserScripts();
	assert.equal(status.state, "ready");
	assert.equal(status.apiPresent, true);
	assert.equal(status.callWorks, true);
});

test("granted but the namespace is hidden: toggle_off", async () => {
	fakeChrome({ granted: true });
	assert.equal((await probeUserScripts()).state, "toggle_off");
});

test("granted, namespace present, calls blocked by the toggle: toggle_off with the browser's text", async () => {
	const msg = "The 'userScripts' API is only available for users when the 'Allow User Scripts' toggle is enabled.";
	fakeChrome({
		granted: true,
		api: {
			...workingApi(),
			getScripts: () => {
				throw new Error(msg);
			},
		},
	});
	const status = await probeUserScripts();
	assert.equal(status.state, "toggle_off");
	assert.equal(status.apiPresent, true);
	assert.equal(status.callWorks, false);
	assert.equal(status.error, msg);
});

test("granted, call fails for another reason: probe_error with the text", async () => {
	fakeChrome({ granted: true, api: { ...workingApi(), getScripts: async () => Promise.reject(new Error("worker shutting down")) } });
	const status = await probeUserScripts();
	assert.equal(status.state, "probe_error");
	assert.equal(status.error, "worker shutting down");
});

test("permissions.contains itself fails: probe_error, unless the API works anyway", async () => {
	fakeChrome({ containsThrows: "no permissions API" });
	const broken = await probeUserScripts();
	assert.equal(broken.state, "probe_error");
	assert.equal(broken.permissionGranted, null);
	assert.match(broken.error, /permissions\.contains: no permissions API/);

	fakeChrome({ containsThrows: "no permissions API", api: workingApi() });
	assert.equal((await probeUserScripts()).state, "ready");

	// Both calls fail: both reasons are kept.
	fakeChrome({ containsThrows: "no permissions API", api: { ...workingApi(), getScripts: async () => Promise.reject(new Error("boom")) } });
	assert.equal((await probeUserScripts()).error, "permissions.contains: no permissions API; boom");
});

test("only the browser's refusal sends a script to the debugger path", () => {
	assert.ok(isUserScriptsGated(new Error("The 'userScripts' API is only available when the 'Allow User Scripts' toggle is enabled.")));
	assert.ok(isUserScriptsGated("requires developer mode"));
	assert.ok(!isUserScriptsGated(new Error("No tab with id: 12")));
	assert.ok(!isUserScriptsGated(new Error("Cannot access contents of the page")));
});

test("injection path and doctor share one presence check; a throwing getter counts as absent", () => {
	fakeChrome({ granted: true, getterThrows: "gated" });
	assert.equal(userScriptsApi(), undefined);
	fakeChrome({ granted: true, api: { getScripts: async () => [] } });
	assert.equal(userScriptsApi(), undefined, "no execute: the injection path would not use it");
	fakeChrome({ granted: true, api: workingApi() });
	assert.ok(userScriptsApi());
});

test("classifier: every probe maps to exactly one state", () => {
	const cases = [
		[{ permissionGranted: true, apiPresent: true, callWorks: true }, "ready"],
		[{ permissionGranted: null, apiPresent: true, callWorks: true }, "ready"],
		[{ permissionGranted: false, apiPresent: false, callWorks: false }, "not_granted"],
		[{ permissionGranted: true, apiPresent: false, callWorks: false }, "toggle_off"],
		[{ permissionGranted: true, apiPresent: true, callWorks: false }, "toggle_off"],
		[{ permissionGranted: true, apiPresent: true, callWorks: false, error: "developer mode required" }, "toggle_off"],
		[{ permissionGranted: true, apiPresent: true, callWorks: false, error: "boom" }, "probe_error"],
		[{ permissionGranted: null, apiPresent: false, callWorks: false }, "probe_error"],
	];
	for (const [probe, state] of cases) assert.equal(classifyUserScripts(probe).state, state, JSON.stringify(probe));
});
