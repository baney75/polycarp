/**
 * Downloads a document with the person's own sign-in: the extension's fetch sends the site's cookies, as the tab would.
 * It stops at the size limit while reading, so a huge file never fills memory, and at two minutes.
 */
import { DocumentError, LIMITS } from "./parse.js";
import type { Fetched } from "./service.js";

const TIMEOUT_MS = 120_000;

/** The file name from Content-Disposition, else the address's last part. */
export function fileNameOf(url: string, disposition: string | null): string {
	const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition ?? "")?.[1];
	const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? "")?.[1];
	let name = "";
	try {
		name = decodeURIComponent((star ?? plain ?? "").trim().replace(/^"|"$/g, ""));
	} catch {
		name = (star ?? plain ?? "").trim();
	}
	if (!name) {
		try {
			name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
		} catch {
			name = "";
		}
	}
	if (/^https:\/\/arxiv\.org\/pdf\//.test(url) && !/\.pdf$/i.test(name)) name = `${name}.pdf`;
	return name || "document";
}

/**
 * `proxy`, when the person set a CORS proxy in Settings, is tried once if the site can't be reached directly (the
 * proxy's address with the file's address appended, encoded).
 */
export async function download(url: string, signal?: AbortSignal, proxy?: string): Promise<Fetched> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const opts: RequestInit = { credentials: "include", signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
	let response: Response;
	try {
		try {
			response = await fetch(url, opts);
		} catch (err) {
			if (!proxy || timeout.aborted || signal?.aborted) throw err;
			response = await fetch(proxy + encodeURIComponent(url), { signal: opts.signal });
		}
	} catch (err) {
		if (timeout.aborted) throw new DocumentError("The download took over 2 minutes, so it was stopped.");
		if (signal?.aborted) throw new DocumentError("Stopped.");
		throw new DocumentError(
			`Could not download ${url}: ${err instanceof Error ? err.message : String(err)}. If the site needs a sign-in, open it in a tab, sign in, and get the document from that tab.`,
		);
	}
	if (!response.ok)
		throw new DocumentError(
			response.status === 401 || response.status === 403
				? `The site answered ${response.status}: it needs a sign-in Polycarp's browser doesn't have. Ask the person to open it in a tab and sign in, then get it from the tab.`
				: `The site answered ${response.status} ${response.statusText} for ${url}.`,
		);
	const length = Number(response.headers.get("content-length") ?? 0);
	if (length > LIMITS.bytes)
		throw new DocumentError(`The file is ${(length / 1048576).toFixed(1)} MB, over the 60 MB documents can be.`);
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body?.getReader();
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > LIMITS.bytes) {
				await reader.cancel();
				throw new DocumentError("The file is over the 60 MB documents can be.");
			}
			chunks.push(value);
		}
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		bytes.set(c, at);
		at += c.byteLength;
	}
	const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	const name = fileNameOf(
		proxy && response.url.startsWith(proxy) ? url : response.url || url,
		response.headers.get("content-disposition"),
	);
	// A sign-in page where a file was expected: say so rather than store the sign-in page.
	if (/\.(pdf|docx|xlsx|pptx|epub)$/i.test(new URL(url).pathname) && mime.includes("html"))
		throw new DocumentError(
			`${url} answered with a web page, not the file: the site probably wants a sign-in. Ask the person to open it in a tab and sign in, then get it from the tab.`,
		);
	return { bytes, mime, name };
}
