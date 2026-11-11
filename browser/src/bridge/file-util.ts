/**
 * Small pure helpers for the `files` tool (src/bridge/files.ts): what a file input accepts, the
 * name a server suggests for a download, and reading a data: URL. No browser API, so they are
 * tested with plain node (test/file-util.test.mjs). `acceptsFile` is also stringified into the
 * page, so it must stay self-contained.
 */

/** Whether a file input's `accept` attribute takes this file. An empty accept takes anything. */
export function acceptsFile(accept: string, name: string, mime: string): boolean {
	const tokens = String(accept || "")
		.split(",")
		.map((t) => t.trim().toLowerCase())
		.filter((t) => t !== "");
	if (tokens.length === 0) return true;
	const lowerName = String(name).toLowerCase();
	const type = String(mime || "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return tokens.some((t) => {
		if (t.startsWith(".")) return lowerName.endsWith(t);
		if (t.endsWith("/*")) return type.startsWith(t.slice(0, -1));
		return type === t;
	});
}

/** The file name in a Content-Disposition header, or undefined. `filename*` (RFC 5987) wins over `filename`. */
export function dispositionName(header: string | null | undefined): string | undefined {
	if (!header) return undefined;
	const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
	if (star) {
		try {
			return decodeURIComponent(star[2].trim());
		} catch {
			/* fall through to the plain name */
		}
	}
	const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
	if (!plain) return undefined;
	const value = (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain[2]).trim();
	return value || undefined;
}

/** The last path part of a URL, decoded, or undefined when it has none. */
export function urlFileName(url: string): string | undefined {
	try {
		const last = new URL(url).pathname.split("/").pop() ?? "";
		return decodeURIComponent(last) || undefined;
	} catch {
		return undefined;
	}
}

/** How many bytes a base64 string decodes to, or -1 when it is not base64. */
export function base64Bytes(b64: string): number {
	if (typeof b64 !== "string" || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return -1;
	const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	return (b64.length / 4) * 3 - pad;
}

/** A data: URL as its type and its content in base64, or undefined when it is malformed. */
export function parseDataUrl(url: string): { mime: string; b64: string } | undefined {
	const m = /^data:([^,]*),([\s\S]*)$/i.exec(url);
	if (!m) return undefined;
	const head = m[1].split(";").map((s) => s.trim());
	const isBase64 = head.at(-1)?.toLowerCase() === "base64";
	const mime = (head[0] || "text/plain").toLowerCase();
	try {
		if (isBase64) {
			const b64 = decodeURIComponent(m[2]).replace(/\s+/g, "");
			const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
			return base64Bytes(padded) < 0 ? undefined : { mime, b64: padded };
		}
		const bytes = new TextEncoder().encode(decodeURIComponent(m[2]));
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { mime, b64: btoa(bin) };
	} catch {
		return undefined;
	}
}
