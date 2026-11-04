/** RFC 4180 style CSV and TSV parsing for the table preview. */

export interface DelimitedTable {
	rows: string[][];
	/** Rows left out because of the row limit. */
	truncated: boolean;
	/** Some rows had more fields than the column limit. */
	wide: boolean;
	/** Rows and widest row in the whole file, past the limits too. */
	totalRows: number;
	totalColumns: number;
	delimiter: string;
}

/** Pick the delimiter: tab for .tsv/.tab, otherwise whichever of , ; tab | splits the first lines most evenly. */
export function detectDelimiter(text: string, filename = ""): string {
	const ext = filename.split(".").pop()?.toLowerCase();
	if (ext === "tsv" || ext === "tab") return "\t";
	const sample = text
		.slice(0, 10_000)
		.split(/\r?\n/)
		.slice(0, 10)
		.filter((l) => l.length > 0);
	if (sample.length === 0) return ",";
	let best = ",";
	let bestScore = 0;
	for (const d of [",", "\t", ";", "|"]) {
		const counts = sample.map((l) => countOutsideQuotes(l, d));
		const min = Math.min(...counts);
		if (min === 0) continue;
		const consistent = counts.every((c) => c === counts[0]);
		const score = min * (consistent ? 2 : 1);
		if (score > bestScore) {
			bestScore = score;
			best = d;
		}
	}
	return best;
}

function countOutsideQuotes(line: string, d: string): number {
	let n = 0;
	let quoted = false;
	for (const ch of line) {
		if (ch === '"') quoted = !quoted;
		else if (ch === d && !quoted) n++;
	}
	return n;
}

export function parseDelimited(
	text: string,
	delimiter: string,
	maxRows = Number.POSITIVE_INFINITY,
	maxColumns = Number.POSITIVE_INFINITY,
): DelimitedTable {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const n = text.length;
	let truncated = false;
	let wide = false;
	let fieldsInRow = 0;
	let widest = 0;
	const pushField = () => {
		fieldsInRow++;
		if (row.length < maxColumns) row.push(field);
		else wide = true;
	};
	const endRow = () => {
		pushField();
		widest = Math.max(widest, fieldsInRow);
		fieldsInRow = 0;
		field = "";
		rows.push(row);
		row = [];
	};
	while (i < n) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field.length === 0) {
			quoted = true;
			i++;
			continue;
		}
		if (ch === delimiter) {
			pushField();
			field = "";
			i++;
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			endRow();
			if (ch === "\r" && text[i + 1] === "\n") i++;
			i++;
			if (rows.length >= maxRows) {
				truncated = i < n;
				const rest = countRest(text, i, delimiter);
				return {
					rows,
					truncated,
					wide,
					delimiter,
					totalRows: rows.length + rest.rows,
					totalColumns: Math.max(widest, rest.widest),
				};
			}
			continue;
		}
		field += ch;
		i++;
	}
	if (field.length > 0 || row.length > 0) endRow();
	return { rows, truncated, wide, delimiter, totalRows: rows.length, totalColumns: widest };
}

/** Rows and widest row from `start` on, by the parser's quoting rules, without keeping any text. */
function countRest(text: string, start: number, delimiter: string): { rows: number; widest: number } {
	let rows = 0;
	let widest = 0;
	let fields = 1;
	let quoted = false;
	let atFieldStart = true;
	let pending = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		pending = true;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') i++;
				else quoted = false;
			}
			continue;
		}
		if (ch === '"' && atFieldStart) {
			quoted = true;
			atFieldStart = false;
		} else if (ch === delimiter) {
			fields++;
			atFieldStart = true;
		} else if (ch === "\r" || ch === "\n") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			rows++;
			widest = Math.max(widest, fields);
			fields = 1;
			atFieldStart = true;
			pending = false;
		} else atFieldStart = false;
	}
	if (pending) {
		rows++;
		widest = Math.max(widest, fields);
	}
	return { rows, widest };
}

/** Heuristic for content stored as text rather than base64: a delimited file has a delimiter or newline in its first line. */
export function looksDelimited(text: string): boolean {
	const head = text.slice(0, 4096);
	return /[,\t;|\n]/.test(head) || !/^[A-Za-z0-9+/=\s]+$/.test(head);
}
