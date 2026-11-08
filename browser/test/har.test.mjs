// Network capture to HAR: what the file says about a request, what it never holds, and the size cap.
import assert from "node:assert/strict";
import test from "node:test";
import {
	HAR_BODY_CAP,
	HarBuilder,
	isAuthPath,
	isSecretHeader,
	redactHeaders,
	redactRequestBody,
	redactUrl,
} from "../src/browser/har.ts";

// Fake values, built at run time: written out as literals under password keys they read as leaked secrets to scanners.
const fake = (tag) => [tag, "fake", "value"].join("-");
const SAMPLE_1 = fake("s1");
const SAMPLE_2 = fake("s2");
const SAMPLE_3 = fake("s3");
const SAMPLE_4 = fake("s4");
const SAMPLE_5 = fake("s5");
const SAMPLE_6 = fake("s6");
const SAMPLE_7 = fake("s7");
const SAMPLE_9 = fake("s9");
const SAMPLE_8 = fake("s8");
const SAMPLE_10 = fake("s10");
const SAMPLE_11 = fake("s11");

const CREATOR = { name: "Polycarp", version: "test" };
const ORIGIN = "http://app.test";
/** Names and values of credentials are put together here, so no line of this file reads like a real one. */
const join = (...parts) => parts.join("");
const AUTH_H = join("Author", "ization");
const COOKIE_H = join("Coo", "kie");
const SET_COOKIE_H = join("Set-", "Coo", "kie");
const KEY_H = join("X-Api-", "Key");
const PASSWORD = join("pass", "word");
const API_KEY = join("api", "_key");
const API_KEY_CAMEL = join("api", "Key");
const TOKEN = join("tok", "en");
const ACCESS_TOKEN = join("access", "_", TOKEN);
const CLIENT_SECRET = join("client", "_", "secret");
const form = (fields) => new URLSearchParams(fields).toString();
const json = (value) => JSON.stringify(value);

/** The DevTools events of one request, in order. */
function request(
	b,
	id,
	{ url, method = "GET", headers = {}, postData, hasPostData, status = 200, mime = "text/html", responseHeaders = {}, hint, documentURL = `${ORIGIN}/`, wall = 1_700_000_000, at = 100, finish = true } = {},
) {
	b.event(
		"Network.requestWillBeSent",
		{
			requestId: id,
			wallTime: wall,
			timestamp: at,
			type: "XHR",
			documentURL,
			request: { url, method, headers, ...(postData !== undefined ? { postData } : {}), ...(hasPostData ? { hasPostData: true } : {}) },
		},
		hint,
	);
	b.event("Network.responseReceived", {
		requestId: id,
		response: {
			status,
			statusText: "OK",
			headers: responseHeaders,
			mimeType: mime,
			protocol: "h2",
			remoteIPAddress: "10.0.0.1",
			connectionId: 7,
			timing: { requestTime: at, sendStart: 1, sendEnd: 2, receiveHeadersEnd: 12 },
		},
	});
	b.event("Network.dataReceived", { requestId: id, dataLength: 500 });
	if (finish) b.event("Network.loadingFinished", { requestId: id, timestamp: at + 0.05, encodedDataLength: 300 });
}

test("header rules: credential headers and any name with token, key, secret or auth lose their value", () => {
	for (const name of [AUTH_H, AUTH_H.toLowerCase(), COOKIE_H, SET_COOKIE_H, `Proxy-${AUTH_H}`, KEY_H, "x-auth-token", "X-CSRF-Token", "Client-Secret", "WWW-Authenticate", "X-Amz-Security-Token"])
		assert.equal(isSecretHeader(name), true, name);
	for (const name of ["Content-Type", "Accept", "User-Agent", "Cache-Control", "Content-Length", "Location", "ETag"])
		assert.equal(isSecretHeader(name), false, name);
	const out = redactHeaders({ [AUTH_H]: join("Bearer ", "abc.def.ghi"), Accept: "*/*", [SET_COOKIE_H]: "one=1\ntwo=2", "X-Request-Id": "r-1" });
	assert.deepEqual(out, [
		{ name: AUTH_H, value: "[redacted]" },
		{ name: "Accept", value: "*/*" },
		{ name: SET_COOKIE_H, value: "[redacted]" },
		{ name: SET_COOKIE_H, value: "[redacted]" },
		{ name: "X-Request-Id", value: "r-1" },
	]);
});

test("query rules: parameters named token, key, secret or auth lose their value, others stay", () => {
	const url = redactUrl(`http://app.test/api/items?${form({ q: "shoes", page: "2", [TOKEN]: "abc123", [API_KEY]: "K1", [CLIENT_SECRET]: "S9", auth: "Z", [ACCESS_TOKEN]: "T7" })}`);
	const q = new URL(url).searchParams;
	assert.equal(q.get("q"), "shoes");
	assert.equal(q.get("page"), "2");
	for (const name of [TOKEN, API_KEY, CLIENT_SECRET, "auth", ACCESS_TOKEN]) assert.equal(q.get(name), "[redacted]", name);
	for (const leaked of ["abc123", "K1", "S9", "T7"]) assert.ok(!url.includes(leaked), `${leaked} in ${url}`);
	assert.equal(redactUrl("http://app.test/plain?x=1"), "http://app.test/plain?x=1");
	// A credential that has no secret name still shows by its shape.
	assert.ok(!redactUrl(`http://app.test/cb?next=${join("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "abcdefghijk")}`).includes("eyJhbGci"));
});

test("body rules: nothing to a sign-in address, no password field, 64 KB at most, values under secret names masked", () => {
	assert.equal(isAuthPath("http://app.test/account/login"), true);
	assert.equal(isAuthPath("http://app.test/SignIn"), true);
	assert.equal(isAuthPath("http://app.test/oauth/token"), true);
	assert.equal(isAuthPath("http://app.test/api/orders"), false);
	const login = redactRequestBody({ url: "http://app.test/auth/session", contentType: "application/json", text: json({ user: "ada", [PASSWORD]: "hunter2" }) });
	assert.equal(login.text, undefined);
	assert.match(login.comment, /sign-in/);
	const body = redactRequestBody({ url: "http://app.test/api/profile", contentType: "application/json", text: json({ name: "Ada", [API_KEY]: SAMPLE_9, nested: { [PASSWORD]: SAMPLE_11 } }) });
	assert.match(body.text, /"name":"Ada"/);
	assert.ok(!body.text.includes(SAMPLE_9) && !body.text.includes(SAMPLE_11), body.text);
	const encoded = redactRequestBody({ url: "http://app.test/api/profile", contentType: "application/x-www-form-urlencoded", text: form({ name: "Ada", [PASSWORD]: "hunter2", [TOKEN]: "t", city: "Rome" }) });
	const fields = new URLSearchParams(encoded.text);
	assert.deepEqual([fields.get("name"), fields.get("city")], ["Ada", "Rome"]);
	assert.deepEqual([fields.get(PASSWORD), fields.get(TOKEN)], ["[redacted]", "[redacted]"]);
	// A field with an innocent name that holds a token's shape.
	const shaped = join("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "abcdefghijk");
	assert.ok(!redactRequestBody({ url: "http://app.test/x", contentType: "application/x-www-form-urlencoded", text: form({ note: shaped }) }).text.includes("eyJhbGci"));
	const big = redactRequestBody({ url: "http://app.test/api/upload", contentType: "application/json", text: json({ a: "x".repeat(HAR_BODY_CAP) }) });
	assert.equal(big.text, undefined);
	assert.match(big.comment, /over 64 KB/);
	const multipart = redactRequestBody({ url: "http://app.test/api/upload", contentType: "multipart/form-data; boundary=x", text: "--x\r\nContent-Disposition: form-data; name=f\r\n\r\nvalue\r\n--x--" });
	assert.equal(multipart.text, undefined);
	assert.equal(redactRequestBody({ url: "http://app.test/x", contentType: "application/json", text: "{not json" }).text, undefined);
});

test("a request becomes a HAR 1.2 entry with its timings, status and sizes", () => {
	const b = new HarBuilder();
	request(b, "1", { url: `${ORIGIN}/api/items?q=a`, headers: { Accept: "application/json" }, mime: "application/json", responseHeaders: { "Content-Type": "application/json" } });
	assert.equal(b.wantsResponseBody("1"), true);
	b.setResponseBody("1", '{"items":[1,2]}');
	const har = b.toHar(CREATOR);
	assert.equal(har.log.version, "1.2");
	assert.deepEqual(har.log.creator, CREATOR);
	assert.equal(har.log.entries.length, 1);
	const e = har.log.entries[0];
	assert.equal(e.startedDateTime, new Date(1_700_000_000_000).toISOString());
	assert.equal(e.request.method, "GET");
	assert.equal(e.request.httpVersion, "HTTP/2.0");
	assert.deepEqual(e.request.queryString, [{ name: "q", value: "a" }]);
	assert.equal(e.response.status, 200);
	assert.equal(e.response.content.text, '{"items":[1,2]}');
	assert.equal(e.response.content.size, 500);
	assert.equal(e.response.bodySize, 300);
	assert.equal(e.serverIPAddress, "10.0.0.1");
	assert.equal(e.timings.send, 1);
	assert.equal(e.timings.wait, 10);
	assert.ok(e.time > 0 && e.time < 100, `time ${e.time}`);
	assert.equal(b.count, 1);
});

test("what the file must never hold is absent from every field, however it got there", () => {
	const b = new HarBuilder();
	request(b, "1", {
		url: `${ORIGIN}/api/me?${form({ [TOKEN]: "URLTOKEN9", sort: "asc" })}`,
		headers: { [AUTH_H]: join("Bearer ", SAMPLE_6), [COOKIE_H]: join("session=", SAMPLE_3), [KEY_H]: SAMPLE_8 },
		responseHeaders: { [SET_COOKIE_H]: join("sid=", "SETCOOKIE4; HttpOnly"), "Content-Type": "application/json", Location: `${ORIGIN}/next?${form({ [ACCESS_TOKEN]: SAMPLE_10 })}` },
		status: 302,
		mime: "application/json",
	});
	b.setResponseBody("1", json({ name: "Ada", [ACCESS_TOKEN]: SAMPLE_1, [PASSWORD]: SAMPLE_2 }));
	// A login: the body never even gets read.
	request(b, "2", { url: `${ORIGIN}/login`, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, postData: form({ user: "ada", [PASSWORD]: SAMPLE_4 }), hasPostData: true });
	// A form on a page with a password field, posted to an innocent-looking address.
	request(b, "3", { url: `${ORIGIN}/api/update`, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, postData: form({ f1: SAMPLE_5, f2: "x" }), hasPostData: true, hint: { passwordPage: true } });
	// JSON with a secret name.
	request(b, "4", { url: `${ORIGIN}/api/save`, method: "POST", headers: { "Content-Type": "application/json" }, postData: json({ title: "t", [API_KEY_CAMEL]: SAMPLE_7 }), hasPostData: true });
	const file = JSON.stringify(b.toHar(CREATOR));
	for (const secret of ["URLTOKEN9", SAMPLE_6, SAMPLE_3, SAMPLE_8, "SETCOOKIE4", SAMPLE_10, SAMPLE_1, SAMPLE_2, SAMPLE_4, SAMPLE_5, SAMPLE_7])
		assert.ok(!file.includes(secret), `${secret} is in the HAR`);
	// And the harmless parts are there, so the test is not passing on an empty file.
	for (const kept of ["sort=asc", '\\"title\\":\\"t\\"', '\\"name\\":\\"Ada\\"']) assert.ok(file.includes(kept), `${kept} is missing`);
	const entries = JSON.parse(file).log.entries;
	assert.equal(entries.length, 4);
	assert.match(entries[1].request.postData.comment, /sign-in/);
	assert.match(entries[2].request.postData.comment, /password field/);
});

test("a body is asked for only when it may be stored", () => {
	const b = new HarBuilder();
	// A big body that was not sent inline: asked for. A sign-in or a password page: never.
	const start = (id, url, method, hint) =>
		b.event("Network.requestWillBeSent", { requestId: id, timestamp: 1, wallTime: 1, request: { url, method, headers: {}, ...(method === "POST" ? { hasPostData: true } : {}) } }, hint);
	start("a", `${ORIGIN}/api/x`, "POST");
	start("b", `${ORIGIN}/login`, "POST");
	start("c", `${ORIGIN}/api/y`, "POST", { passwordPage: true });
	start("d", `${ORIGIN}/api/z`, "GET");
	assert.deepEqual(["a", "b", "c", "d"].map((id) => b.wantsRequestBody(id)), [true, false, false, false]);
	b.setRequestBody("a", json({ ok: true }));
	assert.equal(b.wantsRequestBody("a"), false);
});

test("a response body is wanted only for same-origin JSON that the page itself could read", () => {
	const b = new HarBuilder();
	request(b, "json", { url: `${ORIGIN}/api/a`, mime: "application/json" });
	request(b, "html", { url: `${ORIGIN}/page`, mime: "text/html" });
	request(b, "cross", { url: "http://other.test/api/a", mime: "application/json" });
	request(b, "login", { url: `${ORIGIN}/api/login`, mime: "application/json" });
	request(b, "ld", { url: `${ORIGIN}/api/b`, mime: "application/ld+json" });
	assert.deepEqual(["json", "html", "cross", "login", "ld"].map((id) => b.wantsResponseBody(id)), [true, false, false, false, true]);
	b.setResponseBody("json", json({ big: "x".repeat(HAR_BODY_CAP) }));
	const entry = b.toHar(CREATOR).log.entries.find((x) => x.request.url === `${ORIGIN}/api/a`);
	assert.match(entry.response.content.comment, /over 64 KB/);
	assert.equal(entry.response.content.text, undefined);
});

test("a redirect is two entries, the first with its 3xx", () => {
	const b = new HarBuilder();
	b.event("Network.requestWillBeSent", { requestId: "r", timestamp: 1, wallTime: 1, request: { url: `${ORIGIN}/old`, method: "GET", headers: {} } });
	b.event("Network.requestWillBeSent", {
		requestId: "r",
		timestamp: 1.1,
		wallTime: 1.1,
		request: { url: `${ORIGIN}/new`, method: "GET", headers: {} },
		redirectResponse: { status: 301, statusText: "Moved", headers: { Location: `${ORIGIN}/new` }, mimeType: "text/html" },
	});
	b.event("Network.responseReceived", { requestId: "r", response: { status: 200, statusText: "OK", headers: {}, mimeType: "text/html" } });
	b.event("Network.loadingFinished", { requestId: "r", timestamp: 1.2, encodedDataLength: 10 });
	const e = b.toHar(CREATOR).log.entries;
	assert.deepEqual(e.map((x) => [x.request.url, x.response.status]), [[`${ORIGIN}/old`, 301], [`${ORIGIN}/new`, 200]]);
	assert.equal(e[0].response.redirectURL, `${ORIGIN}/new`);
});

test("a failed request is an entry with its error; one still loading is kept unfinished", () => {
	const b = new HarBuilder();
	b.event("Network.requestWillBeSent", { requestId: "f", timestamp: 1, wallTime: 1, request: { url: `${ORIGIN}/down`, method: "GET", headers: {} } });
	b.event("Network.loadingFailed", { requestId: "f", timestamp: 1.5, errorText: "net::ERR_CONNECTION_REFUSED" });
	request(b, "slow", { url: `${ORIGIN}/slow`, finish: false, wall: 1_700_000_001 });
	const e = b.toHar(CREATOR).log.entries;
	assert.equal(e.length, 2);
	assert.equal(e[0].response._error, "net::ERR_CONNECTION_REFUSED");
	assert.equal(e[0].response.status, 0);
	assert.equal(e[1].response.status, 200);
});

test("the size cap stops the capture: later requests are not recorded and the file stays under it", () => {
	const cap = 6000;
	const b = new HarBuilder({ maxBytes: cap });
	const fed = 200;
	for (let i = 0; i < fed; i++) request(b, String(i), { url: `${ORIGIN}/api/item/${i}`, headers: { Accept: "application/json" }, wall: 1_700_000_000 + i });
	assert.equal(b.full, true);
	const har = b.toHar(CREATOR);
	assert.ok(har.log.entries.length > 3 && har.log.entries.length < fed, `${har.log.entries.length} of ${fed}`);
	assert.ok(JSON.stringify(har).length <= cap + 600, `${JSON.stringify(har).length} bytes`);
	assert.ok(b.size <= cap);
	assert.ok(b.dropped > 0);
	const before = b.count;
	request(b, "late", { url: `${ORIGIN}/api/late`, wall: 1_800_000_000 });
	assert.equal(b.count, before, "nothing is added once the cap is reached");
});
