import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assertSelfHostedFirecrawlUrl, firecrawlCrawl, firecrawlMap, pageMarkdown, requireFirecrawlApiUrl } from "../src/firecrawl.ts";
import { requireSearxngUrl, searxSearch, searxngUrl } from "../src/searx.ts";

const saved = { ...process.env };

function restoreEnv() {
	for (const k of ["SEARXNG_URL", "FIRECRAWL_API_URL", "FIRECRAWL_API_KEY", "TABKYRA_CONFIG_DIR"]) {
		if (Object.hasOwn(saved, k)) process.env[k] = saved[k];
		else delete process.env[k];
	}
}

beforeEach(() => {
	delete process.env.SEARXNG_URL;
	delete process.env.FIRECRAWL_API_URL;
	delete process.env.FIRECRAWL_API_KEY;
	process.env.TABKYRA_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tk-search-"));
});
afterEach(restoreEnv);

describe("searx", () => {
	it("requires SEARXNG_URL or config", () => {
		assert.equal(searxngUrl(), "");
		assert.throws(() => requireSearxngUrl(), /SEARXNG_URL/);
	});

	it("reads searxngUrl from search.json", () => {
		writeFileSync(join(process.env.TABKYRA_CONFIG_DIR, "search.json"), JSON.stringify({ searxngUrl: "http://127.0.0.1:8888/" }));
		assert.equal(requireSearxngUrl(), "http://127.0.0.1:8888");
	});

	it("queries the JSON API", async () => {
		const srv = createServer((req, res) => {
			assert.match(req.url, /\/search\?/);
			assert.match(req.url, /format=json/);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ results: [{ title: "One", url: "https://example.com/a", content: "hi", engine: "test" }] }));
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const { port } = srv.address();
		process.env.SEARXNG_URL = `http://127.0.0.1:${port}`;
		const out = await searxSearch("tabkyra");
		srv.close();
		assert.equal(out.query, "tabkyra");
		assert.equal(out.results.length, 1);
		assert.equal(out.results[0].url, "https://example.com/a");
	});
});

describe("firecrawl self-host only", () => {
	it("refuses api.firecrawl.dev and cousins", () => {
		for (const bad of [
			"https://api.firecrawl.dev",
			"https://api.firecrawl.dev/v2",
			"http://api.firecrawl.dev",
			"https://API.Firecrawl.dev",
			"https://foo.api.firecrawl.dev",
			"https://api.firecrawl.dev.",
			"https://api.firecrawl.dev./v2",
		]) {
			assert.throws(() => assertSelfHostedFirecrawlUrl(bad), /refuses hosted Firecrawl/, bad);
		}
	});

	it("accepts loopback and private URLs", () => {
		assert.equal(assertSelfHostedFirecrawlUrl("http://127.0.0.1:3002/"), "http://127.0.0.1:3002");
		assert.equal(assertSelfHostedFirecrawlUrl("http://100.64.0.1:3002"), "http://100.64.0.1:3002");
	});

	it("requireFirecrawlApiUrl refuses when unset", () => {
		assert.throws(() => requireFirecrawlApiUrl(), /FIRECRAWL_API_URL/);
	});

	it("page_markdown posts /v2/scrape", async () => {
		const srv = createServer((req, res) => {
			assert.equal(req.method, "POST");
			assert.equal(req.url, "/v2/scrape");
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				const j = JSON.parse(body);
				assert.equal(j.url, "https://example.com/");
				assert.deepEqual(j.formats, ["markdown"]);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						success: true,
						data: { markdown: "# Hi", metadata: { title: "Hi", sourceURL: "https://example.com/" } },
					}),
				);
			});
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const { port } = srv.address();
		process.env.FIRECRAWL_API_URL = `http://127.0.0.1:${port}`;
		const out = await pageMarkdown("https://example.com/");
		srv.close();
		assert.equal(out.markdown, "# Hi");
		assert.equal(out.title, "Hi");
	});

	it("page_markdown does not follow redirects (hosted bypass)", async () => {
		let destHits = 0;
		const dest = createServer((_req, res) => {
			destHits += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					success: true,
					data: { markdown: "# leaked", metadata: { title: "leaked", sourceURL: "https://example.com/" } },
				}),
			);
		});
		await new Promise((r) => dest.listen(0, "127.0.0.1", r));
		const destPort = dest.address().port;
		const srv = createServer((_req, res) => {
			res.writeHead(302, { Location: `http://127.0.0.1:${destPort}/v2/scrape` });
			res.end();
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const { port } = srv.address();
		process.env.FIRECRAWL_API_URL = `http://127.0.0.1:${port}`;
		try {
			await assert.rejects(
				() => pageMarkdown("https://example.com/"),
				(err) => {
					const msg = `${err}\n${err?.cause ?? ""}`;
					assert.match(msg, /unexpected redirect/i);
					return true;
				},
			);
			assert.equal(destHits, 0, "must not follow the redirect to the destination");
		} finally {
			delete process.env.FIRECRAWL_API_URL;
			await new Promise((r) => srv.close(r));
			await new Promise((r) => dest.close(r));
		}
	});

	it("map and crawl hit their paths", async () => {
		const seen = [];
		const srv = createServer((req, res) => {
			seen.push(req.url);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const { port } = srv.address();
		process.env.FIRECRAWL_API_URL = `http://127.0.0.1:${port}`;
		await firecrawlMap("https://example.com");
		await firecrawlCrawl("https://example.com", { limit: 3 });
		srv.close();
		assert.deepEqual(seen, ["/v2/map", "/v2/crawl"]);
	});
});
