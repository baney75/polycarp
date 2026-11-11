// The files tool in the extension (src/bridge/files.ts): an upload reaches only the document it was
// approved for, and never a page once the caller is gone. The page here is a small stand-in: each
// document is its own script context with a file input, and the scripts the bridge injects run in
// whichever document the tab shows at that moment, as they do in the browser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { allowHost } = await import("../src/bridge/permissions.ts");
const files = await import("../src/bridge/files.ts");

/** One loaded page: its address, its globals and its file input. */
function makeDoc(url) {
	const at = new URL(url);
	class El {
		constructor(tag) {
			this.tagName = tag.toUpperCase();
			this.isConnected = true;
			this.events = [];
		}
		dispatchEvent(e) {
			this.events.push(e.type);
			return true;
		}
		getBoundingClientRect() {
			return { left: 0, top: 0, width: 10, height: 10 };
		}
	}
	class HTMLInputElement extends El {
		constructor() {
			super("input");
			Object.assign(this, { type: "file", multiple: true, accept: "", disabled: false, files: null });
		}
	}
	class HTMLLabelElement extends El {}
	class DataTransfer {
		constructor() {
			this.files = [];
			this.items = { add: (f) => this.files.push(f) };
		}
	}
	const input = new HTMLInputElement();
	const window = { HTMLInputElement, HTMLLabelElement, DataTransfer, File, Event, DragEvent: Event };
	const document = { defaultView: window, querySelector: (sel) => (sel === "#file" ? input : null) };
	input.ownerDocument = document;
	// __name: the test loader (tsx) wraps named functions with it, and the bridge stringifies some into its scripts.
	const globals = { location: { origin: at.origin, hostname: at.hostname }, document, window, Blob, File, atob, btoa, Uint8Array, crypto, __name: (f) => f };
	return { url, input, globals, context: vm.createContext(globals) };
}

/** A tab (id 7) showing one document, and a record of every script the bridge ran in it. */
function browser(url) {
	const tab = { doc: makeDoc(url), ran: [], beforeRun: undefined };
	chrome.tabs.get = async () => ({ id: 7, url: tab.doc.url, title: "Page" });
	chrome.userScripts = {
		async configureWorld() {},
		async execute({ js }) {
			// A navigation that lands after the tab's address was read and before this script runs.
			const hook = tab.beforeRun;
			if (hook) await hook(tab);
			tab.ran.push(js[0].code);
			return [{ result: await vm.runInContext(js[0].code, tab.doc.context) }];
		},
	};
	return tab;
}

const sha = (b) => createHash("sha256").update(b).digest("hex");

function caller(overrides = {}) {
	const state = { aborted: false };
	const ctx = {
		clientId: "c1",
		session: { id: "s1", tabIds: [7] },
		aborted: () => state.aborted,
		isGuarded: () => false,
		askUpload: async () => true,
		checkUrl: async () => {},
		emit() {},
		delivered() {},
		...overrides,
	};
	return { ctx, state };
}

const handlers = files.fileHandlers(async () => 7);

/** begin and every chunk of a three-piece upload to #file; what is left is the commit. */
async function begun(ctx) {
	const body = Buffer.from("first piece, second piece, third piece");
	const pieces = [body.subarray(0, 13), body.subarray(13, 27), body.subarray(27)];
	const { transferId } = await handlers["files.upload.begin"](ctx, {
		selector: "#file",
		files: [{ name: "notes.txt", bytes: body.length, sha256: sha(body), mime: "text/plain" }],
	});
	for (const [seq, piece] of pieces.entries())
		await handlers["files.upload.chunk"](ctx, { transferId, seq, data: piece.toString("base64") });
	return { transferId, body };
}

/** Nothing of the upload is in this document: no files on the input, no events, no stashed pieces. */
function untouched(doc, what) {
	assert.equal(doc.input.files, null, `${what}: the input was given files`);
	assert.deepEqual(doc.input.events, [], `${what}: events were fired`);
	const stash = doc.globals.__polycarpUploads ?? {};
	assert.deepEqual(Object.values(stash).flat(), [], `${what}: pieces were left in the page`);
}

test("an upload to the page it began on arrives whole", async () => {
	await allowHost("good.test");
	const tab = browser("https://good.test/form");
	const { ctx } = caller();
	const { transferId, body } = await begun(ctx);
	const done = await handlers["files.upload.commit"](ctx, { transferId });
	assert.equal(done.host, "good.test");
	assert.deepEqual(tab.doc.input.events, ["input", "change"]);
	assert.equal(Buffer.from(await tab.doc.input.files[0].arrayBuffer()).toString(), body.toString());
	assert.deepEqual(Object.keys(tab.doc.globals.__polycarpUploads), [], "the stash is emptied");
	assert.equal(files.transferCount(), 0);
});

test("a tab that navigates after the site check gets nothing: the scripts check the document they run in", async () => {
	await allowHost("good.test");
	// At each point a script runs during the commit: the three pieces, then the one that sets the files.
	for (const at of [0, 1, 2, 3]) {
		const tab = browser("https://good.test/form");
		const { ctx } = caller();
		const { transferId } = await begun(ctx);
		const good = tab.doc;
		const evil = makeDoc("https://evil.test/form");
		const start = tab.ran.length;
		tab.beforeRun = (t) => {
			// The address the bridge read a moment ago said good.test; the page is evil.test now, with the same selector.
			if (t.ran.length === start + at) t.doc = evil;
		};
		await assert.rejects(handlers["files.upload.commit"](ctx, { transferId }), (err) => {
			assert.equal(err.code, "permission_denied", err.message);
			assert.match(err.message, /moved from good\.test to evil\.test.*Nothing was set/);
			return true;
		});
		untouched(evil, `navigated before script ${at}`);
		assert.equal(good.input.files, null);
		assert.equal(files.transferCount(), 0);
	}
});

test("a reload of the same page between begin and commit is refused too: the yes was for that document", async () => {
	await allowHost("good.test");
	const tab = browser("https://good.test/form");
	const { ctx } = caller();
	const { transferId } = await begun(ctx);
	const reloaded = makeDoc("https://good.test/form");
	tab.doc = reloaded;
	await assert.rejects(handlers["files.upload.commit"](ctx, { transferId }), /reloaded or changed during the upload. Nothing was set/);
	untouched(reloaded, "reloaded");
});

test("a tab that leaves the site while the upload begins is refused before the person is asked", async () => {
	await allowHost("good.test");
	const tab = browser("https://good.test/form");
	let asked = 0;
	const { ctx } = caller({ askUpload: async () => (asked++, true) });
	tab.beforeRun = (t) => {
		t.doc = makeDoc("https://evil.test/form");
	};
	await assert.rejects(
		handlers["files.upload.begin"](ctx, { selector: "#file", files: [{ name: "a.txt", bytes: 1, sha256: sha(Buffer.from("a")), ask: true }] }),
		/left good\.test as the upload began/,
	);
	assert.equal(asked, 0);
	assert.equal(files.transferCount(), 0);
});

test("a caller that goes away during the commit: no more pieces, no files set, the stash cleared", async () => {
	await allowHost("good.test");
	const leave = {
		"the bridge connection closes (the call is aborted)": (state) => {
			state.aborted = true;
			files.dropAllTransfers();
		},
		"its client disconnects": () => files.dropTransfersForClient("c1"),
		"its session ends": () => files.dropTransfersForSession("s1"),
	};
	for (const [what, go] of Object.entries(leave)) {
		// After the first piece, and after the last one, right before the files would be set.
		for (const after of [1, 3]) {
			const tab = browser("https://good.test/form");
			const { ctx, state } = caller();
			const { transferId } = await begun(ctx);
			const start = tab.ran.length;
			tab.beforeRun = undefined;
			const execute = chrome.userScripts.execute;
			chrome.userScripts.execute = async (args) => {
				const out = await execute(args);
				if (tab.ran.length === start + after) go(state);
				return out;
			};
			await assert.rejects(handlers["files.upload.commit"](ctx, { transferId }), (err) => {
				assert.equal(err.code, "interrupted", `${what}: ${err.message}`);
				return true;
			});
			assert.equal(tab.ran.slice(start).some((code) => code.includes("DataTransfer")), false, `${what}: the files were set`);
			if (after === 1) assert.equal(tab.ran.slice(start).filter((code) => code.includes(".push(")).length, 1, `${what}: more pieces were sent`);
			// The clearing script may still be on its way when the call fails.
			await new Promise((r) => setTimeout(r, 20));
			untouched(tab.doc, `${what}, after script ${after}`);
			assert.equal(files.transferCount(), 0);
			// And it can't be committed again.
			await assert.rejects(handlers["files.upload.commit"](ctx, { transferId }), /transfer is gone/);
		}
	}
});

test("a download is fetched only in the page it was judged for", async () => {
	await allowHost("good.test");
	const tab = browser("https://good.test/files");
	let fetched = 0;
	const evil = makeDoc("https://evil.test/files");
	for (const doc of [tab.doc, evil]) doc.globals.fetch = async () => (fetched++, { ok: false, status: 404 });
	const { ctx } = caller();
	// Same page: the fetch runs (and the server says 404).
	await assert.rejects(handlers["files.download.begin"](ctx, { url: "/me.json" }), /answered 404/);
	assert.equal(fetched, 1);
	// The tab moved after its address was read: the relative URL would now be evil.test's, with its cookies.
	tab.beforeRun = (t) => {
		t.doc = evil;
	};
	await assert.rejects(handlers["files.download.begin"](ctx, { url: "/me.json" }), /tab moved to evil\.test before the download began/);
	assert.equal(fetched, 1, "nothing was fetched in the other page");
});
