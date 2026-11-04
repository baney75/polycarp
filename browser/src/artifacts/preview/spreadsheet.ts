/** Spreadsheet helpers for the Excel viewer: bounded input for SheetJS and bounded output. */
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { PREVIEW_LIMITS, PreviewLimitError, SafeZip } from "./content.js";

export const MAX_SHEETS = 50;

/** Pictures, thumbnails and printer settings: nothing SheetJS needs to show cell values. */
const SKIP_PART =
	/(^|\/)(media|embeddings|printerSettings|Thumbnails|Pictures)\/|\.(png|jpe?g|gif|bmp|emf|wmf|tiff?|svg|webp)$/i;

/**
 * Re-zip, uncompressed, exactly the parts that passed the size caps, so SheetJS never inflates
 * anything itself. An archive that lists a name twice can't hand SheetJS the uncapped copy.
 */
export async function cappedWorkbookZip(bytes: Uint8Array): Promise<Uint8Array> {
	const shared = {
		bytesLeft: PREVIEW_LIMITS.maxSpreadsheetTotalBytes,
		iwaLeft: PREVIEW_LIMITS.maxSpreadsheetTotalBytes,
	};
	return rebuild(bytes, shared, 0);
}

/** Budgets one workbook shares with an archive nested inside it. */
interface Shared {
	bytesLeft: number;
	iwaLeft: number;
}

async function rebuild(bytes: Uint8Array, shared: Shared, depth: number): Promise<Uint8Array> {
	const zip = await SafeZip.open(bytes, {
		maxEntryBytes: PREVIEW_LIMITS.maxSpreadsheetEntryBytes,
		maxTotalBytes: shared.bytesLeft,
	});
	const clean = new JSZip();
	for (const path of zip.list()) {
		if (SKIP_PART.test(path)) continue;
		const isZip = /\.zip$/i.test(path);
		// SheetJS reads an Apple Numbers "Index.zip" part as a workbook of its own; it goes
		// through the same caps, one level deep. Other archives inside are never read.
		if (isZip && (depth > 0 || !/(^|\/)index\.zip$/i.test(path))) continue;
		const data = await zip.bytes(path);
		if (!data) continue;
		shared.bytesLeft -= data.length;
		if (isZip) {
			clean.file(path, await rebuild(data, shared, depth + 1), { compression: "STORE" });
			continue;
		}
		// Apple Numbers keeps its tables in Snappy-compressed .iwa parts that SheetJS inflates
		// itself, so their sizes are checked here before SheetJS sees them.
		if (/\.iwa/i.test(path))
			shared.iwaLeft -= iwaUncompressedSize(data, Math.min(PREVIEW_LIMITS.maxSpreadsheetEntryBytes, shared.iwaLeft));
		clean.file(path, data, { compression: "STORE" });
	}
	return clean.generateAsync({ type: "uint8array", compression: "STORE" });
}

/** Shrink a sheet's range to the column and cell limits so sheet_to_html stays bounded. */
export function clampSheet(ws: XLSX.WorkSheet) {
	const ref = ws["!ref"];
	if (!ref) return;
	const range = XLSX.utils.decode_range(ref);
	const cols = Math.min(range.e.c - range.s.c + 1, PREVIEW_LIMITS.maxTableColumns);
	const rows = Math.min(
		range.e.r - range.s.r + 1,
		PREVIEW_LIMITS.maxTableRows,
		Math.max(1, Math.floor(PREVIEW_LIMITS.maxTableCells / Math.max(1, cols))),
	);
	range.e.c = range.s.c + cols - 1;
	range.e.r = range.s.r + rows - 1;
	ws["!ref"] = XLSX.utils.encode_range(range);
}

const IWA_TOO_LARGE = "This Numbers file expands past the preview limit. Export it to XLSX to preview it.";

/**
 * Uncompressed size of an Apple .iwa part (Snappy chunks framed as type byte plus 3-byte
 * length), found without decompressing: each chunk's declared size and the size its literal
 * and copy tags actually produce must agree and stay within `cap`. Throws PreviewLimitError
 * past the cap and Error on a malformed stream.
 */
export function iwaUncompressedSize(buf: Uint8Array, cap: number): number {
	let total = 0;
	let l = 0;
	while (l < buf.length) {
		if (l + 4 > buf.length) throw new Error("Malformed Numbers stream");
		const type = buf[l];
		const len = buf[l + 1] | (buf[l + 2] << 8) | (buf[l + 3] << 16);
		l += 4;
		if (type !== 0 || l + len > buf.length) throw new Error("Malformed Numbers stream");
		const end = l + len;
		// Declared size: a varint at the start of the chunk.
		let declared = 0;
		let shift = 0;
		let p = l;
		for (;;) {
			if (p >= end || shift > 35) throw new Error("Malformed Numbers stream");
			const b = buf[p++];
			declared += (b & 0x7f) * 2 ** shift;
			shift += 7;
			if (b < 0x80) break;
		}
		if (total + declared > cap) throw new PreviewLimitError(IWA_TOO_LARGE);
		// Actual size: the sum of what each tag emits.
		let actual = 0;
		while (p < end) {
			const tag = buf[p] & 3;
			let n: number;
			if (tag === 0) {
				n = buf[p++] >> 2;
				if (n < 60) n += 1;
				else {
					const c = n - 59;
					if (p + c > end) throw new Error("Malformed Numbers stream");
					n = 0;
					for (let k = 0; k < c; k++) n += buf[p + k] * 2 ** (8 * k);
					n += 1;
					p += c;
				}
				p += n;
			} else if (tag === 1) {
				n = ((buf[p] >> 2) & 7) + 4;
				p += 2;
			} else {
				n = (buf[p] >> 2) + 1;
				p += tag === 2 ? 3 : 5;
			}
			actual += n;
			if (total + actual > cap) throw new PreviewLimitError(IWA_TOO_LARGE);
		}
		if (p !== end || actual !== declared) throw new Error("Malformed Numbers stream");
		total += actual;
		l = end;
	}
	return total;
}
