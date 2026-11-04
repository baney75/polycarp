// Fails if a removed subscription sign-in, or any identifier that poses as another app,
// comes back. docs/auth-policy.md has the provider terms behind each entry.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const b64 = (s) => Buffer.from(s).toString("base64");

/** [what it is, the text that must not appear] */
const FORBIDDEN = [
	["Codex CLI OAuth client id", "app_EMoamEEZ73f0CkXaXp7hrann"],
	["VS Code Copilot Chat OAuth client id", "Iv1.b507a08c87ecfe98"],
	["Gemini CLI OAuth client id", "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j"],
	["Gemini CLI OAuth client secret", "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"],
	["Claude Code OAuth client id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"],
	["Codex originator parameter", "originator"],
	["Codex CLI sign-in flag", "codex_cli_simplified_flow"],
	["Copilot Chat user agent", "GitHubCopilotChat"],
	["Copilot editor header", "Editor-Version"],
	["Copilot editor plugin header", "Editor-Plugin-Version"],
	["Copilot integration header", "Copilot-Integration-Id"],
	["Copilot integration id", "vscode-chat"],
	["Copilot internal token endpoint", "copilot_internal"],
	["Gemini Code Assist endpoint", "cloudcode-pa.googleapis.com"],
	["Gemini CLI user agent", "google-api-nodejs-client"],
	// The Google GenAI SDK sends its own x-goog-api-client legitimately; the spoof was this value.
	["Gemini CLI client header value", "gl-node/22.17.0"],
	["ChatGPT subscription backend", "chatgpt.com/backend-api"],
	// Codex CLI's OAuth endpoints. Sign in with ChatGPT uses auth.openai.com/api/accounts/... with
	// Tabkyra's own registration; the allowlist test below pins every auth.openai.com URL to those.
	["Codex CLI OAuth endpoints", "auth.openai.com/oauth/"],
	["Claude OAuth host", "claude.ai/oauth"],
	["Claude console OAuth", "platform.claude.com/v1/oauth"],
	["Anthropic console OAuth", "console.anthropic.com/v1/oauth"],
	["Claude Code beta flag", "claude-code-20250219"],
	["Claude Code user agent", "claude-cli/"],
	["Codex user agent", "codex_cli_rs"],
	["Claude Code system prompt", "You are Claude Code"],
];

// Base64 hides an id from a plain grep; the old code did exactly that. Plain needles match
// case-insensitively (HTTP header names are); base64 is case-sensitive by nature.
const NEEDLES = FORBIDDEN.flatMap(([what, text]) => [
	[what, text.toLowerCase(), true],
	[`${what} (base64)`, b64(text), false],
]);

function scan(text) {
	const lower = text.toLowerCase();
	return NEEDLES.filter(([, needle, folded]) => (folded ? lower : text).includes(needle));
}

const ROOTS = ["src", "static", "cli/src", "cli/scripts", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "bench", "probe"]);
const TEXT = /\.(ts|js|mjs|json|html|css)$/;

function* files(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!SKIP_DIRS.has(name)) yield* files(path);
		} else if (TEXT.test(name)) yield path;
	}
}

test("no borrowed client ids, headers or subscription endpoints in shipped source", () => {
	const hits = [];
	for (const root of ROOTS) {
		const dir = join(repo, root);
		if (!existsSync(dir)) continue;
		for (const file of files(dir)) {
			for (const [what, needle] of scan(readFileSync(file, "utf8"))) hits.push(`${relative(repo, file)}: ${what} (${needle})`);
		}
	}
	assert.deepEqual(hits, [], `Removed sign-in identifiers came back:\n${hits.join("\n")}`);
});

test("a fresh build of the extension carries none of them either", () => {
	// Build a throwaway copy (never the dist-chrome a browser may have loaded) and scan it.
	const out = mkdtempSync(join(tmpdir(), "tabkyra-auth-build-"));
	try {
		execFileSync(process.execPath, [join(repo, "scripts", "build.mjs")], {
			cwd: repo,
			env: { ...process.env, TABKYRA_NO_BUMP: "1", TABKYRA_OUT_DIR: out },
			stdio: "pipe",
		});
		assert.ok(existsSync(join(out, "sidepanel.js")), "the build produced no sidepanel.js");
		const hits = [];
		for (const file of files(out)) {
			if (file.endsWith(".map")) continue;
			for (const [what] of scan(readFileSync(file, "utf8"))) hits.push(`${relative(out, file)}: ${what}`);
		}
		assert.deepEqual(hits, [], `The bundle still ships removed sign-in code:\n${hits.join("\n")}`);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("the removed sign-in modules stay removed", () => {
	for (const file of ["openai-codex.ts", "github-copilot.ts", "google-gemini-cli.ts", "anthropic.ts", "browser-oauth.ts"]) {
		assert.equal(existsSync(join(repo, "src", "oauth", file)), false, `src/oauth/${file} is back`);
	}
});

test("the policy still lists every removed provider and subscription API", () => {
	const policy = readFileSync(join(repo, "src", "auth", "policy.ts"), "utf8");
	for (const id of ["openai-codex", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex-responses"]) {
		assert.ok(policy.includes(`"${id}"`), `src/auth/policy.ts no longer blocks ${id}`);
	}
	assert.match(policy, /sk-ant-oat/, "Claude subscription tokens must stay refused");
});

// Sign in with ChatGPT (open-source path) and Copilot through the SDK are the only subscription
// sign-ins, each on the provider's documented route with Tabkyra's own registration
// (docs/auth-policy.md, D-entry "Subscription sign-ins"). These pin exactly what they may contact.
const SIWC_ENDPOINTS = new Set([
	"https://auth.openai.com",
	"https://auth.openai.com/api/accounts/authorize",
	"https://auth.openai.com/api/accounts/oauth/token",
	"https://auth.openai.com/.well-known/openid-configuration",
]);
const GITHUB_OAUTH_ENDPOINTS = new Set(["https://github.com/login/device/code", "https://github.com/login/oauth/access_token"]);

function urlsIn(text, host) {
	const re = new RegExp(`https://${host.replace(/\./g, "\\.")}[^\\s"'\`)]*`, "g");
	return [...text.matchAll(re)].map((m) => m[0].replace(/[.,;]+$/, ""));
}

test("every auth.openai.com and github.com/login URL in shipped source is a documented sign-in endpoint", () => {
	const bad = [];
	for (const root of ROOTS) {
		const dir = join(repo, root);
		if (!existsSync(dir)) continue;
		for (const file of files(dir)) {
			const text = readFileSync(file, "utf8");
			for (const url of urlsIn(text, "auth.openai.com")) if (!SIWC_ENDPOINTS.has(url)) bad.push(`${relative(repo, file)}: ${url}`);
			for (const url of urlsIn(text, "github.com/login")) if (!GITHUB_OAUTH_ENDPOINTS.has(url)) bad.push(`${relative(repo, file)}: ${url}`);
		}
	}
	assert.deepEqual(bad, [], `Unexpected sign-in endpoints:\n${bad.join("\n")}`);
});

test("the only OAuth client ids are Tabkyra's own: SIWC registers dynamically, Copilot uses Tabkyra's OAuth App", () => {
	const constants = readFileSync(join(repo, "src", "subscriptions", "constants.ts"), "utf8");
	assert.match(constants, /dynamicClient: "dynamic_agent_client"/);
	assert.match(constants, /clientId: "Ov23li1qDiu9lRXbvcFh"/);
	assert.match(constants, /agentName: "Tabkyra"/);
	// No client secret for either: the SIWC open-source flow and GitHub's device flow need none.
	// serve's authorization server (D30) issues and checks secrets for clients that register with
	// it; it never sends one. It is exempt only while it makes no outbound request at all.
	const authorizationServer = join(repo, "cli", "src", "oauth.ts");
	assert.doesNotMatch(readFileSync(authorizationServer, "utf8"), /\bfetch\(|node:https?["']|\.request\(|XMLHttpRequest|WebSocket/, "cli/src/oauth.ts makes an outbound request");
	for (const root of ROOTS) {
		const dir = join(repo, root);
		if (!existsSync(dir)) continue;
		for (const file of files(dir)) {
			if (file === authorizationServer) continue;
			const text = readFileSync(file, "utf8");
			assert.doesNotMatch(text, /client_secret["'\]]?\s*[:,=]/, `${relative(repo, file)} sends a client secret`);
		}
	}
});

test("no provider CLI is spawned and no subscription sign-in exists for Anthropic or Google", () => {
	const dirs = [join(repo, "src", "subscriptions"), join(repo, "cli", "src", "subscriptions")];
	for (const dir of dirs) {
		for (const file of files(dir)) {
			const text = readFileSync(file, "utf8");
			// install-sdk.ts runs npm (the user's own command) and nothing else.
			if (file.endsWith("install-sdk.ts")) {
				assert.doesNotMatch(text, /spawnSync\((?!npm)/);
				continue;
			}
			assert.doesNotMatch(text, /child_process/, `${relative(repo, file)} starts a process`);
		}
	}
	const constants = readFileSync(join(repo, "src", "subscriptions", "constants.ts"), "utf8");
	for (const provider of ["anthropic", "google", "gemini", "claude"]) {
		assert.doesNotMatch(constants, new RegExp(`_PROVIDER = "${provider}`, "i"));
	}
});

test("the UI says API use is billed and offers only the sanctioned subscription sign-ins", () => {
	const tab = readFileSync(join(repo, "src", "dialogs", "ApiKeysTab.ts"), "utf8");
	const dialog = readFileSync(join(repo, "src", "dialogs", "ApiKeyDialog.ts"), "utf8");
	for (const text of [tab, dialog]) assert.match(text, /API_BILLING_NOTE/);
	const policy = readFileSync(join(repo, "src", "auth", "policy.ts"), "utf8");
	assert.match(policy, /billed by the provider/);
	for (const file of readdirSync(join(repo, "src", "dialogs"))) {
		const text = readFileSync(join(repo, "src", "dialogs", file), "utf8");
		assert.doesNotMatch(text, /oauthLogin|Subscription Login|Log in with your existing subscription/, `${file} offers a sign-in`);
	}
	const section = readFileSync(join(repo, "src", "subscriptions", "SubscriptionsSection.ts"), "utf8");
	assert.match(section, /Continue with ChatGPT/, "OpenAI's UI guidelines name the button Continue with ChatGPT");
	assert.match(section, /Sign in with GitHub Copilot/);
	assert.match(section, /Use your Claude Code or Gemini CLI subscription by running it with Tabkyra's MCP server/);
	assert.doesNotMatch(section, /Sign in with Claude|Continue with Claude|Sign in with Gemini|Sign in with Google/);
});

test("docs/auth-policy.md keeps a row for every provider decision", () => {
	const doc = readFileSync(join(repo, "docs", "auth-policy.md"), "utf8");
	for (const provider of ["OpenAI", "GitHub", "Google", "Anthropic"]) assert.match(doc, new RegExp(`\\| ${provider} \\|`));
	assert.match(doc, /Sign in with ChatGPT/);
	assert.match(doc, /Copilot SDK/);
	assert.match(doc, /Checked 2026-\d\d-\d\d/);
});
