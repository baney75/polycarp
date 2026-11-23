#!/usr/bin/env node
/* Build the Polycarp audio library (Kokoro TTS) into extension/lib/audio/.

   Usage:
     node scripts/build-audio.mjs --deps <dir>
   or
     POLYCARP_AUDIO_DEPS=<dir> node scripts/build-audio.mjs

   <dir> is a folder OUTSIDE the project with a package.json and node_modules
   holding the pinned packages below plus esbuild. Set it up once with:
     npm install --save-exact kokoro-js@1.2.1 esbuild@0.28.2 \
       @huggingface/transformers@3.8.1 onnxruntime-web@1.22.0-dev.20250409-89f8206ba4

   Output (all code is local, nothing is loaded from a CDN at runtime):
     kokoro.mjs                          kokoro-js + transformers.js + onnxruntime-web (ESM)
     phonemizer.mjs                      phonemizer 1.2.1 (eSpeak NG compiled to wasm), unmodified upstream file
     ort-wasm-simd-threaded.jsep.wasm    the one onnxruntime wasm used (serves WebGPU and WASM)
     licenses/                           license texts of every bundled package plus GPL-3.0 for eSpeak NG

   The build fails if any shipped file still names a CDN (jsdelivr, unpkg, cdnjs, cdn.*). */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINS = {
  "kokoro-js": "1.2.1",
  "@huggingface/transformers": "3.8.1",
  "onnxruntime-web": "1.22.0-dev.20250409-89f8206ba4",
  phonemizer: "1.2.1"
};
const WASM_FILE = "ort-wasm-simd-threaded.jsep.wasm";
// eSpeak NG ships the GPL-3.0 text as COPYING; pinned to a tag so the text is stable.
const GPL_URL = "https://raw.githubusercontent.com/espeak-ng/espeak-ng/1.52.0/COPYING";
const CDN_PATTERN = /jsdelivr|unpkg\.com|cdnjs|\bcdn\.[a-z]/i;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "extension", "lib", "audio");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const depsDir = path.resolve(argValue("--deps") || process.env.POLYCARP_AUDIO_DEPS || "");
if (!depsDir || !fs.existsSync(path.join(depsDir, "node_modules"))) {
  console.error("build-audio: pass --deps <dir> (or POLYCARP_AUDIO_DEPS) pointing at a folder with node_modules.");
  process.exit(2);
}
if (depsDir.startsWith(root + path.sep)) {
  console.error("build-audio: the deps folder must be outside the project.");
  process.exit(2);
}

const nm = path.join(depsDir, "node_modules");
const require = createRequire(path.join(depsDir, "package.json"));
const esbuild = require("esbuild");

function pkgJson(name) {
  return JSON.parse(fs.readFileSync(path.join(nm, name, "package.json"), "utf8"));
}

// 1. Exact versions only.
for (const [name, want] of Object.entries(PINS)) {
  const have = pkgJson(name).version;
  if (have !== want) throw new Error(`build-audio: ${name} is ${have}, expected ${want}`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "licenses"), { recursive: true });

// 2. Bundle. transformers.js defaults the onnxruntime wasm path to jsDelivr; rewrite it to the
//    folder of the bundle itself. The worker also sets the path explicitly; this is a second lock.
const localWasmPaths = {
  name: "local-wasm-paths",
  setup(build) {
    build.onResolve({ filter: /^phonemizer$/ }, () => ({ path: "./phonemizer.mjs", external: true }));
    // transformers.js and onnxruntime-web must share one onnxruntime-common (its Tensor class).
    // npm hoists onnxruntime-node's older copy to the top; use the one onnxruntime-web ships with.
    build.onResolve({ filter: /^onnxruntime-common$/ }, () => {
      const nested = path.join(nm, "onnxruntime-web/node_modules/onnxruntime-common");
      const dir = fs.existsSync(nested) ? nested : path.join(nm, "onnxruntime-common");
      const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      return { path: path.join(dir, pj.exports?.["."]?.import || pj.module || "dist/esm/index.js") };
    });
    build.onLoad({ filter: /transformers[\\/]dist[\\/]transformers\.web\.js$/ }, async (args) => {
      let src = await fs.promises.readFile(args.path, "utf8");
      const re = /`https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\$\{[^}`]+\}\/dist\/`/g;
      const hits = src.match(re) || [];
      if (hits.length !== 1) {
        throw new Error(`build-audio: expected 1 jsDelivr wasmPaths default in transformers.js, found ${hits.length}. Upstream moved; update the plugin.`);
      }
      src = src.replace(re, 'new URL("./", import.meta.url).href');
      return { contents: src, loader: "js" };
    });
  }
};

const result = await esbuild.build({
  stdin: {
    contents: [
      'export { KokoroTTS, env } from "kokoro-js";',
      'export { env as transformersEnv } from "@huggingface/transformers";'
    ].join("\n"),
    resolveDir: depsDir,
    sourcefile: "polycarp-kokoro-entry.mjs",
    loader: "js"
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  legalComments: "eof",
  outfile: path.join(outDir, "kokoro.mjs"),
  metafile: true,
  logLevel: "warning",
  plugins: [localWasmPaths]
});

// 3. Copy the one wasm variant onnxruntime-web's default bundle loads, and phonemizer as is.
const ortBundle = fs.readFileSync(path.join(nm, "onnxruntime-web/dist/ort.bundle.min.mjs"), "utf8");
if (!ortBundle.includes(WASM_FILE)) throw new Error(`build-audio: ort bundle no longer loads ${WASM_FILE}`);
fs.copyFileSync(path.join(nm, "onnxruntime-web/dist", WASM_FILE), path.join(outDir, WASM_FILE));
fs.copyFileSync(path.join(nm, "phonemizer/dist/phonemizer.js"), path.join(outDir, "phonemizer.mjs"));

// 4. Licenses for every package that ended up in the output.
const MIT_MICROSOFT = "MIT License\n\nCopyright (c) Microsoft Corporation.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n";
// phonemizer and the ort wasm are copied, not bundled; @huggingface/jinja is inlined inside
// transformers.web.js by its own build, so the metafile does not list it.
const pkgDirs = new Map([
  ["phonemizer", path.join(nm, "phonemizer")],
  ["onnxruntime-web", path.join(nm, "onnxruntime-web")],
  ["@huggingface/jinja", path.join(nm, "@huggingface/jinja")]
]);
for (const input of Object.keys(result.metafile.inputs)) {
  const abs = path.resolve(input); // metafile paths are relative to the working directory
  const m = abs.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (m) pkgDirs.set(m[2], m[1]);
}
const notices = [];
for (const [name, dir] of [...pkgDirs].sort()) {
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const lic = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const dest = path.join(outDir, "licenses", `${name.replace("/", "__")}.LICENSE.txt`);
  if (lic) fs.copyFileSync(path.join(dir, lic), dest);
  else if (name.startsWith("onnxruntime-") && pj.license === "MIT") fs.writeFileSync(dest, MIT_MICROSOFT);
  else throw new Error(`build-audio: no license text for ${name}`);
  notices.push(`${name}@${pj.version}  ${pj.license}`);
}

const gplCache = path.join(depsDir, "espeak-ng-COPYING.txt");
if (!fs.existsSync(gplCache)) {
  const res = await fetch(GPL_URL);
  if (!res.ok) throw new Error(`build-audio: could not fetch ${GPL_URL}: ${res.status}`);
  fs.writeFileSync(gplCache, await res.text());
}
fs.copyFileSync(gplCache, path.join(outDir, "licenses", "eSpeak-NG.GPL-3.0.txt"));

fs.writeFileSync(path.join(outDir, "licenses", "NOTICE.txt"), [
  "Polycarp audio library: third party components",
  "",
  ...notices,
  "",
  "phonemizer.mjs is the unmodified dist/phonemizer.js of phonemizer@" + PINS.phonemizer + " (https://github.com/xenova/phonemizer).",
  "It contains eSpeak NG (https://github.com/espeak-ng/espeak-ng) compiled to WebAssembly, with its English data.",
  "eSpeak NG is licensed GPL-3.0-or-later; see eSpeak-NG.GPL-3.0.txt. Source: the phonemizer and espeak-ng repositories above.",
  "",
  "Model weights and voices (onnx-community/Kokoro-82M-v1.0-ONNX, Apache-2.0) are not shipped;",
  "they are downloaded from Hugging Face at the user's request and cached by the browser.",
  ""
].join("\n"));

// 5. No CDN load paths anywhere in shipped audio code.
const shipped = [
  ...fs.readdirSync(outDir).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(outDir, f)),
  ...fs.readdirSync(path.join(root, "extension/src/audio"))
    .filter((f) => /\.(m?js|html)$/.test(f) && !f.startsWith("dev-"))
    .map((f) => path.join(root, "extension/src/audio", f))
];
const bad = [];
for (const file of shipped) {
  const text = fs.readFileSync(file, "utf8");
  const re = new RegExp(CDN_PATTERN.source, "gi");
  let m;
  while ((m = re.exec(text))) bad.push(`${path.relative(root, file)}: ...${text.slice(Math.max(0, m.index - 60), m.index + 60)}...`);
}
if (bad.length) {
  for (const b of bad) console.error("CDN reference: " + b);
  fs.rmSync(outDir, { recursive: true, force: true });
  throw new Error(`build-audio: ${bad.length} CDN reference(s) in shipped files; output removed.`);
}

let total = 0;
for (const f of fs.readdirSync(outDir, { recursive: true })) {
  const p = path.join(outDir, f);
  if (fs.statSync(p).isFile()) total += fs.statSync(p).size;
}
console.log(`build-audio: ok. ${shipped.length} files scanned, no CDN references. extension/lib/audio is ${(total / 1048576).toFixed(2)} MiB.`);
for (const n of notices) console.log("  " + n);
