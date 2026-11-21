// Everything shown as agent output, panel state or terminal output comes from the real run
// recorded in public/capture/capture.json by scripts/demo/capture-video.mjs.
import capture from "../public/capture/capture.json";

const elements = (snapshot: string): string[] => snapshot.split("\n").filter((l) => /^e\d+ /.test(l));

const b = capture.browser;
const book = b.book;
/** A line the video quotes; a capture without it fails the render instead of showing a blank. */
const line = (prefix: string): string => {
	const found = book.text.split("\n").find((l) => l.startsWith(prefix));
	if (!found) throw new Error(`capture.json: the book page has no line starting ${prefix}`);
	return found;
};
const summary = line('"Moby Dick; Or, The Whale" by Herman Melville');

export const DATA = {
	recordedAt: capture.recordedAt,
	group: b.statusAfter.tabGroup,
	prompt: {
		message: b.permissionPrompt.message,
		choices: b.permissionPrompt.requestedSchema.properties.decision.enumNames,
	},
	bookUrl: b.book.url,
	bookTitle: book.title,
	bookHeading: line("Moby Dick; Or, The Whale by"),
	bookSummary: `${summary.split(". ")[0]}.`,
	catalogUrl: b.catalogUrl,
	refs: b.catalog.refs,
	readPage1: elements(b.readPage1),
	readPage2: elements(b.readPage2),
	readPage3: elements(b.readPage3),
	confirmation: b.catalog.confirmation.split("\n").at(-1) ?? "",
	setupPrompt: b.setupPrompt,
	copyButton: b.copyButton,
	/** Side panel element boxes in CSS px, measured during the capture; crops and rings use them. */
	boxes: b.boxes,
	cli: capture.cli,
};

type Call = { name: string; args: Record<string, unknown>; ms: number; text: string };
const calls = b.calls as Call[];

/** The real result of the nth call to `name` (0-based), compacted to one line. */
export function result(name: string, nth = 0): string {
	const hit = calls.filter((c) => c.name === name)[nth];
	if (!hit) throw new Error(`no ${name} call #${nth} in capture.json`);
	return hit.text.replace(/\s*\n\s*/g, " ");
}

/** One field of the nth call's JSON result, e.g. the page title a navigate returned. */
export function field(name: string, key: string, nth = 0): string {
	return String((JSON.parse(result(name, nth)) as Record<string, unknown>)[key]);
}

/** The real arguments of the nth call to `name`, as the agent sent them. */
export function args(name: string, nth = 0): string {
	const hit = calls.filter((c) => c.name === name)[nth];
	if (!hit) throw new Error(`no ${name} call #${nth} in capture.json`);
	const parts = Object.entries(hit.args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
	return `${name} { ${parts.join(", ")} }`;
}
