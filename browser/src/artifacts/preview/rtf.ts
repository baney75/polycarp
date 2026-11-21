/**
 * RTF reading for the preview: paragraphs with basic character and paragraph formatting,
 * simple tables and embedded PNG/JPEG pictures. Fields show their result, objects show their
 * picture, and everything else that is not body text (headers, metadata, style tables) is
 * skipped. Pure: no DOM.
 */

export interface RtfRunStyle {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	/** Points. */
	size?: number;
	color?: string;
	background?: string;
	font?: string;
	script?: "super" | "sub";
	caps?: "all" | "small";
}

export type RtfRun =
	| { text: string; style: RtfRunStyle }
	| { image: string; width?: number; height?: number }
	| { br: true };

export interface RtfParagraph {
	kind: "para";
	align?: "left" | "center" | "right" | "justify";
	/** Points. */
	indentLeft?: number;
	indentRight?: number;
	firstLine?: number;
	spaceBefore?: number;
	spaceAfter?: number;
	runs: RtfRun[];
}

export interface RtfTable {
	kind: "table";
	rows: RtfParagraph[][][];
}

export type RtfBlock = RtfParagraph | RtfTable;

export interface RtfDocument {
	blocks: RtfBlock[];
	truncated: boolean;
}

export const MAX_RTF_BLOCKS = 20_000;
export const MAX_RTF_RUNS = 200_000;
export const MAX_RTF_CHARS = 5_000_000;
export const MAX_RTF_COLUMNS = 500;

export function looksLikeRtf(text: string): boolean {
	return text.trimStart().startsWith("{\\rtf");
}

interface CharState {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	size: number;
	color?: number;
	background?: number;
	font?: number;
	script?: "super" | "sub";
	caps?: "all" | "small";
	hidden: boolean;
}

interface ParaState {
	align?: RtfParagraph["align"];
	indentLeft: number;
	indentRight: number;
	firstLine: number;
	spaceBefore: number;
	spaceAfter: number;
	inTable: boolean;
}

type Dest = "body" | "skip" | "fonttbl" | "colortbl" | "pict" | "fldinst";

interface GroupState {
	char: CharState;
	para: ParaState;
	dest: Dest;
	uc: number;
}

const SKIP_DESTINATIONS = new Set(
	"stylesheet info listtable listoverridetable rsidtbl generator xmlnstbl mmathPr themedata colorschememapping datastore latentstyles header footer headerl headerr headerf footerl footerr footerf footnote annotation atnid atnauthor nonshppict objdata objclass pgdsctbl filetbl revtbl protusertbl bkmkstart bkmkend xe tc txe pnseclvl template userprops docvar wgrffmtfilter pntxtb pntxta fldtype defchp defpap panose falt fname ftnsep ftnsepc aftnsep aftnsepc shpinst sp sn sv".split(
		" ",
	),
);

const SYMBOLS: Record<string, string> = {
	bullet: "•",
	endash: "–",
	emdash: "—",
	lquote: "‘",
	rquote: "’",
	ldblquote: "“",
	rdblquote: "”",
	tab: "\t",
	emspace: " ",
	enspace: " ",
	qmspace: " ",
	zwj: "‍",
	zwnj: "‌",
};

function defaultChar(): CharState {
	return { bold: false, italic: false, underline: false, strike: false, size: 12, hidden: false };
}

function defaultPara(): ParaState {
	return { indentLeft: 0, indentRight: 0, firstLine: 0, spaceBefore: 0, spaceAfter: 0, inTable: false };
}

function decoderFor(codepage: number): TextDecoder {
	const label =
		codepage === 65001
			? "utf-8"
			: codepage === 932
				? "shift_jis"
				: codepage === 936
					? "gbk"
					: codepage === 949
						? "euc-kr"
						: codepage === 950
							? "big5"
							: `windows-${codepage}`;
	try {
		return new TextDecoder(label);
	} catch {
		return new TextDecoder("windows-1252");
	}
}

const HEX = /^[0-9a-fA-F]$/;

function hexToBase64(hex: string): string {
	const clean = hex.replace(/[^0-9a-fA-F]/g, "");
	let binary = "";
	for (let i = 0; i + 1 < clean.length; i += 2)
		binary += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
	return btoa(binary);
}

export function parseRtf(
	source: string,
	maxBlocks = MAX_RTF_BLOCKS,
	maxRuns = MAX_RTF_RUNS,
	maxChars = MAX_RTF_CHARS,
): RtfDocument {
	if (!looksLikeRtf(source)) throw new Error("Not an RTF file");
	const fonts = new Map<number, string>();
	const colors: (string | undefined)[] = [];
	let decoder = decoderFor(1252);
	const blocks: RtfBlock[] = [];
	let truncated = false;

	const stack: GroupState[] = [];
	let st: GroupState = { char: defaultChar(), para: defaultPara(), dest: "body", uc: 1 };

	let runs: RtfRun[] = [];
	let text = "";
	let bytes: number[] = [];
	// Table assembly
	let tableRows: RtfParagraph[][][] = [];
	let row: RtfParagraph[][] = [];
	let cell: RtfParagraph[] = [];
	// Font table and color table assembly
	let fontNum: number | undefined;
	let fontName = "";
	let colorParts: { r?: number; g?: number; b?: number } = {};
	let colorSeen = false;
	// Picture assembly
	let pict: { type?: string; hex: string; w?: number; h?: number; sx: number; sy: number } | undefined;
	let skipChars = 0;
	let runCount = 0;
	/** Everything that becomes a DOM node (run, break, picture, paragraph, cell) costs one unit. */
	const spend = () => {
		if (++runCount >= maxRuns || charCount >= maxChars) truncated = true;
	};
	let charCount = 0;
	let defaultFont: number | undefined;

	const flushBytes = () => {
		if (bytes.length) {
			text += decoder.decode(new Uint8Array(bytes));
			bytes = [];
		}
	};
	const charStyle = (): RtfRunStyle => {
		const c = st.char;
		const s: RtfRunStyle = { size: c.size };
		if (c.bold) s.bold = true;
		if (c.italic) s.italic = true;
		if (c.underline) s.underline = true;
		if (c.strike) s.strike = true;
		if (c.color !== undefined && colors[c.color]) s.color = colors[c.color];
		if (c.background !== undefined && colors[c.background]) s.background = colors[c.background];
		if (c.font !== undefined && fonts.has(c.font)) s.font = fonts.get(c.font);
		if (c.script) s.script = c.script;
		if (c.caps) s.caps = c.caps;
		return s;
	};
	let runStyle: RtfRunStyle | undefined;
	const flushText = () => {
		flushBytes();
		if (text) {
			if (st.dest === "body" && !st.char.hidden) {
				runs.push({ text, style: runStyle ?? charStyle() });
				charCount += text.length;
				spend();
			}
			text = "";
		}
		runStyle = undefined;
	};
	const commitFont = () => {
		const name = fontName.replace(/;\s*$/, "").trim();
		if (fontNum !== undefined && name) fonts.set(fontNum, name);
		fontNum = undefined;
		fontName = "";
	};
	const addText = (t: string) => {
		if (st.dest === "fonttbl") {
			// Fonts end with ";", whether or not each sits in its own group.
			const parts = t.split(";");
			for (let k = 0; k < parts.length; k++) {
				fontName += parts[k];
				if (k < parts.length - 1) commitFont();
			}
			return;
		}
		if (st.dest !== "body" || st.char.hidden) return;
		const style = charStyle();
		if (runStyle && JSON.stringify(runStyle) !== JSON.stringify(style)) flushText();
		runStyle = style;
		// Bytes from \'hh escapes come first: they precede this text in the file.
		flushBytes();
		text += t;
		// Long unstyled text never flushes on its own; the character cap applies as it grows.
		if (charCount + text.length + bytes.length >= maxChars) {
			text = text.slice(0, Math.max(0, maxChars - charCount - bytes.length));
			flushText();
			truncated = true;
		}
	};
	const addBlock = (b: RtfBlock) => {
		if (blocks.length >= maxBlocks) {
			truncated = true;
			return;
		}
		blocks.push(b);
	};
	const endTable = () => {
		if (cell.length) row.push(cell);
		if (row.length) tableRows.push(row);
		if (tableRows.length) addBlock({ kind: "table", rows: tableRows });
		tableRows = [];
		row = [];
		cell = [];
	};
	const endParagraph = (force = true) => {
		flushText();
		if (!force && runs.length === 0) return;
		const p = st.para;
		const para: RtfParagraph = { kind: "para", runs };
		if (p.align) para.align = p.align;
		if (p.indentLeft) para.indentLeft = p.indentLeft / 20;
		if (p.indentRight) para.indentRight = p.indentRight / 20;
		if (p.firstLine) para.firstLine = p.firstLine / 20;
		if (p.spaceBefore) para.spaceBefore = p.spaceBefore / 20;
		if (p.spaceAfter) para.spaceAfter = p.spaceAfter / 20;
		runs = [];
		spend();
		if (p.inTable) cell.push(para);
		else {
			if (tableRows.length || row.length) endTable();
			addBlock(para);
		}
	};

	const n = source.length;
	let i = 0;
	let depth = 0;
	while (i < n && !truncated) {
		const ch = source[i];
		if (ch === "{") {
			flushText();
			stack.push(st);
			st = { char: { ...st.char }, para: { ...st.para }, dest: st.dest, uc: st.uc };
			depth++;
			if (depth > 500) throw new Error("RTF is nested too deeply to preview");
			i++;
			continue;
		}
		if (ch === "}") {
			flushText();
			if (st.dest === "fonttbl") commitFont();
			if (st.dest === "pict" && pict && (stack.length === 0 || stack[stack.length - 1].dest !== "pict")) {
				const prev = stack[stack.length - 1];
				if (prev?.dest === "body" && pict.type) {
					const w = pict.w ? (pict.w / 20) * (pict.sx / 100) : undefined;
					const h = pict.h ? (pict.h / 20) * (pict.sy / 100) : undefined;
					runs.push({ image: `data:${pict.type};base64,${hexToBase64(pict.hex)}`, width: w, height: h });
					spend();
				}
				pict = undefined;
			}
			st = stack.pop() ?? st;
			depth--;
			i++;
			continue;
		}
		if (ch === "\\") {
			const next = source[i + 1];
			if (next === undefined) break;
			// Control symbols
			if (next === "'") {
				const hex = source.slice(i + 2, i + 4);
				i += 4;
				if (skipChars > 0) {
					skipChars--;
					continue;
				}
				if (HEX.test(hex[0] ?? "") && HEX.test(hex[1] ?? "")) {
					if (st.dest === "body" && !st.char.hidden) {
						const style = charStyle();
						if (runStyle && JSON.stringify(runStyle) !== JSON.stringify(style)) flushText();
						runStyle = style;
						bytes.push(Number.parseInt(hex, 16));
						if (charCount + text.length + bytes.length >= maxChars) {
							flushText();
							truncated = true;
						}
					} else if (st.dest === "fonttbl") {
						addText(String.fromCharCode(Number.parseInt(hex, 16)));
					}
				}
				continue;
			}
			if (!/[a-zA-Z]/.test(next)) {
				i += 2;
				if (next === "*") {
					// The following control word is an ignorable destination unless we know it.
					const m = /^\\([a-zA-Z]+)/.exec(source.slice(i, i + 40));
					const word = m?.[1];
					// Inside a picture this also skips \blipuid and \picprop, so only image bytes are read.
					if (word !== "shppict" && word !== "fldinst") st.dest = "skip";
					continue;
				}
				if (next === "~") addText(" ");
				else if (next === "_") addText("‑");
				else if (next === "-") {
					// optional hyphen
				} else if (next === "\\" || next === "{" || next === "}") addText(next);
				else if (next === "\n" || next === "\r") {
					flushBytes();
					endParagraph();
				}
				continue;
			}
			// Control word
			let j = i + 1;
			while (j < n && /[a-zA-Z]/.test(source[j])) j++;
			const word = source.slice(i + 1, j);
			let param: number | undefined;
			const m = /^-?\d{1,10}/.exec(source.slice(j, j + 11));
			if (m) {
				param = Number(m[0]);
				j += m[0].length;
			}
			if (source[j] === " ") j++;
			i = j;
			if (word === "bin" && param !== undefined) {
				i += Math.max(0, param);
				continue;
			}
			if (skipChars > 0 && st.dest === "body") {
				skipChars--;
				continue;
			}
			// Text-producing words flush pending bytes so their order holds.
			if (word !== "u") flushBytes();
			switch (word) {
				case "ansicpg":
					decoder = decoderFor(param ?? 1252);
					break;
				case "deff":
					defaultFont = param;
					st.char.font ??= param;
					break;
				case "fonttbl":
					st.dest = "fonttbl";
					break;
				case "colortbl":
					st.dest = "colortbl";
					colorParts = {};
					colorSeen = false;
					break;
				case "f":
					if (st.dest === "fonttbl") {
						commitFont();
						fontNum = param;
					} else st.char.font = param;
					break;
				case "red":
				case "green":
				case "blue":
					if (st.dest === "colortbl") {
						colorParts[word === "red" ? "r" : word === "green" ? "g" : "b"] = param ?? 0;
						colorSeen = true;
					}
					break;
				case "pict":
					st.dest = "pict";
					pict = { hex: "", sx: 100, sy: 100 };
					break;
				case "pngblip":
					if (pict) pict.type = "image/png";
					break;
				case "jpegblip":
					if (pict) pict.type = "image/jpeg";
					break;
				case "picwgoal":
					if (pict) pict.w = param;
					break;
				case "pichgoal":
					if (pict) pict.h = param;
					break;
				case "picscalex":
					if (pict) pict.sx = param ?? 100;
					break;
				case "picscaley":
					if (pict) pict.sy = param ?? 100;
					break;
				case "fldinst":
					st.dest = "skip";
					break;
				case "fldrslt":
				case "shppict":
				case "result":
					if (st.dest !== "skip") st.dest = "body";
					break;
				case "par":
					endParagraph();
					break;
				case "sect":
				case "page":
					endParagraph(false);
					break;
				case "line":
					flushText();
					if (st.dest === "body") {
						runs.push({ br: true });
						spend();
					}
					break;
				case "pard":
					st.para = { ...defaultPara() };
					break;
				case "plain":
					st.char = defaultChar();
					st.char.font = defaultFont;
					break;
				case "b":
					st.char.bold = param !== 0;
					break;
				case "i":
					st.char.italic = param !== 0;
					break;
				case "ul":
				case "uld":
				case "uldb":
				case "ulw":
				case "ulth":
				case "uldash":
				case "ulwave":
					st.char.underline = param !== 0;
					break;
				case "ulnone":
					st.char.underline = false;
					break;
				case "strike":
				case "striked":
					st.char.strike = param !== 0;
					break;
				case "fs":
					if (param) st.char.size = param / 2;
					break;
				case "cf":
					st.char.color = param;
					break;
				case "cb":
				case "highlight":
					st.char.background = param || undefined;
					break;
				case "super":
					st.char.script = "super";
					break;
				case "sub":
					st.char.script = "sub";
					break;
				case "nosupersub":
					st.char.script = undefined;
					break;
				case "caps":
					st.char.caps = param === 0 ? undefined : "all";
					break;
				case "scaps":
					st.char.caps = param === 0 ? undefined : "small";
					break;
				case "v":
					st.char.hidden = param !== 0;
					break;
				case "ql":
					st.para.align = "left";
					break;
				case "qc":
					st.para.align = "center";
					break;
				case "qr":
					st.para.align = "right";
					break;
				case "qj":
				case "qd":
					st.para.align = "justify";
					break;
				case "li":
					st.para.indentLeft = param ?? 0;
					break;
				case "ri":
					st.para.indentRight = param ?? 0;
					break;
				case "fi":
					st.para.firstLine = param ?? 0;
					break;
				case "sb":
					st.para.spaceBefore = param ?? 0;
					break;
				case "sa":
					st.para.spaceAfter = param ?? 0;
					break;
				case "intbl":
					st.para.inTable = true;
					break;
				case "cell":
				case "nestcell":
					endParagraph(false);
					if (row.length < MAX_RTF_COLUMNS) row.push(cell);
					cell = [];
					spend();
					break;
				case "row":
				case "nestrow":
					if (cell.length && row.length < MAX_RTF_COLUMNS) row.push(cell);
					tableRows.push(row);
					spend();
					row = [];
					cell = [];
					break;
				case "uc":
					st.uc = param ?? 1;
					break;
				case "u": {
					flushBytes();
					let code = param ?? 0;
					if (code < 0) code += 65536;
					addText(String.fromCharCode(code));
					skipChars = st.uc;
					break;
				}
				default:
					if (SYMBOLS[word] !== undefined) addText(SYMBOLS[word]);
					else if (SKIP_DESTINATIONS.has(word)) st.dest = "skip";
			}
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			i++;
			continue;
		}
		// Plain text
		let j = i;
		while (
			j < n &&
			source[j] !== "\\" &&
			source[j] !== "{" &&
			source[j] !== "}" &&
			source[j] !== "\r" &&
			source[j] !== "\n"
		)
			j++;
		let chunk = source.slice(i, j);
		i = j;
		if (skipChars > 0) {
			const drop = Math.min(skipChars, chunk.length);
			chunk = chunk.slice(drop);
			skipChars -= drop;
		}
		if (!chunk) continue;
		if (st.dest === "colortbl") {
			for (const c of chunk) {
				if (c === ";") {
					const { r, g, b } = colorParts;
					colors.push(
						colorSeen
							? `#${[r ?? 0, g ?? 0, b ?? 0].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`
							: undefined,
					);
					colorParts = {};
					colorSeen = false;
				}
			}
		} else if (st.dest === "pict" && pict) {
			if (pict.hex.length < 60_000_000) pict.hex += chunk;
		} else {
			addText(chunk);
		}
	}
	flushText();
	if (runs.length) endParagraph();
	if (tableRows.length || row.length || cell.length) endTable();
	return { blocks, truncated };
}
