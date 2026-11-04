/**
 * Release notes for the side panel's "What's new" card (the GitHub release body, from
 * CHANGELOG.md). The card shows each entry's first sentence, so a body over the limit loses the
 * detail at the end of each bullet first, then the last bullets of the longest sections, and
 * every section keeps at least its first entry. scripts/release/notes.mjs uses it to write the
 * summary at the top of each release body.
 */

export const MAX_NOTES_CHARS = 8000;

/** The line fitNotes adds when it drops entries; the card adds the count to "And N more". */
export const MORE_LINE = /^More: (\d+) entr(?:y|ies) in the full release notes\.$/m;

const isBullet = (line: string) => /^[-*]\s/.test(line);
const isHeading = (line: string) => /^#{2,4}\s/.test(line);

/** Cut a bullet's text to about `max` characters at a word boundary, never inside a code span. */
function shorten(line: string, max: number): string {
	if (line.length <= max) return line;
	const marker = line.slice(0, 2);
	const body = line.slice(2);
	const cut = body.slice(0, max - 2);
	let short = cut.slice(0, Math.max(cut.lastIndexOf(" "), 0));
	if ((short.match(/`/g) ?? []).length % 2) short = short.slice(0, short.lastIndexOf("`")).trimEnd();
	// An entry that opens with a long code span: keep the start of the span and close it.
	if (!short.trim()) short = /^`/.test(cut) ? `\`${cut.replace(/`/g, "").slice(0, max - 7)}\`` : cut;
	return `${marker}${short}…`;
}

/** The notes within `max` characters, every section kept; a plain cut only if even that fails. */
export function fitNotes(body: string, max = MAX_NOTES_CHARS): string {
	const text = body.replace(/\r\n?/g, "\n");
	if (text.length <= max) return text;
	let lines = text.split("\n");
	for (const bullet of [400, 200, 120]) {
		lines = lines.map((line) => (isBullet(line) ? shorten(line, bullet) : line));
		if (lines.join("\n").length <= max) return lines.join("\n");
	}
	// Still too long: drop the last bullets of the sections with the most, one per section kept.
	// One pass to group bullets by section, then drop from the largest until it fits.
	const sections: number[][] = [[]];
	for (let i = 0; i < lines.length; i++) {
		if (isHeading(lines[i])) sections.push([]);
		else if (isBullet(lines[i])) sections[sections.length - 1].push(i);
	}
	const moreLine = (n: number) => `More: ${n} ${n === 1 ? "entry" : "entries"} in the full release notes.`;
	let length = lines.join("\n").length + moreLine(9999).length + 2;
	const dropped = new Set<number>();
	while (length > max) {
		const largest = sections.reduce((a, b) => (b.length > a.length ? b : a));
		if (largest.length <= 1) break;
		const i = largest.pop() as number;
		dropped.add(i);
		length -= lines[i].length + 1;
	}
	const kept = lines.filter((_, i) => !dropped.has(i)).join("\n");
	const out = dropped.size ? `${kept}\n\n${moreLine(dropped.size)}` : kept;
	return out.length <= max ? out : `${out.slice(0, max - 3)}...`;
}

/** What the host keeps of a release body: the summary above the full notes, fitted. */
export function releaseSummary(body: string): string {
	return fitNotes(body.replace(/\r\n?/g, "\n").split(/\n<details>/)[0].trim());
}
