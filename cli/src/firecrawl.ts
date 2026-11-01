/**
 * Optional client for a self-hosted Firecrawl API. FIRECRAWL_API_URL must point at your
 * own instance. Hosted api.firecrawl.dev (and lookalikes) are refused.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "./version.ts";

const HOSTED = /(?:^|\.)(?:api\.)?firecrawl\.dev$/i;

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

/** Raw configured URL, or empty. */
export function firecrawlApiUrlRaw(): string {
	const fromEnv = (process.env.FIRECRAWL_API_URL || "").trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	const file = join(configDir(), "search.json");
	if (!existsSync(file)) return "";
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as { firecrawlApiUrl?: string };
		return String(data.firecrawlApiUrl || "")
			.trim()
			.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

/**
 * Validate and return the self-hosted Firecrawl base URL.
 * Throws when unset, unparsable, or hosted (api.firecrawl.dev).
 */
export function requireFirecrawlApiUrl(): string {
	const url = firecrawlApiUrlRaw();
	if (!url) {
		throw new Error(
			"FIRECRAWL_API_URL is not set (and search.json has no firecrawlApiUrl). Point it at your self-hosted Firecrawl, for example http://127.0.0.1:3002. See config/search.example.json. Hosted api.firecrawl.dev is refused.",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`FIRECRAWL_API_URL is not a valid URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`FIRECRAWL_API_URL must be http(s), got ${parsed.protocol}`);
	}
	// URL keeps a trailing DNS dot; strip so api.firecrawl.dev. still matches HOSTED.
	const host = parsed.hostname.replace(/\.+$/, "");
	if (HOSTED.test(host)) {
		throw new Error(
			`FIRECRAWL_API_URL refuses hosted Firecrawl (${host}). Run your own instance and point FIRECRAWL_API_URL at it (loopback or tailnet only).`,
		);
	}
	return url.replace(/\/+$/, "");
}

/** Parse and refuse hosted endpoints. Returns the normalized base or throws. */
export function assertSelfHostedFirecrawlUrl(url: string): string {
	const prev = process.env.FIRECRAWL_API_URL;
	process.env.FIRECRAWL_API_URL = url;
	try {
		return requireFirecrawlApiUrl();
	} finally {
		if (prev === undefined) delete process.env.FIRECRAWL_API_URL;
		else process.env.FIRECRAWL_API_URL = prev;
	}
}

async function firecrawlPost(path: string, body: Record<string, unknown>): Promise<unknown> {
	const base = requireFirecrawlApiUrl();
	const key = (process.env.FIRECRAWL_API_KEY || "").trim();
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
		"User-Agent": `tabkyra-cli/${VERSION}`,
	};
	if (key) headers.Authorization = `Bearer ${key}`;
	const res = await fetch(new URL(path, `${base}/`), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
		// Never follow redirects: a 3xx to api.firecrawl.dev would bypass the hostname guard.
		redirect: "error",
	});
	const text = await res.text();
	let json: unknown = text;
	try {
		json = JSON.parse(text);
	} catch {
		/* keep text */
	}
	if (!res.ok) {
		const msg = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : text.slice(0, 200);
		throw new Error(`Firecrawl ${path} HTTP ${res.status}: ${msg}`);
	}
	return json;
}

export interface PageMarkdown {
	url: string;
	markdown: string;
	title?: string;
}

/** Scrape one URL to markdown through self-hosted Firecrawl. */
export async function pageMarkdown(url: string): Promise<PageMarkdown> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`page_markdown needs an absolute http(s) URL, got ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`page_markdown only fetches http(s), got ${parsed.protocol}`);
	}
	const json = (await firecrawlPost("/v2/scrape", {
		url: parsed.toString(),
		formats: ["markdown"],
	})) as {
		success?: boolean;
		data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } };
		markdown?: string;
	};
	const markdown = json.data?.markdown ?? json.markdown ?? "";
	if (!markdown) throw new Error("Firecrawl scrape returned no markdown.");
	return {
		url: json.data?.metadata?.sourceURL || parsed.toString(),
		markdown,
		title: json.data?.metadata?.title,
	};
}

export async function firecrawlMap(url: string, options: { limit?: number } = {}): Promise<unknown> {
	return firecrawlPost("/v2/map", { url, limit: options.limit ?? 100 });
}

export async function firecrawlCrawl(url: string, options: { limit?: number } = {}): Promise<unknown> {
	return firecrawlPost("/v2/crawl", { url, limit: options.limit ?? 10 });
}
