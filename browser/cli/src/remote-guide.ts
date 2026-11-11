/**
 * The terminal side of `remote setup`: questions, waits and opening a page, used only when a person runs it in a terminal
 * (stdin and stdout are TTYs, no --json, and no --no-wait or --no-input). An app or an agent's shell gets the non-blocking
 * report instead. Nothing here prints a secret.
 */
import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { envVar } from "./env.ts";
import { which } from "./harness.ts";

/**
 * Whether this run talks to a person at a terminal. TABKYRA_ASSUME_TTY=1 says yes for tests, which drive the questions through a
 * pipe; it only turns on questions and waits, never anything a terminal alone could not do.
 */
export function interactiveTerminal(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY) || envVar("ASSUME_TTY") === "1";
}

let reader: Interface | undefined;
const queued: string[] = [];
const waiting: ((line: string | undefined) => void)[] = [];
let ended = false;

function lines(): void {
	if (reader) return;
	// No output stream: the terminal stays in its own line mode, so Ctrl-C reaches the process as SIGINT and ends it.
	reader = createInterface({ input: process.stdin });
	reader.on("line", (line) => {
		const next = waiting.shift();
		if (next) next(line);
		else queued.push(line);
	});
	reader.on("close", () => {
		ended = true;
		for (const next of waiting.splice(0)) next(undefined);
	});
}

/** One answer from the person, or undefined when input has ended. */
export async function ask(question: string): Promise<string | undefined> {
	process.stdout.write(question);
	lines();
	if (queued.length) return queued.shift();
	if (ended) return undefined;
	return new Promise((resolve) => waiting.push(resolve));
}

/** y/N: only a typed yes counts. */
export async function askYes(question: string): Promise<boolean> {
	const answer = (await ask(question))?.trim().toLowerCase();
	return answer === "y" || answer === "yes";
}

/** Let the process end: stop reading stdin. */
export function closeInput(): void {
	reader?.close();
	reader = undefined;
}

/** What openPage uses, so tests can ask for another platform. Production code passes nothing. */
export interface OpenSeam {
	platform?: NodeJS.Platform;
	which?: (name: string) => string | undefined;
	spawn?: (cmd: string, args: string[], opts: { stdio: "ignore"; detached: boolean }) => { on(event: "error", fn: () => void): unknown; unref(): void };
	env?: NodeJS.ProcessEnv;
}

/**
 * Opens an https page in the person's browser with the platform's opener: open on macOS and xdg-open on Linux, found on PATH
 * only; on Windows, rundll32.exe by full path with url.dll's FileProtocolHandler, which hands the URL to the default browser
 * without cmd, so an & in a query string stays in it. On Windows a URL with a space, quote or % is refused, since a command
 * line could split or expand it. False when there is no opener (a server over ssh): the caller prints the address either way.
 */
export function openPage(url: string, seam: OpenSeam = {}): boolean {
	if (!/^https:\/\//.test(url)) return false;
	const platform = seam.platform ?? process.platform;
	const find = seam.which ?? which;
	let opener: string | undefined;
	let args = [url];
	if (platform === "win32") {
		if (/[\s"%^<>|`]/.test(url)) return false;
		opener = win32.join((seam.env ?? process.env).SystemRoot || "C:\\Windows", "System32", "rundll32.exe");
		args = ["url.dll,FileProtocolHandler", url];
	} else opener = platform === "darwin" ? find("open") : platform === "linux" ? find("xdg-open") : undefined;
	if (!opener) return false;
	try {
		const child = (seam.spawn ?? spawn)(opener, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/** A wait's length in ms: the default, or TABKYRA_<NAME> when a test shortens it. */
export function waitMs(name: string, fallback: number): number {
	const n = Number(envVar(name));
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** "5 seconds", "10 minutes": for the one line every wait prints. */
export function duration(ms: number): string {
	if (ms >= 120_000) return `${Math.round(ms / 60_000)} minutes`;
	const s = Math.max(1, Math.round(ms / 1000));
	return `${s} second${s === 1 ? "" : "s"}`;
}
