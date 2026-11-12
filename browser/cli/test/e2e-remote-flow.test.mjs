// "Use Polycarp from Claude, ChatGPT and Grok" in a real Chromium, at the panel's narrowest width (320 px), light and dark.
// A stand-in plays the helper behind the Connect relay, one scenario per page, so each screen is drawn from the same JSON
// the helper sends: choose a way, sign in (which moves on by itself), Turn on, Funnel not allowed (retried by itself), the
// result with its code and checks, Repair only when `remote fix` exists, Tailnet Lock, and the Cloudflare form.
//
// Needs the extension built into dist-chrome without a version bump, as e2e-panel.test.mjs does:
//   TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=$PWD/dist-chrome npm run build   (repo root)
// Set TABKYRA_SHOTS_DIR to keep a screenshot of every screen.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..", "dist-chrome");
const PANEL = "chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/sidepanel.html";
const SHOTS = process.env.TABKYRA_SHOTS_DIR;
const CODE = "TK-7QF3-K2MD";

let profile;
let context;

before(async () => {
	assert.ok(existsSync(join(extensionDir, "sidepanel.html")), `build the extension into ${extensionDir} first (see the top of this file)`);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
	profile = mkdtempSync(join(tmpdir(), "tabkyra-e2e-remote-"));
	context = await chromium.launchPersistentContext(profile, {
		channel: "chromium",
		headless: true,
		viewport: { width: 320, height: 900 },
		args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--use-mock-keychain", "--password-store=basic", "--remote-debugging-port=0"],
	});
	await context.route(/^https?:\/\//, (r) => r.abort());
	// The helper, played from the page. The scenario is read when a request arrives, so a page's own init script sets it.
	await context.addInitScript(
		({ CODE }) => {
			if (!globalThis.chrome?.runtime?.connect) return;
			const original = chrome.runtime.connect.bind(chrome.runtime);
			const theme = { preset: "tabkyra" };
			const routes = { tailscale: { installed: true, signedIn: false }, cloudflare: { installed: false, signedIn: false } };
			const publicUrl = "https://laptop.tail1a2b.ts.net:8443";
			const okChecks = ["dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming"].map((name) => ({ name, status: "ok", detail: "fine" }));
			const dnsPending = [{ name: "dns", status: "fail", detail: "laptop.tail1a2b.ts.net has no public address yet.", pending: true }];
			const st = { route: "none", stateCalls: 0, funnelCalls: 0, testCalls: 0, calls: [] };
			globalThis.__helper = st;
			const scenario = () => globalThis.__scenario ?? "choose";
			const answer = (method) => {
				const sc = scenario();
				st.calls.push(method);
				switch (method) {
					case "status":
						if (sc === "repair" || sc === "norepair") st.route = "funnel";
						return st.route === "funnel" ? { route: "remote", remoteKind: "funnel", publicUrl, passcodeSet: false, theme } : { route: "none", passcodeSet: false, theme, joinScopes: [] };
					case "remoteState":
						st.stateCalls++;
						if (sc === "tailnet") return { state: "tailnet_lock", message: "Tailnet Lock is on.", routes: { ...routes, tailscale: { installed: true, signedIn: true } } };
						if (sc === "repair" || sc === "norepair") return { state: "on", message: "Connector ready.", route: "funnel", connectorUrl: `${publicUrl}/mcp` };
						if (sc === "advance" && st.stateCalls > 2) return { state: "ready", message: "Tailscale is ready.", routes: { ...routes, tailscale: { installed: true, signedIn: true } } };
						if (sc === "funnel") return st.route === "funnel" ? { state: "funnel_closed", message: "Funnel is closed.", route: "funnel" } : { state: "ready", message: "Tailscale is ready.", routes: { ...routes, tailscale: { installed: true, signedIn: true } } };
						if (sc === "dns") return st.route === "funnel" ? { state: "on", message: "Remote access is on.", route: "funnel", connectorUrl: `${publicUrl}/mcp` } : { state: "ready", message: "Tailscale is ready.", routes: { ...routes, tailscale: { installed: true, signedIn: true } } };
						return { state: "tailscale_signed_out", message: "Tailscale is installed but signed out.", next: { kind: "sign_in", command: "tailscale up" }, routes };
					case "remoteSetup":
						st.route = "funnel";
						// A first Turn on with a brand-new name: on, public DNS not there yet, and the press's code.
						if (sc === "dns") return { state: "on", message: "Connector ready.", route: "funnel", connectorUrl: `${publicUrl}/mcp`, checks: dnsPending, connectCode: CODE, connectCodeExpiresAt: Date.now() + 10 * 60_000 };
						return { state: "funnel_not_allowed", message: "Funnel isn't enabled for this tailnet yet.", route: "funnel", connectorUrl: `${publicUrl}/mcp`, next: { kind: "open_page", url: "https://login.tailscale.com/f/funnel?node=nX7" } };
					case "remoteFunnel":
						st.funnelCalls++;
						if (st.funnelCalls < 2) return { state: "funnel_not_allowed", message: "Funnel isn't enabled for this tailnet yet.", route: "funnel", connectorUrl: `${publicUrl}/mcp`, next: { kind: "open_page", url: "https://login.tailscale.com/f/funnel?node=nX7" } };
						// The retry carries no gesture, so it never brings a code (second-N2).
						return { state: "on", message: "Connector ready.", route: "funnel", connectorUrl: `${publicUrl}/mcp`, checks: okChecks };
					case "remoteTest":
						st.testCalls++;
						if (sc === "dns" && st.testCalls < 2) return { state: "problem", code: "dns", message: "dns: no address yet", route: "funnel", connectorUrl: `${publicUrl}/mcp`, checks: dnsPending };
						if (sc === "repair" || sc === "norepair") {
							const checks = okChecks.map((c) => (c.name === "tls" ? { ...c, status: "fail", detail: "The certificate for laptop.tail1a2b.ts.net expired." } : c));
							return { state: "problem", code: "tls", message: "tls: certificate expired", route: "funnel", connectorUrl: `${publicUrl}/mcp`, checks };
						}
						return { state: "on", message: "Reachable.", route: "funnel", connectorUrl: `${publicUrl}/mcp`, checks: okChecks };
					case "remoteFixPlan":
						if (sc === "repair" || sc === "dns") return { available: true, ok: true, state: "problem", code: "fix_pending", message: "Would renew the certificate.", actions: [{ kind: "serve", what: "Restart Tailscale serve", status: "planned" }] };
						throw { code: "bad_params", message: 'Unknown method "remoteFixPlan".' };
					case "approvalCode":
						return { code: "TK-9PQM-4RTX", expiresAt: Date.now() + 10 * 60_000, connectorUrl: `${publicUrl}/mcp` };
					default:
						throw { code: "bad_params", message: "not stubbed" };
				}
			};
			chrome.runtime.connect = (info) => {
				if (info?.name !== "tabkyra-connect") return original(info);
				const listeners = [];
				return {
					name: info.name,
					onMessage: { addListener: (l) => listeners.push(l) },
					onDisconnect: { addListener: () => {} },
					disconnect() {},
					postMessage(req) {
						setTimeout(() => {
							const reply = (r) => listeners.forEach((l) => l({ id: req.id, ...r }));
							try {
								reply({ result: answer(req.method) });
							} catch (error) {
								reply({ error });
							}
						}, 30);
					},
				};
			};
		},
		{ CODE },
	);
});

after(async () => {
	await context?.close();
	try {
		if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* Chromium helpers may still be writing to the profile */
	}
});

/** Settings > Agents in `theme`, at 320 px, with the helper playing `scenario`. */
async function connect(scenario, theme) {
	const page = await context.newPage();
	await page.addInitScript((s) => {
		globalThis.__scenario = s;
	}, scenario);
	page.errors = [];
	page.on("pageerror", (e) => page.errors.push(e.message));
	await page.setViewportSize({ width: 320, height: 1700 });
	await page.goto(PANEL);
	await page.evaluate((t) => localStorage.setItem("theme", t), theme);
	await page.evaluate(() => chrome.storage.local.set({ "tk-welcome-seen": true }));
	await page.reload();
	await page.getByPlaceholder(/Ask about this page/).waitFor({ timeout: 20_000 });
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	await page.locator("[data-remote-flow]").waitFor({ timeout: 10_000 });
	return page;
}

async function shot(page, name) {
	const flow = page.locator("[data-remote-flow]");
	await flow.scrollIntoViewIfNeeded();
	if (SHOTS) await flow.screenshot({ path: join(SHOTS, `${name}.png`) });
	// Nothing in the flow runs past the panel or makes it scroll sideways.
	const fit = await page.evaluate(() => {
		const el = document.querySelector("[data-remote-flow]");
		const over = [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 0.5).map((n) => n.outerHTML.slice(0, 80));
		return { over, sideways: document.documentElement.scrollWidth > window.innerWidth };
	});
	assert.deepEqual(fit.over, [], `${name}: runs past the panel`);
	assert.equal(fit.sideways, false, `${name}: the page scrolls sideways`);
	assert.deepEqual(page.errors, [], `${name}: the page threw`);
}

for (const theme of ["light", "dark"]) {
	test(`choose a way, then signing in moves on to Turn on by itself (${theme})`, async () => {
		const page = await connect("advance", theme);
		try {
			const tailscale = page.locator('[data-route="tailscale"]');
			// The cards draw at once; the helper's answer fills in the badge and the status line in place.
			await page.locator('[data-route="tailscale"]', { hasText: "Recommended" }).waitFor();
			assert.match(await tailscale.textContent(), /Recommended/);
			assert.match(await page.locator('[data-route="cloudflare"]').textContent(), /domain on your Cloudflare account/);
			await shot(page, `01-choose-${theme}`);
			await tailscale.click();
			await page.locator('[data-remote-step="tailscale_signed_out"]').waitFor();
			assert.match(await page.locator("[data-flow-step]").textContent(), /Step 2 of 3/);
			assert.match(await page.locator('[data-copy="command"] code').textContent(), /^tailscale up$/);
			await shot(page, `02-sign-in-${theme}`);
			// No press: the next poll finds Tailscale signed in.
			await page.locator('[data-remote-step="ready"]').waitFor({ timeout: 12_000 });
			assert.match(await page.locator("[data-flow-step]").textContent(), /Step 3 of 3/);
			await shot(page, `03-ready-${theme}`);
		} finally {
			await page.close();
		}
	});

	test(`Turn on, Funnel not allowed, then the result arrives with no press (${theme})`, async () => {
		const page = await connect("funnel", theme);
		try {
			await page.locator('[data-route="tailscale"]').click();
			await page.locator('[data-remote-step="ready"]').waitFor();
			await page.getByRole("button", { name: "Turn on", exact: true }).click();
			await page.locator('[data-remote-step="funnel_not_allowed"]').waitFor({ timeout: 10_000 });
			assert.match(await page.locator("[data-remote-wait]").textContent(), /checks by itself/);
			await shot(page, `04-allow-funnel-${theme}`);
			// The panel opens Funnel again by itself every five seconds; the stand-in allows it on the second try.
			await page.locator("[data-remote-result]").waitFor({ timeout: 20_000 });
			const helper = await page.evaluate(() => globalThis.__helper.calls);
			assert.ok(helper.filter((m) => m === "remoteFunnel").length >= 2, helper.join(","));
			// The retry made no code: the result asks for a press, and New code is the main button.
			assert.equal(await page.locator("[data-connect-code]").textContent(), "----");
			assert.match(await page.locator("[data-code-note]").textContent(), /Press New code/);
			assert.ok(!helper.includes("approvalCode"), "a code was asked for without a press");
			await shot(page, `05-result-no-code-${theme}`);
			await page.getByRole("button", { name: "New code", exact: true }).click();
			await page.locator("[data-connect-code]", { hasText: "TK-9PQM-4RTX" }).waitFor();
			assert.match(await page.locator('[role="timer"]').textContent(), /Expires in (9:5\d|10:00)/);
			assert.deepEqual(await page.locator("[data-assistant]").evaluateAll((els) => els.map((e) => e.dataset.assistant)), ["claude", "chatgpt", "grok"]);
			assert.match(await page.locator('[data-copy="address"] code').textContent(), /^https:\/\/laptop\.tail1a2b\.ts\.net:8443\/mcp$/);
			assert.match(await page.locator("[data-no-passcode]").textContent(), /No passcode was made here/);
			assert.match(await page.locator("[data-checks] summary").textContent(), /Every check passed/);
			assert.equal(await page.getByRole("button", { name: "Repair" }).count(), 0);
			await shot(page, `05-result-${theme}`);
			// The countdown ticks, and nothing else moves while the panel keeps polling.
			const where = () => page.evaluate(() => ["[data-copy=address]", "[data-checks]", "[data-no-passcode]"].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)));
			const first = await where();
			await page.waitForTimeout(4000);
			assert.deepEqual(await where(), first, "the result moved while it polled");
			// The code reached no storage.
			const stored = await page.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session?.get(null), { ...localStorage }, { ...sessionStorage }]));
			assert.ok(!stored.includes("TK-9PQM-4RTX"), "the connect code was stored");
		} finally {
			await page.close();
		}
	});

	test(`a brand-new name: on at once with the code, waiting for DNS with no Repair, then clear by itself (${theme})`, async () => {
		const page = await connect("dns", theme);
		try {
			await page.locator('[data-route="tailscale"]').click();
			await page.locator('[data-remote-step="ready"]').waitFor();
			await page.getByRole("button", { name: "Turn on", exact: true }).click();
			await page.locator("[data-remote-result]").waitFor({ timeout: 10_000 });
			assert.match(await page.locator("[data-result-title]").textContent(), /still being published/);
			assert.match(await page.locator("[data-remote-result] [data-remote-wait]").textContent(), /checks again by itself/);
			assert.equal(await page.locator("[data-connect-code]").textContent(), CODE);
			assert.equal(await page.locator('[data-check="dns"]').getAttribute("data-status"), "waiting");
			assert.match(await page.locator('[data-check="dns"]').textContent(), /Waiting/);
			assert.equal(await page.getByRole("button", { name: "Repair" }).count(), 0, "Repair showed for a pending check");
			const asked = await page.evaluate(() => globalThis.__helper.calls);
			assert.ok(!asked.includes("remoteFixPlan"), "a pending check asked what Repair would do");
			await shot(page, `09-dns-waiting-${theme}`);
			// The first test still waits; the panel tests again 30 seconds on by itself, the name answers, and the line clears.
			await page.locator("[data-checks] summary", { hasText: "Every check passed" }).waitFor({ timeout: 45_000 });
			assert.match(await page.locator("[data-result-title]").textContent(), /On: add Polycarp to an assistant/);
			assert.equal(await page.locator("[data-remote-result] [data-remote-wait]").count(), 0);
			assert.equal(await page.locator("[data-connect-code]").textContent(), CODE);
			await shot(page, `10-dns-cleared-${theme}`);
			const tests = (await page.evaluate(() => globalThis.__helper.calls)).filter((m) => m === "remoteTest").length;
			assert.ok(tests >= 2, `checked from outside ${tests} time(s); the still-pending answer should have been followed by another`);
		} finally {
			await page.close();
		}
	});

	test(`a failed outside check shows Repair only when this helper has remote fix (${theme})`, async () => {
		const page = await connect("repair", theme);
		try {
			await page.locator("[data-remote-result]").waitFor();
			await page.getByRole("button", { name: "Repair", exact: true }).waitFor({ timeout: 10_000 });
			assert.match(await page.locator("[data-checks] summary").textContent(), /1 check failed/);
			assert.match(await page.locator("[data-result-title]").textContent(), /a check from the internet failed/);
			assert.equal(await page.locator('[data-check="tls"]').getAttribute("data-status"), "fail");
			await shot(page, `06-check-failed-repair-${theme}`);
		} finally {
			await page.close();
		}
		const without = await connect("norepair", theme);
		try {
			await without.locator('[data-check="tls"][data-status="fail"]').waitFor({ timeout: 10_000 });
			await without.waitForTimeout(500);
			assert.equal(await without.getByRole("button", { name: "Repair" }).count(), 0, "Repair showed with no remote fix");
		} finally {
			await without.close();
		}
	});

	test(`Tailnet Lock says why and offers Cloudflare, whose form takes the address (${theme})`, async () => {
		const page = await connect("tailnet", theme);
		try {
			await page.locator('[data-route="tailscale"]').click();
			await page.locator('[data-remote-step="tailnet_lock"]').waitFor();
			assert.match(await page.locator('[data-remote-step="tailnet_lock"]').textContent(), /Tailnet Lock turned on, and Funnel doesn't work with it/);
			await shot(page, `07-tailnet-lock-${theme}`);
			await page.getByRole("button", { name: "Use Cloudflare", exact: true }).click();
			await page.locator("[data-tunnel-form]").waitFor();
			await page.getByPlaceholder("polycarp.yourdomain.com").fill("polycarp.example.com");
			await shot(page, `08-cloudflare-${theme}`);
		} finally {
			await page.close();
		}
	});
}
