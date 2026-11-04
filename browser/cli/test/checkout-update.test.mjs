// The checkout updater and the native host's update action, against a throwaway git checkout
// with its own origin. The checkout's build scripts are stand-ins that build in a moment; the
// updater itself is the real CLI bundle, copied into the checkout so it detects checkout mode
// from where it runs, as the native host does.
//
// Covers: mode detection, a fast-forward update, refusals (local changes, another branch, a
// diverged main), a failed build leaving the old build, rollback, the no-parameters rule of the
// host's update action, the settings actions and the version-mismatch report.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const realCli = join(here, "..", "dist", "index.js");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "tabkyra-checkout-")));
const home = join(tmp, "home");
const claudeHome = join(home, ".claude");
mkdirSync(claudeHome, { recursive: true });
// Unix socket paths are capped near 104 bytes on macOS, so this one is short.
const socketDir = mkdtempSync("/tmp/tkco-");
after(() => {
	rmSync(tmp, { recursive: true, force: true });
	rmSync(socketDir, { recursive: true, force: true });
});

function env(extra = {}) {
	const e = {
		...process.env,
		HOME: home,
		TABKYRA_HOME: join(home, ".local", "share", "tabkyra"),
		TABKYRA_SOCKET_DIR: socketDir,
		TABKYRA_UPDATE_API: "http://127.0.0.1:9/unused",
		CLAUDE_CONFIG_DIR: claudeHome,
		CODEX_HOME: join(home, ".codex-absent"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"),
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		REAL_TABKYRA_CLI: realCli,
		NO_COLOR: "1",
		...extra,
	};
	for (const k of ["XDG_CONFIG_HOME", "TABKYRA_CONFIG_DIR", "TABKYRA_NO_UPDATE_CHECK", "TABKYRA_OUT_DIR", "TABKYRA_CLI_OUT_DIR", "FORCE_COLOR"]) delete e[k];
	return e;
}
writeFileSync(join(tmp, "gitconfig"), "");

function git(cwd, ...args) {
	const r = spawnSync("git", args, { cwd, env: env(), encoding: "utf8" });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

// The stand-in project: the same layout and commands the updater runs, building in milliseconds.
const BUILD_EXT = `
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
if (existsSync("FAIL_BUILD")) { console.error("error TS2304: Cannot find name 'broken'."); process.exit(2); }
// A real build bumps the version unless TABKYRA_NO_BUMP is set; that would leave local changes.
if (!process.env.TABKYRA_NO_BUMP) writeFileSync("static/manifest.chrome.json", JSON.stringify({ version: "9.9.9" }));
const out = process.env.TABKYRA_OUT_DIR || "dist-chrome";
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync("static/manifest.chrome.json", "utf8")).version;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
for (const f of ["background.js", "sidepanel.js", "sidepanel.html", "app.css"]) writeFileSync(join(out, f), "// " + commit);
writeFileSync(join(out, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Tabkyra", version }));
writeFileSync(join(out, "build-info.json"), JSON.stringify({ id: randomUUID(), commit, version, builtAt: new Date().toISOString() }));
`;
const BUILD_CLI = `
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const out = process.env.TABKYRA_CLI_OUT_DIR || "dist";
mkdirSync(out, { recursive: true });
copyFileSync(process.env.REAL_TABKYRA_CLI, join(out, "index.js"));
const version = JSON.parse(readFileSync("../static/manifest.chrome.json", "utf8")).version;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(out, "build-info.json"), JSON.stringify({ id: randomUUID(), commit, version, builtAt: new Date().toISOString() }));
`;

let n = 0;
/** origin (bare), a checkout of it, built once like a fresh setup; plus a second clone to push from. */
function makeCheckout() {
	const dir = join(tmp, `case-${++n}`);
	const seed = join(dir, "seed");
	mkdirSync(join(seed, "static"), { recursive: true });
	mkdirSync(join(seed, "scripts"), { recursive: true });
	mkdirSync(join(seed, "cli"), { recursive: true });
	writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "tabkyra", private: true, type: "module", scripts: { build: "node build.mjs" } }));
	writeFileSync(join(seed, "build.mjs"), BUILD_EXT);
	writeFileSync(join(seed, "cli", "package.json"), JSON.stringify({ name: "tabkyra-cli", private: true, type: "module", scripts: { build: "node build.mjs" } }));
	writeFileSync(join(seed, "cli", "build.mjs"), BUILD_CLI);
	writeFileSync(join(seed, "static", "manifest.chrome.json"), JSON.stringify({ version: "1.2.0" }));
	writeFileSync(join(seed, "scripts", "setup-siblings.sh"), "#!/bin/bash\nset -e\necho ran >> .setup-ran\n", { mode: 0o755 });
	writeFileSync(join(seed, ".gitignore"), "dist-chrome/\ncli/dist/\n.tabkyra-update/\n.setup-ran\n");
	git(dir, "init", "-q", "-b", "main", seed);
	git(seed, "add", ".");
	git(seed, "commit", "-q", "-m", "First");
	const origin = join(dir, "origin.git");
	git(dir, "clone", "-q", "--bare", seed, origin);
	const checkout = join(dir, "tabkyra");
	git(dir, "clone", "-q", origin, checkout);
	const pusher = join(dir, "pusher");
	git(dir, "clone", "-q", origin, pusher);
	// First build, as a developer's own `npm run build` would leave it.
	for (const [cwd, out] of [
		[checkout, { TABKYRA_NO_BUMP: "1" }],
		[join(checkout, "cli"), {}],
	]) {
		const r = spawnSync(process.execPath, ["build.mjs"], { cwd, env: env(out), encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	}
	return { dir, checkout, origin, pusher, cli: join(checkout, "cli", "dist", "index.js") };
}

/** Commit in the pusher clone and push it to origin. */
function pushCommit(c, subject, files = {}) {
	for (const [name, text] of Object.entries(files)) writeFileSync(join(c.pusher, name), text);
	if (Object.keys(files).length) git(c.pusher, "add", ...Object.keys(files));
	git(c.pusher, "commit", "-q", "--allow-empty", "-m", subject);
	git(c.pusher, "push", "-q", "origin", "main");
	return git(c.pusher, "rev-parse", "HEAD");
}

function runHost(cli, ...args) {
	return runHostWith({}, cli, ...args);
}

function runHostWith(extraEnv, cli, ...args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, "update", "--host", ...args], { env: env(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("close", (code) => {
			const events = out
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
			resolve({ code, events, last: events.at(-1), stderr: err });
		});
	});
}

const buildId = (dir) => JSON.parse(readFileSync(join(dir, "build-info.json"), "utf8"));
const extBuild = (c) => buildId(join(c.checkout, "dist-chrome"));
const cliBuild = (c) => buildId(join(c.checkout, "cli", "dist"));
const lastUpdate = () => JSON.parse(readFileSync(join(home, ".config", "tabkyra", "last-update.json"), "utf8"));

test("checkout mode: a fast-forward pulls, sets up and builds aside; activation swaps it in and keeps the old build", async () => {
	const c = makeCheckout();
	const before = extBuild(c);
	const head = pushCommit(c, "Add the update button");
	const r = await runHost(c.cli);
	assert.equal(r.code, 0, JSON.stringify(r.events) + r.stderr);
	const phases = r.events.map((e) => e.phase);
	for (const p of ["checking", "pulling", "installing", "building", "done"]) assert.ok(phases.includes(p), `${p} in ${phases}`);
	assert.equal(r.last.staged, true, "the build waits to be activated");
	assert.equal(r.last.reload, undefined);
	assert.equal(git(c.checkout, "rev-parse", "HEAD"), head);
	assert.equal(extBuild(c).id, before.id, "nothing live changes until activation");

	const a = await runHost(c.cli, "--activate");
	assert.equal(a.code, 0, JSON.stringify(a.events));
	assert.ok(a.events.some((e) => e.phase === "skills"));
	assert.equal(a.last.reload, true);
	assert.equal(extBuild(c).commit, head);
	assert.equal(cliBuild(c).commit, head);
	assert.equal(a.last.extensionBuild, extBuild(c).id);
	assert.ok(existsSync(join(c.checkout, ".setup-ran")), "setup-siblings.sh ran");
	assert.equal(buildId(join(c.checkout, ".tabkyra-update", "previous", "dist-chrome")).id, before.id, "the old build is kept");
	assert.equal(git(c.checkout, "status", "--porcelain"), "", "the build left no local changes (no version bump)");
	const record = lastUpdate();
	assert.equal(record.kind, "update");
	assert.equal(record.mode, "checkout");
	assert.deepEqual(
		record.commits.map((x) => x.subject),
		["Add the update button"],
	);
	assert.equal(record.totalCommits, 1);
	assert.equal(record.extensionBuild, extBuild(c).id);

	const again = await runHost(c.cli);
	assert.equal(again.last.phase, "done");
	assert.match(again.last.message, /Up to date/);
	assert.equal(again.last.reload, undefined, "nothing to reload");
	const nothing = await runHost(c.cli, "--activate");
	assert.match(nothing.last.message, /Nothing was waiting/);
	assert.equal(nothing.last.reload, undefined);
});

test("activation refuses a build when the checkout moved after it", async () => {
	const c = makeCheckout();
	const before = extBuild(c);
	pushCommit(c, "One");
	assert.equal((await runHost(c.cli)).last.staged, true);
	git(c.checkout, "commit", "-q", "--allow-empty", "-m", "Moved meanwhile");
	const a = await runHost(c.cli, "--activate");
	assert.equal(a.last.phase, "failed");
	assert.match(a.last.message, /moved/);
	assert.equal(extBuild(c).id, before.id);
	assert.ok(!existsSync(join(c.checkout, ".tabkyra-update", "next")), "the stale build is dropped");
});

test("checkout mode refuses local changes, another branch and a diverged main, changing nothing", async () => {
	const c = makeCheckout();
	pushCommit(c, "Upstream change");
	const head = git(c.checkout, "rev-parse", "HEAD");
	const build = extBuild(c).id;
	const unchanged = () => {
		assert.equal(git(c.checkout, "rev-parse", "HEAD"), head);
		assert.equal(extBuild(c).id, build);
		assert.ok(!existsSync(join(c.checkout, ".setup-ran")));
	};

	writeFileSync(join(c.checkout, "build.mjs"), `${BUILD_EXT}\n// my edit\n`);
	let r = await runHost(c.cli);
	assert.equal(r.code, 1);
	assert.equal(r.last.phase, "failed");
	assert.match(r.last.message, /has local changes \(build\.mjs\)/);
	unchanged();
	git(c.checkout, "checkout", "-q", "--", "build.mjs");

	git(c.checkout, "checkout", "-q", "-b", "feature");
	r = await runHost(c.cli);
	assert.match(r.last.message, /on branch feature, not main/);
	unchanged();
	git(c.checkout, "checkout", "-q", "main");

	git(c.checkout, "commit", "-q", "--allow-empty", "-m", "Local only");
	const local = git(c.checkout, "rev-parse", "HEAD");
	r = await runHost(c.cli);
	assert.equal(r.last.phase, "failed");
	assert.match(r.last.message, /diverged/);
	assert.equal(git(c.checkout, "rev-parse", "HEAD"), local);
	assert.equal(extBuild(c).id, build);
});

test("a failed build leaves the old build live; the next update builds the pulled commit", async () => {
	const c = makeCheckout();
	const before = extBuild(c);
	const beforeCli = cliBuild(c);
	const broken = pushCommit(c, "Break the build", { FAIL_BUILD: "1" });
	const r = await runHost(c.cli);
	assert.equal(r.code, 1);
	assert.equal(r.last.phase, "failed");
	assert.match(r.last.message, /extension build failed\. The old build is still in place/);
	assert.match(r.last.message, /Cannot find name 'broken'/, "the reason reaches the side panel");
	assert.equal(extBuild(c).id, before.id);
	assert.equal(cliBuild(c).id, beforeCli.id);
	assert.ok(!existsSync(join(c.checkout, ".tabkyra-update", "next")), "the half build is removed");
	assert.equal(git(c.checkout, "rev-parse", "HEAD"), broken, "the pull itself went through");

	const fixed = pushCommit(c, "Fix the build");
	git(c.pusher, "rm", "-q", "FAIL_BUILD");
	git(c.pusher, "commit", "-q", "-m", "Remove the failure marker");
	git(c.pusher, "push", "-q", "origin", "main");
	const ok = await runHost(c.cli);
	assert.equal(ok.last.phase, "done", JSON.stringify(ok.events));
	await runHost(c.cli, "--activate");
	assert.equal(extBuild(c).commit, git(c.checkout, "rev-parse", "HEAD"));
	assert.notEqual(fixed, undefined);
	// What's new counts from the live build, so the commits of the failed run are included.
	assert.deepEqual(
		lastUpdate().commits.map((x) => x.subject),
		["Remove the failure marker", "Fix the build", "Break the build"],
	);
});

test("rollback swaps the previous build back, and again", async () => {
	const c = makeCheckout();
	const none = await runHost(c.cli, "--rollback");
	assert.equal(none.last.phase, "failed");
	assert.match(none.last.message, /No previous build/);

	const old = extBuild(c);
	const oldCli = cliBuild(c);
	pushCommit(c, "New feature");
	await runHost(c.cli);
	await runHost(c.cli, "--activate");
	const fresh = extBuild(c);
	assert.notEqual(fresh.id, old.id);

	const back = await runHost(c.cli, "--rollback");
	assert.equal(back.last.phase, "done", JSON.stringify(back.events));
	assert.equal(back.last.reload, true);
	assert.equal(extBuild(c).id, old.id);
	assert.equal(cliBuild(c).id, oldCli.id);
	assert.equal(lastUpdate().kind, "rollback");

	const forward = await runHost(c.cli, "--rollback");
	assert.equal(forward.last.phase, "done");
	assert.equal(extBuild(c).id, fresh.id);
});

test("mode detection: a copy that is neither a release nor a checkout refuses", async () => {
	const loose = join(tmp, "loose", "cli", "dist");
	mkdirSync(loose, { recursive: true });
	copyFileSync(realCli, join(loose, "index.js"));
	const r = await runHost(join(loose, "index.js"));
	assert.equal(r.code, 1);
	assert.match(r.last.message, /neither a release install nor a git checkout/);
	assert.match(r.last.message, /tabkyra update in a terminal/);
});

test("skill refresh replaces unedited copies and reports edited ones", () => {
	const install = spawnSync(process.execPath, [realCli, "skill", "install", "tabkyra", "academic-research"], { env: env(), encoding: "utf8" });
	assert.equal(install.status, 0, install.stdout + install.stderr);
	const plain = join(claudeHome, "skills", "tabkyra", "SKILL.md");
	const edited = join(claudeHome, "skills", "academic-research", "SKILL.md");
	// An older bundled text Tabkyra wrote (recorded), and a hand edit (not recorded).
	const marker = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";
	const older = `---\nname: tabkyra\ndescription: old\n---\n${marker}\nold text\n`;
	writeFileSync(plain, older);
	const recordFile = join(home, ".config", "tabkyra", "skills-installed.json");
	const record = JSON.parse(readFileSync(recordFile, "utf8"));
	record[plain] = createHash("sha256").update(older).digest("hex");
	writeFileSync(recordFile, JSON.stringify(record));
	writeFileSync(edited, `${readFileSync(edited, "utf8")}\nMy own step.\n`);

	const r = spawnSync(process.execPath, [realCli, "skill", "refresh", "--json"], { env: env(), encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const result = JSON.parse(r.stdout);
	assert.deepEqual(result.refreshed, [plain]);
	assert.deepEqual(
		result.skipped.map((s) => s.skill),
		["academic-research"],
	);
	assert.notEqual(readFileSync(plain, "utf8"), older);
	assert.match(readFileSync(edited, "utf8"), /My own step/);
});

// ---- the native host's update action --------------------------------------------------

function frame(message) {
	const body = Buffer.from(JSON.stringify(message));
	const out = Buffer.alloc(4 + body.length);
	out.writeUInt32LE(body.length, 0);
	body.copy(out, 4);
	return out;
}

function startHost(cli) {
	const host = spawn(process.execPath, [cli, "host", "chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/"], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
	const messages = [];
	let buf = Buffer.alloc(0);
	host.stdout.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
			const len = buf.readUInt32LE(0);
			messages.push(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
			buf = buf.subarray(4 + len);
		}
	});
	const send = (m) => host.stdin.write(frame(m));
	const waitFor = async (pred, what, ms = 20000) => {
		const end = Date.now() + ms;
		for (;;) {
			const found = messages.find(pred);
			if (found) return found;
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(messages.slice(-5))}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	return { host, messages, send, waitFor };
}

test("the host runs an update only for a bare {type, action} and streams its steps", async (t) => {
	const c = makeCheckout();
	const disk = extBuild(c);
	const h = startHost(c.cli);
	t.after(() => h.host.kill());
	h.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: disk });
	const status = await h.waitFor((m) => m.type === "update_status", "update_status");
	assert.equal(status.mode, "checkout");
	assert.equal(status.root, c.checkout);
	assert.equal(status.location, "here");
	assert.equal(status.policy, "notify");
	assert.equal(status.available, false);
	// The stand-in CLI build is a copy of the real bundle, whose compiled build differs from the
	// build-info.json the stand-in writes, so only the host's own check can differ here.
	assert.notEqual(status.mismatch?.fix, "reinstall");

	const head = pushCommit(c, "Something new");
	// Anything besides {type, action} is refused, and nothing runs.
	for (const bad of [
		{ type: "update_action", action: "update", args: ["--yes"] },
		{ type: "update_action", action: "update --rollback" },
		{ type: "update_action", action: "update", root: "/" },
	]) {
		const before = h.messages.length;
		h.send(bad);
		const refused = await h.waitFor((m, i) => h.messages.indexOf(m) >= before && m.type === "update_progress", "refusal");
		assert.equal(refused.phase, "failed");
		assert.match(refused.message, /Refused/);
	}
	await new Promise((r) => setTimeout(r, 300));
	assert.notEqual(git(c.checkout, "rev-parse", "HEAD"), head, "a refused request ran nothing");

	h.send({ type: "update_action", action: "check" });
	const checked = await h.waitFor((m) => m.type === "update_status" && m.available, "a check that sees the new commit");
	assert.equal(checked.behind, 1);

	h.send({ type: "update_action", action: "policy-auto" });
	await h.waitFor((m) => m.type === "update_status" && m.policy === "auto", "policy auto");
	assert.equal(JSON.parse(readFileSync(join(home, ".config", "tabkyra", "update.json"), "utf8")).policy, "auto");
	h.send({ type: "update_action", action: "policy-notify" });
	await h.waitFor((m) => m.type === "update_status" && m.policy === "notify", "policy notify");

	const sentAt = h.messages.length;
	h.send({ type: "update_action", action: "update" });
	const done = await h.waitFor(
		(m) => h.messages.indexOf(m) >= sentAt && m.type === "update_progress" && m.action === "update" && (m.phase === "done" || m.phase === "failed"),
		"the update to finish",
		60000,
	);
	assert.equal(done.phase, "done", done.message);
	assert.equal(done.staged, true);
	const steps = h.messages.slice(sentAt).filter((m) => m.type === "update_progress" && m.action === "update").map((m) => m.phase);
	assert.ok(steps.includes("pulling") && steps.includes("building"), steps.join(","));
	assert.equal(git(c.checkout, "rev-parse", "HEAD"), head);
	// Activate right away, as the worker may, before the update process has even exited.
	const activateAt = h.messages.length;
	h.send({ type: "update_action", action: "activate" });
	const installed = await h.waitFor(
		(m) => h.messages.indexOf(m) >= activateAt && m.type === "update_progress" && m.action === "activate" && (m.phase === "done" || m.phase === "failed"),
		"activation",
		60000,
	);
	assert.equal(installed.reload, true, installed.message);
	assert.ok(!h.messages.slice(activateAt).some((m) => m.type === "update_progress" && /already running/.test(m.message)), "not refused as busy");

	// The extension still runs the old build: the host reports it and offers the reload.
	const doneAt = h.messages.indexOf(installed);
	const after = await h.waitFor((m) => h.messages.indexOf(m) > doneAt && m.type === "update_status", "status after the update");
	assert.equal(after.mismatch?.fix, "reload");
	assert.equal(after.lastUpdate.commits[0].subject, "Something new");
});

test("the host reports a half-installed update as a mismatch with the install fix", async (t) => {
	const c = makeCheckout();
	const disk = extBuild(c);
	// The extension build is from another commit than the CLI build.
	writeFileSync(join(c.checkout, "dist-chrome", "build-info.json"), JSON.stringify({ ...disk, id: "other", commit: "f".repeat(40) }));
	const h = startHost(c.cli);
	t.after(() => h.host.kill());
	h.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: { ...disk, id: "other" } });
	const status = await h.waitFor((m) => m.type === "update_status", "update_status");
	assert.equal(status.mismatch?.fix, "reinstall");
	assert.match(status.mismatch.reason, /built from different commits/);
});

test("the host refuses to update a folder the browser doesn't load from", async (t) => {
	const c = makeCheckout();
	const disk = extBuild(c);
	const h = startHost(c.cli);
	t.after(() => h.host.kill());
	h.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: { ...disk, id: "somewhere-else" } });
	const status = await h.waitFor((m) => m.type === "update_status", "update_status");
	assert.equal(status.location, "elsewhere");
	assert.match(status.blocked, /another folder/);
	pushCommit(c, "New");
	const head = git(c.checkout, "rev-parse", "HEAD");
	h.send({ type: "update_action", action: "update" });
	const refused = await h.waitFor((m) => m.type === "update_progress" && m.action === "update", "refusal");
	assert.equal(refused.phase, "failed");
	assert.match(refused.message, /another folder/);
	assert.equal(git(c.checkout, "rev-parse", "HEAD"), head);
});

/** Crash states of a journaled swap, built by hand: each step as the updater leaves it. */
function crashMidSwap(c, op) {
	const state = join(c.checkout, ".tabkyra-update");
	const prevNew = join(state, "prev-new");
	mkdirSync(prevNew, { recursive: true });
	writeFileSync(join(state, "journal.json"), JSON.stringify({ op, step: "prepare" }));
	cpSync(join(c.checkout, "cli", "dist"), join(prevNew, "cli-dist"), { recursive: true });
	writeFileSync(join(state, "journal.json"), JSON.stringify({ op, step: "swap" }));
	// Stopped right after the first rename: no dist-chrome at all.
	renameSync(join(c.checkout, "dist-chrome"), join(prevNew, "dist-chrome"));
}

async function helloFrom(c) {
	const disk = JSON.parse(readFileSync(join(c.checkout, ".tabkyra-update", "prev-new", "dist-chrome", "build-info.json"), "utf8"));
	const h = startHost(c.cli);
	h.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: disk });
	await h.waitFor((m) => m.type === "update_status", "update_status");
	h.host.kill();
}

test("the host finishes an install a crash interrupted when it starts", async () => {
	const c = makeCheckout();
	const old = extBuild(c);
	pushCommit(c, "Something new");
	assert.equal((await runHost(c.cli)).last.staged, true);
	const staged = buildId(join(c.checkout, ".tabkyra-update", "next", "dist-chrome"));
	crashMidSwap(c, "activate");
	assert.ok(!existsSync(join(c.checkout, "dist-chrome")));
	assert.ok(existsSync(c.cli), "the CLI the launcher runs is still there");
	await helloFrom(c);
	assert.equal(extBuild(c).id, staged.id, "the install was finished");
	assert.equal(cliBuild(c).commit, staged.commit, "with the matching CLI");
	assert.equal(buildId(join(c.checkout, ".tabkyra-update", "previous", "dist-chrome")).id, old.id, "the old build is kept for rollback");
	assert.ok(!existsSync(join(c.checkout, ".tabkyra-update", "journal.json")));
});

test("the host finishes a rollback a crash interrupted when it starts", async () => {
	const c = makeCheckout();
	const old = extBuild(c);
	pushCommit(c, "Something new");
	await runHost(c.cli);
	await runHost(c.cli, "--activate");
	const fresh = extBuild(c);
	crashMidSwap(c, "rollback");
	await helloFrom(c);
	assert.equal(extBuild(c).id, old.id, "rolled back");
	assert.equal(cliBuild(c).commit, old.commit, "with the matching CLI");
	assert.equal(buildId(join(c.checkout, ".tabkyra-update", "previous", "dist-chrome")).id, fresh.id);
	// And it rolls forward again from there.
	assert.equal((await runHost(c.cli, "--rollback")).last.phase, "done");
	assert.equal(extBuild(c).id, fresh.id);
	assert.equal(cliBuild(c).commit, fresh.commit);
});

test("a crash inside the commit step is finished without touching the kept build", async () => {
	const c = makeCheckout();
	const old = extBuild(c);
	pushCommit(c, "Something new");
	await runHost(c.cli);
	await runHost(c.cli, "--activate");
	const fresh = extBuild(c);
	// The commit had already moved prev-new to previous/ but not yet dropped next/ and the journal.
	const state = join(c.checkout, ".tabkyra-update");
	mkdirSync(join(state, "next"), { recursive: true });
	writeFileSync(join(state, "next", "staged.json"), "{}");
	writeFileSync(join(state, "journal.json"), JSON.stringify({ op: "activate", step: "commit" }));
	const h = startHost(c.cli);
	h.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: fresh, diskBuild: fresh });
	await h.waitFor((m) => m.type === "update_status", "update_status");
	h.host.kill();
	assert.equal(extBuild(c).id, fresh.id);
	assert.equal(buildId(join(state, "previous", "dist-chrome")).id, old.id, "the kept build is untouched");
	assert.ok(existsSync(join(state, "previous", "cli-dist", "index.js")));
	assert.ok(!existsSync(join(state, "journal.json")) && !existsSync(join(state, "next")));
});

test("an install stopped before it changed anything is undone, and the staged build stays", async () => {
	const c = makeCheckout();
	const old = extBuild(c);
	pushCommit(c, "Something new");
	await runHost(c.cli);
	const state = join(c.checkout, ".tabkyra-update");
	writeFileSync(join(state, "journal.json"), JSON.stringify({ op: "activate", step: "prepare" }));
	mkdirSync(join(state, "prev-new", "cli-dist"), { recursive: true });
	const a = await runHost(c.cli, "--activate");
	assert.equal(a.last.reload, true, a.last.message);
	assert.equal(extBuild(c).commit, git(c.checkout, "rev-parse", "HEAD"));
	assert.equal(buildId(join(state, "previous", "dist-chrome")).id, old.id);
});

test("a host that starts after an updater died says so instead of showing it as running", async (t) => {
	const c = makeCheckout();
	const disk = extBuild(c);
	mkdirSync(join(home, ".config", "tabkyra"), { recursive: true });
	writeFileSync(join(home, ".config", "tabkyra", "update-progress.json"), JSON.stringify({ pid: 999999, action: "update", phase: "building", message: "Building the CLI", at: Date.now() }));
	const h = startHost(c.cli);
	t.after(() => h.host.kill());
	h.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: disk });
	const failed = await h.waitFor((m) => m.type === "update_progress" && m.phase === "failed", "the stopped updater reported");
	assert.match(failed.message, /stopped before it finished/);
	rmSync(join(home, ".config", "tabkyra", "update-progress.json"), { force: true });
});

test("a skills record that can't be written doesn't stop the install", async () => {
	const c = makeCheckout();
	pushCommit(c, "Something");
	// Tabkyra refuses to write through a linked config folder; the update must still install.
	const real = join(tmp, "real-config");
	mkdirSync(real, { recursive: true });
	const linked = join(tmp, "linked-config");
	spawnSync("ln", ["-s", real, linked]);
	assert.equal((await runHostWith({ TABKYRA_CONFIG_DIR: linked }, c.cli)).last.staged, true);
	const a = await runHostWith({ TABKYRA_CONFIG_DIR: linked }, c.cli, "--activate");
	assert.equal(a.last.phase, "done", a.last.message);
	assert.equal(a.last.reload, true);
	assert.equal(extBuild(c).commit, git(c.checkout, "rev-parse", "HEAD"));
});

test("the mismatch fix rebuilds HEAD on any branch, but not with local changes", async () => {
	const c = makeCheckout();
	git(c.checkout, "checkout", "-q", "-b", "feature");
	git(c.checkout, "commit", "-q", "--allow-empty", "-m", "Feature work");
	const r = await runHost(c.cli, "--reinstall");
	assert.equal(r.last.staged, true, r.last.message);
	assert.equal((await runHost(c.cli, "--activate")).last.reload, true);
	assert.equal(extBuild(c).commit, git(c.checkout, "rev-parse", "HEAD"));
	writeFileSync(join(c.checkout, "build.mjs"), `${BUILD_EXT}\n// edit\n`);
	const dirty = await runHost(c.cli, "--reinstall");
	assert.equal(dirty.last.phase, "failed");
	assert.match(dirty.last.message, /local changes/);
});

test("an install whose updater died is reported with a reload, after repairing the swap", async (t) => {
	const c = makeCheckout();
	const disk = extBuild(c);
	mkdirSync(join(home, ".config", "tabkyra"), { recursive: true });
	writeFileSync(join(home, ".config", "tabkyra", "update-progress.json"), JSON.stringify({ pid: 999999, action: "activate", phase: "installing", message: "Swapping", at: Date.now() }));
	const h = startHost(c.cli);
	t.after(() => h.host.kill());
	h.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: disk });
	const failed = await h.waitFor((m) => m.type === "update_progress" && m.action === "activate" && m.phase === "failed", "the dead install reported");
	assert.equal(failed.reload, true, "files may have changed: reload into what is installed");
	assert.equal(failed.extensionBuild, disk.id);
	rmSync(join(home, ".config", "tabkyra", "update-progress.json"), { force: true });
});

test("a dead install's result keeps its reload when a later host replays it", async () => {
	const c = makeCheckout();
	const disk = extBuild(c);
	mkdirSync(join(home, ".config", "tabkyra"), { recursive: true });
	writeFileSync(join(home, ".config", "tabkyra", "update-progress.json"), JSON.stringify({ pid: 999999, action: "activate", phase: "installing", message: "Swapping", at: Date.now() }));
	// The first host finds the dead updater and reports it.
	const first = startHost(c.cli);
	first.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: disk });
	await first.waitFor((m) => m.type === "update_progress" && m.phase === "failed", "first report");
	first.host.kill();
	// The next host (the extension reloaded, or the browser restarted) replays it: still a reload.
	const second = startHost(c.cli);
	second.send({ type: "hello", version: "1.2.0", protocol: 1, methods: [], build: disk, diskBuild: disk });
	const replay = await second.waitFor((m) => m.type === "update_progress" && m.replay, "the replayed result");
	second.host.kill();
	assert.equal(replay.phase, "failed");
	assert.equal(replay.reload, true, "a replay must not let the gate go onto a mixed install");
	assert.equal(replay.extensionBuild, disk.id);
	rmSync(join(home, ".config", "tabkyra", "update-progress.json"), { force: true });
});

test("an activation that fails mid-swap is recovered before it asks for a reload", async () => {
	const c = makeCheckout();
	pushCommit(c, "Something new");
	assert.equal((await runHost(c.cli)).last.staged, true);
	const staged = buildId(join(c.checkout, ".tabkyra-update", "next", "dist-chrome"));
	const a = await runHostWith({ TABKYRA_TEST_SWAP_FAIL: "after-extension" }, c.cli, "--activate");
	assert.equal(a.last.phase, "failed");
	assert.equal(a.last.reload, true);
	// Recovered before the reload: the extension and the CLI are one build, and the journal is done.
	assert.equal(extBuild(c).id, staged.id);
	assert.equal(cliBuild(c).commit, staged.commit, "the CLI matches the extension");
	assert.ok(!existsSync(join(c.checkout, ".tabkyra-update", "journal.json")));
	assert.equal(a.last.extensionBuild, staged.id);
});
