/**
 * DNS over HTTPS (RFC 8484's JSON form): what public DNS says about a name, asked of a public resolver instead of this
 * computer's, which inside a tailnet answers ts.net names with tailnet addresses. TABKYRA_DOH_URL points it at a fake for tests.
 */
import { envVar } from "./env.ts";

export const dohUrl = () => envVar("DOH_URL") || "https://cloudflare-dns.com/dns-query";

export type DohRecord = { name?: unknown; type?: unknown; data?: unknown };
export type DohAnswer = { Status?: unknown; Answer?: DohRecord[]; Authority?: DohRecord[] };

/** DNS response codes by number, for messages. 0 (NOERROR) and 3 (NXDOMAIN) are answers; the rest mean the lookup failed. */
const RCODES: Record<number, string> = { 1: "FORMERR", 2: "SERVFAIL", 4: "NOTIMP", 5: "REFUSED" };

/**
 * The resolver was reached and answered, but with a failure: an HTTP error, or a DNS status other than NOERROR or NXDOMAIN
 * (SERVFAIL, for example, from broken DNSSEC). Unlike a resolver that can't be reached, waiting doesn't fix this.
 */
export class DohAnswerError extends Error {}

/** One question to the public resolver. Throws when it can't be asked, answers with an HTTP error, or its answer isn't JSON. */
export async function dohQuery(name: string, type: "A" | "AAAA" | "SOA" | "NS", timeoutMs = 5000): Promise<DohAnswer> {
	const url = new URL(dohUrl());
	url.searchParams.set("name", name);
	url.searchParams.set("type", type);
	const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
	// An HTTP error (5xx, 429) is the resolver having trouble, not an answer about the name: only a DNS rcode is that.
	if (!res.ok) throw new Error(`public DNS answered HTTP ${res.status}`);
	const body = (await res.json()) as DohAnswer;
	return body && typeof body === "object" ? body : {};
}

const records = (answer: DohAnswer, type: number) =>
	(Array.isArray(answer.Answer) ? answer.Answer : []).filter((a) => a && a.type === type && typeof a.data === "string").map((a) => String(a.data));

/** Throws a DohAnswerError when the answer's DNS status says the lookup failed. */
function checkStatus(name: string, answer: DohAnswer): void {
	const status = Number(answer.Status ?? 0);
	if (status !== 0 && status !== 3) throw new DohAnswerError(`public DNS couldn't look up ${name}: ${RCODES[status] ?? `status ${status}`}`);
}

/**
 * The addresses public DNS gives `name` (CNAMEs followed by the resolver): its IPv4 addresses, or when it has none, its IPv6
 * ones. Throws when it can't be asked, and a DohAnswerError when the lookup itself failed.
 */
export async function dohAddresses(name: string, timeoutMs = 5000): Promise<string[]> {
	const a = await dohQuery(name, "A", timeoutMs);
	checkStatus(name, a);
	const v4 = records(a, 1);
	if (v4.length || Number(a.Status ?? 0) === 3) return v4;
	const aaaa = await dohQuery(name, "AAAA", timeoutMs);
	checkStatus(name, aaaa);
	return records(aaaa, 28);
}
