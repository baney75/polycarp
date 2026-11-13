// D49: a click that starts a download says so in its result, and that the save folder is not known.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const says = (value) => ({ result: { value: { ok: true, value } } });
const isLook = (params) => /function refsGone/.test(params?.expression ?? "");
const look = { url: "https://shop.example/", title: "Shop", focus: "", doc: "d1", gone: [], text: "",
	nodes: [{ ref: "e1", role: "link", name: "Export", x: 1, y: 1, width: 10, height: 10, visible: true }] };

let bridge;
/** One bridge for the file: the download listener, once installed, stays on the first fake chrome. */
const startBridge = () => (bridge ??= open());

async function open() {
	const fake = installFakeChrome();
	const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
	chrome.tabs.onActivated ??= ev();
	chrome.webNavigation.onCommitted ??= ev();
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	native.startBridge();
	const port = fake.ports[0];
	let nextId = 1;
	const request = async (method, params = {}) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId: "c1", id, method, params, guardedHosts: [] });
		for (let i = 0; i < 1000; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.clientId === "c1" && m.id === id);
			if (reply) return reply;
			await new Promise((r) => setTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "downloads" } });
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	const tabId = (await request("tabs.create")).result.tabId;
	await chrome.tabs.update(tabId, { url: "https://shop.example/", status: "complete" });
	return { request, tabId };
}

/** Answers the look and the point; `onRelease` runs when the click's button comes up. */
let send;
function page(tabId, onRelease) {
	send ??= chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") onRelease?.((m, p) => {
			for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, m, p);
		});
		if (method === "Runtime.evaluate" && isLook(params)) return says(look);
		if (method === "Runtime.evaluate" && /scrollIntoView/.test(params.expression)) return says({ x: 5, y: 5, width: 10, height: 10 });
		return send(target, method, params);
	};
}

test("a click on an attachment link reports the file: name, type, size, state, masked URL and the folder limit", async () => {
	const { request, tabId } = await startBridge();
	page(tabId, (emit) => {
		emit("Page.downloadWillBegin", { frameId: "F", guid: "g1", url: "https://shop.example/export?id=7&token=s3cr3tvalue", suggestedFilename: "orders.csv" });
		setTimeout(() => emit("Page.downloadProgress", { guid: "g1", totalBytes: 2048, receivedBytes: 2048, state: "completed" }), 100);
	});
	const reply = await request("click", { ref: "e1" });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	const [d] = reply.result.downloads;
	assert.deepEqual({ ...d, url: undefined }, { name: "orders.csv", type: "csv", state: "completed", bytes: 2048, url: undefined });
	assert.ok(d.url.startsWith("https://shop.example/export?id=7") && !d.url.includes("s3cr3tvalue"), d.url);
	assert.match(reply.result.downloadNote, /download folder; the path isn't known\. Polycarp doesn't open/);
});

test("a script-made file (data: URL) is reported without its bytes; a canceled one says so", async () => {
	const { request, tabId } = await startBridge();
	page(tabId, (emit) => {
		emit("Page.downloadWillBegin", { frameId: "F", guid: "g2", url: `data:text/plain;base64,${"QUFB".repeat(500)}`, suggestedFilename: "notes.txt" });
		emit("Page.downloadProgress", { guid: "g2", totalBytes: 0, receivedBytes: 0, state: "canceled" });
	});
	const reply = await request("click", { ref: "e1" });
	assert.deepEqual(reply.result.downloads, [{ name: "notes.txt", type: "txt", url: "data:text/plain;base64,...", state: "canceled" }]);
});

test("a download an earlier action began is not the next action's", async () => {
	const { request, tabId } = await startBridge();
	page(tabId, (emit) => {
		emit("Page.downloadWillBegin", { frameId: "F", guid: "g3", url: "blob:https://shop.example/1", suggestedFilename: "a.pdf" });
		emit("Page.downloadProgress", { guid: "g3", totalBytes: 9, receivedBytes: 9, state: "completed" });
	});
	assert.equal((await request("click", { ref: "e1" })).result.downloads.length, 1);
	page(tabId);
	const second = await request("click", { ref: "e1" });
	assert.equal(second.result.downloads, undefined);
	assert.equal(second.result.downloadNote, undefined);
});

test("a download that doesn't end (a save box waits on the person) is reported as started within the 2 s wait", async () => {
	const { request, tabId } = await startBridge();
	page(tabId, (emit) => emit("Page.downloadWillBegin", { frameId: "F", guid: "g4", url: "https://shop.example/big.zip", suggestedFilename: "big.zip" }));
	const t = Date.now();
	const reply = await request("click", { ref: "e1" });
	assert.deepEqual(reply.result.downloads, [{ name: "big.zip", type: "zip", url: "https://shop.example/big.zip", state: "started" }]);
	assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`);
});
