/**
 * Bug reports are off unless the user turns them on. While on, errors from the side panel
 * are kept locally, redacted, in a short ring buffer. Nothing leaves the browser on its own:
 * the user reviews and edits the report in Tabkyra, copies it, and pastes it into a GitHub
 * issue they open and submit themselves.
 */

export const BUG_REPORTS_KEY = "privacy.bugReports";
export const BUG_LOG_KEY = "privacy.bugLog";
const MAX_ENTRIES = 20;
/** A blank new-issue page: the report travels by the clipboard, never in the URL. */
export const NEW_ISSUE_URL = "https://github.com/baney75/tabkyra/issues/new?labels=bug-report";

export interface BugEntry {
	at: string;
	message: string;
	stack?: string;
}

/**
 * Strip secrets only: API keys and tokens by their known prefixes, bearer headers, JWTs and
 * private key blocks. Unlike `redact`, it keeps addresses and names: a chat transcript an
 * agent reads back still needs its URLs, but never a key someone pasted into it.
 */
export function redactSecrets(text: string): string {
	return (
		text
			.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private-key]")
			.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [secret]")
			.replace(
				/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza|ya29|eyJ|npm_|hf_|sk-ant|sk-proj|sk-or)[\w-]{10,}/g,
				"[secret]",
			)
			// Long mixed-case or mixed letter-and-digit tokens (keys without a known prefix). Plain
			// hex stays only at a git commit id's length (40): 32 and 64 hex digits are the shapes of
			// API keys, auth tokens and private keys (Datadog, Twilio, ed25519), so those go.
			.replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, (m) => {
				if (/^[0-9a-f]+$/i.test(m)) return m.length === 40 ? m : "[secret]";
				return !/[0-9]/.test(m) || !/[A-Za-z]/.test(m) ? m : "[secret]";
			})
	);
}

/**
 * Strip what could identify the user or leak a secret. Web addresses become `[url]`
 * (paths and hosts can name people, records or accounts); Tabkyra's own extension scripts
 * keep only the file name, which is what a maintainer needs from a stack trace.
 */
export function redact(text: string): string {
	// Tabkyra's own script URLs keep only the file name, and only when it looks like one of its
	// build files ("chunk-4f2a.js", at most 24 characters before the extension) followed by a line number or a break; anything else in the
	// path (a key, an address, a user name) becomes "[file]". The name is set aside so the
	// long-token rule can't eat it. The query and fragment stay until the secret rules have read
	// them, then go.
	const files: string[] = [];
	const marked = text
		.replace(/\u0000/g, "")
		.replace(/\bchrome-extension:\/\/[a-p]{32}\/([^\s"'<>?#)]*)/gi, (_m, path: string) => {
			const name = /^(?:.*\/)?([A-Za-z][\w-]{0,23}\.(?:m?js|html|css|wasm|json))(?::\d+){0,2}$/.exec(path)?.[1];
			const tail = name ? path.slice(path.lastIndexOf(name) + name.length) : "";
			return `\u0000${files.push(name ? redactSecrets(name) : "[file]") - 1}\u0000${tail}`;
		});
	return (
		redactSecrets(marked)
			.replace(/(\u0000\d+\u0000(?::\d+){0,2})[?#][^\s"'<>)]*/g, "$1")
			// A URL may contain ")" (wiki paths); only trailing punctuation belongs to the sentence.
			.replace(/\b[a-z][\w+.-]*:\/\/[^\s"'<>]+/gi, (m) => `[url]${/[).,;:!?]+$/.exec(m)?.[0] ?? ""}`)
			// Addresses without "//": data, blob, about and javascript URLs carry page content.
			.replace(/\b(?:data|blob|about|javascript):[^\s"'<>]+/gi, "[url]")
			.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[ip]")
			// IPv6: compressed (with "::") or all eight groups, bracketed or not, with a port.
			.replace(
				/\[?(?:[0-9a-f]{1,4}:){0,7}[0-9a-f]{0,4}::(?:[0-9a-f]{0,4}:?){0,7}[0-9a-f]{0,4}\]?(?::\d+)?|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi,
				"[ip]",
			)
			.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
			.replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AKIA|AIza|ya29|eyJ)[\w-]{10,}/g, "[secret]")
			.replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, "[long-token]")
			.replace(/\/(Users|home)\/[^/\s]+/g, "/$1/[user]")
			.replace(/[A-Z]:\\Users\\[^\\\s]+/g, "C:\\Users\\[user]")
			.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `ext:/${files[Number(i)]}`)
			.slice(0, 2000)
	);
}

export function addEntry(log: BugEntry[], error: unknown, now = new Date()): BugEntry[] {
	const err = error instanceof Error ? error : new Error(String(error));
	const entry: BugEntry = {
		at: now.toISOString(),
		message: redact(err.message),
		stack: err.stack ? redact(err.stack.split("\n").slice(0, 8).join("\n")) : undefined,
	};
	return [...log, entry].slice(-MAX_ENTRIES);
}

/** The report text the user reviews and edits before anything is shared. */
export function reportText(version: string, log: BugEntry[], userAgent: string): string {
	return [
		`Tabkyra ${version}`,
		`Browser: ${redact(userAgent)}`,
		"",
		"What were you doing?",
		"",
		"Recent errors (redacted):",
		"```",
		...log.slice(-5).map((e) => `${e.at} ${e.message}${e.stack ? `\n${e.stack}` : ""}`),
		"```",
	].join("\n");
}
