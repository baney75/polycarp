// Ratchets for the Polycarp extension: every color and duration comes from the theme, every page loads the theme,
// and the old name appears nowhere a user can see it. Run: node --test tests/theme.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const ours = [...walk("src"), ...walk("newtab")].filter((f) => !path.basename(f).startsWith("dev-"));
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

test("stylesheets take colors and durations from the theme", () => {
  for (const f of ours.filter((f) => f.endsWith(".css") && !f.endsWith("theme.css"))) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/i, `${f}: a color literal`);
    assert.doesNotMatch(css, /[\s:(,]\.?\d+(\.\d+)?m?s\b/, `${f}: a raw duration`);
    assert.doesNotMatch(css, /var\(\s*--var\(/, `${f}: a var() nested where a name belongs`);
  }
});

test("scripts hold no color literals except the user's tint choices", () => {
  for (const f of ours.filter((f) => f.endsWith(".js"))) {
    const lines = read(f).split("\n").filter((l) => /#[0-9a-fA-F]{6}\b/.test(l) && !/\{ label: "[^"]+", color: "#[0-9A-F]{6}" \}/.test(l));
    assert.deepEqual(lines, [], `${f}: a color literal`);
  }
});

test("every page loads the theme before its own styles", () => {
  for (const f of ours.filter((f) => f.endsWith(".html"))) {
    const links = [...read(f).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(links.length && /(^|\/)shared\/theme\.css$/.test(links[0]), `${f}: theme.css first (${links.join(", ")})`);
  }
  const war = JSON.parse(read("manifest.json")).web_accessible_resources.flatMap((w) => w.resources);
  assert.ok(war.includes("src/shared/theme.css"), "the content script can read the theme");
});

test("the old name is gone, but for the one line that reads old backups", () => {
  const shipped = [...ours, "manifest.json", "README.md", "PRIVACY.md"];
  const hits = shipped.flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l])).filter(([, , l]) => /phont/i.test(l));
  assert.equal(hits.length, 1, hits.map(([f, n]) => f + ":" + n).join(" "));
  assert.equal(hits[0][0], path.join("src", "shared", "backup.js"));
});
