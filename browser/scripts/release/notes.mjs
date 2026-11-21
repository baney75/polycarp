#!/usr/bin/env node
// Release notes for a version from CHANGELOG.md: node scripts/release/notes.mjs 1.2.0 > notes.md
// The body opens with a summary of every section that fits in the first 8,000 characters, which
// is all an installed host (1.1.9 and earlier) keeps for the side panel's "What's new". The full
// notes follow in a collapsed block, so the release page still has every word.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fitNotes } from "../../cli/src/release-notes.ts";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const core = version.replace(/-.*/, "");
const log = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "CHANGELOG.md"), "utf8").replace(
	/\r\n?/g,
	"\n",
);
const heading = new RegExp(`## \\[${core.replace(/\./g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
const notes = log.match(heading)?.[1].trim() ?? "";
const summary = fitNotes(notes, 6500);
const body =
	summary === notes
		? notes
		: `${summary}\n\n<details>\n<summary>Full release notes</summary>\n\n${notes}\n\n</details>`;
process.stdout.write(
	`${body}\n\n---\n\nUpdate with \`tabkyra update\` (it verifies the minisign signature and the checksum), then reload Tabkyra.\n`,
);
