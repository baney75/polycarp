// Bundle a TypeScript entry with esbuild into a temp file and import it, so a test can call
// the CLI's own functions (with stand-ins injected) without building the whole CLI first.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `source` is TypeScript that re-exports what the test needs; paths in it are relative to cli/src. */
export async function loadTs(source) {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-bundle-"));
	const entry = join(dir, "entry.ts");
	const out = join(dir, "out.mjs");
	writeFileSync(entry, source.replaceAll("@src/", `${join(root, "src")}/`));
	try {
		await build({
			absWorkingDir: root,
			entryPoints: [entry],
			bundle: true,
			platform: "node",
			target: ["node20"],
			format: "esm",
			outfile: out,
			packages: "bundle",
			loader: { ".pub": "text", ".md": "text" },
			define: { __TABKYRA_BUILD__: "null" },
			logLevel: "silent",
		});
		return await import(pathToFileURL(out).href);
	} finally {
		// The module is loaded; the files are no longer needed.
		rmSync(dir, { recursive: true, force: true });
	}
}
