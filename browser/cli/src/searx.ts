/**
 * MCP `search`: query a self-hosted SearXNG. The base URL comes from SEARXNG_URL (or
 * ~/.config/tabkyra/search.json "searxngUrl"). No default host is baked in: set the env or
 * the config file. See config/search.example.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "./version.ts";

export interface SearchHit {
	title: string;
	url: string;
	content?: string;
	engine?: string;
	publishedDate?: string;
}

export interface SearchResult {
	query: string;
	results: SearchHit[];
}

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

/** Resolve the SearXNG base URL (no trailing slash). Empty when unset. */
export function searxngUrl(): string {
	const fromEnv = (process.env.SEARXNG_URL || "").trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	const file = join(configDir(), "search.json");
	if (!existsSync(file)) return "";
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { searxngUrl?: string };
		return String(data.searxngUrl || "")
			.trim()
			.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

export function requireSearxngUrl(): string {
	const url = searxngUrl();
	if (!url) {
		throw new Error(
			"SEARXNG_URL is not set (and ~/.config/tabkyra/search.json has no searxngUrl). Point it at your self-hosted SearXNG, for example http://127.0.0.1:8888. See config/search.example.json.",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`SEARXNG_URL is not a valid URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`SEARXNG_URL must be http(s), got ${parsed.protocol}`);
	}
	return url;
}

/** Query SearXNG's JSON API. categories default to general. */
export async function searxSearch(query: string, options: { categories?: string; language?: string; pageno?: number; limit?: number } = {}): Promise<SearchResult> {
	const q = query.trim();
	if (!q) throw new Error("search needs a non-empty query.");
	const base = requireSearxngUrl();
	const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
	const u = new URL("/search", `${base}/`);
	u.searchParams.set("q", q);
	u.searchParams.set("format", "json");
	if (options.categories) u.searchParams.set("categories", options.categories);
	if (options.language) u.searchParams.set("language", options.language);
	if (options.pageno && options.pageno > 1) u.searchParams.set("pageno", String(options.pageno));
	const res = await fetch(u, {
		headers: { Accept: "application/json", "User-Agent": `tabkyra-cli/${VERSION}` },
		signal: AbortSignal.timeout(30_000),
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status} for ${u.origin}.`);
	const body = (await res.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string; engine?: string; publishedDate?: string }>;
	};
	const results: SearchHit[] = (body.results ?? [])
		.filter((r) => r.url && r.title)
		.slice(0, limit)
		.map((r) => ({
			title: String(r.title),
			url: String(r.url),
			content: r.content ? String(r.content) : undefined,
			engine: r.engine ? String(r.engine) : undefined,
			publishedDate: r.publishedDate ? String(r.publishedDate) : undefined,
		}));
	return { query: q, results };
}
