import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { buildInfo } from "./build-info.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const isWatch = process.argv.includes("--watch");
const staticDir = join(packageRoot, "static");

// Chrome only
const targetBrowser = "chrome";
// TABKYRA_OUT_DIR builds elsewhere (test/auth-policy.test.mjs builds a throwaway copy).
const outDir = process.env.TABKYRA_OUT_DIR || join(packageRoot, "dist-chrome");

const entryPoints = {
	sidepanel: join(packageRoot, "src/sidepanel.ts"),
	debug: join(packageRoot, "src/debug.ts"),
	background: join(packageRoot, "src/background.ts"),
	// Speech to text on this device, in its own worker (src/dictation/worker.ts).
	"dictation-worker": join(packageRoot, "src/dictation/worker.ts"),
	// The page that asks for the microphone once: the side panel can't show the prompt.
	"mic-permission": join(packageRoot, "src/dictation/permission.ts"),
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ============================================================================
// REMOVED SIGN-INS (docs/auth-policy.md)
// ============================================================================
// pi-ai ships providers for ChatGPT, Gemini CLI and Copilot subscriptions that pose as
// Codex CLI, Gemini CLI and VS Code. Tabkyra never offers them, so their code and the
// models that carry their headers are left out of the bundle, not just hidden.
const REMOVED_PROVIDERS = ["github-copilot", "google-antigravity", "google-gemini-cli", "openai-codex"];
const refuse = (name) =>
	`export const ${name} = () => { throw new Error("Subscription sign-in was removed from Tabkyra; see docs/auth-policy.md"); };`;
const piAiStubs = {
	"providers/openai-codex-responses.ts": [
		refuse("streamOpenAICodexResponses"),
		refuse("streamSimpleOpenAICodexResponses"),
	].join("\n"),
	"providers/google-gemini-cli.ts": [refuse("streamGoogleGeminiCli"), refuse("streamSimpleGoogleGeminiCli")].join(
		"\n",
	),
	"providers/github-copilot-headers.ts": [
		"export const inferCopilotInitiator = () => 'user';",
		"export const hasCopilotVisionInput = () => false;",
		"export const buildCopilotDynamicHeaders = () => ({});",
	].join("\n"),
};

/** Drop the removed providers' top-level blocks from models.generated.ts. */
function stripRemovedModels(source) {
	const lines = source.split(/\r?\n/);
	const out = [];
	const found = new Set();
	let skipping = false;
	for (const line of lines) {
		const bare = line.trimEnd();
		const opens = REMOVED_PROVIDERS.find((p) => bare === `\t"${p}": {`);
		if (!skipping && opens) {
			found.add(opens);
			skipping = true;
			continue;
		}
		if (skipping) {
			if (bare === "\t},") skipping = false;
			continue;
		}
		out.push(line);
	}
	if (skipping) throw new Error("models.generated.ts: a removed provider block never closed");
	const missing = REMOVED_PROVIDERS.filter((p) => !found.has(p));
	if (missing.length) throw new Error(`models.generated.ts changed upstream: no block for ${missing.join(", ")}`);
	return out.join("\n");
}

/**
 * pi-ai's Anthropic provider treats an sk-ant-oat token as a Claude subscription and
 * sends Claude Code's identity headers with it. Tabkyra refuses those tokens earlier
 * (src/auth/policy.ts); here the branch itself goes, so no build can pose as Claude Code.
 */
function stripClaudeCodeIdentity(source) {
	const edits = [
		[
			/function isOAuthToken\(apiKey: string\): boolean \{[^}]*\}/,
			"function isOAuthToken(_apiKey: string): boolean {\n\treturn false;\n}",
		],
		[/\s*"user-agent": `claude-cli\/\$\{claudeCodeVersion\}`,/, ""],
		[/\s*"x-app": "cli",/, ""],
		[/claude-code-\d{8},oauth-\d{4}-\d\d-\d\d,/, ""],
		[/"You are Claude\s+Code, Anthropic's official CLI for Claude\."/, '""'],
	];
	let out = source;
	for (const [pattern, replacement] of edits) {
		if (!pattern.test(out))
			throw new Error(`anthropic.ts changed upstream: ${pattern} not found; re-check docs/auth-policy.md`);
		out = out.replace(pattern, replacement);
	}
	return out;
}

const stripRemovedSignIns = {
	name: "strip-removed-sign-ins",
	setup(b) {
		// Every transform must run on every build; a path that no longer matches would ship
		// the borrowed identities silently, so a miss fails the build instead.
		const expected = [...Object.keys(piAiStubs), "models.generated.ts", "providers/anthropic.ts"];
		const applied = new Set();
		b.onStart(() => applied.clear());
		// Match on the path tail: esbuild hands over real paths, which differ from packageRoot
		// when pi-mono or the checkout sits behind a symlink (macOS /tmp is /private/tmp).
		b.onLoad({ filter: /[\\/]packages[\\/]ai[\\/]src[\\/].*\.ts$/ }, (args) => {
			const rel = args.path.replaceAll("\\", "/").match(/\/packages\/ai\/src\/(.+)$/)?.[1];
			if (!rel || !expected.includes(rel)) return undefined;
			applied.add(rel);
			if (piAiStubs[rel]) return { contents: piAiStubs[rel], loader: "ts" };
			const source = readFileSync(args.path, "utf8");
			if (rel === "models.generated.ts") return { contents: stripRemovedModels(source), loader: "ts" };
			return { contents: stripClaudeCodeIdentity(source), loader: "ts" };
		});
		b.onEnd((result) => {
			if (result.errors.length) return;
			const missed = expected.filter((rel) => !applied.has(rel));
			if (missed.length) {
				return {
					errors: [
						{ text: `Removed sign-in code was not stripped (${missed.join(", ")}); see docs/auth-policy.md` },
					],
				};
			}
		});
	},
};

/** A SKILL.md's frontmatter description: one line, or a YAML block (`>`, `|`) folded to one line. */
function frontmatterDescription(text) {
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
	const lines = front.split(/\r?\n/);
	const at = lines.findIndex((l) => /^description:/.test(l));
	if (at < 0) return "";
	const first = lines[at].replace(/^description:\s*/, "").trim();
	if (!/^[>|][-+]?$/.test(first)) return first.replace(/^(["'])(.*)\1$/, "$2");
	const body = [];
	for (const l of lines.slice(at + 1)) {
		if (!/^\s+\S/.test(l) && l.trim() !== "") break;
		body.push(l.trim());
	}
	return body.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The bundled skill library (skills/<name>/SKILL.md, what `tabkyra skill list` shows) as a
 * module, so the side panel's "/" menu can list and run them: `virtual:library-skills`.
 */
/**
 * transformers.js defaults the ONNX runtime to jsDelivr at import time. The dictation worker
 * points it at the copy in <out>/ort before any model loads; this makes the default local too, so
 * no build can reach a CDN for code (src/dictation/worker.ts). The build fails if the default
 * moves, or if the file holding it is no longer the one bundled.
 */
const localOnnxRuntime = {
	name: "local-onnx-runtime",
	setup(b) {
		let applied = false;
		b.onStart(() => {
			applied = false;
		});
		b.onEnd((result) => {
			if (!result.errors.length && !applied)
				return {
					errors: [
						{ text: "transformers.web.js wasn't bundled: the ONNX runtime's CDN default was not replaced" },
					],
				};
		});
		b.onLoad({ filter: /@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.web\.js$/ }, (args) => {
			const source = readFileSync(args.path, "utf8");
			const cdn = "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_ENV.versions.web}/dist/";
			if (!source.includes(cdn))
				throw new Error(
					"transformers.js no longer defaults to jsDelivr in the expected way: recheck the dictation worker's runtime paths",
				);
			applied = true;
			return { contents: source.replace(cdn, "/ort/"), loader: "js" };
		});
	},
};

const librarySkills = {
	name: "library-skills",
	setup(b) {
		b.onResolve({ filter: /^virtual:library-skills$/ }, () => ({
			path: "library-skills",
			namespace: "library-skills",
		}));
		b.onLoad({ filter: /.*/, namespace: "library-skills" }, () => {
			const dir = join(packageRoot, "skills");
			const files = [];
			const skills = readdirSync(dir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
				.map((d) => d.name)
				.sort()
				.map((name) => {
					const file = join(dir, name, "SKILL.md");
					files.push(file);
					const text = readFileSync(file, "utf8");
					const description = frontmatterDescription(text);
					if (!description || /^[>|]/.test(description))
						throw new Error(`${file}: no readable description in its frontmatter`);
					return { name, description, text };
				});
			return {
				contents: `export const LIBRARY_SKILLS = ${JSON.stringify(skills)};`,
				loader: "js",
				watchFiles: files,
				watchDirs: [dir],
			};
		});
	},
};

/**
 * marked's ES module entry: Tabkyra's own copy (package.json), which mini-lit's MarkdownBlock shares.
 * Its package.json "browser" field points at a UMD build, so the module entry is named directly.
 */
function markedEntry() {
	const candidates = [
		join(packageRoot, "node_modules/marked"),
		join(packageRoot, "node_modules/@mariozechner/mini-lit/node_modules/marked"),
	];
	for (const dir of candidates) {
		const pkgPath = join(dir, "package.json");
		if (!existsSync(pkgPath)) continue;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		return join(dir, pkg.module ?? pkg.main);
	}
	throw new Error("marked not found; run scripts/setup-siblings.sh");
}

const buildOptions = {
	plugins: [stripRemovedSignIns, librarySkills, localOnnxRuntime],
	absWorkingDir: packageRoot,
	entryPoints,
	bundle: true,
	outdir: outDir,
	format: "esm",
	target: ["chrome120"],
	platform: "browser",
	sourcemap: isWatch ? "inline" : true,
	entryNames: "[name]",
	loader: {
		".ts": "ts",
		".tsx": "tsx",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
		"process.env.TARGET_BROWSER": JSON.stringify(targetBrowser),
		global: "globalThis",
		// Set in run(), after the version bump: what this build was made from (src/update/build.ts).
		__TABKYRA_BUILD__: "undefined",
	},
	inject: [join(packageRoot, "scripts/process-shim.js")],
	// Let bare imports inside the bundled pi-mono source resolve against pi-mono's
	// installed dependencies (openai, @anthropic-ai/sdk, typebox, ...).
	nodePaths: [join(packageRoot, "../pi-mono/node_modules")],
	// Force all mini-lit and lit imports to resolve to tabkyra's node_modules
	alias: {
		process: join(packageRoot, "scripts/process-shim.js"),
		"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
		// Bundle the sibling pi-mono packages straight from TypeScript source. Their
		// published entrypoints are dist/ builds that require the tsgo toolchain; pointing
		// esbuild at src/ lets us build without pre-compiling them.
		"@mariozechner/pi-ai": join(packageRoot, "../pi-mono/packages/ai/src/index.ts"),
		"@mariozechner/pi-agent-core": join(packageRoot, "../pi-mono/packages/agent/src/index.ts"),
		"@mariozechner/pi-web-ui": join(packageRoot, "../pi-mono/packages/web-ui/src/index.ts"),
		// The notebook preview (src/artifacts) and mini-lit's MarkdownBlock share one copy of marked.
		marked: markedEntry(),
		// One copy each of SheetJS and JSZip for pi-web-ui and src/artifacts: Tabkyra's own, the
		// copies test/artifact-previews.test.mjs exercises. highlight.js stays on pi-web-ui's copy.
		xlsx: join(packageRoot, "node_modules/xlsx"),
		jszip: join(packageRoot, "node_modules/jszip"),
		"highlight.js": join(packageRoot, "../pi-mono/node_modules/highlight.js"),
		lit: join(packageRoot, "node_modules/lit"),
		"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
};

// ============================================================================
// VERSIONING
// ============================================================================
// Every production build bumps the version. Each component runs 1..10; when one
// would exceed 10 it rolls over to 1 and the next-higher component increments:
//   1.1.1 -> 1.1.2 -> ... -> 1.1.10 -> 1.2.1 -> ... -> 1.10.10 -> 2.1.1 -> ...
// Major caps at 10 (stays at 10.10.10). Watch/dev rebuilds do NOT bump.
const computeNextVersion = (version) => {
	const parts = String(version)
		.split(".")
		.map((p) => Number.parseInt(p, 10));
	let [major, minor, patch] = parts;
	// If the current version is outside the 1..10 scheme, snap to the baseline.
	const inScheme = [major, minor, patch].every((n) => Number.isInteger(n) && n >= 1 && n <= 10);
	if (!inScheme) return "1.1.1";
	patch += 1;
	if (patch > 10) {
		patch = 1;
		minor += 1;
	}
	if (minor > 10) {
		minor = 1;
		major += 1;
	}
	if (major > 10) {
		return "10.10.10"; // cap
	}
	return `${major}.${minor}.${patch}`;
};

const bumpVersion = () => {
	const manifestPath = join(packageRoot, "static/manifest.chrome.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const current = manifest.version || "1.0.0";
	const next = computeNextVersion(current);
	if (next === current) {
		console.log(`Version: ${current} (capped)`);
		return next;
	}
	manifest.version = next;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	// Keep package.json in sync so the repo version matches the shipped manifest.
	try {
		const pkgPath = join(packageRoot, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		pkg.version = next;
		writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	} catch {
		// non-fatal
	}

	console.log(`Version: ${current} -> ${next}`);
	return next;
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

const copyStatic = () => {
	// Use browser-specific manifest
	const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(outDir, "manifest.json");
	copyFileSync(manifestSource, manifestDest);

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(packageRoot, relative);
		const destination = join(outDir, filename);
		copyFileSync(source, destination);
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(packageRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(packageRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(outDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	// The ONNX runtime the dictation worker runs models with, shipped inside the extension so no
	// code is loaded from a CDN (src/dictation/worker.ts points the runtime here).
	// The copy transformers.js itself resolves, so the wasm matches the JS glue bundled with it.
	const fromTransformers = createRequire(createRequire(import.meta.url).resolve("@huggingface/transformers"));
	const ortEntry = fromTransformers.resolve("onnxruntime-web");
	const ortSource = join(
		ortEntry.slice(0, ortEntry.lastIndexOf("onnxruntime-web") + "onnxruntime-web".length),
		"dist",
	);
	const ortDest = join(outDir, "ort");
	mkdirSync(ortDest, { recursive: true });
	for (const file of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"])
		copyFileSync(join(ortSource, file), join(ortDest, file));
	if (readFileSync(join(outDir, "dictation-worker.js"), "utf8").includes("cdn.jsdelivr.net/npm/onnxruntime"))
		throw new Error("dictation-worker.js still points the ONNX runtime at jsDelivr");

	writeFileSync(join(outDir, "build-info.json"), `${JSON.stringify(info, null, "\t")}\n`);

	console.log(`Built for ${targetBrowser} in ${outDir}`);
};

/** Set once per run, after any version bump, so the bundle and build-info.json agree. */
let info;

const run = async () => {
	if (isWatch) {
		info = buildInfo(packageRoot);
		buildOptions.define.__TABKYRA_BUILD__ = JSON.stringify(info);
		const ctx = await context(buildOptions);
		await ctx.watch();
		copyStatic();

		// Watch the entire static directory
		watch(staticDir, { recursive: true }, (eventType) => {
			if (eventType === "change") {
				console.log(`\nStatic files changed, copying...`);
				copyStatic();
			}
		});

		// Watch the manifest file for the target browser
		const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
		watch(manifestSource, (eventType) => {
			if (eventType === "change") {
				console.log(`\nManifest changed, copying...`);
				copyStatic();
			}
		});

		process.stdout.write("Watching for changes...\n");
	} else {
		// `tabkyra setup` builds with TABKYRA_NO_BUMP=1 so installing never edits the checkout.
		if (!process.env.TABKYRA_NO_BUMP) bumpVersion();
		info = buildInfo(packageRoot);
		buildOptions.define.__TABKYRA_BUILD__ = JSON.stringify(info);
		await build(buildOptions);
		copyStatic();
		// The stylesheet is generated by Tailwind; without it the side panel renders unstyled.
		// `npm run build` also runs this step, but a direct invocation must produce a complete bundle.
		execSync(`npx tailwindcss -i ./src/app.css -o ${JSON.stringify(join(outDir, "app.css"))} --minify`, {
			cwd: packageRoot,
			stdio: "inherit",
		});
	}
};

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
