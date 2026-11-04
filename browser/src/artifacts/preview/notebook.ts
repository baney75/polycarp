/** Jupyter notebook (.ipynb, nbformat 4 and 3) reading for the preview. Pure: no DOM. */

export type NotebookOutput =
	| { kind: "stream"; name: string; text: string }
	| { kind: "error"; text: string }
	| { kind: "image"; mime: string; data: string }
	| { kind: "svg"; svg: string }
	| { kind: "html"; html: string }
	| { kind: "markdown"; text: string }
	| { kind: "text"; text: string };

export interface NotebookCell {
	type: "markdown" | "code" | "raw";
	source: string;
	executionCount?: number | null;
	outputs: NotebookOutput[];
	/** Images attached to a markdown cell, by name, as data URLs. */
	attachments: Record<string, string>;
}

export interface Notebook {
	language: string;
	cells: NotebookCell[];
	totalCells: number;
	/** Outputs or text were left out to stay within the limits. */
	truncated: boolean;
}

export const MAX_NOTEBOOK_OUTPUTS = 5_000;
export const MAX_NOTEBOOK_CHARS = 20_000_000;
/** Cell sources are highlighted or rendered as markdown, so they get a smaller budget of their own. */
export const MAX_NOTEBOOK_SOURCE_CHARS = 5_000_000;
/** Text that outputs put on the page (images count only toward MAX_NOTEBOOK_CHARS). */
export const MAX_NOTEBOOK_TEXT_CHARS = 5_000_000;

function outputSize(o: NotebookOutput): number {
	switch (o.kind) {
		case "image":
			return o.data.length;
		case "svg":
			return o.svg.length;
		case "html":
			return o.html.length;
		default:
			return o.text.length;
	}
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function joinSource(v: Json | undefined): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : "")).join("");
	return "";
}

function isObject(v: Json | undefined): v is { [key: string]: Json } {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Remove ANSI color codes that tracebacks carry. */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b[@-_]/g, "");
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function richOutput(data: { [key: string]: Json }): NotebookOutput | undefined {
	for (const mime of IMAGE_TYPES) {
		const v = joinSource(data[mime]).replace(/\s+/g, "");
		if (v && /^[A-Za-z0-9+/]+=*$/.test(v)) return { kind: "image", mime, data: v };
	}
	const svg = joinSource(data["image/svg+xml"]);
	if (svg) return { kind: "svg", svg };
	const htmlOut = joinSource(data["text/html"]);
	if (htmlOut) return { kind: "html", html: htmlOut };
	const md = joinSource(data["text/markdown"]);
	if (md) return { kind: "markdown", text: md };
	const plain = joinSource(data["text/plain"]);
	if (plain) return { kind: "text", text: stripAnsi(plain) };
	const json = data["application/json"];
	if (json !== undefined) return { kind: "text", text: JSON.stringify(json, null, 2) };
	return undefined;
}

function readOutput(o: Json): NotebookOutput | undefined {
	if (!isObject(o)) return undefined;
	const type = o.output_type;
	if (type === "stream") {
		const name = typeof o.name === "string" ? o.name : typeof o.stream === "string" ? o.stream : "stdout";
		return { kind: "stream", name, text: stripAnsi(joinSource(o.text)) };
	}
	if (type === "error" || type === "pyerr") {
		const tb = Array.isArray(o.traceback) ? o.traceback.map((t) => (typeof t === "string" ? t : "")).join("\n") : "";
		const text =
			tb || `${typeof o.ename === "string" ? o.ename : "Error"}: ${typeof o.evalue === "string" ? o.evalue : ""}`;
		return { kind: "error", text: stripAnsi(text) };
	}
	if (isObject(o.data)) return richOutput(o.data);
	// nbformat 3 keeps the mime bundle on the output itself.
	const v3: { [key: string]: Json } = {};
	if (typeof o.png === "string") v3["image/png"] = o.png;
	if (typeof o.jpeg === "string") v3["image/jpeg"] = o.jpeg;
	if (o.svg !== undefined) v3["image/svg+xml"] = o.svg;
	if (o.html !== undefined) v3["text/html"] = o.html;
	if (o.text !== undefined) v3["text/plain"] = o.text;
	return Object.keys(v3).length ? richOutput(v3) : undefined;
}

export function looksLikeNotebook(text: string): boolean {
	const head = text.trimStart();
	return head.startsWith("{") && /"cells"|"worksheets"|"nbformat"/.test(head.slice(0, 200_000));
}

export function parseNotebook(
	text: string,
	maxCells = Number.POSITIVE_INFINITY,
	maxOutputs = MAX_NOTEBOOK_OUTPUTS,
	maxChars = MAX_NOTEBOOK_CHARS,
): Notebook {
	let raw: Json;
	try {
		raw = JSON.parse(text) as Json;
	} catch {
		throw new Error("Not a Jupyter notebook: the file is not valid JSON");
	}
	if (!isObject(raw)) throw new Error("Not a Jupyter notebook");
	const meta = isObject(raw.metadata) ? raw.metadata : {};
	const langInfo = isObject(meta.language_info) ? meta.language_info : {};
	const kernel = isObject(meta.kernelspec) ? meta.kernelspec : {};
	const language =
		(typeof langInfo.name === "string" && langInfo.name) ||
		(typeof kernel.language === "string" && kernel.language) ||
		"python";

	let rawCells: Json[] = [];
	if (Array.isArray(raw.cells)) rawCells = raw.cells;
	else if (Array.isArray(raw.worksheets)) {
		for (const ws of raw.worksheets) if (isObject(ws) && Array.isArray(ws.cells)) rawCells.push(...ws.cells);
	} else {
		throw new Error("Not a Jupyter notebook: no cells");
	}

	const cells: NotebookCell[] = [];
	let outputsLeft = maxOutputs;
	let charsLeft = maxChars;
	let sourceLeft = MAX_NOTEBOOK_SOURCE_CHARS;
	let textLeft = MAX_NOTEBOOK_TEXT_CHARS;
	let truncated = false;
	for (const c of rawCells.slice(0, maxCells)) {
		if (!isObject(c)) continue;
		if (sourceLeft <= 0) {
			truncated = true;
			break;
		}
		const t = c.cell_type;
		const type = t === "markdown" || t === "heading" ? "markdown" : t === "code" ? "code" : "raw";
		let source = joinSource(c.source ?? c.input);
		sourceLeft -= source.length;
		if (t === "heading" && typeof c.level === "number")
			source = `${"#".repeat(Math.min(6, Math.max(1, c.level)))} ${source}`;
		// One budget for the whole notebook; consecutive stream outputs merge, as in Jupyter.
		const outputs: NotebookOutput[] = [];
		for (const raw of Array.isArray(c.outputs) ? c.outputs : []) {
			if (outputsLeft <= 0 || charsLeft <= 0 || textLeft <= 0) {
				truncated = true;
				break;
			}
			const o = readOutput(raw);
			if (!o) continue;
			charsLeft -= outputSize(o);
			if (o.kind !== "image" && o.kind !== "svg") textLeft -= outputSize(o);
			const last = outputs[outputs.length - 1];
			if (o.kind === "stream" && last?.kind === "stream" && last.name === o.name) {
				last.text += o.text;
				continue;
			}
			outputsLeft--;
			outputs.push(o);
		}
		// No prototype, so names such as "constructor" find nothing.
		const attachments: Record<string, string> = Object.create(null);
		if (isObject(c.attachments)) {
			for (const [name, bundle] of Object.entries(c.attachments)) {
				if (!isObject(bundle)) continue;
				for (const mime of IMAGE_TYPES) {
					const v = joinSource(bundle[mime]).replace(/\s+/g, "");
					if (v && /^[A-Za-z0-9+/]+=*$/.test(v)) {
						// Attachments count toward the notebook's character budget once each.
						charsLeft -= v.length;
						if (charsLeft < 0) {
							truncated = true;
							break;
						}
						attachments[name] = `data:${mime};base64,${v}`;
						break;
					}
				}
			}
		}
		const count = c.execution_count ?? c.prompt_number;
		cells.push({
			type,
			source,
			executionCount: typeof count === "number" ? count : null,
			outputs,
			attachments,
		});
	}
	return { language, cells, totalCells: rawCells.length, truncated };
}

/** The data URL an `attachment:` reference names, if the cell has it as its own entry. */
export function attachmentData(attachments: Record<string, string>, url: string): string | undefined {
	const name = attachmentName(url);
	const value = Object.hasOwn(attachments, name) ? attachments[name] : undefined;
	return typeof value === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(value) ? value : undefined;
}

/** The attachment name in an `attachment:` URL, percent-decoded when the escape is valid. */
export function attachmentName(url: string): string {
	const name = url.slice("attachment:".length);
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/**
 * Make markdown safe to render without network access: images that point anywhere but an
 * attachment or an inline data URL become plain links. Code spans and fences are left alone.
 */
export function neutralizeRemoteImages(markdown: string, attachments: Record<string, string>): string {
	const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
	return parts
		.map((part, i) => {
			if (i % 2 === 1) return part;
			// Every bounded class stops at "[", so a scan from one "![" ends at the next: linear time.
			return part.replace(
				/!\[([^\][\n]{0,200})\]\(\s{0,10}<?([^)\s>[(]{0,4096})>?(\s{1,10}"[^"\n]{0,200}")?\s{0,10}\)|!\[([^\][\n]{0,200})\]/g,
				(whole, alt, url, _title, refAlt) => {
					if (refAlt !== undefined) return `[Image: ${refAlt}]`;
					// Attachment references stay as written; the viewer resolves them after sanitizing,
					// so a large attachment is never copied into the text once per reference.
					if (typeof url === "string" && url.startsWith("attachment:")) {
						return attachmentData(attachments, url) ? whole : `[Image: ${alt || url}]`;
					}
					if (typeof url === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(url)) return whole;
					return `[Image: ${alt || url}](${url})`;
				},
			);
		})
		.join("");
}
