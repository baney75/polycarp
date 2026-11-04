// Regression checks on what bundled skills tell an agent to do. The lint checks a skill's
// safety and shape; these check that specific instructions stay correct after review found
// them wrong: commands are run where the tool exists, and wording is pinned where it isn't.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const skill = (name) => readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8");
const root = mkdtempSync(join(tmpdir(), "tabkyra-skill-content-"));
after(() => rmSync(root, { recursive: true, force: true }));
const has = (cmd) => spawnSync(cmd, ["-version"], { encoding: "utf8" }).status === 0;
const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;

/** The one fenced block of a language in a skill, with the step's indent removed. */
function fenced(text, lang) {
	const m = text.match(new RegExp(`\\n( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n *\`\`\``));
	assert.ok(m, `a ${lang} block`);
	return m[2]
		.split("\n")
		.map((l) => l.slice(m[1].length))
		.join("\n");
}

test("notes: the rename helper leaves external URLs alone and takes titles literally", { skip: !hasPython && "no python3" }, () => {
	assert.ok(skill("notes").includes('none of\n   `# | ^ [ ] \\ / : * " < > ?`'), "step 7 lists every character check refuses");
	const helper = join(root, "note_rename.py");
	writeFileSync(helper, fenced(skill("notes"), "python"));
	const py = (...args) => spawnSync("python3", ["-I", helper, ...args], { encoding: "utf8" });

	const vault = join(root, "vault");
	mkdirSync(join(vault, "School"), { recursive: true });
	writeFileSync(join(vault, "School", "Bio.md"), "# Bio\n");
	const linker = join(vault, "Links.md");
	writeFileSync(
		linker,
		[
			"[[Bio]] [[School/Bio|b]] ![[bio#Cells]] [local](School/Bio.md) [ext](https://example.org/Bio.md) [[MyBio]]",
			"| [[Bio\\|b]] | [ab](<School/Bio.md>) | [t](School/Bio.md \"lecture\") | [h](<School/Bio.md#Cells> 'x') |",
		].join("\n"),
	);
	mkdirSync(join(vault, "Other"));
	const rel = join(vault, "Other", "Rel.md");
	const near = join(vault, "School", "Near.md");
	writeFileSync(rel, "[[../School/Bio]] [[chool/Bio]] `[[Bio]]`\n```\n[[Bio]] [x](School/Bio.md)\n```\n");
	writeFileSync(near, "[[./Bio|here]]\n");
	const forms = join(vault, "Forms.md");
	const kept = "~~~\n[[Bio]]\n~~~\n\n    [[Bio]] in indented code\n";
	writeFileSync(forms, `See [lesson][bio].\n\n[bio]: School/Bio.md "notes"\n[ab]: <School/Bio.md>\n\n- list\n    - nested [[Bio]]\n\n    - loose nested [[Bio]]\n\n${kept}`);
	for (const bad of ["Bio #2", "Plan | v2", "a/b", "x:y"]) assert.equal(py("check", vault, "School/Bio.md", bad).status, 1, bad);
	assert.equal(py("check", vault, "School/Bio.md", "Biology 101").status, 0);
	renameSync(join(vault, "School", "Bio.md"), join(vault, "School", "Biology 101.md"));
	assert.equal(py("relink", vault, "School/Bio.md", "Biology 101").status, 0);
	assert.equal(py("verify", vault, "School/Bio.md", "Biology 101").status, 0);
	const text = readFileSync(linker, "utf8");
	assert.match(text, /\[ext\]\(https:\/\/example\.org\/Bio\.md\)/, "the external URL is untouched");
	assert.match(text, /\[local\]\(School\/Biology%20101\.md\)/);
	assert.match(text, /\[\[Biology 101\]\] \[\[School\/Biology 101\|b\]\] !\[\[Biology 101#Cells\]\]/);
	assert.match(text, /\[\[MyBio\]\]/);
	assert.ok(text.includes("| [[Biology 101\\|b]] |"), "a table-escaped alias link is relinked");
	assert.ok(text.includes("[ab](<School/Biology 101.md>)"), "an angle-bracket destination is relinked");
	assert.ok(text.includes('[t](School/Biology%20101.md "lecture")'), "a titled destination is relinked");
	assert.ok(text.includes("[h](<School/Biology 101.md#Cells> 'x')"));
	for (const left of ["| [[Bio\\|b]] |", "[a](<School/Bio.md>)", '[t](School/Bio.md "lecture")']) {
		writeFileSync(join(vault, "Left.md"), `${left}\n`);
		assert.equal(py("verify", vault, "School/Bio.md", "Biology 101").status, 1, `verify sees ${left}`);
	}
	rmSync(join(vault, "Left.md"));
	assert.equal(readFileSync(rel, "utf8"), "[[../School/Biology 101]] [[chool/Bio]] `[[Bio]]`\n```\n[[Bio]] [x](School/Bio.md)\n```\n", "relative link relinked; suffix and code untouched");
	assert.equal(readFileSync(near, "utf8"), "[[./Biology 101|here]]\n");
	assert.equal(
		readFileSync(forms, "utf8"),
		`See [lesson][bio].\n\n[bio]: School/Biology%20101.md "notes"\n[ab]: <School/Biology 101.md>\n\n- list\n    - nested [[Biology 101]]\n\n    - loose nested [[Biology 101]]\n\n${kept}`,
		"reference definitions and nested list items relinked; tilde-fenced and indented code kept byte for byte",
	);
	writeFileSync(join(vault, "Left.md"), "[x][b]\n\n[b]: School/Bio.md\n");
	assert.equal(py("verify", vault, "School/Bio.md", "Biology 101").status, 1, "verify sees a reference definition");
	rmSync(join(vault, "Left.md"));
	for (const left of ["[[../School/Bio]]", "[[./Bio]]"]) {
		writeFileSync(join(vault, "Other", "Left.md"), `${left}\n`);
		writeFileSync(join(vault, "School", "Left.md"), `${left}\n`);
		assert.equal(py("verify", vault, "School/Bio.md", "Biology 101").status, 1, `verify sees ${left}`);
	}
	rmSync(join(vault, "Other", "Left.md"));
	rmSync(join(vault, "School", "Left.md"));

	// A title with regex metacharacters: a leftover link fails verify instead of passing.
	writeFileSync(join(vault, "Q&A (2024).md"), "x\n");
	writeFileSync(join(vault, "Ref.md"), "see [[Q&A (2024)]] and [[C++ notes]]\n");
	assert.equal(py("verify", vault, "Q&A (2024).md", "QA 2024").status, 1);
	writeFileSync(join(vault, "C++ notes.md"), "x\n");
	assert.equal(py("verify", vault, "C++ notes.md", "Cpp notes").status, 1);
	writeFileSync(join(vault, "Alias.md"), "---\naliases: [Q&A (2024)]\n---\n");
	assert.equal(py("check", vault, "Q&A (2024).md", "QA 2024").status, 1, "an alias clash stops the rename");
});

test("video-editing: captions on a trimmed clip are cut to it: straddling cues clipped, none past the end", { skip: !hasPython && "no python3" }, () => {
	const text = skill("video-editing");
	const cut = text.match(/^python3 -I srt_cut\.py 12 47 < cap\.srt > cap-clip\.srt$/m);
	assert.ok(cut, "the worked example cuts the captions");
	assert.match(text, /-i clip\.mp4 -i cap-clip\.srt /, "the cut file is the one muxed");
	for (const line of text.split("\n").filter((l) => /cap\.srt/.test(l) && /-i |subtitles=|< /.test(l))) {
		assert.match(line, /srt_cut\.py/, `only srt_cut.py reads the source-timed cap.srt: ${line.trim()}`);
	}
	assert.doesNotMatch(text, /-itsoffset|-output_ts_offset/, "ffmpeg's packet shift drops a cue that starts before the cut");
	assert.match(text, /-map 0:s:0 check\.srt/, "a soft track is checked by extracting it");
	const dir = mkdtempSync(join(root, "srt-"));
	writeFileSync(join(dir, "srt_cut.py"), fenced(text, "python"));
	const cue = (n, a, b) => `${n}\r\n00:00:${a} --> 00:00:${b}\r\nline ${n}\r\n`;
	writeFileSync(join(dir, "cap.srt"), `\ufeff${[cue(1, "05,000", "07,000"), cue(2, "11,000", "14,000"), cue(3, "20,250", "21,000"), cue(4, "46,000", "50,000"), cue(5, "55,000", "57,000")].join("\r\n")}`);
	const r = spawnSync("bash", ["-c", cut[0]], { cwd: dir, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const out = readFileSync(join(dir, "cap-clip.srt"), "utf8");
	const cues = [...out.matchAll(/^(\S+) --> (\S+)$/gm)].map((m) => `${m[1]}-${m[2]}`);
	assert.deepEqual(cues, ["00:00:00,000-00:00:02,000", "00:00:08,250-00:00:09,000", "00:00:34,000-00:00:35,000"]);
	assert.match(out, /^1\n00:00:00,000 --> 00:00:02,000\nline 2\n/, "renumbered, text kept, BOM and CRLF read");
	if (!has("ffmpeg")) return;
	const mk = ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=35", "-c:v", "libx264", "-preset", "ultrafast", "clip.mp4"];
	assert.equal(spawnSync("ffmpeg", mk, { cwd: dir }).status, 0);
	const mux = text.match(/^(ffmpeg -i clip\.mp4 -i cap-clip\.srt .*clip-cc\.mp4)$/m)[1].replace("-c:a copy ", "");
	assert.equal(spawnSync("bash", ["-c", mux.replace(/^ffmpeg /, "ffmpeg -v error -y ")], { cwd: dir }).status, 0);
	const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=duration", "-of", "csv=p=0", "clip-cc.mp4"], { cwd: dir, encoding: "utf8" });
	for (const d of dur.stdout.trim().split("\n")) assert.ok(Number(d) <= 35.05, `no stream runs past the clip: ${dur.stdout}`);
});

test("video-editing: clips that differ, or have no audio, are normalized before a join", () => {
	const text = skill("video-editing");
	const norm = text.match(/`(ffmpeg -i a\.mp4 -vf "scale=[^`]+ n-a\.mp4)`/);
	assert.ok(norm, "step 5 has a normalize command");
	for (const opt of ["fps=", "pad=", "setsar=1", "-ar ", "-ac ", "-pix_fmt yuv420p"]) assert.ok(norm[1].includes(opt), opt);
	if (!has("ffmpeg")) return;
	const dir = mkdtempSync(join(root, "join-"));
	const make = (name, size, rate, ar, ac) =>
		spawnSync(
			"ffmpeg",
			["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=2`, "-f", "lavfi", "-i", `sine=d=2:sample_rate=${ar}`]
				.concat(["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ac", ac, "-shortest", name]),
			{ cwd: dir },
		).status;
	assert.equal(make("a.mp4", "1280x720", 24, 44100, "1"), 0);
	assert.equal(make("b.mp4", "1920x1080", 30, 48000, "2"), 0);
	const silence = text.match(/gets silence: add `([^`]+)`/);
	assert.ok(silence, "step 5 says how a clip without audio gets silence");
	const r0 = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "s.mp4"], { cwd: dir });
	assert.equal(r0.status, 0);
	for (const c of ["s", "a", "b"]) {
		let cmd = norm[1].replaceAll("a.mp4", `${c}.mp4`).replace("-crf 18", "-crf 18 -preset ultrafast");
		if (c === "s") cmd = cmd.replace("-i s.mp4", `-i s.mp4 ${silence[1]}`);
		const r = spawnSync("bash", ["-c", cmd.replace(/^ffmpeg /, "ffmpeg -v error -y ")], { cwd: dir, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	}
	writeFileSync(join(dir, "list.txt"), "file 'n-s.mp4'\nfile 'n-a.mp4'\nfile 'n-b.mp4'\n");
	assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], { cwd: dir }).status, 0);
	const probe = (sel) =>
		Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", sel, "-show_entries", "stream=duration", "-of", "csv=p=0", "joined.mp4"], { cwd: dir, encoding: "utf8" }).stdout);
	assert.ok(Math.abs(probe("v:0") - 6) < 0.1, `joined video ${probe("v:0")}`);
	assert.ok(Math.abs(probe("a:0") - 6) < 0.15, `joined audio ${probe("a:0")}, silent intro included`);
});

test("email-organization: read-back checks the row's own mail, and every count in the example was searched", () => {
	const text = skill("email-organization");
	const step8 = text.slice(text.indexOf("8. **Read back"), text.indexOf("9. **Report"));
	assert.match(step8, /query plus `-label:/, "label membership is checked on the row's query");
	assert.doesNotMatch(step8, /search `label:Receipts`; with Existing mail yes the count must match/);
	assert.match(step8, /with no,[^.]*count before applying[^.]*must not change/, "a future-only archive row keeps existing inbox mail");
	const example = text.slice(text.indexOf("## Worked example"));
	const counts = [...example.matchAll(/"1-50 of ([\d,]+)"/g)].map((m) => m[1]);
	for (const n of ["214", "402", "1,380"]) assert.ok(counts.includes(n), `a count header for ${n}`);
	const shops = example.match(/#search\/from%3A\(([^)]*receipts[^)]*)\)/);
	assert.equal(shops[1].split("+OR+").length, 3, "the 3-shop row's query names 3 senders");
	assert.match(example, /3 shops/);
});

test("chemistry: a mixing question reads SDS section 10, not only GHS codes", () => {
	const text = skill("chemistry");
	assert.match(text, /\*\*Mixing or storing two chemicals together\*\*[\s\S]*?section\s+10 \(stability and reactivity/);
	assert.match(text, /^- A mixing answer names the reaction product and quotes section 10 of both SDSs\.$/m);
	assert.match(text, /^- Mixing hazards come from SDS section 10, not from GHS codes\.$/m);
});

test("office-docs: the Downloads snapshot goes to a private mktemp file, never a fixed /tmp path", () => {
	const text = skill("office-docs");
	assert.doesNotMatch(text, /\/tmp\//);
	assert.match(text, /snap=\$\(mktemp\)/);
	assert.match(text, /rm -f "\[snap\]"/);
});

test("proton: a username in a Pass result row is list text; navigate and wait are allowed on Pass", () => {
	const text = skill("proton");
	assert.doesNotMatch(text, /shows a username, password or code, an item is open/);
	assert.match(text, /Each result row shows a username or email under its title/);
	assert.match(text, /an item's detail pane means an item is open/);
	// Steps 1 and 2 navigate and wait on Pass; step 15 and Done when must allow that.
	assert.match(text, /\(`status`, `navigate`, `wait` and `tabs_show` are fine\)/);
	assert.doesNotMatch(text, /On pass\.proton\.me only `find`, `type`, `click` and `press` ran/);
	assert.match(text, /On pass\.proton\.me no `get_page_text`, `get_page_html`, `screenshot` or `read_page` ran/);
});

test("skill-platform doc states the evidence rule at min(catalog size, 13) skills", () => {
	const doc = readFileSync(join(repo, "docs", "skill-platform.md"), "utf8");
	assert.match(doc, /min\(catalog size, 13\)/);
	// The measured figures name the case file as it is: total cases and none cases.
	const cases = readFileSync(join(repo, "skills-eval", "router-cases.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
	const none = cases.filter((c) => c.skill === "none").length;
	assert.match(doc, new RegExp(`tuned set of\\s+${cases.length} cases,`), `${cases.length} cases`);
	assert.match(doc, new RegExp(`false invokes 0% \\(0 of ${none}\\)`), `${none} none cases`);
});
