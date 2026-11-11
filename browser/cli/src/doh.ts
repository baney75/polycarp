/**
 * DNS over HTTPS (RFC 8484's JSON form): what public DNS says about a name, asked of a public resolver instead of this
 * computer's, which inside a tailnet answers ts.net names with tailnet addresses. TABKYRA_DOH_URL points it at a fake for tests.
 */
import { envVar } from "./env.ts";

export const dohUrl = () => envVar("DOH_URL") || "https://cloudflare-dns.com/dns-query";

export type DohRecord = { name?: unknown; type?: unknown; data?: unknown };
export type DohAnswer = { Status?: unknown; Answer?: DohRecord[]; Authority?: DohRecord[] };

/** One question to the public resolver. Throws when it can't be asked or its answer isn't JSON. */
export async function dohQuery(name: string, type: "A" | "AAAA" | "SOA" | "NS", timeoutMs = 5000): Promise<DohAnswer> {
	const url = new URL(dohUrl());
	url.searchParams.set("name", name);
	url.searchParams.set("type", type);
	const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
	const body = (await res.json()) as DohAnswer;
	return body && typeof body === "object" ? body : {};
}

/** The IPv4 addresses public DNS gives `name` (CNAMEs followed by the resolver). Throws when it can't be asked. */
export async function dohAddresses(name: string, timeoutMs = 5000): Promise<string[]> {
	const answer = await dohQuery(name, "A", timeoutMs);
	return (Array.isArray(answer.Answer) ? answer.Answer : []).filter((a) => a && a.type === 1 && typeof a.data === "string").map((a) => String(a.data));
}
