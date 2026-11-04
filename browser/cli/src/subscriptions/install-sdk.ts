/**
 * `tabkyra copilot-sdk install`: put GitHub's Copilot SDK, at the version Tabkyra pins, where the
 * native host loads it from. Run by the user, never by the extension: it downloads about 160 MB
 * (the SDK's runtime for this platform) from the npm registry.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COPILOT } from "../../../src/subscriptions/constants.ts";
import { sdkInstallDir } from "./copilot.ts";
import { ensurePrivateDir } from "./store.ts";

export function installCopilotSdk(): { ok: boolean; message: string } {
	const dir = sdkInstallDir();
	ensurePrivateDir(dir);
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "tabkyra-copilot-sdk", private: true }, null, "\t")}\n`);
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const spec = `${COPILOT.sdkPackage}@${COPILOT.sdkVersion}`;
	const run = spawnSync(npm, ["install", "--prefix", dir, "--save-exact", "--no-audit", "--no-fund", spec], { stdio: "inherit" });
	if (run.status !== 0) return { ok: false, message: `npm install ${spec} failed (exit ${run.status ?? run.error?.message}).` };
	return { ok: true, message: `Installed ${spec} in ${dir}. Sign in with GitHub Copilot in Tabkyra's settings.` };
}
