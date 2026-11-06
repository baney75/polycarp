// Mechanical checks on the text of the artifacts, visual-explainer and mechanism-design skills:
// rules a reviewer found broken once and that a test can hold. The browser behaviour behind
// them (the CSP blocking injected script, the 375px iframe) was checked live in Tabkyra.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, "..", "..", "skills");
const read = (name) => readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

const HTML_SKILLS = ["artifacts", "visual-explainer"];
const CHECKED = [...HTML_SKILLS, "mechanism-design"];
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'self'";
const TOOLS = ["run_js", "navigate", "read_console", "read_network", "screenshot", "tabs_close", "tabs_create", "get_page_text", "read_page"];

/** Every `tool {...}` call written in inline code. */
function toolCalls(text) {
	const out = [];
	for (const m of text.matchAll(new RegExp(`\`(${TOOLS.join("|")}) (\\{.*?\\})\``, "g"))) out.push({ tool: m[1], json: m[2] });
	return out;
}

test("both HTML skills require the same Content-Security-Policy, and neither allows inline script", () => {
	for (const name of HTML_SKILLS) {
		const text = flat(read(name));
		assert.ok(text.includes(POLICY), `${name} must state the policy: ${POLICY}`);
		assert.doesNotMatch(text, /script-src '?unsafe-inline/, `${name} must never allow unsafe-inline scripts`);
		assert.match(text, /policy is the (step 6 one|skeleton's), word for word except a `sha256` script-src/, `${name}'s check must compare the policy word for word`);
	}
});

test("every tool call in these skills is valid JSON, and tabs_close always names a tabId", () => {
	for (const name of CHECKED) {
		const calls = toolCalls(read(name));
		assert.ok(calls.length > 0, `${name} has tool calls`);
		for (const c of calls) {
			// N stands for the tabId the skill says to take from navigate.
			assert.doesNotThrow(() => JSON.parse(c.json.replace(/:N\}/g, ":0}")), `${name}: ${c.tool} ${c.json}`);
		}
		for (const m of read(name).matchAll(/`tabs_close[^`]*`/g)) assert.match(m[0], /"tabId":/, `${name}: ${m[0]}`);
	}
});

test("every run_js check is one JavaScript expression (run_js rejects statements)", () => {
	for (const name of HTML_SKILLS) {
		const codes = toolCalls(read(name))
			.filter((c) => c.tool === "run_js")
			.map((c) => JSON.parse(c.json).code);
		assert.ok(codes.length >= 3, `${name} has its run_js checks`);
		for (const code of codes) assert.doesNotThrow(() => new Function(`return (${code});`), `${name}: ${code}`);
	}
});

test("the decorative-SVG rule and the unlabeled-SVG check agree", () => {
	for (const name of HTML_SKILLS) {
		const text = read(name);
		assert.ok(text.includes("svg:not([aria-hidden=true]):not(svg svg):not([role=img][aria-label])"), `${name} skips decorative and nested SVGs`);
	}
	assert.match(flat(read("visual-explainer")), /defs-only SVG gets `aria-hidden="true"`/);
});

test("a failed safety check is never handed over as done", () => {
	for (const name of HTML_SKILLS) {
		const done = flat(read(name).split("## Done when")[1].split("## ")[0]);
		assert.match(done, /If one failed, it is not done/, `${name}`);
		assert.doesNotMatch(done, /or the hand-over names the one that didn't/, `${name}`);
	}
});

test("mechanism-design's worked example matches its own formulas", () => {
	const text = flat(read("mechanism-design"));
	// The four-bar sweep exactly as step 7 states it: z^2 = a^2 + d^2 - 2ad cos t, cos mu from
	// step 6, rocker angle atan2(-a sin t, d - a cos t) + acos((c^2 + z^2 - b^2) / (2cz)).
	const sweep = (a, b, c, d) => {
		const mus = [];
		const rocker = [];
		for (let deg = 0; deg < 360; deg++) {
			const t = (deg * Math.PI) / 180;
			const z = Math.sqrt(a * a + d * d - 2 * a * d * Math.cos(t));
			const cosMu = (b * b + c * c - a * a - d * d + 2 * a * d * Math.cos(t)) / (2 * b * c);
			mus.push((Math.acos(cosMu) * 180) / Math.PI);
			rocker.push(((Math.atan2(-a * Math.sin(t), d - a * Math.cos(t)) + Math.acos((c * c + z * z - b * b) / (2 * c * z))) * 180) / Math.PI);
		}
		return { muMin: Math.min(...mus), muMax: Math.max(...mus), swing: Math.max(...rocker) - Math.min(...rocker) };
	};
	const first = sweep(20, 60, 45, 55);
	assert.equal(first.swing.toFixed(0), "60");
	assert.equal(first.muMin.toFixed(1), "35.4");
	assert.ok(text.includes("mu min 35.4 degrees"));
	const second = sweep(17, 60, 35, 70);
	assert.equal(second.swing.toFixed(1), "58.5");
	assert.equal(`${second.muMin.toFixed(1)}-${second.muMax.toFixed(1)}`, "61.3-130.8");
	assert.ok(text.includes("swing 58.5 degrees, mu 61.3-130.8 degrees"));
	// The dead-centre formula gives the same full-turn swing.
	const phi = (s) => (Math.acos((35 * 35 + 70 * 70 - s * s) / (2 * 35 * 70)) * 180) / Math.PI;
	assert.equal((phi(77) - phi(43)).toFixed(1), "58.5");
});

test("visual-explainer carries the upstream MIT notice in the installed text and the folder", () => {
	const text = flat(read("visual-explainer"));
	assert.ok(text.includes("Copyright (c) 2025 Nico Bailon"));
	assert.ok(text.includes("The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."));
	assert.ok(existsSync(join(skillsDir, "visual-explainer", "LICENSE")));
});
