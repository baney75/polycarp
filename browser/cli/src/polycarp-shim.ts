/**
 * The `polycarp` command for an npm link or a checkout, where there is no Polycarp app to provide it.
 * The bundled skills and the docs say `polycarp browser <command>`; this makes that line work here too.
 * `polycarp browser ...` runs this helper. Anything else belongs to the app: it goes to the app's own
 * `polycarp` when one is further along PATH, and otherwise says so.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

function real(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The first `polycarp` on PATH that is not this file. */
export function otherPolycarp(path: string, self: string, names: string[] = process.platform === "win32" ? ["polycarp.exe", "polycarp.cmd", "polycarp"] : ["polycarp"]): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const found = real(join(dir, name));
			if (found && found !== self) return join(dir, name);
		}
	}
	return undefined;
}

const self = real(fileURLToPath(import.meta.url)) ?? fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
if (args[0] === "browser") {
	// The helper starts copies of itself from argv[1] (self.ts), so it must see its own file there, not this one.
	const helper = new URL("./index.js", import.meta.url);
	process.argv.splice(1, 2, fileURLToPath(helper));
	await import(helper.href);
} else {
	const app = otherPolycarp(process.env.PATH ?? "", self);
	if (app) {
		const run = spawnSync(app, args, { stdio: "inherit", shell: process.platform === "win32" && app.endsWith(".cmd") });
		process.exit(run.status ?? 1);
	}
	const asked = args[0] ? `\`polycarp ${args[0]}\`` : "`polycarp` on its own";
	console.error(`${asked} needs the Polycarp app, which isn't installed here. This install has the browser helper only: run \`polycarp browser <command>\` or \`polycarp-browser <command>\`.`);
	process.exit(1);
}
