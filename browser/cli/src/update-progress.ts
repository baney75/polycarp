/**
 * The updater's progress record (~/.config/tabkyra/update-progress.json): the last step of the
 * running or last `tabkyra update --host` run. The updater writes it (update-run.ts); a native
 * host that starts while it runs follows it (update-host.ts). Kept apart from update-run.ts so
 * the host doesn't load the skill catalog.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdatePhase } from "../../src/bridge/protocol.ts";
import { configDir } from "./update.ts";

export type HostRunAction = "update" | "activate" | "rollback" | "reinstall";

export interface ProgressEvent {
	phase: UpdatePhase;
	message: string;
	/** Done, and a build is staged: the extension activates it once no agent runs. */
	staged?: boolean;
	/** Done, and the extension should reload now to run what is installed. */
	reload?: boolean;
	extensionBuild?: string;
}

/** The last step of the running (or last) updater, for a host that starts while it runs. */
export interface ProgressRecord extends ProgressEvent {
	pid: number;
	action: HostRunAction;
	at: number;
}

export const progressFile = () => join(configDir(), "update-progress.json");

/** Rewrite the progress record (the host marks a dead updater's record failed, once). */
export function writeProgressRecord(record: ProgressRecord): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const tmp = `${progressFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record)}\n`);
	renameSync(tmp, progressFile());
}

export function readProgressRecord(): ProgressRecord | undefined {
	try {
		return JSON.parse(readFileSync(progressFile(), "utf8")) as ProgressRecord;
	} catch {
		return undefined;
	}
}

