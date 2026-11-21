/**
 * What a key check's failure means for the key:
 * - "rejected": the provider turned the key down: a 401, or a 400 or 403 that names the key (Google
 *   and xAI answer a bad key with 400). Don't save it.
 * - "limited": the provider knew the key but the account is out of credit or over a limit (402,
 *   429). Save it: a free OpenRouter key has no credit and is still the key Free mode needs.
 * - "unchecked": anything else, such as no network, a timeout, a server error or a 403 for the test
 *   model alone. The key may be fine; the user can save it anyway.
 */
export type KeyFailure = { kind: "rejected" | "limited" | "unchecked"; reason: string };

/**
 * A provider's error in a sentence: "401 {"error":{"message":"invalid x-api-key"}}" becomes
 * "the provider turned it down (invalid x-api-key)".
 */
export function keyFailure(raw: string | undefined): KeyFailure {
	const text = (raw ?? "").trim();
	// "401 {json}" (OpenAI and Anthropic SDKs), or bare JSON with error.code (Google's SDK).
	const match = /^(\d{3})\b\s*(.*)$/s.exec(text);
	let status = match ? Number(match[1]) : undefined;
	let detail = match ? match[2] : text;
	// Unwrap JSON a few layers deep: Google's SDK puts the API's JSON error inside the message of
	// its own, and xAI sends the message as a quoted JSON string.
	for (let depth = 0; depth < 3; depth++) {
		let body: unknown;
		try {
			body = JSON.parse(detail);
		} catch {
			break;
		}
		if (typeof body === "string") {
			detail = body;
			continue;
		}
		const b = body as { error?: { message?: unknown; code?: unknown } | string; message?: unknown; code?: unknown };
		const err = typeof b?.error === "object" ? b.error : undefined;
		const code = err?.code ?? b?.code;
		if (status === undefined && typeof code === "number" && code >= 400 && code < 600) status = code;
		const found = err?.message ?? b?.message ?? (typeof b?.error === "string" ? b.error : undefined);
		if (typeof found !== "string") break;
		detail = found.trim();
	}
	detail = detail.trim().replace(/\.$/, "");
	// Read the whole message before it's shortened for display.
	const badKey = BAD_KEY.test(detail);
	if (detail.length > 160) detail = `${detail.slice(0, 160)}…`;
	const why = detail ? ` (${detail})` : "";
	if (status === 401 || ((status === 400 || status === 403 || status === undefined) && badKey))
		return { kind: "rejected", reason: `the provider turned it down${why}.` };
	if (status === 402 || status === 429)
		return { kind: "limited", reason: `the provider says the account is out of credit or over its limit${why}.` };
	// A 403 that doesn't name the key can mean the key may not use the one test model.
	if (status === 403) return { kind: "unchecked", reason: `the provider refused the test request${why}.` };
	return { kind: "unchecked", reason: detail ? `${detail}.` : "the provider didn't say why." };
}

/**
 * Phrases a provider uses when the key itself is wrong ("Invalid API Key", "Incorrect API key
 * provided", "API key not valid", "invalid x-api-key"). A bare mention of an API key isn't enough:
 * "This API key has no access to model X" is about the model.
 */
const BAD_KEY =
	/\b(invalid|incorrect|wrong|bad|expired|revoked)[ _-]?(x-)?(api[ _-]?)?key\b|\bapi[ _-]?key\b[^.]{0,40}?\b(not valid|invalid|expired|revoked|incorrect)\b|\bapi_key_invalid\b|\bauthenticat|\bunauthori[sz]ed\b/i;
