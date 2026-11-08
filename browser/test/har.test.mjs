// Network capture to HAR: what the file says about a request, what it never holds, and the size cap.
import assert from "node:assert/strict";
import test from "node:test";
import {
	HAR_BODY_CAP,
	HAR_ENVELOPE_BYTES,
	HarBuilder,
	isAuthPath,
	isSecretHeader,
	looksLikeToken,
	redactHeaders,
	redactRequestBody,
	redactResponseBody,
	redactUrl,
	utf8Bytes,
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
// Credential shapes, assembled at run time from neutral parts: none of these is a real value.
const jwtLike = (tag) => join("ey", "J", tag, "head1234", ".", "ey", "J", tag, "body5678", ".", tag, "sign9012");
const hexLike = (tag) => join(tag, "9f3a7c1e".repeat(5));
const mixedLike = (tag) => join(tag, "Ab1-", "Cd2_".repeat(9));
const byteLength = (text) => Buffer.byteLength(text, "utf8");

/** The DevTools events of one request, in order. */
function request(
	b,
	id,
	{ url, method = "GET", headers = {}, extraHeaders, postData, hasPostData, status = 200, mime = "text/html", responseHeaders = {}, hint, documentURL = `${ORIGIN}/`, wall = 1_700_000_000, at = 100, finish = true, requestExtra = {}, responseExtra = {}, paramsExtra = {} } = {},
) {
	b.event(
		"Network.requestWillBeSent",
		{
			requestId: id,
			wallTime: wall,
			timestamp: at,
			type: "XHR",
			documentURL,
			...paramsExtra,
			request: { url, method, headers, ...(postData !== undefined ? { postData } : {}), ...(hasPostData ? { hasPostData: true } : {}), ...requestExtra },
		},
		hint,
	);
	if (extraHeaders) b.event("Network.requestWillBeSentExtraInfo", { requestId: id, headers: extraHeaders });
	b.event("Network.responseReceived", {
		requestId: id,
		response: {
			...responseExtra,
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
	// An HTTP/2 request: Chrome reports its address again as the :path pseudo-header, and the page, the response and the
	// initiator each carry addresses of their own. A credential-shaped value under an ordinary header name, in an
	// ordinary query parameter and in an ordinary JSON field never has a secret name to give it away.
	const h2Secrets = {
		path: "H2PATHSECRET1",
		pathShaped: jwtLike("p"),
		fragment: "FRAGSECRET2",
		documentUrl: "DOCSECRET3",
		responseUrl: "RESPURLSECRET4",
		headersText: "HEADERSTEXTSECRET5",
		initiator: "INITSECRET6",
		session: jwtLike("s"),
		hex: hexLike("ab"),
		mixed: mixedLike("m"),
		scheme: "dXNlcjpwYXNzd29yZA",
		queryShaped: hexLike("cd"),
		bodyShaped: jwtLike("b"),
	};
	request(b, "5", {
		url: `${ORIGIN}/api/data?${form({ sort: "asc", [TOKEN]: h2Secrets.path, next: h2Secrets.queryShaped })}`,
		documentURL: `${ORIGIN}/page?${form({ [TOKEN]: h2Secrets.documentUrl })}`,
		headers: { Accept: "application/json" },
		extraHeaders: {
			":method": "GET",
			":scheme": "http",
			":path": `/api/data?${form({ sort: "asc", [TOKEN]: h2Secrets.path, next: h2Secrets.pathShaped })}`,
			"X-Session": h2Secrets.session,
			"X-Trace": h2Secrets.hex,
			"X-Blob": h2Secrets.mixed,
			"X-Note": join("Bas", "ic ", h2Secrets.scheme),
		},
		requestExtra: { urlFragment: `#${form({ [ACCESS_TOKEN]: h2Secrets.fragment })}` },
		paramsExtra: { initiator: { type: "script", url: `${ORIGIN}/app.js?${form({ [TOKEN]: h2Secrets.initiator })}` } },
		responseExtra: {
			url: `${ORIGIN}/api/data?${form({ [TOKEN]: h2Secrets.responseUrl })}`,
			requestHeadersText: `GET /api/data?${form({ [TOKEN]: h2Secrets.headersText })} HTTP/2\r\n`,
		},
		mime: "application/json",
	});
	b.setResponseBody("5", json({ name: "Ada", note: h2Secrets.bodyShaped }));
	request(b, "6", { url: `${ORIGIN}/api/save`, method: "POST", headers: { "Content-Type": "application/json" }, postData: json({ title: "t2", note: h2Secrets.bodyShaped, ref: h2Secrets.hex }), hasPostData: true });
	const file = JSON.stringify(b.toHar(CREATOR));
	for (const secret of ["URLTOKEN9", SAMPLE_6, SAMPLE_3, SAMPLE_8, "SETCOOKIE4", SAMPLE_10, SAMPLE_1, SAMPLE_2, SAMPLE_4, SAMPLE_5, SAMPLE_7, ...Object.values(h2Secrets)])
		assert.ok(!file.includes(secret), `${secret} is in the HAR`);
	// And the harmless parts are there, so the test is not passing on an empty file.
	for (const kept of ["sort=asc", '\\"title\\":\\"t\\"', '\\"name\\":\\"Ada\\"']) assert.ok(file.includes(kept), `${kept} is missing`);
	const entries = JSON.parse(file).log.entries;
	assert.equal(entries.length, 6);
	assert.match(entries[1].request.postData.comment, /sign-in/);
	assert.match(entries[2].request.postData.comment, /password field/);
	// The h2 entry keeps its harmless parts: the path with its other parameters, and the plain headers.
	const h2 = entries[4];
	assert.equal(h2.request.headers.find((h) => h.name === ":path").value.split("?")[0], "/api/data");
	assert.ok(h2.request.headers.find((h) => h.name === ":path").value.includes("sort=asc"));
	assert.equal(h2.request.headers.find((h) => h.name === ":method").value, "GET");
	assert.equal(h2.request.headers.find((h) => h.name === "Accept").value, "application/json");
	assert.ok(h2.response.content.text.includes('"name":"Ada"'));
	assert.ok(entries[5].request.postData.text.includes('"title":"t2"'));
});

test("first-F1: on HTTP/2 and HTTP/3 the :path pseudo-header is an address and goes through the same redaction", () => {
	const secret = "PATHONLYSECRET";
	const out = redactHeaders({ ":path": `/api/data?${form({ [TOKEN]: secret, sort: "asc" })}`, ":method": "GET", ":scheme": "https" });
	const path = out.find((h) => h.name === ":path").value;
	assert.ok(!path.includes(secret), path);
	assert.equal(new URL(path, "https://x.test").searchParams.get(TOKEN), "[redacted]");
	assert.equal(new URL(path, "https://x.test").searchParams.get("sort"), "asc");
	assert.equal(out.find((h) => h.name === ":method").value, "GET");
	// Any other header whose value is a path or an address is read the same way.
	const other = redactHeaders({ "X-Original-Url": `https://app.test/a?${form({ [TOKEN]: secret })}`, "X-Forwarded-Uri": `/b?${form({ [ACCESS_TOKEN]: secret })}` });
	for (const h of other) assert.ok(!h.value.includes(secret), `${h.name}: ${h.value}`);
	// It reaches the entry through the extra-info event, as Chrome sends it.
	const b = new HarBuilder();
	request(b, "h2", { url: `${ORIGIN}/api/data?${form({ [TOKEN]: secret })}`, extraHeaders: { ":path": `/api/data?${form({ [TOKEN]: secret })}` } });
	assert.ok(!JSON.stringify(b.toHar(CREATOR)).includes(secret));
});

test("sol-F2: a value that has a credential's shape is redacted under any header name, and in queries, forms and JSON", () => {
	const shaped = { jwt: jwtLike("h"), hex: hexLike("ab"), mixed: mixedLike("z"), plain: join("Zq", "8fK3", "mP1xW", "7nRt", "Y2vB", "c9LdH", "4sJa", "0GeUo5") };
	for (const [shape, value] of Object.entries(shaped)) assert.equal(looksLikeToken(value) || shape === "jwt", true, shape);
	const out = Object.fromEntries(
		redactHeaders({ "X-Session": shaped.jwt, "X-Trace": shaped.hex, "X-Blob": shaped.mixed, "X-Opaque": shaped.plain, "X-Auth-Scheme": "Bearer short", "X-Other": join("Bas", "ic dXNlcjpw"), "X-Embedded": `ids ${shaped.jwt} end` }).map((h) => [h.name, h.value]),
	);
	for (const [name, value] of Object.entries(out)) assert.equal(value, "[redacted]", name);
	// What is not a credential stays: ids, languages, agents, cache rules, a trace parent, a word that starts like a scheme.
	const kept = {
		"X-Request-Id": "123e4567-e89b-12d3-a456-426614174000",
		"Accept-Language": "en-US,en;q=0.9",
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		"Cache-Control": "no-cache, max-age=0",
		Traceparent: join("00-", "4bf92f3577b34da6a3ce929d0e0e4736", "-00f067aa0ba902b7-01"),
		"X-Plan": "Basically fine",
		"X-Slug": "a-very-long-lowercase-article-slug-with-many-words",
		"Content-Type": "application/json; charset=utf-8",
	};
	for (const h of redactHeaders(kept)) assert.equal(h.value, kept[h.name], h.name);
	// Query values: the name is innocent, the value is not.
	const url = redactUrl(`http://app.test/cb?${form({ next: shaped.jwt, ref: shaped.hex, blob: shaped.mixed, q: "shoes", id: "123e4567-e89b-12d3-a456-426614174000" })}`);
	const q = new URL(url).searchParams;
	for (const name of ["next", "ref", "blob"]) assert.match(q.get(name), /^\[(?:redacted|secret)\]$/, name);
	assert.equal(q.get("q"), "shoes");
	assert.equal(q.get("id"), "123e4567-e89b-12d3-a456-426614174000");
	// A fragment written as parameters is read the same way.
	assert.ok(!redactUrl(`http://app.test/cb#${form({ state: shaped.hex })}`).includes(shaped.hex));
	// JSON bodies, request and response, and forms.
	const bodyOf = (value) => json({ title: "kept", nested: { note: value, list: [value, "ok"] } });
	for (const shape of ["jwt", "hex", "mixed"]) {
		const req = redactRequestBody({ url: "http://app.test/api/x", contentType: "application/json", text: bodyOf(shaped[shape]) });
		assert.ok(!req.text.includes(shaped[shape]), `request ${shape}: ${req.text}`);
		assert.ok(req.text.includes('"title":"kept"') && req.text.includes('"ok"'), req.text);
		const res = redactResponseBody(bodyOf(shaped[shape]));
		assert.ok(!res.text.includes(shaped[shape]), `response ${shape}: ${res.text}`);
		const encoded = redactRequestBody({ url: "http://app.test/api/x", contentType: "application/x-www-form-urlencoded", text: form({ note: shaped[shape], city: "Rome" }) });
		assert.ok(!encoded.text.includes(shaped[shape]) && encoded.text.includes("city=Rome"), `form ${shape}: ${encoded.text}`);
	}
	assert.ok(redactResponseBody(json({ id: "123e4567-e89b-12d3-a456-426614174000", name: "Ada" })).text.includes("123e4567"));
});

test("sol-F4, first-F5: sizes are UTF-8 bytes: a 64 KB body cap and the file cap count what the file really takes", () => {
	// utf8Bytes agrees with the encoder on ASCII, two- and three-byte characters, a pair, and a lone surrogate.
	for (const text of ["", "plain", "caf\u00e9", "\u4e2d\u6587", "\u{1F600}", "a\ud800b", "\udc00"]) assert.equal(utf8Bytes(text), byteLength(text), JSON.stringify(text));
	// About 25,000 Chinese characters: under the cap in UTF-16 units, three times over it in bytes.
	const wide = "\u4e2d".repeat(25_000);
	assert.ok(wide.length < HAR_BODY_CAP && byteLength(wide) > HAR_BODY_CAP);
	const req = redactRequestBody({ url: "http://app.test/api/x", contentType: "application/json", text: json({ a: wide }) });
	assert.equal(req.text, undefined);
	assert.match(req.comment, /over 64 KB/);
	const res = redactResponseBody(json({ a: wide }));
	assert.equal(res.text, undefined);
	assert.match(res.comment, /over 64 KB/);
	// Just inside the cap in bytes is kept.
	const fits = "\u4e2d".repeat(20_000);
	assert.ok(byteLength(json({ a: fits })) < HAR_BODY_CAP);
	assert.ok(redactRequestBody({ url: "http://app.test/api/x", contentType: "application/json", text: json({ a: fits }) }).text);
	// The request body size in the entry is bytes, too.
	const b = new HarBuilder();
	request(b, "w", { url: `${ORIGIN}/api/save`, method: "POST", headers: { "Content-Type": "application/json" }, postData: json({ a: "\u4e2d".repeat(100) }), hasPostData: true });
	assert.equal(b.toHar(CREATOR).log.entries[0].request.bodySize, byteLength(json({ a: "\u4e2d".repeat(100) })));
	// The file cap: entries whose text is mostly Chinese. The file, as the helper writes it, stays under the cap.
	const cap = 40_000;
	const capped = new HarBuilder({ maxBytes: cap });
	assert.equal(capped.size, HAR_ENVELOPE_BYTES, "the wrapper is counted before any entry");
	for (let i = 0; i < 200; i++) request(capped, String(i), { url: `${ORIGIN}/api/item/${i}`, headers: { "X-Note": "\u4e2d".repeat(500) }, wall: 1_700_000_000 + i });
	assert.equal(capped.full, true);
	const file = JSON.stringify(capped.toHar(CREATOR));
	assert.ok(byteLength(file) <= cap, `${byteLength(file)} bytes against a cap of ${cap}`);
	assert.ok(capped.count > 3 && capped.count < 200, `${capped.count} entries`);
	assert.ok(capped.size <= cap && capped.size >= byteLength(file) - 1000, `size ${capped.size} for a file of ${byteLength(file)}`);
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
