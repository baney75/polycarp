/**
 * Terminal output: color only on a TTY, never with NO_COLOR or TERM=dumb.
 * FORCE_COLOR turns it on for pipes (tests, CI logs that render ANSI).
 */

import { createInterface } from "node:readline/promises";

function colorEnabled(stream: NodeJS.WriteStream): boolean {
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
	if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
	if (process.env.TERM === "dumb") return false;
	return Boolean(stream.isTTY);
}

const useColor = colorEnabled(process.stdout);
const wrap = (open: string, close: string) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
	bold: wrap("1", "22"),
	dim: wrap("2", "22"),
	red: wrap("31", "39"),
	green: wrap("32", "39"),
	// Brass, the brand color, as 256-color 179 (close to #E3A93B).
	brass: wrap("38;5;179", "39"),
	cyan: wrap("36", "39"),
};

export const sym = {
	ok: c.green("✓"),
	fail: c.red("✗"),
	warn: c.brass("!"),
	dot: c.dim("·"),
	arrow: c.brass("→"),
};

/** The one-line banner: the helm glyph is ⎈ (U+2388, "helm symbol"). */
export function banner(title: string): string {
	return `${c.brass("⎈")} ${c.bold("Tabkyra")} ${c.dim(title)}`;
}

/** Visible width of a string without ANSI escapes. */
function width(s: string): number {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes
	return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

/** A rounded box around lines, padded to the widest one. */
export function box(lines: string[], title?: string): string {
	const inner = Math.max(...lines.map(width), title ? width(title) + 2 : 0);
	const top = title
		? `╭─ ${title} ${"─".repeat(Math.max(0, inner - width(title) - 1))}╮`
		: `╭${"─".repeat(inner + 2)}╮`;
	const body = lines.map((l) => `│ ${l}${" ".repeat(inner - width(l))} │`);
	return [c.dim(top), ...body.map((l) => l.replace(/^│/, c.dim("│")).replace(/│$/, c.dim("│"))), c.dim(`╰${"─".repeat(inner + 2)}╯`)].join(
		"\n",
	);
}

/** Ask a yes/no question. `assumeYes` answers yes without asking; no TTY answers no. */
export async function confirm(question: string, options: { assumeYes: boolean; defaultYes?: boolean }): Promise<boolean> {
	const defaultYes = options.defaultYes ?? true;
	if (options.assumeYes) {
		process.stdout.write(`${question} ${c.dim("yes (--yes)")}\n`);
		return true;
	}
	if (!process.stdin.isTTY) {
		process.stdout.write(`${question} ${c.dim("skipped (no terminal; pass --yes to accept)")}\n`);
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`${question} ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
		if (answer === "") return defaultYes;
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}
