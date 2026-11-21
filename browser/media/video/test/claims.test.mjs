// Every stamp and label the hero shows must come from the recording. These tests run the
// render's own checks on the real capture and on doctored copies of it: a doctored copy that
// contradicts a stamp must make the check throw, so the render fails instead of lying.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogRunFrom, checkCli, checkGroup, checkPrompt, checkRouter } from "../src/hero/claims.ts";

const real = JSON.parse(readFileSync(new URL("../public/capture/capture.json", import.meta.url), "utf8"));
const realRouter = JSON.parse(readFileSync(new URL("../public/capture/router.json", import.meta.url), "utf8"));
const copy = () => structuredClone(real);
const catalog = (c) => catalogRunFrom(c.browser.calls, c.browser.catalog.refs, c.browser.catalogUrl, c.browser.catalog.confirmation);
const prompt = (c) =>
	checkPrompt(
		c.browser.permissionPrompt.requestedSchema.properties.decision,
		c.browser.permissionPrompt.message,
		c.browser.permissionAnswer,
		c.browser.statusAfter.allowedHosts,
		new URL(c.browser.book.url).hostname,
	);
const readBackIndex = (c) => c.browser.calls.findIndex((x) => x.name === "get_page_text" && x.text.includes("Hold placed"));

test("the real capture passes and REFUSED sits on the 404 refusal line", () => {
	const cli = checkCli(real.cli);
	assert.match(cli.refusal, /is not registered \(doi\.org returned 404\)/);
	assert.equal(cli.cleanLine, "✓ Clean.");
	assert.equal(cli.lintErrors.length, 4);
	const run = catalog(real);
	assert.match(run.clickHold, /\/\/ Place hold$/);
	assert.match(run.clickConfirm, /\/\/ Confirm hold$/);
	assert.match(run.readBack, /^get_page_text/);
	assert.equal(run.confirmation, "Hold placed for Ada Lovelace: Moby-Dick. Pick it up at Main Street after Thursday.");
	assert.equal(cli.skillPath, "page-helper/SKILL.md");
	assert.equal(cli.citedBy, 3011);
	assert.deepEqual(cli.shown, {
		madeUp: "tabkyra library add 10.1037/0000-0000.000.0.000",
		retracted: "tabkyra library add '10.1016/S0140-6736(97)11096-0'",
		lint: "tabkyra skill lint page-helper",
		shipped: "tabkyra skill lint skills/",
	});
	const router = checkRouter(realRouter);
	assert.deepEqual(
		router.rows.map((r) => [r.name, r.score]),
		[["academic-research", "11.73"], ["osint", "9.86"], ["none", ""], ["rsi", "6"]],
	);
	assert.equal(router.rows[2].description, "no skill fits this task.");
	assert.ok(router.p95Ms < 1);
	assert.deepEqual(prompt(real), { picked: 0, label: "Allow www.gutenberg.org from now on" });
});

test("a doi.org outage during the made-up DOI add fails the render", () => {
	const c = copy();
	c.cli.libraryMadeUp.out = "✗ Couldn't reach doi.org (ETIMEDOUT). Try again later.";
	assert.throws(() => checkCli(c.cli), /made-up DOI refusal/);
});

test("a made-up DOI add that succeeded fails the render", () => {
	const c = copy();
	c.cli.libraryMadeUp.code = 0;
	assert.throws(() => checkCli(c.cli), /made-up DOI add/);
});

test("a shipped-skills lint with an error fails the render", () => {
	const c = copy();
	c.cli.lintShipped.out = "✓ Clean.\nfoo/SKILL.md:3  error  remote-code  Runs downloaded code.";
	assert.throws(() => checkCli(c.cli), /lists errors/);
});

test("a retracted add that didn't exit 3 fails the render", () => {
	const c = copy();
	c.cli.libraryRetracted.code = 0;
	assert.throws(() => checkCli(c.cli), /retracted add/);
});

test("an extra click before the hold puts the real hold click under the hold shot", () => {
	const c = copy();
	const calls = c.browser.calls;
	const results = calls.findIndex((x) => x.name === "read_page" && x.text.includes("Place hold"));
	// A cookie-banner dismissal after the search, read from its own snapshot.
	calls.splice(
		results,
		0,
		{ name: "read_page", args: { filter: "interactive" }, ms: 5, text: 'Page: x\ne1 button "Accept cookies"\n' },
		{ name: "click", args: { ref: "e7" }, ms: 5, text: '{"clicked":{"x":1,"y":1}}' },
	);
	const run = catalog(c);
	assert.equal(run.clickHold, 'click { ref: "e1" }  // Place hold');
	assert.equal(run.clickConfirm, 'click { ref: "e3" }  // Confirm hold');
});

test("a hold click made from a different snapshot than the results fails the render", () => {
	const c = copy();
	const calls = c.browser.calls;
	const hold = calls.findIndex((x) => x.name === "click");
	calls.splice(hold, 0, { name: "read_page", args: { filter: "interactive" }, ms: 5, text: 'Page: x\ne1 button "Accept cookies"\n' });
	assert.throws(() => catalog(c), /hold button/);
});

test("a run that clicked a button other than Confirm fails the render", () => {
	const c = copy();
	const form = c.browser.calls.find((x) => x.name === "read_page" && x.text.includes("Confirm hold"));
	form.text = form.text.replace('e3 button "Confirm hold"', 'e3 button "Cancel"');
	assert.throws(() => catalog(c), /confirm/i);
});

test("a p95 of a millisecond or more fails the render", () => {
	const r = structuredClone(realRouter);
	r.eval.speed.p95Ms = 1.4;
	assert.throws(() => checkRouter(r), /not under a millisecond/);
});

test("a 'none' task that routed to a skill fails the render", () => {
	const r = structuredClone(realRouter);
	r.matches[2].out = "osint                  9.86  Research a person.";
	assert.throws(() => checkRouter(r), /routed to osint, expected none/);
});

test("a skill match that failed or routed elsewhere fails the render", () => {
	const r = structuredClone(realRouter);
	r.matches[0].code = 1;
	assert.throws(() => checkRouter(r), /exited 1/);
	const r2 = structuredClone(realRouter);
	r2.matches[1].out = "Warning: something\nosint  9.86  Research a person.";
	assert.throws(() => checkRouter(r2), /expected osint/);
});

test("the read-back sentence is the checked call's result, and a stale cached copy fails the render", () => {
	const c = copy();
	c.browser.catalog.confirmation = "Pinecrest Library\nHold placed for Grace Hopper: Moby-Dick. Pick it up at Riverside after Thursday.";
	assert.throws(() => catalog(c), /disagrees with the recorded read-back/);
});

test("a read-back that doesn't name what was filled fails the render", () => {
	const c = copy();
	const call = c.browser.calls[readBackIndex(c)];
	const page = JSON.parse(call.text);
	page.text = page.text.replace("Main Street", "Riverside");
	call.text = JSON.stringify(page);
	c.browser.catalog.confirmation = page.text;
	assert.throws(() => catalog(c), /at "Riverside", not "Ada Lovelace", "Moby-Dick" at "Main Street"/);
});

test("a read-back with no confirmation sentence fails the render", () => {
	const c = copy();
	const call = c.browser.calls[readBackIndex(c)];
	call.text = JSON.stringify({ text: "Pinecrest Library\nHold placed? Something went wrong." });
	assert.throws(() => catalog(c), /hold confirmation/);
});

test("a lint error past the end of the bad skill file fails the render", () => {
	const c = copy();
	c.cli.badSkill = c.cli.badSkill.split("\n").slice(0, 15).join("\n");
	assert.throws(() => checkCli(c.cli), /names line 16, past the 15-line skill file/);
});

test("a lint error about a different file fails the render", () => {
	const c = copy();
	c.cli.lintBad.out = c.cli.lintBad.out.replace("page-helper/SKILL.md:14", "other/SKILL.md:14");
	assert.throws(() => checkCli(c.cli), /isn't about page-helper\/SKILL.md/);
});

test("reordered prompt choices move the checkmark to the recorded answer", () => {
	const c = copy();
	const d = c.browser.permissionPrompt.requestedSchema.properties.decision;
	d.enum.reverse();
	d.enumNames.reverse();
	assert.deepEqual(prompt(c), { picked: 2, label: "Allow www.gutenberg.org from now on" });
});

test("a recorded deny, a missing answer or an unallowed site fails the render", () => {
	const deny = copy();
	deny.browser.permissionAnswer = "deny";
	assert.throws(() => prompt(deny), /not an allow/);
	const missing = copy();
	delete missing.browser.permissionAnswer;
	assert.throws(() => prompt(missing), /isn't one of the prompt's choices/);
	const unallowed = copy();
	unallowed.browser.statusAfter.allowedHosts = ["127.0.0.1"];
	assert.throws(() => prompt(unallowed), /isn't in the allowed sites/);
});

test("a shipped-skills lint run on one skill can't back 'Every bundled skill passes'", () => {
	const c = copy();
	c.cli.lintShipped.args = ["skill", "lint", "skills/academic-research"];
	c.cli.lintShipped.shown = "tabkyra skill lint skills/academic-research";
	assert.throws(() => checkCli(c.cli), /ran on skills\/academic-research, not skills\//);
});

test("a shown command that isn't the command recorded fails the render", () => {
	const c = copy();
	c.cli.libraryMadeUp.shown = "tabkyra library add 10.1037/1111-1111.000.0.000";
	assert.throws(() => checkCli(c.cli), /made-up DOI add is shown as/);
	const d = copy();
	d.cli.libraryMadeUp.args = ["library", "add", "10.1037/1111-1111.000.0.000"];
	d.cli.libraryMadeUp.shown = "tabkyra library add 10.1037/1111-1111.000.0.000";
	assert.throws(() => checkCli(d.cli), /isn't about 10\.1037\/1111/);
	const e = copy();
	e.cli.lintBad.args = ["skill", "lint", "other-skill"];
	e.cli.lintBad.shown = "tabkyra skill lint other-skill";
	assert.throws(() => checkCli(e.cli), /ran on other-skill, not the page-helper skill/);
});

test("a citation count with a thousands separator reads in full", () => {
	const c = copy();
	c.cli.libraryRetracted.out = c.cli.libraryRetracted.out.replace("cited by 3011", "cited by 3,011");
	assert.equal(checkCli(c.cli).citedBy, 3011);
	const d = copy();
	d.cli.libraryRetracted.out = d.cli.libraryRetracted.out.replace("cited by 3011", "cited by many");
	assert.throws(() => checkCli(d.cli), /citation count/);
});

test("a search for another book than the recorded results fails the render", () => {
	const c = copy();
	c.browser.calls.find((x) => x.name === "type").args.text = "Hamlet";
	assert.throws(() => catalog(c), /results aren't for "Hamlet"/);
});

const setReadBack = (c, sentence) => {
	const call = c.browser.calls[readBackIndex(c)];
	const page = JSON.parse(call.text);
	page.text = page.text.replace(/Hold placed .*$/m, sentence);
	call.text = JSON.stringify(page);
	c.browser.catalog.confirmation = page.text;
};

test("a hold on the other 'Place hold' button (the graphic novel) fails the render", () => {
	const c = copy();
	setReadBack(c, "Hold placed for Ada Lovelace: Moby-Dick: A Graphic Novel. Pick it up at Main Street after Thursday.");
	assert.throws(() => catalog(c), /"Moby-Dick: A Graphic Novel"/);
});

test("a read-back with the name and branch swapped, or a partial fill, fails the render", () => {
	const c = copy();
	setReadBack(c, "Hold placed for Main Street: Moby-Dick. Pick it up at Ada Lovelace after Thursday.");
	assert.throws(() => catalog(c), /the hold is for "Main Street"/);
	const d = copy();
	d.browser.calls.find((x) => x.name === "fill").args.value = "Ada";
	assert.throws(() => catalog(d), /not "Ada", "Moby-Dick"/);
});

test("a failed fill, click, type or navigate fails the render", () => {
	const fail = (pick, text, re) => {
		const c = copy();
		pick(c.browser.calls).text = text;
		assert.throws(() => catalog(c), re);
	};
	fail((calls) => calls.filter((x) => x.name === "fill")[1], '{"error":"Element not found; action failed"}', /fill of e2 didn't succeed/);
	fail((calls) => calls.filter((x) => x.name === "click")[1], "Element not found; action failed", /no JSON result/);
	fail((calls) => calls.find((x) => x.name === "type"), '{"typed":0}', /didn't type "Moby-Dick"/);
	fail((calls) => calls.find((x) => x.name === "navigate"), '{"error":"timeout"}', /didn't land on the catalog/);
});

test("a router command that isn't the recorded task fails the render", () => {
	const r = structuredClone(realRouter);
	r.matches[0].shown = "tabkyra skill match /osint";
	assert.throws(() => checkRouter(r), /is shown as tabkyra skill match \/osint/);
	const r2 = structuredClone(realRouter);
	r2.matches[2].shown = 'tabkyra skill match "use the osint skill"';
	assert.throws(() => checkRouter(r2), /is shown as/);
});

test("a prompt for another site fails the render", () => {
	const c = copy();
	const p = c.browser.permissionPrompt;
	p.message = p.message.replace("www.gutenberg.org", "example.com");
	p.requestedSchema.properties.decision.enumNames[0] = "Allow example.com from now on";
	assert.throws(() => prompt(c), /isn't the one for www.gutenberg.org/);
});

const group = (c) => checkGroup(c.browser.statusAfter, c.browser.book, "claude");

test("the real capture's tab group, title and URL are the recorded ones", () => {
	assert.deepEqual(group(real), {
		group: "Tabkyra · claude",
		title: "Moby Dick; Or, The Whale by Herman Melville | Project Gutenberg",
		url: "https://www.gutenberg.org/ebooks/2701",
	});
	assert.deepEqual(checkRouter(realRouter).commandMs, { min: 114, max: 117 });
});

test("an ungrouped tab, another agent's group or a wrong tab fails the render", () => {
	for (const tabGroup of ["", null, "Tabkyra · codex"]) {
		const c = copy();
		c.browser.statusAfter.tabGroup = tabGroup;
		assert.throws(() => group(c), /the tab group is/);
	}
	const empty = copy();
	empty.browser.statusAfter.tabs = [];
	assert.throws(() => group(empty), /no tab in the group holds/);
	const retitled = copy();
	retitled.browser.statusAfter.tabs[0].title = "Hamlet | Project Gutenberg";
	assert.throws(() => group(retitled), /the tab's title is "Hamlet/);
});

test("a lint summary that counts more problems than the scene lists fails the render", () => {
	const c = copy();
	c.cli.lintBad.out = c.cli.lintBad.out
		.replace("✗ 4 problems.", "✗ 5 problems.")
		.replace("\n✗", "\npage-helper/SKILL.md:9  warning  budget  Over budget.\n✗");
	assert.throws(() => checkCli(c.cli), /the lint summary says "✗ 5 problems/);
});

test("a match with no recorded wall time fails the render", () => {
	const r = structuredClone(realRouter);
	r.matches[1].ms = 0;
	assert.throws(() => checkRouter(r), /no recorded wall time/);
});
