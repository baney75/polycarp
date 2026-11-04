/**
 * `tabkyra setup`: build, register, wire up the harnesses, then load and connect.
 * Interactive by default; `--yes` accepts every offer. It edits a harness config only
 * after a yes and always points harnesses at the absolute path of the tabkyra launcher.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient, listSockets } from "./client.ts";
import { buildState, builtVersion, sourceVersion } from "./doctor.ts";
import { harnesses, launcherValid, runCommand, shellJoin, tabkyraBinary, which } from "./harness.ts";
import { browserDirs, install } from "./install.ts";
import { extensionDir, repoRoot } from "./paths.ts";
import { installSkills, skillTargets } from "./skill.ts";
import { SKILLS } from "./skills-catalog.ts";
import { banner, box, c, confirm, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

export interface SetupOptions {
	yes: boolean;
	/** Skip waiting for the extension to connect. */
	wait: boolean;
	/** Seconds to wait for the extension; 0 waits until Ctrl+C. */
	timeoutS: number;
}

/** Without a terminal nobody can press Ctrl+C on an endless wait, so it gets a bound. */
export const UNATTENDED_TIMEOUT_S = 300;

function step(n: number, title: string): void {
	console.log();
	console.log(`${c.brass(`${n}.`)} ${c.bold(title)}`);
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	console.log(`  ${c.dim(`$ ${shellJoin([command, ...args])}`)}`);
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	if (result.error) console.log(`  ${sym.fail} ${result.error.message}`);
	return result.status === 0;
}

async function ensureBuild(options: SetupOptions): Promise<boolean> {
	const state = buildState();
	if (state === "ok") {
		console.log(`  ${sym.ok} Extension built ${c.dim(`(${builtVersion()}, ${extensionDir()})`)}`);
		return true;
	}
	const root = repoRoot();
	console.log(
		state === "missing"
			? `  ${sym.warn} No extension build at ${extensionDir()}`
			: `  ${sym.warn} The extension build (${builtVersion()}) does not match this checkout (${sourceVersion()})`,
	);
	if (!(await confirm(`  ${state === "missing" ? "Build it now? The first build fetches pi-mono and mini-lit and takes a few minutes." : "Rebuild it now?"}`, { assumeYes: options.yes }))) {
		console.log(`  Build it yourself with: ${c.bold(`cd ${shellJoin([root])} && ./scripts/setup-siblings.sh && npm run build`)}`);
		return false;
	}
	if (process.platform === "win32") {
		console.log(`  ${sym.warn} Automatic builds need a POSIX shell. Build it yourself in Git Bash or WSL:`);
		console.log(`  ${c.bold(`cd ${shellJoin([root])} && ./scripts/setup-siblings.sh && npm run build`)}`);
		return false;
	}
	// The extension compiles against sibling checkouts of pi-mono and mini-lit.
	if (!existsSync(join(root, "..", "pi-mono")) || !existsSync(join(root, "node_modules"))) {
		if (!run("./scripts/setup-siblings.sh", [], root)) {
			console.log(`  ${sym.fail} Sibling setup failed. Fix the error above, then run ${c.bold("tabkyra setup")} again.`);
			return false;
		}
	}
	if (!run("npm", ["run", "build"], root, { ...process.env, TABKYRA_NO_BUMP: "1" }) || buildState() !== "ok") {
		console.log(`  ${sym.fail} The build failed. Fix the error above, then run ${c.bold("tabkyra setup")} again.`);
		return false;
	}
	console.log(`  ${sym.ok} Extension built ${c.dim(`(${builtVersion()})`)}`);
	return true;
}

function registerHost(): boolean {
	const result = install();
	if (process.platform === "win32") {
		for (const key of result.written) console.log(`  ${sym.ok} ${key}`);
		return result.written.length > 0;
	}
	const present = browserDirs().filter(({ dir }) => existsSync(dir));
	if (present.length === 0) {
		console.log(`  ${sym.fail} No Chromium browser profile found. Open your browser once, then run ${c.bold("tabkyra setup")} again.`);
		return false;
	}
	for (const { name, dir } of present) {
		const changed = result.written.some((w) => w.startsWith(join(dir, "NativeMessagingHosts")));
		console.log(`  ${sym.ok} ${name.padEnd(13)} ${c.dim(changed ? "registered" : "already registered")}`);
	}
	return true;
}

function copyToClipboard(text: string): boolean {
	const candidates: Array<[string, string[]]> =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
						["xsel", ["--clipboard", "--input"]],
					];
	for (const [command, args] of candidates) {
		if (process.platform !== "win32" && !which(command)) continue;
		try {
			execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
			return true;
		} catch {
			/* try the next one */
		}
	}
	return false;
}

interface Probe {
	connected: boolean;
	/** The version the browser is running, when connected. */
	version?: string;
	/** Why no socket could be used (an insecure socket directory, a wedged host). */
	error?: string;
	socket?: string;
}

/** Look for a live bridge with the extension behind it, and ask it which version it runs. */
async function probe(): Promise<Probe> {
	let sockets: string[];
	try {
		sockets = listSockets();
	} catch (err) {
		return { connected: false, error: err instanceof Error ? err.message : String(err) };
	}
	let error: string | undefined;
	for (const path of sockets) {
		const client = new BridgeClient({ name: "setup" });
		try {
			await client.connect(path);
			if (!client.extensionConnected) continue;
			try {
				const info = (await client.call("bridge.debug", {}, 5000)) as { version?: string };
				return { connected: true, version: info.version, socket: path };
			} catch (err) {
				// Connected but not answering: not ready, and the reason is worth showing.
				return { connected: true, socket: path, error: err instanceof Error ? err.message : String(err) };
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			client.close();
		}
	}
	return { connected: false, error };
}

/** Ask the running extension to reload itself (it comes back on the new build). */
async function reloadExtension(socket: string): Promise<void> {
	const client = new BridgeClient({ name: "setup" });
	try {
		await client.connect(socket);
		await client.call("bridge.reload", {}, 5000);
	} catch {
		/* the reload drops the connection; that is expected */
	} finally {
		client.close();
	}
}

/** Offer each detected harness the MCP server. Returns false if an attempted add failed. */
async function connectHarnesses(options: SetupOptions): Promise<boolean> {
	const binary = tabkyraBinary();
	const found = harnesses(binary).filter((h) => h.detected);
	if (found.length === 0) {
		console.log(`  No coding harness found. Any MCP client can run: ${c.bold(`${binary} mcp`)}`);
		return true;
	}
	let ok = true;
	for (const h of found) {
		if (h.configured === true) {
			console.log(`  ${sym.ok} ${h.name.padEnd(12)} ${c.dim("already has Tabkyra")}`);
			continue;
		}
		if (h.configured === undefined) {
			console.log(`  ${sym.warn} ${h.name}: couldn't tell whether Tabkyra is configured. ${c.dim("Run tabkyra doctor for details.")}`);
			continue;
		}
		const replacing = h.configured === "stale" || h.configured === "other";
		if (h.addCommand) {
			const commands = replacing && h.removeCommand ? [h.removeCommand, h.addCommand] : [h.addCommand];
			const shown = commands.map(shellJoin).join(" && ");
			// Windows harness CLIs are .cmd shims that need a shell; print the command there instead.
			if (process.platform === "win32") {
				console.log(`  ${sym.dot} ${c.bold(h.name)}: run ${shown}`);
				continue;
			}
			let question = `Add Tabkyra to ${c.bold(h.name)}?`;
			if (h.configured === "stale") question = `${c.bold(h.name)}'s tabkyra entry points at a missing command. Replace it?`;
			if (h.configured === "other") question = `${c.bold(h.name)}'s tabkyra entry runs ${h.currentCommand}. Replace it with this install?`;
			// An entry running some other existing command may be the user's own wrapper:
			// --yes doesn't replace it, and the interactive default is no.
			const assumeYes = options.yes && h.configured !== "other";
			if (options.yes && h.configured === "other") {
				console.log(`  ${sym.warn} ${question} ${c.dim("left alone (--yes never replaces a working entry)")}`);
				console.log(`    ${c.dim("To replace it:")} ${shown}`);
				continue;
			}
			if (await confirm(`  ${sym.dot} ${question} ${c.dim(`(${shown})`)}`, { assumeYes, defaultYes: h.configured !== "other" })) {
				const failedAt = commands.findIndex((command) => !runCommand(command));
				if (failedAt === -1) console.log(`  ${sym.ok} ${h.name} is set up.`);
				else {
					ok = false;
					console.log(`  ${sym.fail} That failed. Run it yourself: ${c.bold(commands.slice(failedAt).map(shellJoin).join(" && "))}`);
				}
			} else {
				console.log(`    ${c.dim("Later:")} ${shown}`);
			}
			continue;
		}
		if (h.snippet?.startsWith("{")) {
			console.log(`  ${sym.dot} ${c.bold(h.name)}: ${replacing ? "replace the tabkyra entry in" : "add this to"} ${c.cyan(h.configFile ?? "its MCP config")}`);
			for (const line of h.snippet.split("\n")) console.log(`    ${line}`);
		} else if (h.snippet) {
			console.log(`  ${sym.dot} ${c.bold(h.name)}: run ${c.bold(h.snippet)}`);
		}
	}
	await offerSkill(options);
	return ok;
}

/** The skill teaches the agent the loop and the safety rules; harnesses load it on demand. */
async function offerSkill(options: SetupOptions): Promise<void> {
	const targets = skillTargets().filter((t) => t.detected);
	if (targets.length === 0) return;
	const names = targets.map((t) => t.name).join(", ");
	const skills = [...SKILLS.keys()].join(", ");
	if (!(await confirm(`  ${sym.dot} Install the Tabkyra skills (${skills}) for ${names}? ${c.dim("(tabkyra skill install)")}`, { assumeYes: options.yes }))) {
		console.log(`    ${c.dim("Later:")} tabkyra skill install`);
		return;
	}
	const results = installSkills({ force: false, all: false });
	for (const t of targets) {
		const mine = results.filter((r) => r.target.id === t.id);
		const ok = mine.filter((r) => r.state === "written" || r.state === "current").length;
		if (ok) console.log(`  ${sym.ok} ${t.name}: ${ok} skills ${c.dim(t.dir)}`);
		for (const r of mine.filter((r) => r.state === "linked")) console.log(`  ${sym.warn} ${t.name}: ${r.file} is a symbolic link; left alone`);
		for (const r of mine.filter((r) => r.state === "kept")) console.log(`  ${sym.warn} ${t.name}: ${r.file} is not ours; left alone ${c.dim(`(tabkyra skill install ${r.skill} --force)`)}`);
	}
}

/** How long to wait for a reloaded extension to come back on the current build. */
const RELOAD_GRACE_MS = 15000;

interface ReloadState {
	reloadedAt?: number;
}

/**
 * Connected and running the build on disk. A stale running copy is reloaded once; if it
 * still runs another version after RELOAD_GRACE_MS, `mismatch` says so and the caller stops.
 */
async function connectedOnCurrentBuild(state: ReloadState): Promise<Probe & { ready: boolean; mismatch?: boolean }> {
	const p = await probe();
	if (!p.connected) return { ...p, ready: false };
	const built = builtVersion();
	if (!p.version) return { ...p, ready: !built && !p.error };
	if (!built || p.version === built) return { ...p, ready: true };
	if (state.reloadedAt === undefined && p.socket) {
		state.reloadedAt = Date.now();
		console.log(`  ${sym.warn} The browser runs Tabkyra ${p.version}, the build is ${built}. Reloading the extension...`);
		await reloadExtension(p.socket);
		return { ...p, ready: false };
	}
	const mismatch = state.reloadedAt !== undefined && Date.now() - state.reloadedAt > RELOAD_GRACE_MS;
	return { ...p, ready: false, mismatch };
}

async function loadExtension(options: SetupOptions): Promise<boolean> {
	const reload: ReloadState = {};
	const first = await connectedOnCurrentBuild(reload);
	if (first.ready) {
		console.log(`  ${sym.ok} The extension is loaded and connected ${c.dim(`(${first.version ?? "unknown version"})`)}.`);
		return true;
	}
	const dir = extensionDir();
	if (!first.connected) {
		console.log(
			box(
				[
					`${c.brass("1")}  Open ${c.bold("chrome://extensions")}, turn on ${c.bold("Developer mode")},`,
					`   and click ${c.bold("Load unpacked")}.`,
					`${c.brass("2")}  Pick this folder:`,
					`   ${c.cyan(dir)}`,
					`${c.brass("3")}  Optional: click ${c.bold("Details")} on Tabkyra and turn on`,
					`   ${c.bold("Allow user scripts")} (faster page scripts).`,
				],
				"One step in your browser",
			),
		);
		console.log(c.dim("  Browsers require this step by hand. In Helium, Brave or Edge the page is the same."));
		// Offered only at a terminal: --yes and scripted runs never overwrite the clipboard.
		if (process.stdin.isTTY && !options.yes && (await confirm("  Copy the folder path to the clipboard?", { assumeYes: false }))) {
			console.log(copyToClipboard(dir) ? `  ${sym.ok} Copied.` : `  ${sym.warn} No clipboard tool found; copy the path above.`);
		}
	}
	if (!options.wait) {
		console.log(`  ${c.dim("Not waiting (--no-wait). Check later with")} ${c.bold("tabkyra status")}`);
		return false;
	}

	const deadline = options.timeoutS > 0 ? Date.now() + options.timeoutS * 1000 : Number.POSITIVE_INFINITY;
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const live = Boolean(process.stdout.isTTY);
	let frame = 0;
	let last: Probe = first;
	if (!live) {
		console.log(
			options.timeoutS > 0
				? `  Waiting up to ${options.timeoutS} s for the extension to connect...`
				: "  Waiting for the extension to connect (Ctrl+C to stop)...",
		);
	}
	while (Date.now() < deadline) {
		const p = await connectedOnCurrentBuild(reload);
		last = p;
		if (p.mismatch) {
			if (live) process.stdout.write("\r\x1b[2K");
			console.log(`  ${sym.fail} The browser still runs Tabkyra ${p.version} after a reload; the build is ${builtVersion()}.`);
			console.log(`  It is probably loaded from another folder. On chrome://extensions, remove Tabkyra and load unpacked:`);
			console.log(`  ${c.cyan(dir)}`);
			return false;
		}
		if (p.ready) {
			if (live) process.stdout.write("\r\x1b[2K");
			console.log(`  ${sym.ok} ${c.bold("Connected.")} Tabkyra can reach your browser ${c.dim(`(${p.version ?? "unknown version"})`)}.`);
			return true;
		}
		if (live) process.stdout.write(`\r  ${c.brass(frames[frame++ % frames.length])} Waiting for the extension to connect ${c.dim("(Ctrl+C to stop)")}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (live) process.stdout.write("\r\x1b[2K");
	console.log(`  ${sym.fail} The extension did not connect within ${options.timeoutS} s.`);
	if (last.connected) console.log(`  It is connected but still runs an old build. Reload it on chrome://extensions.`);
	else if (reload.reloadedAt !== undefined) {
		console.log(`  It went away after the reload. On chrome://extensions, check that Tabkyra is on and loaded from:`);
		console.log(`  ${c.cyan(dir)}`);
	} else if (last.error) console.log(`  Last error: ${last.error}`);
	console.log(`  If it is loaded, reload it once on chrome://extensions, then run ${c.bold("tabkyra doctor")}.`);
	return false;
}

export async function runSetup(options: SetupOptions): Promise<number> {
	const timeoutS = options.timeoutS || (process.stdin.isTTY ? 0 : UNATTENDED_TIMEOUT_S);
	const opts = { ...options, timeoutS };
	console.log(banner(`setup ${VERSION}`));
	console.log(c.dim("You steer. Your agents work the tabs."));

	step(1, "Build the extension");
	if (!(await ensureBuild(opts))) return 1;

	step(2, "Register the native host with your browsers");
	if (!registerHost()) return 1;
	if (!launcherValid()) {
		install({ force: true });
		if (!launcherValid()) {
			console.log(`  ${sym.fail} Could not write the agent launcher at ${tabkyraBinary()}. Check that ~/.config/tabkyra is writable.`);
			return 1;
		}
	}

	// Harnesses come before the wait, so an unattended run configures them even if the
	// browser step is still to come.
	step(3, "Connect your coding agents");
	const harnessesOk = await connectHarnesses(opts);

	step(4, "Load the extension");
	const connected = await loadExtension(opts);

	console.log();
	if (connected && harnessesOk) {
		console.log(`${sym.ok} ${c.bold("Tabkyra is ready.")} Ask your agent to open a page, for example:`);
		console.log(`  ${c.dim('"Use tabkyra to open news.ycombinator.com and list the top five stories."')}`);
		return 0;
	}
	const next = connected ? "fix the agent step above" : "load the extension";
	console.log(`${sym.warn} ${c.bold("Almost there.")} ${next[0].toUpperCase()}${next.slice(1)}, then run ${c.bold("tabkyra doctor")} to check everything.`);
	return 1;
}
