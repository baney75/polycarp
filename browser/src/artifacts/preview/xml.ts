/**
 * A small, strict-enough XML reader for office documents (OOXML, ODF).
 *
 * Document previews read untrusted files, so this parser never expands DTD entities (no
 * billion-laughs), never resolves external references, and caps input size, depth and node
 * count. It keeps text nodes in order so mixed content (ODF paragraphs) survives.
 */

export interface XmlElement {
	/** Qualified name as written, e.g. "a:t". */
	name: string;
	/** Name without the namespace prefix, e.g. "t". */
	local: string;
	attrs: Record<string, string>;
	children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export interface XmlLimits {
	maxChars: number;
	maxDepth: number;
	maxNodes: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = { maxChars: 20_000_000, maxDepth: 200, maxNodes: 1_000_000 };

export class XmlError extends Error {}

/** Office files use a handful per element; thousands only slow every lookup. */
const MAX_ATTRIBUTES = 256;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
	if (text.indexOf("&") < 0) return text;
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
			try {
				return String.fromCodePoint(code);
			} catch {
				return "";
			}
		}
		// Unknown named entities stay literal: no DTD is ever read.
		return NAMED_ENTITIES[body] ?? whole;
	});
}

function localName(name: string): string {
	const i = name.indexOf(":");
	return i < 0 ? name : name.slice(i + 1);
}

const NAME_END = /[\s/>]/;

export function parseXml(source: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlElement {
	if (source.length > limits.maxChars) throw new XmlError("XML part is too large to preview");
	const root: XmlElement = { name: "#document", local: "#document", attrs: {}, children: [] };
	const stack: XmlElement[] = [root];
	let nodes = 0;
	let i = 0;
	const n = source.length;
	// Skip a byte order mark.
	if (source.charCodeAt(0) === 0xfeff) i = 1;
	while (i < n) {
		const lt = source.indexOf("<", i);
		if (lt < 0) {
			pushText(source.slice(i));
			break;
		}
		if (lt > i) pushText(source.slice(i, lt));
		if (source.startsWith("<!--", lt)) {
			const end = source.indexOf("-->", lt + 4);
			if (end < 0) throw new XmlError("Unclosed comment");
			i = end + 3;
			continue;
		}
		if (source.startsWith("<![CDATA[", lt)) {
			const end = source.indexOf("]]>", lt + 9);
			if (end < 0) throw new XmlError("Unclosed CDATA");
			pushRaw(source.slice(lt + 9, end));
			i = end + 3;
			continue;
		}
		if (source.startsWith("<?", lt)) {
			const end = source.indexOf("?>", lt + 2);
			if (end < 0) throw new XmlError("Unclosed processing instruction");
			i = end + 2;
			continue;
		}
		if (source.startsWith("<!", lt)) {
			// DOCTYPE and its internal subset are skipped, never interpreted.
			i = skipDeclaration(lt);
			continue;
		}
		if (source[lt + 1] === "/") {
			const end = source.indexOf(">", lt + 2);
			if (end < 0) throw new XmlError("Unclosed end tag");
			const name = source.slice(lt + 2, end).trim();
			// Tolerate mismatches by popping to the nearest matching open element.
			for (let k = stack.length - 1; k > 0; k--) {
				if (stack[k].name === name) {
					stack.length = k;
					break;
				}
			}
			i = end + 1;
			continue;
		}
		// Start tag.
		let j = lt + 1;
		while (j < n && !NAME_END.test(source[j])) j++;
		const name = source.slice(lt + 1, j);
		if (!name) throw new XmlError("Empty tag name");
		const attrs: Record<string, string> = {};
		let selfClosing = false;
		let attrCount = 0;
		while (j < n) {
			const c = source[j];
			if (c === ">") {
				j++;
				break;
			}
			if (c === "/" && source[j + 1] === ">") {
				selfClosing = true;
				j += 2;
				break;
			}
			if (c === " " || c === "\n" || c === "\t" || c === "\r") {
				j++;
				continue;
			}
			if (++attrCount > MAX_ATTRIBUTES) throw new XmlError("XML element has too many attributes to preview");
			let k = j;
			while (k < n && source[k] !== "=" && !/[\s/>]/.test(source[k])) k++;
			const attrName = source.slice(j, k);
			while (k < n && /\s/.test(source[k])) k++;
			if (source[k] !== "=") {
				// Attribute without a value: keep it, empty.
				attrs[attrName] = "";
				j = k;
				continue;
			}
			k++;
			while (k < n && /\s/.test(source[k])) k++;
			const quote = source[k];
			if (quote !== '"' && quote !== "'") throw new XmlError("Unquoted attribute value");
			const close = source.indexOf(quote, k + 1);
			if (close < 0) throw new XmlError("Unclosed attribute value");
			attrs[attrName] = decodeEntities(source.slice(k + 1, close));
			j = close + 1;
		}
		const element: XmlElement = { name, local: localName(name), attrs, children: [] };
		if (++nodes > limits.maxNodes) throw new XmlError("XML part has too many elements to preview");
		stack[stack.length - 1].children.push(element);
		if (!selfClosing) {
			if (stack.length > limits.maxDepth) throw new XmlError("XML part is nested too deeply to preview");
			stack.push(element);
		}
		i = j;
	}
	const top = root.children.find((c): c is XmlElement => typeof c !== "string");
	if (!top) throw new XmlError("No root element");
	return top;

	function pushText(raw: string) {
		if (stack.length === 1) return; // whitespace outside the root
		pushRaw(decodeEntities(raw));
	}
	function pushRaw(text: string) {
		if (!text) return;
		if (++nodes > limits.maxNodes) throw new XmlError("XML part has too many nodes to preview");
		stack[stack.length - 1].children.push(text);
	}
	function skipDeclaration(start: number): number {
		let depth = 0;
		for (let k = start + 2; k < n; k++) {
			const c = source[k];
			if (c === "[") depth++;
			else if (c === "]") depth--;
			else if (c === ">" && depth <= 0) return k + 1;
		}
		throw new XmlError("Unclosed declaration");
	}
}

function matches(el: XmlElement, name: string): boolean {
	return name.includes(":") ? el.name === name : el.local === name;
}

/** First child element with this name. A name with a prefix matches exactly; without one, by local name. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
	if (!el) return undefined;
	for (const c of el.children) if (typeof c !== "string" && matches(c, name)) return c;
	return undefined;
}

export function children(el: XmlElement | undefined, name?: string): XmlElement[] {
	if (!el) return [];
	const out: XmlElement[] = [];
	for (const c of el.children) if (typeof c !== "string" && (name === undefined || matches(c, name))) out.push(c);
	return out;
}

/** Follow a path of child names. */
export function path(el: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
	let cur = el;
	for (const name of names) cur = child(cur, name);
	return cur;
}

/** Attribute by qualified name, falling back to the local name with any prefix. */
export function attr(el: XmlElement | undefined, name: string): string | undefined {
	if (!el) return undefined;
	const direct = el.attrs[name];
	if (direct !== undefined) return direct;
	if (name.includes(":")) return undefined;
	for (const key in el.attrs) {
		if (localName(key) === name) return el.attrs[key];
	}
	return undefined;
}

export function numAttr(el: XmlElement | undefined, name: string): number | undefined {
	const v = attr(el, name);
	if (v === undefined || v === "") return undefined;
	const num = Number(v);
	return Number.isFinite(num) ? num : undefined;
}

/** All text below this element, in document order. */
export function textOf(el: XmlNode | undefined): string {
	if (el === undefined) return "";
	if (typeof el === "string") return el;
	let out = "";
	for (const c of el.children) out += textOf(c);
	return out;
}

/** Depth-first search for every descendant with this name. */
export function descendants(el: XmlElement | undefined, name: string, limit = 100_000): XmlElement[] {
	const out: XmlElement[] = [];
	if (!el) return out;
	const walk = (node: XmlElement) => {
		for (const c of node.children) {
			if (typeof c === "string") continue;
			if (out.length >= limit) return;
			if (matches(c, name)) out.push(c);
			walk(c);
		}
	};
	walk(el);
	return out;
}
