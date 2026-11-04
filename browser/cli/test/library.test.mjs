// `tabkyra library` against a local stand-in for doi.org, OpenAlex and Crossref: sources are
// verified before they're saved, retractions are flagged, unregistered DOIs are refused, and
// hostile metadata can't hide text, inject Markdown or YAML, or write outside the vault.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-library-"));

const RECORDS = {
	"10.1000/good": {
		type: "journal-article",
		title: "Spacing & memory: 100% {better}",
		author: [{ family: "Cepeda", given: "N." }, { family: "Rohrer", given: "D." }],
		issued: { "date-parts": [[2006, 5]] },
		"container-title": "Psychological Bulletin",
		volume: "132",
		issue: "3",
		page: "354-380",
		DOI: "10.1000/good",
	},
	"10.1000/retracted": {
		type: "journal-article",
		title: "RETRACTED: A bad study",
		author: [{ family: "Wakefield", given: "A." }],
		issued: { "date-parts": [[1998]] },
		"container-title": "The Lancet",
		DOI: "10.1000/retracted",
	},
	"10.1000/hostile": {
		type: "journal-article",
		title: "Normal​ title [[Secret note]] <script>alert(1)</script>\n---\ninjected: true",
		author: [{ family: "Evil‮", given: "E." }],
		issued: { "date-parts": [[2020]] },
		DOI: "10.1000/hostile",
	},
	"10.48550/arXiv.1706.03762": {
		type: "article",
		title: "Attention Is All You Need",
		author: [{ family: "Vaswani", given: "Ashish" }],
		issued: { "date-parts": [[2017]] },
		DOI: "10.48550/arXiv.1706.03762",
	},
};

let server;
let env;
const requests = [];
/** Switches the tests flip: checks that fail, and DOIs retracted after they were added. */
const mock = { failChecks: false, retractedNow: new Set(), openalexMissing: new Set(), doiDown: false };
Object.assign(RECORDS, {
	"10.1000/later": { type: "journal-article", title: "Fine at first", author: [{ family: "Later", given: "L." }], issued: { "date-parts": [[2019]] }, DOI: "10.1000/later" },
	"10.1000/a#b": { type: "journal-article", title: "Hash in the suffix", author: [{ family: "Hash", given: "H." }], issued: { "date-parts": [[2018]] }, DOI: "10.1000/a#b" },
	"10.1000/escapes": {
		type: "journal-article",
		title: "Outcomes for n<10 versus n>50 cohorts with a back\\slash and \\[Full text\\](https://evil.example.net/p.pdf)",
		author: [{ family: "Esc", given: "E." }],
		issued: { "date-parts": [[2021]] },
		DOI: "10.1000/escapes",
	},
	"10.1000/oaonly": { type: "journal-article", title: "Flagged by OpenAlex only", author: [{ family: "Oa", given: "O." }], issued: { "date-parts": [[2016]] }, DOI: "10.1000/oaonly" },
	"10.1000/many-notices": { type: "journal-article", title: "Many notices", author: [{ family: "Many", given: "M." }], issued: { "date-parts": [[2015]] }, DOI: "10.1000/many-notices" },
	"10.1000/alias2": { type: "journal-article", title: "Alias of a retracted work", author: [{ family: "Alias", given: "B." }], issued: { "date-parts": [[2014]] }, DOI: "10.1000/primary-retracted" },
	"10.1000/alias3": { type: "journal-article", title: "Alias sharing a notice", author: [{ family: "Shared", given: "S." }], issued: { "date-parts": [[2013]] }, DOI: "10.1000/primary3" },
	"10.1000/primary3": { type: "journal-article", title: "Primary sharing a notice", author: [{ family: "Shared", given: "S." }], issued: { "date-parts": [[2013]] }, DOI: "10.1000/primary3" },
	"10.1000/alias4": { type: "journal-article", title: "Alias sharing a DOI-less notice", author: [{ family: "Shared", given: "T." }], issued: { "date-parts": [[2014]] }, DOI: "10.1000/primary4" },
	"10.1000/primary4": { type: "journal-article", title: "Primary sharing a DOI-less notice", author: [{ family: "Shared", given: "T." }], issued: { "date-parts": [[2014]] }, DOI: "10.1000/primary4" },
	"10.1000/nodoi-notices": { type: "journal-article", title: "Two corrections without DOIs", author: [{ family: "Nodoi", given: "N." }], issued: { "date-parts": [[2012]] }, DOI: "10.1000/nodoi-notices" },
	"10.1000/primary-retracted": { type: "journal-article", title: "Primary", author: [{ family: "Alias", given: "B." }], issued: { "date-parts": [[2014]] }, DOI: "10.1000/primary-retracted" },
	"10.1000/marker": { type: "journal-article", title: "A title with tabkyra-generated: inside it", author: [{ family: "Marker", given: "M." }], issued: { "date-parts": [[2013]] }, DOI: "10.1000/marker" },
	"10.1000/percent": { type: "journal-article", title: "Vaccine outcomes %% hidden", author: [{ literal: "World Health Organization" }], issued: { "date-parts": [[2012]] }, DOI: "10.1000/percent" },
	"10.1000/partial": { type: "journal-article", title: "Partly retracted", author: [{ family: "Part", given: "P." }], issued: { "date-parts": [[2011]] }, DOI: "10.1000/partial" },
	"10.1000/emptyshape": { type: "journal-article", title: "Empty answers", author: [{ family: "Empty", given: "E." }], issued: { "date-parts": [[2010]] }, DOI: "10.1000/emptyshape" },
	"10.1000/springer_13": { type: "chapter", title: "Underscore DOI", author: [{ family: "Under", given: "U." }], issued: { "date-parts": [[2020]] }, DOI: "10.1000/springer_13" },
	"10.1000/nullnotice": { type: "journal-article", title: "Null notice", author: [{ family: "Null", given: "N." }], issued: { "date-parts": [[2009]] }, DOI: "10.1000/nullnotice" },
	"10.1000/smuggle": { type: "journal-article", title: `Visible${String.fromCodePoint(0xe0100, 0xe0101)} title`, author: [{ family: "Smug", given: "S." }], issued: { "date-parts": [[2008]] }, DOI: "10.1000/smuggle" },
	"10.48550/arXiv.hep-th/9901001": { type: "article", title: "Old style arXiv", author: [{ family: "Old", given: "O." }], issued: { "date-parts": [[1999]] }, DOI: "10.48550/arXiv.hep-th/9901001" },
	"10.1000/odd": {
		type: "__proto__",
		title: "RETRACTED: Odd record",
		author: [null, { family: "Smith and Mallory", given: "J." }],
		issued: { "date-parts": [[1e21]] },
		DOI: "10.1000/odd",
	},
	"10.1000/noagency": { type: "journal-article", title: "No agency", author: [{ family: "Nobody", given: "N." }], issued: { "date-parts": [[2007]] }, DOI: "10.1000/noagency" },
	"10.1000/updatedby": { type: "journal-article", title: "Retracted via updated-by", author: [{ family: "Upd", given: "U." }], issued: { "date-parts": [[2006]] }, DOI: "10.1000/updatedby" },
	"10.1000/ordinary": { type: "journal-article", title: "Retraction rates in biomedical journals: a review", author: [{ family: "Rate", given: "R." }], issued: { "date-parts": [[2005]] }, DOI: "10.1000/ordinary" },
	"10.1000/brace": { type: "journal-article", title: "Effect of } on recall", author: [{ family: "Brace", given: "B." }], issued: { "date-parts": [[2004]] }, DOI: "10.1000/brace" },
	"10.1000/oaodd": { type: "journal-article", title: "Odd open access link", author: [{ family: "Link", given: "L." }], issued: { "date-parts": [[2003]] }, DOI: "10.1000/oaodd" },
	"10.1000/alias": { type: "journal-article", title: "Alias target", author: [{ family: "Alias", given: "A." }], issued: { "date-parts": [[2017]] }, DOI: "10.9999/someone-else" },
});

before(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		requests.push(url.pathname + url.search);
		const json = (status, body) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/doi/10.1000/landing-only") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end("<html>publisher landing page</html>");
		}
		if (url.pathname.startsWith("/doi/") && mock.doiDown) return json(503, {});
		if (url.pathname === "/doi/10.1000/redirected") {
			// A registrant's own site, on another host, answering with JSON that claims to be a record.
			res.writeHead(302, { location: `http://localhost:${server.address().port}/landing.json` });
			return res.end();
		}
		if (url.pathname === "/landing.json") return json(200, { type: "journal-article", title: "Self-published claim", DOI: "10.1000/redirected" });
		if (url.pathname.startsWith("/doi/ra/")) {
			const doi = decodeURIComponent(url.pathname.slice("/doi/ra/".length));
			if (doi === "10.1000/noagency") return json(404, {});
			return json(200, [{ DOI: doi, RA: doi.startsWith("10.48550/") ? "DataCite" : "Crossref" }]);
		}
		if (url.pathname.startsWith("/doi/")) {
			const doi = decodeURIComponent(url.pathname.slice(5));
			const record = RECORDS[doi];
			if (!record) return json(404, { error: "not found" });
			if ((req.headers.accept ?? "").startsWith("text/x-bibliography")) {
				res.writeHead(200, { "content-type": "text/plain" });
				return res.end(`${record.author[0].family} (${record.issued["date-parts"][0][0]}). ${record.title}.`);
			}
			return json(200, record);
		}
		if (url.pathname.startsWith("/openalex/works/doi:")) {
			if (mock.failChecks) return json(503, {});
			const doi = decodeURIComponent(url.pathname.slice("/openalex/works/doi:".length));
			if (!RECORDS[doi] || mock.openalexMissing.has(doi)) return json(404, {});
			if (doi === "10.1000/emptyshape") return json(200, {});
			const oa = doi === "10.1000/oaodd" ? "https://evil.example.net/[[Secret note]]/%%x" : "https://example.org/files/My%20Paper.pdf";
			return json(200, { is_retracted: doi === "10.1000/oaonly", cited_by_count: 42, open_access: { oa_url: oa } });
		}
		if (url.pathname.startsWith("/crossref/works/")) {
			if (mock.failChecks) return json(429, {});
			const doi = decodeURIComponent(url.pathname.slice("/crossref/works/".length));
			// Like the real Crossref, a notice found by filter=updates is listed again on the work's own record.
			const updatedBy = {
				"10.1000/updatedby": [{ type: "retraction", DOI: "10.1000/rw" }],
				"10.1000/retracted": [{ type: "retraction", DOI: "10.1000/NOTICE" }],
				// Two notices of one type with no DOI: distinct notices, both kept.
				"10.1000/nodoi-notices": [{ type: "correction" }, { type: "correction" }],
				"10.1000/alias4": [{ type: "correction" }],
				"10.1000/primary4": [{ type: "correction" }],
			};
			return json(200, { message: { "updated-by": updatedBy[doi] ?? [] } });
		}
		if (url.pathname === "/crossref/works") {
			if (mock.failChecks) return json(429, {});
			const doi = (url.searchParams.get("filter") ?? "").replace(/^updates:/, "");
			const retracted = doi === "10.1000/retracted" || doi === "10.1000/primary-retracted" || mock.retractedNow.has(doi);
			// An alias and its primary that both point at the same notice.
			if (doi === "10.1000/alias3" || doi === "10.1000/primary3") {
				return json(200, { message: { "total-results": 1, items: [{ DOI: "10.1000/shared-notice", "update-to": [{ type: "retraction", DOI: doi }] }] } });
			}
			const items = retracted ? [{ DOI: "10.1000/notice", "update-to": [{ type: "retraction", DOI: doi }] }] : [];
			if (doi === "10.1000/many-notices") return json(200, { message: { "total-results": 1500, items: [] } });
			if (doi === "10.1000/nullnotice") return json(200, { message: { "total-results": 1, items: [null] } });
			if (doi === "10.1000/partial") return json(200, { message: { "total-results": 1, items: [{ DOI: "10.1000/n2", "update-to": [{ type: "partial_retraction", DOI: doi }] }] } });
			return json(200, { message: { "total-results": items.length, items } });
		}
		json(404, {});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	env = {
		HOME: join(root, "home"),
		PATH: dirname(process.execPath),
		NO_COLOR: "1",
		TABKYRA_LIBRARY_DIR: join(root, "lib"),
		TABKYRA_DOI_BASE: `${base}/doi`,
		TABKYRA_OPENALEX_BASE: `${base}/openalex`,
		TABKYRA_CROSSREF_BASE: `${base}/crossref`,
	};
	mkdirSync(env.HOME, { recursive: true });
});

after(() => {
	server?.close();
	rmSync(root, { recursive: true, force: true });
});

// Async: the stand-in server runs in this process, so a blocking spawn would starve it.
function lib(...args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, "library", ...args], { env });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("close", (code) => resolve({ code, out }));
	});
}

function items() {
	return JSON.parse(readFileSync(join(env.TABKYRA_LIBRARY_DIR, "library.json"), "utf8")).items;
}

test("add verifies a DOI against the registry, OpenAlex and Crossref, then saves it", async () => {
	const r = await lib("add", "https://doi.org/10.1000/good", "--quote", "spacing helps", "--location", "p. 360", "--tag", "memory");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /verified by doi\.org, openalex, crossref-updates; cited by 42/);
	const [item] = items();
	assert.equal(item.id, "cepeda2006spacing");
	assert.equal(item.type, "article-journal", "Crossref's journal-article maps to CSL article-journal");
	assert.equal(item.tabkyra.verified.retracted, false);
	assert.deepEqual(item.tabkyra.quote, { text: "spacing helps", location: "p. 360" });
	assert.equal((await lib("add", "10.1000/good")).out.startsWith("Updated"), true, "adding twice updates, never duplicates");
	assert.equal(items().length, 1);
});

test("a retracted source is saved, flagged, exits 3 and cites as [RETRACTED]", async () => {
	const r = await lib("add", "doi:10.1000/retracted");
	assert.equal(r.code, 3, r.out);
	assert.match(r.out, /notice: retraction 10\.1000\/notice/);
	assert.equal(r.out.match(/notice: retraction/gi)?.length, 1, "a notice Crossref lists twice is shown once");
	assert.match(r.out, /RETRACTED: don't cite this as support/);
	const item = items().find((i) => i.DOI === "10.1000/retracted");
	assert.equal(item.id, "wakefield1998bad", "the RETRACTED: prefix doesn't become the citekey");
	assert.match((await lib("cite", item.id)).out, /^\[RETRACTED\]/);
	assert.match((await lib("export", "--format", "bibtex")).out, /note = \{RETRACTED\}/);
});

test("an unregistered DOI and a non-identifier are refused", async () => {
	const missing = await lib("add", "10.1000/made-up");
	assert.equal(missing.code, 1, missing.out);
	assert.match(missing.out, /not registered/);
	const bad = await lib("add", "https://example.com/some-article");
	assert.equal(bad.code, 1, bad.out);
	assert.match(bad.out, /not a DOI/);
	assert.equal((await lib("bogus")).code, 2);
});

test("an arXiv id resolves through its DataCite DOI", async () => {
	assert.equal((await lib("add", "arXiv:1706.03762v5")).code, 0);
	assert.ok(requests.some((p) => p.startsWith("/doi/10.48550/arXiv.1706.03762")));
});

test("exports escape for each format", async () => {
	const bib = (await lib("export", "--format", "bibtex")).out;
	assert.match(bib, /@article\{cepeda2006spacing,/);
	assert.match(bib, /title = \{Spacing \\& memory: 100\\% \\textbraceleft\{\}better\\textbraceright\{\}\}/);
	assert.match(bib, /pages = \{354--380\}/);
	const ris = (await lib("export", "--format", "ris")).out;
	assert.match(ris, /^TY {2}- JOUR$/m);
	assert.match(ris, /^SP {2}- 354$/m);
	assert.match(ris, /^EP {2}- 380$/m);
	const csl = JSON.parse((await lib("export", "--format", "csl")).out);
	assert.ok(csl.every((i) => !("tabkyra" in i)), "CSL-JSON carries no Tabkyra fields");
	assert.equal((await lib("export", "--format", "docx")).code, 1);
});

test("hostile metadata loses hidden text and can't inject Markdown, HTML or YAML into notes", async () => {
	assert.equal((await lib("add", "10.1000/hostile")).code, 0);
	const item = items().find((i) => i.DOI === "10.1000/hostile");
	assert.doesNotMatch(item.title, /[​‮\n]|<script/);
	const vault = join(root, "vault");
	mkdirSync(vault);
	const r = await lib("obsidian", vault);
	assert.equal(r.code, 0, r.out);
	const note = readFileSync(join(vault, "Sources", `${item.id}.md`), "utf8");
	const front = note.split("\n---\n")[0];
	assert.doesNotMatch(front, /^injected:/m, "a title can't add a frontmatter key");
	assert.doesNotMatch(note, /(?<!\\)\[\[/, "no live wikilink from fetched text");
	assert.match(note, /\\\[\\\[Secret note\\\]\\\]/);
	const retracted = readFileSync(join(vault, "Sources", "wakefield1998bad.md"), "utf8");
	assert.match(retracted, /\[!warning\] Retracted/);
	assert.match(retracted, /^retracted: true$/m);
});

test("obsidian refuses a folder outside the vault, including through a symlink", async () => {
	const vault = join(root, "vault2");
	mkdirSync(vault);
	assert.equal((await lib("obsidian", vault, "--folder", "../escape")).code, 1);
	const outside = join(root, "outside");
	mkdirSync(outside);
	symlinkSync(outside, join(vault, "Linked"));
	const r = await lib("obsidian", vault, "--folder", "Linked");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /outside the vault/);
	assert.deepEqual(readdirSync(outside), []);
	assert.equal(existsSync(join(root, "escape")), false);
});

test("search, remove and the MCP tools agree with the CLI", async () => {
	assert.match((await lib("search", "spacing")).out, /cepeda2006spacing/);
	assert.equal((await lib("search", "nothing-matches-this")).code, 1);
	const mcp = new Client({ name: "tabkyra-library-test", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...env, TABKYRA_SOCKET_DIR: join(root, "sock") }, stderr: "ignore" }),
	);
	try {
		const found = await mcp.callTool({ name: "library_search", arguments: { query: "attention" } });
		assert.match(found.content[0].text, /vaswani2017attention/);
		const cited = await mcp.callTool({ name: "library_cite", arguments: { citekey: "cepeda2006spacing" } });
		assert.match(cited.content[0].text, /Cepeda \(2006\)/);
		const refused = await mcp.callTool({ name: "library_add", arguments: { id: "10.1000/made-up" } });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /not registered/);
	} finally {
		await mcp.close();
	}
	assert.equal((await lib("remove", "vaswani2017attention")).code, 0);
	assert.equal((await lib("remove", "vaswani2017attention")).code, 1);
});

test("failed retraction checks are reported as incomplete, and never clear a recorded retraction", async () => {
	mock.failChecks = true;
	try {
		const r = await lib("add", "10.1000/later");
		assert.equal(r.code, 4, r.out);
		assert.match(r.out, /Retraction check incomplete/);
		assert.equal(items().find((i) => i.DOI === "10.1000/later").tabkyra.verified.complete, false);
		const wakefield = items().find((i) => i.DOI === "10.1000/retracted").id;
		const v = await lib("verify", wakefield);
		assert.equal(v.code, 3, v.out);
		assert.equal(items().find((i) => i.id === wakefield).tabkyra.verified.retracted, true, "an incomplete re-check keeps the retraction");
	} finally {
		mock.failChecks = false;
	}
});

test("adding a source again re-checks it, so a later retraction is caught", async () => {
	assert.equal((await lib("add", "10.1000/later")).code, 0);
	mock.retractedNow.add("10.1000/later");
	try {
		const r = await lib("add", "10.1000/later");
		assert.equal(r.code, 3, r.out);
	} finally {
		mock.retractedNow.delete("10.1000/later");
	}
});

test("parallel adds both land", async () => {
	await Promise.all([lib("add", "10.1000/a#b"), lib("add", "10.1000/escapes")]);
	const dois = items().map((i) => i.DOI);
	assert.ok(dois.includes("10.1000/a#b") && dois.includes("10.1000/escapes"), dois.join(", "));
	assert.ok(requests.some((p) => p.startsWith("/doi/10.1000/a%23b")), "a # in the suffix is encoded, not cut off");
});

test("metadata keeps comparison signs, and every format escapes it correctly", async () => {
	const item = items().find((i) => i.DOI === "10.1000/escapes");
	assert.match(item.title, /n<10 versus n>50/);
	const bib = (await lib("export", "--format", "bibtex")).out;
	assert.match(bib, /back\\textbackslash\{\}slash/);
	assert.doesNotMatch(bib, /textbackslash\\\{/);
	const csl = JSON.parse((await lib("export", "--format", "csl")).out);
	assert.equal(csl.find((i) => i.DOI === "10.1000/retracted").note, "RETRACTED");
	const vault = join(root, "vault-esc");
	mkdirSync(vault);
	assert.equal((await lib("obsidian", vault)).code, 0);
	const note = readFileSync(join(vault, "Sources", `${item.id}.md`), "utf8");
	assert.doesNotMatch(note, /(?<!\\)\[Full text(?<!\\)\]\(/, "no live link from fetched text");
	assert.match(readFileSync(join(vault, "Sources", "cepeda2006spacing.md"), "utf8"), /My%20Paper\.pdf/, "an encoded URL isn't encoded twice");
});

test("the requested DOI is the identity, and an agency without metadata isn't called made up", async () => {
	// The primary DOI isn't known to OpenAlex here, so the check is honestly incomplete (4).
	assert.equal((await lib("add", "10.1000/alias")).code, 4);
	assert.ok(items().some((i) => i.DOI === "10.1000/alias") && !items().some((i) => i.DOI === "10.9999/someone-else"));
	const r = await lib("add", "10.1000/landing-only");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /registered, but its agency returned no citation metadata/);
	assert.doesNotMatch(r.out, /made up/);
});

test("verify reports keys that match nothing", async () => {
	const r = await lib("verify", "nosuchkey2000");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /No source with key nosuchkey2000/);
});

test("obsidian never writes through a link, never makes folders outside, and keeps edited notes", async () => {
	const vault = join(root, "vault-links");
	mkdirSync(join(vault, "Sources"), { recursive: true });
	const target = join(root, "planted-target.txt");
	symlinkSync(target, join(vault, "Sources", "cepeda2006spacing.md"));
	const outside = join(root, "outside-dir");
	mkdirSync(outside);
	symlinkSync(outside, join(vault, "Linked"));
	assert.equal((await lib("obsidian", vault, "--folder", "Linked/NewFolder")).code, 1);
	assert.deepEqual(readdirSync(outside), [], "nothing created through the link");
	const r = await lib("obsidian", vault);
	assert.equal(r.code, 0, r.out);
	assert.equal(existsSync(target), false, "a dangling link's target is never created");
	const mine = join(vault, "Sources", "wakefield1998bad.md");
	writeFileSync(mine, `${readFileSync(mine, "utf8")}\nMy own notes.\n`);
	const again = await lib("obsidian", vault);
	assert.match(again.out, /kept .*wakefield1998bad\.md/);
	assert.match(readFileSync(mine, "utf8"), /My own notes\./);
});

test("cite and exports keep a # in the DOI, and mark sources not fully checked", async () => {
	const key = items().find((i) => i.DOI === "10.1000/a#b").id;
	requests.length = 0;
	assert.equal((await lib("cite", key)).code, 0);
	assert.ok(requests.includes("/doi/10.1000/a%23b"), requests.join(" "));
	const bib = (await lib("export", "--format", "bibtex")).out;
	assert.match(bib, /url = \{https:\/\/doi\.org\/10\.1000\/a%23b\}/);
	mock.failChecks = true;
	try {
		await lib("add", "10.1000/marker");
	} finally {
		mock.failChecks = false;
	}
	const marker = items().find((i) => i.DOI === "10.1000/marker");
	assert.match((await lib("cite", marker.id)).out, /^\[RETRACTION CHECK INCOMPLETE\]/);
	assert.match((await lib("export", "--format", "ris")).out, /N1 {2}- RETRACTION CHECK INCOMPLETE/);
	assert.match((await lib("search", "marker")).out, /marker/);
});

test("an OpenAlex-only retraction survives a later OpenAlex 404", async () => {
	assert.equal((await lib("add", "10.1000/oaonly")).code, 3);
	mock.openalexMissing.add("10.1000/oaonly");
	try {
		const key = items().find((i) => i.DOI === "10.1000/oaonly").id;
		assert.equal((await lib("verify", key)).code, 3);
		assert.equal(items().find((i) => i.id === key).tabkyra.verified.retracted, true);
	} finally {
		mock.openalexMissing.delete("10.1000/oaonly");
	}
});

test("more update notices than one page leaves the check incomplete", async () => {
	assert.equal((await lib("add", "10.1000/many-notices")).code, 4);
});

test("an alias DOI is checked under its primary DOI too", async () => {
	const r = await lib("add", "10.1000/alias2");
	assert.equal(r.code, 3, r.out);
	assert.ok(items().some((i) => i.DOI === "10.1000/alias2"));
});

test("a notice that an alias and its primary both report is listed once", async () => {
	const r = await lib("add", "10.1000/alias3");
	assert.equal(r.code, 3, r.out);
	assert.equal(r.out.match(/notice: retraction 10\.1000\/shared-notice/g)?.length, 1, r.out);
	assert.equal(items().find((i) => i.DOI === "10.1000/alias3").tabkyra.verified.notices.length, 1);
});

test("notices without a DOI are each kept", async () => {
	const r = await lib("add", "10.1000/nodoi-notices");
	assert.equal(r.out.match(/notice: correction/g)?.length, 2, r.out);
});

test("a DOI-less notice that an alias and its primary both report is listed once", async () => {
	const r = await lib("add", "10.1000/alias4");
	assert.equal(r.out.match(/notice: correction/g)?.length, 1, r.out);
	assert.equal(items().find((i) => i.DOI === "10.1000/alias4").tabkyra.verified.notices.length, 1);
});

test("duplicate notices saved by an older version are shown and kept once", async () => {
	const file = join(env.TABKYRA_LIBRARY_DIR, "library.json");
	const library = JSON.parse(readFileSync(file, "utf8"));
	const base = library.items.find((i) => i.DOI === "10.1000/retracted");
	const notice = { type: "retraction", doi: "10.1000/legacy-notice" };
	library.items.push({
		...structuredClone(base),
		id: "legacy1998dup",
		DOI: "10.1000/legacy",
		tabkyra: { ...structuredClone(base.tabkyra), verified: { ...base.tabkyra.verified, retracted: true, notices: [notice, notice, notice] } },
	});
	writeFileSync(file, JSON.stringify(library));
	mock.failChecks = true;
	try {
		// The re-check fails, so the stored retraction and its notices are kept.
		assert.equal((await lib("verify", "legacy1998dup")).code, 3);
	} finally {
		mock.failChecks = false;
	}
	assert.deepEqual(items().find((i) => i.id === "legacy1998dup").tabkyra.verified.notices, [notice]);
});

test("doi.org being down isn't reported as registered or made up; a bare % doesn't crash", async () => {
	mock.doiDown = true;
	try {
		const r = await lib("add", "10.1000/new-while-down");
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /doi\.org couldn't answer/);
		assert.doesNotMatch(r.out, /registered|made up/);
	} finally {
		mock.doiDown = false;
	}
	const pct = await lib("add", "10.1000/100%");
	assert.doesNotMatch(pct.out, /URI malformed/);
	assert.match(pct.out, /not registered/);
});

test("notes escape Obsidian comment markers, place the hash on its own line, and corporate authors stay one name", async () => {
	assert.equal((await lib("add", "10.1000/percent")).code, 0);
	const vault = join(root, "vault-r2");
	mkdirSync(vault);
	assert.equal((await lib("obsidian", vault)).code, 0);
	const pct = items().find((i) => i.DOI === "10.1000/percent").id;
	// The body renders as Markdown, where %% opens a comment; frontmatter is YAML and doesn't.
	const body = readFileSync(join(vault, "Sources", `${pct}.md`), "utf8").split("\n---\n")[1];
	assert.doesNotMatch(body, /(?<!\\)%(?<!\\)%/);
	const again = await lib("obsidian", vault);
	const marker = items().find((i) => i.DOI === "10.1000/marker").id;
	assert.doesNotMatch(again.out, new RegExp(`kept .*${marker}`), "a title with the marker text doesn't break the hash");
	assert.match((await lib("export", "--format", "bibtex")).out, /author = \{\{World Health Organization\}\}/);
});

test("a kept note whose source is retracted is reported, and the export exits 3", async () => {
	const vault = join(root, "vault-stale");
	mkdirSync(vault);
	await lib("obsidian", vault);
	// A source that was clean when its note was written, then retracted after the user edited it.
	const key = items().find((i) => i.DOI === "10.1000/good").id;
	const note = join(vault, "Sources", `${key}.md`);
	assert.match(readFileSync(note, "utf8"), /^status: "verified"$/m);
	writeFileSync(note, `${readFileSync(note, "utf8")}\nmine\n`);
	mock.retractedNow.add("10.1000/good");
	try {
		await lib("verify", key);
		const r = await lib("obsidian", vault);
		assert.equal(r.code, 3, r.out);
		assert.match(r.out, /NOT UPDATED, RETRACTED/);
		// Once the user's note says retracted, it isn't reported again.
		writeFileSync(note, readFileSync(note, "utf8").replace('status: "verified"', 'status: "retracted"'));
		assert.equal((await lib("obsidian", vault)).code, 0);
	} finally {
		mock.retractedNow.delete("10.1000/good");
	}
});

test("unknown options are refused, a linked vault root works, and a dead process's lock is taken over", async () => {
	assert.equal((await lib("add", "10.1000/good", "--qoute", "x")).code, 2);
	const real = join(root, "real-vault");
	mkdirSync(real);
	symlinkSync(real, join(root, "linked-vault"));
	assert.equal((await lib("obsidian", join(root, "linked-vault"))).code !== 1, true);
	const lock = join(env.TABKYRA_LIBRARY_DIR, "library.json.lock");
	mkdirSync(lock);
	writeFileSync(join(lock, "pid"), "999999");
	assert.equal((await lib("remove", "nosuchkey")).code, 1, "ran under a lock taken from a dead owner");
	assert.equal(existsSync(lock), false);
});

test("library_add returns a flat summary with the documented fields", async () => {
	const mcp = new Client({ name: "tabkyra-library-test2", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...env, TABKYRA_SOCKET_DIR: join(root, "sock2") }, stderr: "ignore" }),
	);
	try {
		const r = await mcp.callTool({ name: "library_add", arguments: { id: "10.1000/good" } });
		const out = JSON.parse(r.content[0].text);
		assert.equal(out.citekey, "cepeda2006spacing");
		assert.equal(out.retracted, false);
		assert.equal(out.complete, true);
	} finally {
		await mcp.close();
	}
});

test("an alias whose primary is retracted stays retracted on every later check", async () => {
	const key = items().find((i) => i.DOI === "10.1000/alias2").id;
	assert.equal(items().find((i) => i.id === key).tabkyra.primaryDoi, "10.1000/primary-retracted");
	assert.equal((await lib("verify", key)).code, 3);
	assert.equal((await lib("add", "10.1000/alias2")).code, 3);
});

test("list shows the warning, --name=value works, and a value may start with --", async () => {
	assert.match((await lib("list")).out, /\[RETRACTION CHECK INCOMPLETE\]/);
	const r = await lib("add", "--note=a note", "10.1000/good", "--quote", "-- as the authors note, spacing helps");
	assert.notEqual(r.code, 2, r.out);
	const good = items().find((i) => i.DOI === "10.1000/good");
	assert.equal(good.tabkyra.note, "a note");
	assert.equal(good.tabkyra.quote.text, "-- as the authors note, spacing helps");
});

test("a bare URL in fetched text doesn't become a link in a note", async () => {
	const vault = join(root, "vault-url");
	mkdirSync(vault);
	await lib("obsidian", vault);
	const key = items().find((i) => i.DOI === "10.1000/escapes").id;
	const body = readFileSync(join(vault, "Sources", `${key}.md`), "utf8").split("\n---\n")[1].split("\nDOI:")[0];
	assert.doesNotMatch(body, /https:\/\/evil/);
});

test("a partial retraction counts, and an answer missing its fields isn't a check", async () => {
	assert.equal((await lib("add", "10.1000/partial")).code, 3);
	assert.equal((await lib("add", "10.1000/emptyshape")).code, 4);
});

test("DataCite DOIs aren't marked checked by Crossref; old arXiv ids resolve", async () => {
	assert.equal((await lib("add", "arXiv:hep-th/9901001")).code, 0);
	const item = items().find((i) => i.DOI === "10.48550/arXiv.hep-th/9901001");
	assert.equal(item.tabkyra.agency, "datacite");
	assert.equal(item.tabkyra.verified.checks.crossref, "n/a");
});

test("a malformed notice leaves the check incomplete", async () => {
	assert.equal((await lib("add", "10.1000/nullnotice")).code, 4);
});

test("identifiers with newlines or dot segments are refused, and hidden selectors are stripped", async () => {
	for (const id of ["10.1000/x%0AER%20%20-%20", "10.9999/not-real/../../10.1037/0033-2909.132.3.354", "10.9999/x/%2e%2e/%2e%2e/10.1000/good"]) {
		const r = await lib("add", id);
		assert.equal(r.code, 1, `${id}: ${r.out}`);
		assert.match(r.out, /not a DOI/);
	}
	await lib("add", "10.1000/smuggle");
	assert.doesNotMatch(items().find((i) => i.DOI === "10.1000/smuggle").title, /[\u{E0100}-\u{E01EF}]/u);
});

test("BibTeX keeps the doi field verbatim, marks combine, and an inherited name isn't a subcommand", async () => {
	await lib("add", "10.1000/springer_13");
	assert.match((await lib("export", "--format", "bibtex")).out, /doi = \{10\.1000\/springer_13\}/);
	assert.equal((await lib("constructor", "--x")).code, 2);
});

test("odd records are saved sanely: null authors, absurd years, prototype type names, names with 'and', retraction in the title", async () => {
	const r = await lib("add", "10.1000/odd");
	assert.equal(r.code, 3, r.out);
	const odd = items().find((i) => i.DOI === "10.1000/odd");
	assert.match(odd.id, /^[a-z0-9]+$/);
	assert.equal(odd.issued, undefined);
	assert.equal(typeof odd.type, "string");
	assert.match((await lib("export", "--format", "bibtex")).out, /author = \{\{Smith and Mallory\}, J\.\}/);
});

test("metadata from a registrant's own site isn't accepted, and an unknown agency is incomplete", async () => {
	const r = await lib("add", "10.1000/redirected");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /no citation metadata/);
	assert.equal((await lib("add", "10.1000/noagency")).code, 4);
});

test("a retraction announced only in the title survives every re-check; ordinary titles aren't flagged", async () => {
	const odd = items().find((i) => i.DOI === "10.1000/odd").id;
	assert.equal((await lib("verify", odd)).code, 3);
	assert.equal((await lib("add", "10.1000/odd")).code, 3);
	assert.equal((await lib("add", "10.1000/ordinary")).code, 0);
});

test("Crossref's updated-by on the work's own record counts", async () => {
	assert.equal((await lib("add", "10.1000/updatedby")).code, 3);
});

test("BibTeX braces stay balanced, and an odd open-access link stays inert in a note", async () => {
	await lib("add", "10.1000/brace");
	const bib = (await lib("export", "--format", "bibtex")).out;
	const entry = bib.split("\n\n").find((e) => e.includes("10.1000/brace"));
	const opens = (entry.match(/(?<!\\)\{/g) ?? []).length;
	const closes = (entry.match(/(?<!\\)\}/g) ?? []).length;
	assert.equal(opens, closes, entry);
	assert.match(entry, /\\textbraceright\{\}/);
	await lib("add", "10.1000/oaodd");
	const vault = join(root, "vault-oa");
	mkdirSync(vault);
	await lib("obsidian", vault);
	const key = items().find((i) => i.DOI === "10.1000/oaodd").id;
	const note = readFileSync(join(vault, "Sources", `${key}.md`), "utf8");
	assert.doesNotMatch(note, /\[\[Secret note\]\]|%%x/);
});
