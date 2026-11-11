/**
 * Where the `tailscale` command is. A leaf module: tunnel.ts and remote-setup.ts both import it, so neither imports the other.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { envVar } from "./env.ts";
import { which } from "./harness.ts";
import { type ToolLookup, windowsTool } from "./tool-paths.ts";

/** Where the Tailscale Mac app keeps its command. It never puts `tailscale` on PATH. TABKYRA_APPLICATIONS_DIR replaces /Applications, for tests. */
export const tailscaleAppPath = () => join(envVar("APPLICATIONS_DIR") || "/Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale");

/**
 * The `tailscale` binary: on PATH, or the Tailscale Mac app's own copy at its fixed path, so a terminal and Polycarp's window
 * find the same one. On Windows, tailscale.exe on PATH or in the installer's folder (tool-paths.ts). Nothing else is searched:
 * a path nobody asked for is never run.
 */
export function tailscaleBinary(lookup: ToolLookup = {}): string | undefined {
	if ((lookup.platform ?? process.platform) === "win32") return windowsTool("tailscale", lookup);
	const onPath = which("tailscale");
	if (onPath) return onPath;
	const app = tailscaleAppPath();
	return existsSync(app) ? app : undefined;
}
