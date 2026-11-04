/**
 * The setup and update commands parse their own options (values with rules: a timeout above 0,
 * stable or nightly). Their flag lists live here and the command table (commands.ts) imports
 * them, so help and completions can't offer a flag these parsers refuse, or miss one they take.
 */

import type { SetupOptions } from "./setup.ts";
import type { Channel, UpdateOptions } from "./update.ts";

export const SETUP_FLAGS = ["--yes", "--no-wait", "--timeout"];
export const UPDATE_FLAGS = ["--check", "--json", "--rollback", "--yes", "--channel", "--auto-check"];

/** Parse `setup` flags strictly: a typo should not silently change what setup does. */
export function parseSetupArgs(args: string[]): SetupOptions | string {
	const options: SetupOptions = { yes: false, wait: true, timeoutS: 0 };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--no-wait") options.wait = false;
		else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
			const raw = arg === "--timeout" ? args[++i] : arg.slice("--timeout=".length);
			const seconds = Number(raw);
			if (!raw || !Number.isFinite(seconds) || seconds <= 0) return `--timeout needs a number of seconds above 0, got "${raw ?? ""}".`;
			options.timeoutS = seconds;
		} else return `Unknown option "${arg}".`;
	}
	return options;
}

/** Parse `update` flags strictly, like setup. */
export function parseUpdateArgs(args: string[]): UpdateOptions | string {
	const options: UpdateOptions = { check: false, rollback: false, json: false, yes: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const value = (name: string) => (arg === name ? args[++i] : arg.slice(name.length + 1));
		if (arg === "--check") options.check = true;
		else if (arg === "--rollback") options.rollback = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--channel" || arg.startsWith("--channel=")) {
			const channel = value("--channel");
			if (channel !== "stable" && channel !== "nightly") return `--channel is stable or nightly, got "${channel ?? ""}".`;
			options.channel = channel as Channel;
		} else if (arg === "--auto-check" || arg.startsWith("--auto-check=")) {
			const v = value("--auto-check");
			if (v !== "on" && v !== "off") return `--auto-check is on or off, got "${v ?? ""}".`;
			options.autoCheck = v === "on";
		} else return `Unknown option "${arg}".`;
	}
	if (options.rollback && options.check) return "--rollback and --check don't go together.";
	if (options.json && !options.check) return "--json goes with --check.";
	return options;
}

