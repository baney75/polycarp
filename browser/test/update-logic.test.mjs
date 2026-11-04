// The update system's decisions (src/update/logic.ts): the no-parameters rule for update
// requests, the idle gate before a reload, where the extension runs from, version mismatches,
// automatic updates and the "What's new" card.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	AUTO_UPDATE_QUIET_MS,
	BRIDGE_RUN_GAP_MS,
	diagnoseVersions,
	digestReleaseNotes,
	idleGate,
	locateExtension,
	offerKey,
	parseUpdateRequest,
	safeLink,
	shouldAutoUpdate,
	UPDATE_ACTIONS,
	whatsNewFor,
} from "../src/update/logic.ts";

const build = (id, commit, version = "1.2.0") => ({ id, commit, version, builtAt: "" });

test("an update request is exactly {type, action} with a known action", () => {
	for (const action of UPDATE_ACTIONS) assert.equal(parseUpdateRequest({ type: "update_action", action }), action);
	const refused = [
		{ type: "update_action", action: "update", channel: "nightly" },
		{ type: "update_action", action: "update", args: ["--yes"] },
		{ type: "update_action", action: "update; rm -rf ~" },
		{ type: "update_action", action: "--rollback" },
		{ type: "update_action", action: ["update"] },
		{ type: "update_action" },
		{ type: "hello", action: "update" },
		{ action: "update" },
		["update_action", "update"],
		"update",
		null,
		undefined,
		Object.assign(Object.create({ inherited: 1 }), { type: "update_action", action: "toString" }),
	];
	for (const frame of refused) assert.equal(parseUpdateRequest(frame), undefined, JSON.stringify(frame));
});

test("the idle gate waits for side panel runs and bridge requests", () => {
	const now = 1_000_000;
	const quiet = { now, busyPanels: 0, lastPanelRunAt: 0, bridge: [] };
	assert.deepEqual(idleGate(quiet), { idle: true });
	// A side panel that is opening (#36's pending-open marker) would be closed by a reload.
	const opening = idleGate({ ...quiet, panelsOpening: 1 });
	assert.equal(opening.idle, false);
	assert.match(opening.reason, /side panel is opening/);

	const panel = idleGate({ ...quiet, busyPanels: 1 });
	assert.equal(panel.idle, false);
	assert.match(panel.reason, /side panel/);
	assert.match(idleGate({ ...quiet, busyPanels: 2 }).reason, /2 side panels/);

	const harness = idleGate({ ...quiet, bridge: [{ name: "claude", inFlight: true, lastActivityAt: now }] });
	assert.equal(harness.idle, false);
	assert.match(harness.reason, /claude is using the browser/);

	// A harness between two calls of one run still counts as running for a moment.
	const between = { ...quiet, bridge: [{ name: "codex", inFlight: false, lastActivityAt: now - 5000 }] };
	assert.equal(idleGate(between).idle, false);
	assert.equal(idleGate({ ...between, now: now + BRIDGE_RUN_GAP_MS }).idle, true);

	// Automatic updates also want a few quiet minutes after the last panel run.
	const justEnded = { ...quiet, lastPanelRunAt: now - 60_000 };
	assert.equal(idleGate(justEnded).idle, true);
	assert.equal(idleGate(justEnded, AUTO_UPDATE_QUIET_MS).idle, false);
	assert.equal(idleGate({ ...justEnded, now: now - 60_000 + AUTO_UPDATE_QUIET_MS }, AUTO_UPDATE_QUIET_MS).idle, true);
	const harnessEarlier = { ...quiet, bridge: [{ name: "pi", inFlight: false, lastActivityAt: now - 2 * 60_000 }] };
	assert.equal(idleGate(harnessEarlier).idle, true);
	assert.equal(idleGate(harnessEarlier, AUTO_UPDATE_QUIET_MS).idle, false);
});

test("the extension is located by the build-info.json its folder serves", () => {
	assert.equal(locateExtension("a", "a"), "here");
	assert.equal(locateExtension("a", "b"), "elsewhere");
	assert.equal(locateExtension(undefined, "b"), "unknown");
	assert.equal(locateExtension("a", undefined), "unknown");
});

test("version mismatch: a half-installed update, a stale extension, a stale host", () => {
	const a = build("ext-a", "aaa");
	const aCli = build("cli-a", "aaa");
	const b = build("ext-b", "bbb", "1.2.1");
	const bCli = build("cli-b", "bbb", "1.2.1");

	assert.equal(diagnoseVersions({ extension: b, extensionOnDisk: b, location: "here", host: bCli, cliOnDisk: bCli }), undefined);

	const partial = diagnoseVersions({ extension: a, extensionOnDisk: b, location: "here", host: aCli, cliOnDisk: aCli });
	assert.equal(partial.fix, "reinstall");
	assert.match(partial.reason, /built from different commits/);

	const stale = diagnoseVersions({ extension: a, extensionOnDisk: b, location: "here", host: bCli, cliOnDisk: bCli });
	assert.equal(stale.fix, "reload");
	assert.match(stale.reason, /browser still runs 1\.2\.0 \(aaa\)/);

	// Loaded from another folder: reloading wouldn't help, so it isn't offered.
	assert.equal(diagnoseVersions({ extension: a, extensionOnDisk: b, location: "elsewhere", host: bCli, cliOnDisk: bCli }), undefined);

	const host = diagnoseVersions({ extension: b, extensionOnDisk: b, location: "here", host: aCli, cliOnDisk: bCli });
	assert.equal(host.fix, "reload");
	assert.match(host.reason, /native host/);

	// A rebuild of the same commit is not a mismatch; builds without build-info are skipped.
	const rebuilt = build("ext-a2", "aaa");
	assert.equal(diagnoseVersions({ extension: rebuilt, extensionOnDisk: a, location: "here", host: aCli, cliOnDisk: aCli }), undefined);
	assert.equal(diagnoseVersions({ location: "unknown" }), undefined);
	assert.equal(diagnoseVersions({ extension: a, location: "here", host: aCli }), undefined);
});

test("automatic updates: only with the setting, only something new, never twice", () => {
	const release = { type: "update_status", mode: "release", policy: "auto", available: true, current: "1.2.0", latest: "1.2.1", channel: "stable", checkedAt: 0 };
	assert.equal(shouldAutoUpdate(release), true);
	assert.equal(shouldAutoUpdate({ ...release, policy: "notify" }), false);
	assert.equal(shouldAutoUpdate({ ...release, policy: "off" }), false);
	assert.equal(shouldAutoUpdate({ ...release, available: false }), false);
	assert.equal(shouldAutoUpdate({ ...release, blocked: "local changes" }), false);
	assert.equal(shouldAutoUpdate({ ...release, error: "offline" }), false);
	assert.equal(shouldAutoUpdate({ ...release, mismatch: { fix: "reload", reason: "x" } }), false);
	assert.equal(shouldAutoUpdate({ ...release, mismatch: { fix: "reinstall", reason: "x" } }), true, "the update rebuilds both anyway");
	assert.equal(shouldAutoUpdate({ ...release, staged: "1.2.1" }), false, "already waiting to install");
	assert.equal(shouldAutoUpdate({ ...release, updating: true }), false);
	assert.equal(shouldAutoUpdate({ ...release, mode: "unmanaged" }), false);
	assert.equal(shouldAutoUpdate(release, offerKey(release)), false, "a failed attempt is not retried");
	assert.equal(shouldAutoUpdate(release, "release:1.2.0"), true);
	// The user rolled back from 1.2.1: don't put it straight back.
	const rolledBack = { ...release, lastUpdate: { id: "x", kind: "rollback", mode: "release", at: 0, from: "1.2.1", to: "1.2.0" } };
	assert.equal(shouldAutoUpdate(rolledBack), false);
	assert.equal(shouldAutoUpdate({ ...rolledBack, latest: "1.2.2" }), true);

	const checkout = { ...release, mode: "checkout", latest: "abc1234", behind: 2 };
	assert.equal(shouldAutoUpdate(checkout), true);
	// After a checkout rollback only the build is behind; that waits for the user or a new commit.
	assert.equal(shouldAutoUpdate({ ...checkout, behind: 0, needsBuild: true }), false);
	assert.equal(shouldAutoUpdate(undefined), false);
});

test("what's new shows after the reload into the new build, until dismissed", () => {
	const last = { id: "u1", kind: "update", mode: "checkout", at: 0, from: "a", to: "b", extensionBuild: "new" };
	assert.equal(whatsNewFor(last, undefined, "old"), undefined, "not before the reload");
	assert.equal(whatsNewFor(last, undefined, "new"), last);
	assert.equal(whatsNewFor(last, "u1", "new"), undefined);
	assert.equal(whatsNewFor({ ...last, kind: "rollback" }, undefined, "new"), undefined);
	assert.equal(whatsNewFor({ ...last, extensionBuild: undefined }, undefined, undefined), undefined);
	assert.equal(whatsNewFor(undefined, undefined, "new"), undefined);
});

test("only https links reach the What's new card", () => {
	assert.equal(safeLink("https://github.com/baney75/tabkyra/compare/a...b"), "https://github.com/baney75/tabkyra/compare/a...b");
	assert.equal(safeLink("javascript:alert(1)"), undefined);
	assert.equal(safeLink("http://example.com"), undefined);
	assert.equal(safeLink("not a url"), undefined);
	assert.equal(safeLink(undefined), undefined);
});

test("release notes become a short digest: first sentence of each entry, grouped, references and markdown stripped", () => {
	const notes = [
		"### Added",
		"- **Update now** in the side panel (docs/updates.md). The host runs a fixed command line.",
		"- Side panel `/` menu runs skills. It lists matching skills first.",
		"- Past chats for local agents (D24): `threads_list` and more. Tests in `test/threads.test.mjs`.",
		"- A fourth addition. More text.",
		"",
		"### Changed",
		"- Settings has [six tabs](https://example.com/settings) that wrap, e.g. on narrow panels. Details follow.",
		"",
		"### Fixed",
		"- The `claude mcp add` command was black on the dark theme (#67). Body now sets the color.",
		"",
		"---",
		"",
		"Update with `tabkyra update`, then reload Tabkyra.",
	].join("\n");
	const d = digestReleaseNotes(notes);
	assert.deepEqual(d?.sections, [
		{ title: "New", items: ["Update now in the side panel.", "Side panel `/` menu runs skills."] },
		{ title: "Changed", items: ["Settings has six tabs that wrap, e.g. on narrow panels."] },
		{ title: "Fixed", items: ["The `claude mcp add` command was black on the dark theme."] },
	]);
	assert.equal(d?.more, 2, "the third and fourth additions are counted, not shown");
	assert.equal(digestReleaseNotes(notes, 3)?.sections[0].items[2], "Past chats for local agents: `threads_list` and more.");
});

test("the real 1.1.9 notes, as the host truncates them, digest to short lines instead of a wall of text", () => {
	const notes = readFileSync(new URL("./fixtures/release-notes-1.1.9.md", import.meta.url), "utf8");
	const d = digestReleaseNotes(notes);
	assert.ok(d);
	const items = d.sections.flatMap((s) => s.items);
	assert.ok(items.length >= 2 && items.length <= 6, `${items.length} items`);
	for (const item of items) {
		assert.ok(item.length <= 180, `too long: ${item}`);
		assert.doesNotMatch(item, /\*\*|\]\(|docs\/|\(D\d+/, item);
		assert.equal((item.match(/`/g) ?? []).length % 2, 0, `unbalanced code span: ${item}`);
	}
	assert.equal(items[0], "Updates from the side panel.");
	assert.equal(digestReleaseNotes(notes, 3)?.sections[0].items[2], "Demo video `media/demo.mp4`.", "a long sentence keeps its lead clause");
	assert.ok(d.more > 0);
});

test("notes with no bullet list are left to the plain-text fallback", () => {
	assert.equal(digestReleaseNotes("Just a paragraph about the release."), undefined);
	assert.equal(digestReleaseNotes(undefined), undefined);
	assert.equal(digestReleaseNotes(""), undefined);
});

test("every section gets its first entry before any gets a second, and code spans are kept exactly", () => {
	const notes = [
		"### Added",
		...["A1.", "A2.", "A3.", "A4.", "A5."].map((x) => `- ${x}`),
		"### Changed",
		...["C1.", "C2.", "C3."].map((x) => `- ${x}`),
		"### Removed",
		"- R1.",
		"- R2.",
		"### Fixed",
		"- F1.",
		"- F2.",
	].join("\n");
	const d = digestReleaseNotes(notes);
	assert.deepEqual(
		d?.sections.map((s) => [s.title, s.items.length]),
		[
			["New", 2],
			["Changed", 2],
			["Removed", 1],
			["Fixed", 1],
		],
	);
	assert.equal(d?.more, 6);
	assert.equal(digestReleaseNotes("### Fixed\n- Reads `__dirname` instead of `__filename`.")?.sections[0].items[0], "Reads `__dirname` instead of `__filename`.");
	const cut = digestReleaseNotes("### Added\n- Adds `tabkyra skill eval --json --update-baseline …")?.sections[0].items[0] ?? "";
	assert.equal((cut.match(/`/g) ?? []).length % 2, 0, cut);
});

test("the digest survives CRLF, keeps a seventh section, strips code-span references and counts dropped entries", () => {
	const crlf = "### Added\r\n- One thing. More.\r\n- Two things.\r\n";
	assert.deepEqual(digestReleaseNotes(crlf)?.sections[0].items, ["One thing.", "Two things."]);
	const seven = ["Breaking changes", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"].map((t) => `### ${t}\n- ${t} entry.`).join("\n");
	const d = digestReleaseNotes(seven);
	assert.equal(d?.sections.length, 7, "every section keeps its first entry, past the total");
	assert.equal(d?.sections[6].title, "Security");
	assert.equal(digestReleaseNotes("### Changed\n- The panel reads settings (`src/settings.ts`). More.")?.sections[0].items[0], "The panel reads settings.");
	assert.equal(digestReleaseNotes("### Added\n- A.\n- B.\n- C.\n\nMore: 40 entries in the full release notes.")?.more, 41);
	const withFull = "### Fixed\n- Short.\n\n<details>\n<summary>Full release notes</summary>\n\n### Added\n- Hidden detail.\n</details>";
	assert.deepEqual(digestReleaseNotes(withFull)?.sections.map((s) => s.title), ["Fixed"], "the summary ends at the full notes");
});
