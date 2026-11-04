/**
 * What an agent sees of a request's bodies through read_network, kept to promises that hold:
 *
 * - A request body is shown as its shape only: keys and value types, never a value. It carries
 *   what the user typed, passwords included, and no name list catches every password field. Form
 *   and multipart field names are read only when the content type says so; anything else is a
 *   length and a type.
 * - A response body is shown only when it is complete JSON. Values under credential-named keys
 *   become "[secret]", edited in place so every other byte (64-bit ids, key order, duplicate
 *   keys) comes back as sent. A string (value or key) that holds a credential as text
 *   ("token=...", 'password:"..."', a bearer token, a JWT) is masked whole, never partly parsed.
 *   A secret stored as data, such as {"name":"session_id","value":"..."}, has no credential name
 *   or shape to go by and is shown: the masking is by name and shape, not by meaning.
 * - Anything else (HTML, plain text, a body cut off) isn't shown; get_page_html and run_js cover it.
 *
 * Every pass is linear in the text.
 */

export const SECRET = "[secret]";

/** Names that contain a credential word but hold counts and settings. */
const DATA_NAMES =
	/^(?:(?:max|min|total|input|output|prompt|completion|cached|reasoning|remaining|used)tokens|tokens?(?:count|limit|usage|used|total|budget|remaining|type)|tokenizer|tokenized)$/;
/** Exact names that are credentials. */
const EXACT = /^(?:sid|pin|pw|pwd|pass|key|session|otp|auth|sig|signature|code2fa|cvv|cvc|csc)$/;
/** Credential words anywhere in a name: password_confirmation, secretKey, x-csrf-token. */
const ANYWHERE =
	/password|passwd|passphrase|passcode|secret|token|apikey|accesskey|privatekey|signingkey|authkey|credential|csrf|xsrf|cookie|sessionid|sessid|sessionkey|authorization|codeverifier|authcode|jwt|recoverycode|backupcode|verificationcode|smscode|onetimecode|otpcode|pincode|securitycode|resetcode|logincode|confirmationcode|twofactor|2fa|mfacode|totp|cardnumber|cardno|iban|ssn/;
/** Credential words at the end of a name: user_pw, loginPwd, confirm_pass, cardPin, mfa_otp, X-Amz-Signature. */
const ENDING = /(?:pw|pwd|pass|pin|otp|cvv|cvc|signature)$/;
/** Query parameters that are credentials in a URL but ordinary data in a body: an OAuth code. */
const URL_ONLY = /^(?:code|ticket|nonce)$/;

/** A field name that holds a credential: compared with punctuation, case and trailing digits removed. */
export function isSecretName(name: string): boolean {
	const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!n || DATA_NAMES.test(n)) return false;
	const stem = n.replace(/\d+$/, "");
	return EXACT.test(stem) || ANYWHERE.test(stem) || ENDING.test(stem);
}

/** A string that carries a credential: a token shape, or a credential name followed by : or =. */
export function holdsCredential(text: string): boolean {
	if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
	// A scheme and a token of 16 or more characters, any case: "Basic Subscription" stays.
	if (/\b(?:bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{16,}/i.test(text)) return true;
	// Anchored at a token's start, so a run like "eyJ-eyJ-..." is scanned once, not from every eyJ.
	if (/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)) return true;
	if (
		/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|ya29\.[\w-]{20,}|npm_\w{30,}|hf_\w{30,})/.test(
			text,
		)
	)
		return true;
	// name: value or name=value, the name not starting mid-word; quotes and escapes allowed around it.
	for (const m of text.matchAll(/(?<![A-Za-z0-9_[\]-])\\?["']?([A-Za-z0-9_[\]-]{1,80})\\?["']?\s*[:=]/g))
		if (isSecretName(m[1].replace(/^.*\[|\]$/g, ""))) return true;
	return false;
}

/** The shape of a request body: keys and value types, no values. */
export function bodyShape(text: string, contentType = ""): string {
	const type = contentType.toLowerCase();
	const t = text.trim();
	const describe = (v: unknown, depth: number): unknown => {
		if (Array.isArray(v)) return v.length ? [describe(v[0], depth + 1), `(${v.length} items)`] : [];
		if (v && typeof v === "object") {
			if (depth > 20) return "{…}";
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describe(x, depth + 1)]));
		}
		if (typeof v === "string") return `<string, ${v.length} chars>`;
		return `<${v === null ? "null" : typeof v}>`;
	};
	if (type.includes("json") || /^[[{]/.test(t)) {
		try {
			return JSON.stringify(describe(JSON.parse(t), 0));
		} catch {
			/* not JSON */
		}
	}
	// Field names only where the content type promises them: guessing a form from other text
	// (GraphQL, base64, a cut-off JSON body) would report values as names.
	if (type.includes("x-www-form-urlencoded")) {
		const keys = t.split("&").map((pair) => {
			const key = pair.split("=")[0] ?? "";
			try {
				return decodeURIComponent(key.replace(/\+/g, " "));
			} catch {
				return key;
			}
		});
		return `form fields: ${keys.join(", ")}`;
	}
	const boundary = type.includes("multipart/") ? contentType.match(/boundary="?([^";]+)"?/i)?.[1] : undefined;
	if (boundary) {
		// Each part's own header block, never its contents: a field value can contain text that
		// looks like a header.
		const names = text
			.split(`--${boundary}`)
			.slice(1)
			.map((part) => part.replace(/^\r?\n/, "").split(/\r?\n\r?\n/)[0] ?? "")
			.map((head) => head.match(/^Content-Disposition:[^\r\n]*\bname="([^"\r\n]*)"/im)?.[1])
			.filter((name): name is string => name !== undefined);
		return `multipart fields: ${names.join(", ")}`;
	}
	return `${t.length} characters of ${type || "text"}; values not shown`;
}

/**
 * A complete JSON response with credentials masked in place, or undefined when the text isn't
 * complete JSON (then it isn't shown at all).
 */
export function maskJsonResponse(text: string): string | undefined {
	try {
		JSON.parse(text);
	} catch {
		return undefined;
	}
	let out = "";
	let i = 0;
	const n = text.length;
	const stack: Array<{ obj: boolean; key: boolean }> = [];
	let lastKey = "";
	const stringEnd = (start: number) => {
		let j = start + 1;
		while (j < n) {
			if (text[j] === "\\") j += 2;
			else if (text[j] === '"') return j + 1;
			else j++;
		}
		return n;
	};
	const valueEnd = (start: number) => {
		const c = text[start];
		if (c === '"') return stringEnd(start);
		if (c !== "{" && c !== "[") {
			let j = start;
			while (j < n && !/[,}\]\s]/.test(text[j])) j++;
			return j;
		}
		let level = 0;
		for (let j = start; j < n; j++) {
			const d = text[j];
			if (d === '"') {
				j = stringEnd(j) - 1;
				continue;
			}
			if (d === "{" || d === "[") level++;
			else if (d === "}" || d === "]") {
				level--;
				if (level === 0) return j + 1;
			}
		}
		return n;
	};
	while (i < n) {
		const c = text[i];
		const top = stack[stack.length - 1];
		if (c === '"') {
			const end = stringEnd(i);
			const token = text.slice(i, end);
			if (top?.obj && top.key) {
				lastKey = JSON.parse(token) as string;
				// A credential used as a key (a session map keyed by token) is masked like a value.
				out += holdsCredential(lastKey) ? `"${SECRET}"` : token;
			} else out += holdsCredential(JSON.parse(token) as string) ? `"${SECRET}"` : token;
			i = end;
			continue;
		}
		if (c === ":" && top?.obj) {
			out += c;
			i++;
			while (i < n && /\s/.test(text[i])) out += text[i++];
			if (isSecretName(lastKey) && i < n) {
				i = valueEnd(i);
				out += `"${SECRET}"`;
			}
			top.key = false;
			continue;
		}
		if (c === "{" || c === "[") stack.push({ obj: c === "{", key: c === "{" });
		else if (c === "}" || c === "]") stack.pop();
		else if (c === "," && top?.obj) top.key = true;
		out += c;
		i++;
	}
	return out;
}

/**
 * A URL with credential-named query parameters, token-shaped values and userinfo masked, in the
 * query and in a fragment written as parameters (an OAuth implicit flow's #token=...).
 */
export function maskUrl(url: string): string {
	try {
		// A relative address (a form's action="/reset?token=...") is read against a stand-in base.
		const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url);
		const u = new URL(url, "https://relative.invalid");
		let changed = false;
		const secret = (key: string, value: string) => isSecretName(key) || URL_ONLY.test(key) || holdsCredential(value);
		for (const [key, value] of [...u.searchParams]) {
			if (secret(key, value)) {
				u.searchParams.set(key, SECRET);
				changed = true;
			}
		}
		if (u.hash.includes("=")) {
			const fragment = new URLSearchParams(u.hash.slice(1));
			let masked = false;
			for (const [key, value] of [...fragment])
				if (secret(key, value)) {
					fragment.set(key, SECRET);
					masked = true;
				}
			if (masked) {
				u.hash = fragment.toString();
				changed = true;
			}
		}
		if (u.username || u.password) {
			u.username = "";
			u.password = "";
			changed = true;
		}
		if (!changed) return url;
		return relative ? `${u.pathname}${u.search}${u.hash}` : u.toString();
	} catch {
		return url;
	}
}
