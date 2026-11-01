// Private mode lets the side panel agent reach only zero-data-retention OpenRouter routes and
// models on the user's own machines or network. Bug reports are off by default, redact what
// could identify the user or leak a key, and are only ever shared by the user, by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addEntry, NEW_ISSUE_URL, redact, reportText } from "../src/privacy/bug-reports.ts";
import { assertPrivateProxy, hostOf, isLocalBaseUrl, OPENROUTER_PRIVATE_ROUTING, PrivateModeError, privateModel } from "../src/privacy/private-mode.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const openrouter = { provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" };
// Assembled at run time so the file holds no key-shaped literal.
const fakeKey = ["sk", "ant", "api03", "ABCDEFGHIJKLMNOP"].join("-");

test("OpenRouter gets zero-data-retention routing, keeping any provider order", () => {
	const m = privateModel({ ...openrouter, compat: { openRouterRouting: { order: ["anthropic"] } } });
	assert.deepEqual(m.compat.openRouterRouting, { order: ["anthropic"], zdr: true, data_collection: "deny", allow_fallbacks: false });
	assert.deepEqual(OPENROUTER_PRIVATE_ROUTING, { zdr: true, data_collection: "deny", allow_fallbacks: false });
});

test("OpenRouter on an adapter that wouldn't send the routing is refused, and so are impostors", () => {
	for (const api of ["openai-responses", "anthropic-messages", undefined]) {
		assert.throws(() => privateModel({ ...openrouter, api }), PrivateModeError, String(api));
	}
	assert.throws(() => privateModel({ ...openrouter, baseUrl: "https://openrouter.ai.evil.example.com/v1" }), PrivateModeError);
	assert.throws(() => privateModel({ ...openrouter, provider: "custom" }), PrivateModeError);
	assert.throws(() => privateModel({ ...openrouter, baseUrl: "http://openrouter.ai/api/v1" }), PrivateModeError, "plain HTTP");
});

test("hosted providers are refused; local models pass; tailnet hosts only when the user lists them", () => {
	for (const [provider, baseUrl] of [
		["anthropic", "https://api.anthropic.com"],
		["openai", "https://api.openai.com/v1"],
		["custom", "https://my-vps.example.com/v1"],
		["custom", "http://8.8.8.8:11434/v1"],
		["custom", "https://someone.example.ts.net/v1"],
		["custom", "http://100.101.102.103:11434"],
	]) {
		assert.throws(() => privateModel({ provider, baseUrl }), PrivateModeError, `${provider} ${baseUrl}`);
	}
	for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080"]) assert.ok(isLocalBaseUrl(baseUrl), baseUrl);
	// LAN and mDNS hosts count only once listed: at a hotel the same address is someone else's.
	for (const baseUrl of ["http://192.168.1.20:8000", "http://10.0.0.5/v1", "http://172.20.1.1/v1", "http://studio.local:1234"]) {
		assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
	}
	assert.ok(isLocalBaseUrl("http://192.168.1.20:8000", ["192.168.1.20"]));
	assert.ok(isLocalBaseUrl("https://gpu.example.ts.net/v1", ["gpu.example.ts.net"]));
	const m = { provider: "custom", baseUrl: "https://gpu.example.ts.net/v1" };
	assert.equal(privateModel(m, ["gpu.example.ts.net"]), m);
	for (const baseUrl of ["http://172.32.0.1", "http://192.169.0.1", "not a url"]) assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
});

test("the trusted-hosts field accepts names, IPs, URLs and host:port", () => {
	assert.equal(hostOf("https://mac.example.ts.net"), "mac.example.ts.net");
	assert.equal(hostOf("mac.example.ts.net:11434"), "mac.example.ts.net");
	assert.equal(hostOf("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1");
	assert.equal(hostOf("192.168.1.20"), "192.168.1.20");
	assert.equal(hostOf(""), undefined);
});

test("listing openrouter.ai as trusted doesn't skip the ZDR routing", () => {
	const m = privateModel({ ...openrouter }, ["openrouter.ai"]);
	assert.equal(m.compat.openRouterRouting.zdr, true);
});

test("redaction keeps URLs with parentheses whole, and drops IPv6 and base64 secrets", () => {
	const text = redact(
		"Failed https://wiki.example.com/wiki/Jane_Doe_(patient)/records). At [fd7a:115c:a1e0::1234]:8080 and fe80::1, bad credential wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	);
	assert.doesNotMatch(text, /records|Jane_Doe|fd7a|fe80|wJalr|EXAMPLEKEY/, text);
	assert.match(text, /\[url\]\)\./, "sentence punctuation after a URL is kept");
	assert.match(redact("took 12:34:56 to load"), /12:34:56/, "a clock time isn't an IPv6 address");
});

test("a CORS proxy off the user's machines is refused in private mode", () => {
	assert.throws(() => assertPrivateProxy(true, "https://proxy.example.com"), PrivateModeError);
	assert.doesNotThrow(() => assertPrivateProxy(true, "http://localhost:3001"));
	assert.doesNotThrow(() => assertPrivateProxy(false, "https://proxy.example.com"));
});

test("bug reports drop web addresses, emails, keys and home paths, and never travel in a URL", () => {
	const text = redact(
		`Failed https://mail.example.com/inbox/thread/patient-records-jdoe for ada@example.com with ${fakeKey} at /Users/alex/project and C:\\Users\\ada\\x in chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/sidepanel.js:10`,
	);
	assert.doesNotMatch(text, /mail\.example|patient-records|ada@example|ABCDEFGHIJKLMNOP|alex|\\ada\\|kenehmggpggpiolepbjojeenmeapgfoc/);
	assert.match(text, /\[url\]/);
	assert.match(text, /ext:\/sidepanel\.js/);
	assert.match(
		redact("at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/assets/chunk-4f2a.js:3:9"),
		/ext:\/chunk-4f2a\.js:3:9/,
		"a stack line keeps its file name when the path has digits",
	);
	assert.match(
		redact("at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/assets/components/ThreadListView.js:3:9"),
		/ext:\/ThreadListView\.js:3:9/,
		"a long path keeps its file name",
	);
	assert.match(redact("at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/pages/home/view.js:3:9"), /ext:\/view\.js:3:9/);
	const tokenAfterQuery = ["a1b2c3d4", "e5f6g7h8i9"].join("");
	const leaked = redact(`at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/api.js?auth=Bearer ${tokenAfterQuery}`);
	assert.doesNotMatch(leaked, new RegExp(tokenAfterQuery), "the query is read by the secret rules before it is dropped");
	assert.doesNotMatch(leaked, /auth=/);
	assert.match(redact("a \u00000\u0000 b"), /^a 0 b$/, "a planted marker can't pull in a path");
	// Directories never survive: a path can carry a key (with "/" in it) or an address.
	for (const dir of [["Zx9", "Qw8".repeat(10)].join(""), ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join("/"), "0123456789abcdef".repeat(2) + "01234567", "a/203.0.113.9"]) {
		const out = redact(`at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/${dir}/a.js:3:9`);
		assert.equal(out, "at ext:/a.js:3:9", dir);
	}
	assert.equal(redact(`chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/${"0123456789abcdef".repeat(2)}01234567.js`), "ext:/[file]", "a long file name is dropped");
	// Anything that isn't plainly a build file name loses its path.
	for (const [input, out] of [
		["203.0.113.9", "x ext:/[file]"],
		["Users/alex", "x ext:/[file]"],
		["home/ada", "x ext:/[file]"],
		[['Zq8xW3mN7pL2vR', '9tY4kB6cH1dF5g', 'J0s+Ab3Cd4Ef5Gh6'].join(""), "x ext:/[file]"],
		["a.js@example.com", "x ext:/[file]"],
		[`${["Zx9", "Qw8".repeat(10)].join("")}.js:3:9`, "x ext:/[file]"],
		[`${["ghp", "_", "a1".repeat(18)].join("")}.js`, "x ext:/[file]"],
		["a.js:3?q=patient-records-jdoe", "x ext:/a.js:3"],
		["a.js#frag-jdoe", "x ext:/a.js"],
	]) {
		assert.equal(redact(`x chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/${input}`), out, input);
	}
	// A short key that fits the file-name shape still goes through the secret rules.
	for (const key of [["AKIA", "IOSFODNN7EXAMPLE"].join(""), ["sk", "-ant-", "abc123def4"].join("")]) {
		assert.equal(redact(`at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/assets/${key}.js:3:9`), "at ext:/[secret].js:3:9", key);
	}
	const more = redact(
		"chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/sidepanel.html?session=abc&q=jdoe data:image/png;base64,iVBORw0K/a+b blob:https://x.example/1 at 203.0.113.9:8080",
	);
	assert.doesNotMatch(more, /jdoe|session=|iVBOR|x\.example|203\.0\.113/);
	const log = Array.from({ length: 30 }, (_, i) => i).reduce((l, i) => addEntry(l, new Error(`e${i}`)), []);
	assert.equal(log.length, 20, "the log is a short ring buffer");
	assert.match(reportText("1.2.3", log, "Mozilla/5.0"), /e29/);
	assert.equal(new URL(NEW_ISSUE_URL).search, "?labels=bug-report", "the issue page URL carries no report text");
});

test("bug reports are off by default; turning them off clears the log through the same queue as captures", () => {
	const capture = readFileSync(join(repo, "src", "privacy", "capture.ts"), "utf8");
	assert.match(capture, /!== true\) return/, "capture records only when the setting is exactly true");
	assert.match(capture, /if \(!on\) await storage\.settings\.set\(BUG_LOG_KEY, \[\]\);/);
	assert.match(capture, /export function setBugReports[\s\S]*?return serial\(/, "opt-out runs in the capture queue");
	for (const file of ["src/privacy/capture.ts", "src/privacy/bug-reports.ts", "src/dialogs/PrivacyTab.ts"]) {
		assert.doesNotMatch(readFileSync(join(repo, file), "utf8"), /\bfetch\(|sendBeacon|XMLHttpRequest/, `${file} sends data`);
	}
	const welcome = readFileSync(join(repo, "src", "dialogs", "WelcomeSetupDialog.ts"), "utf8");
	const input = welcome.slice(welcome.indexOf("<input"), welcome.indexOf("/>", welcome.indexOf("<input")));
	assert.ok(input.includes('type="checkbox"'), "found the welcome checkbox");
	// A checked attribute or a .checked binding (reading e.target.checked in the handler is fine).
	assert.doesNotMatch(input, /(^|\s)[.?]?checked(\s*=|\s*$|\s)/m, "the welcome checkbox has no checked attribute or binding");
	assert.match(welcome, /setBugReports\(getTabkyraStorage\(\)/, "the welcome box goes through the shared queue");
	assert.match(welcome, /this\.reportsOn\s*\?/, "when reports are already on, the welcome dialog says so instead of an unchecked box");
});

test("the stream gate applies private mode, the trusted hosts and the proxy check to every side panel request", () => {
	const sidepanel = readFileSync(join(repo, "src", "sidepanel.ts"), "utf8");
	assert.match(sidepanel, /assertPrivateProxy\(/);
	assert.match(sidepanel, /model = privateModel\(model, trusted\);/);
	// Every way into Settings (header button, first run, no key) goes through one page that has the Privacy tab.
	assert.equal((sidepanel.match(/SettingsPage\.open\(/g) ?? []).length, 1, "one settings entry point");
	assert.equal((sidepanel.match(/new PrivacyTab\(\)/g) ?? []).length, 1, "the settings page shows the Privacy tab");
});

test("what read_network shows of bodies: request shapes without values, JSON responses masked in place", async () => {
	const { maskJsonResponse, bodyShape, isSecretName, holdsCredential, maskUrl } = await import("../src/browser/mask-body.ts");
	// Names: the review's short forms and card and code fields are credentials; data names aren't.
	for (const name of ["password1", "pass1", "user_pw", "loginPwd", "newPwd", "pwd1", "userpass", "confirm_pass", "cardPin", "pw", "key", "session", "secretKey", "signing_key", "code_verifier", "x-csrf-token", "client_secret", "mfa_code", "verification_code", "sms_code", "cvv", "card_number", "bypassToken", "passport_client_secret", "otp", "mfa_otp"])
		assert.ok(isSecretName(name), name);
	for (const name of ["max_tokens", "tokenCount", "total_tokens", "author", "footprint", "spotPrice", "hotplug", "depotId", "passenger_count", "passport_country", "code", "sku", "keyboard_layout", "id"])
		assert.equal(isSecretName(name), false, name);
	// Requests: the shape only.
	const login = JSON.stringify({ email: "ada@x.co", password: "hunter2", remember: true, tags: ["a", "b"] });
	const shape = bodyShape(login, "application/json");
	assert.doesNotMatch(shape, /hunter2|ada@x\.co/);
	assert.deepEqual(JSON.parse(shape), { email: "<string, 8 chars>", password: "<string, 7 chars>", remember: "<boolean>", tags: ["<string, 1 chars>", "(2 items)"] });
	assert.equal(bodyShape("user%5Bpassword%5D=hunter2&next=%2F", "application/x-www-form-urlencoded"), "form fields: user[password], next");
	assert.doesNotMatch(bodyShape('--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nhun\r\n--ter2\r\n--b--', "multipart/form-data; boundary=b"), /hun|ter2/);
	assert.doesNotMatch(bodyShape('{viewer(token:"opaque-token-6161"){id}}', "application/graphql"), /opaque/);
	// Responses: complete JSON only, edited in place.
	assert.equal(maskJsonResponse('{"id":1153826337396867073,"id":2,"__proto__":{"x":1}}'), '{"id":1153826337396867073,"id":2,"__proto__":{"x":1}}');
	assert.equal(maskJsonResponse('{"amount":12.50,"secretKey":{"a":[1,2]},"key":"9944b091","user_pw":"x","tokens":["t1"]}'), '{"amount":12.50,"secretKey":"[secret]","key":"[secret]","user_pw":"[secret]","tokens":"[secret]"}');
	let deep = '"password":"opaque-password-6161"';
	for (let i = 0; i < 45; i++) deep = `"k${i}":{${deep}}`;
	assert.doesNotMatch(maskJsonResponse(`{${deep}}`), /opaque-password-6161/);
	const strings = JSON.parse(
		maskJsonResponse(
			JSON.stringify({
				query: 'mutation{login(input:{password:"hunter2"}){id}}',
				anon: '{viewer(token:"opaque-token-6161"){id}}',
				link: "https://x.example/cb?access_token=abc&next=/",
				log: "[INFO] login password=hunter2",
				long: `password=${"x".repeat(5000)}`,
				auth: "Bearer abc123def456ghi789jkl0",
				plan: "Basic Subscription",
				note: "Price: 4242, see the docs",
			}),
		),
	);
	for (const k of ["query", "anon", "link", "log", "long", "auth"]) assert.equal(strings[k], "[secret]", k);
	assert.equal(strings.plan, "Basic Subscription");
	assert.equal(strings.note, "Price: 4242, see the docs");
	assert.equal(maskJsonResponse('{"ok":true,"tokens":["t-1","t-'), undefined, "a cut-off body isn't shown");
	assert.equal(maskJsonResponse("<html>csrf</html>"), undefined, "HTML isn't shown");
	assert.equal(holdsCredential("footprint: 3 kg"), false);
	assert.equal(maskUrl("https://u:p" + "@" + "x.example/a?access_token=abc&page=2"), "https://x.example/a?access_token=%5Bsecret%5D&page=2");
	const t0 = performance.now();
	holdsCredential("a-".repeat(500000));
	maskJsonResponse(JSON.stringify({ blob: "a-".repeat(500000) }));
	assert.ok(performance.now() - t0 < 500, "linear on a 1 MB body");
});

test("review 4 (#73): request bodies guess no layout, schemes in any case, URLs masked wherever they appear", async () => {
	const { maskJsonResponse, bodyShape, isSecretName, holdsCredential, maskUrl } = await import("../src/browser/mask-body.ts");
	// A body whose content type promises no fields shows no names: base64, GraphQL, a cut-off JSON body.
	for (const [body, type] of [
		["YWRhOmh1bnRlcjI=", "text/plain;charset=UTF-8"],
		['mutation{login(input:{password:"hunter2",note:"a=b"}){id}}', "application/graphql"],
		['{"password":"hunter2","avatar":"iVBOR', "application/json"],
		["password=hunter2", ""],
	])
		assert.doesNotMatch(bodyShape(body, type), /hunter2|YWRh/, body);
	// Multipart names come from each part's header, never from a value that looks like one.
	const multipart = '--b\r\nContent-Disposition: form-data; name="note"\r\n\r\nContent-Disposition: form-data; name="hunter2-private"\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nx\r\n--b--';
	assert.equal(bodyShape(multipart, "multipart/form-data; boundary=b"), "multipart fields: note, file");
	// Schemes in any case, with or without a digit; one-time codes; signed URLs; tokens used as keys.
	for (const text of ["Bearer abcdefghijklmnopqrstuvwxyz", "bearer abc123def456ghi789jkl0"]) assert.ok(holdsCredential(text), text);
	for (const name of ["one_time_code", "pin_code", "X-Amz-Signature", "X-Goog-Signature", "cachedToken"]) assert.ok(isSecretName(name), name);
	assert.equal(isSecretName("cached_tokens"), false);
	const keyed = maskJsonResponse('{"sessions":{"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.c2lnbmF0dXJlMTIz":{"device":"x"}}}');
	assert.doesNotMatch(keyed, /eyJhbGci/);
	assert.deepEqual(JSON.parse(keyed), { sessions: { "[secret]": { device: "x" } } });
	// URLs: fragments, OAuth codes, presigned signatures and relative addresses.
	assert.equal(maskUrl("https://app.example/cb#access_token=abc&state=1"), "https://app.example/cb#access_token=%5Bsecret%5D&state=1");
	assert.equal(maskUrl("https://app.example/cb?code=4/0Aabc&state=1"), "https://app.example/cb?code=%5Bsecret%5D&state=1");
	assert.doesNotMatch(maskUrl("https://b.s3.amazonaws.com/k?X-Amz-Signature=deadbeef&X-Amz-Expires=60"), /deadbeef/);
	assert.equal(maskUrl("/password/reset?token=abc123"), "/password/reset?token=%5Bsecret%5D");
	assert.equal(maskUrl("/plain/path?page=2"), "/plain/path?page=2");
	// Linear on a run of JWT prefixes, the worst case for an unanchored token regex.
	const t0 = performance.now();
	holdsCredential("eyJ-".repeat(250000));
	maskJsonResponse(JSON.stringify({ blob: "eyJ-".repeat(250000) }));
	assert.ok(performance.now() - t0 < 500, "linear on 1 MB of eyJ-");
});

test("read_network masks the page address of each request; read_page and inspect_page mask frame and form addresses", () => {
	const cdp = readFileSync(new URL("../src/browser/cdp.ts", import.meta.url), "utf8");
	assert.match(cdp, /documentURL: entry\.documentURL && maskUrl\(entry\.documentURL\)/);
	assert.doesNotMatch(cdp, /\{ \.\.\.e(ntry)?, url: maskUrl/, "every serialized entry goes through maskedUrls");
	assert.doesNotMatch(cdp, /responseBody = cap\(/, "a cut fragment is never sent as the response body");
	const page = readFileSync(new URL("../src/browser/page.ts", import.meta.url), "utf8");
	assert.match(page, /f\.action = maskUrl\(f\.action\)/);
	assert.match(page, /f\.src = maskUrl\(f\.src\)/);
	assert.match(page, /snap\.url = maskUrl\(snap\.url\)/);
	assert.match(page, /split\(\/\[\?#\]\/\)\[0\]/, "frame labels drop the query and fragment");
});

test("a response the page itself couldn't read stays unread: same origin only", async () => {
	const { pageCouldRead } = await import("../src/browser/cdp.ts");
	const page = "https://shop.example/cart";
	assert.equal(pageCouldRead({ url: "https://shop.example/api/cart", documentURL: page }, page), true);
	assert.equal(pageCouldRead({ url: "https://api.other.example/x", documentURL: page }, page), false, "CORS isn't enough: no-cors credentialed reads stay opaque");
	assert.equal(pageCouldRead({ url: "https://bank.example/me" }, page), false);
	assert.equal(pageCouldRead({ url: "https://shop.example/x", documentURL: "https://ads.example/frame" }, page), false, "asked for by another origin's frame");
});

test("inspect_page reports storage and cookie names, never their values", () => {
	const page = readFileSync(new URL("../src/browser/page.ts", import.meta.url), "utf8");
	const inspect = page.slice(page.indexOf("function pageInspect()"), page.indexOf("export async function inspectPage("));
	assert.ok(inspect.length > 100);
	assert.doesNotMatch(inspect, /getItem|\.value\b|split\("="\)\[1\]/, "no storage values, field values or cookie values");
});
