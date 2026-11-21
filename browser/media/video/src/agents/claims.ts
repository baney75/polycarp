// Every caption, stamp, highlight and label the Agents video shows is checked here against the
// recorded run (public/capture/agents/agents.json, from scripts/demo/capture-agents.mjs). A
// recording that doesn't back a claim throws, which fails the render instead of showing it.
// No imports, so test/agents-claims.test.mjs runs these exact checks on doctored copies.

export type Entry = { agent: string; name: string; args: Record<string, unknown>; ms: number; isError: boolean; text: string };
export type Group = { id: number; title: string; color: string; tabs: { id: number; title: string; url: string }[] };
export type Run = { args: string[]; shown: string; code: number; ms: number; out: string };
export type Box = { x: number; y: number; width: number; height: number };

export type AgentsCapture = {
	project: string;
	site: string;
	agents: Record<string, { navigate: Entry; tabId: number; context: string; shot: string; group: { title: string; color: string } }>;
	groups: Group[];
	crossTalk: Entry & { agent1TabAfter: { id: number; groupId: number } };
	resume: { tabsCreate: Entry; before: string; groupsWhileClosed: Group[]; after: string; groupAfter: Group };
	handoff: { tabId: number; groupBefore: Group; context: string; tabAfter: { id: number; title: string; url: string; groupId: number }; userShot: string };
	ask: {
		call: { args: { questions: { header: string; question: string; options: { label: string; description: string }[] }[] } };
		chosen: string;
		result: string;
		boxes: { card: Box; option: Box };
		shots: { asking: string; picked: string };
		after: { readPage: string; fills: Entry[]; shot: string };
	};
	composer: {
		slashAll: string[];
		slashFiltered: string[];
		atAll: string[];
		composed: string;
		task: string;
		teapotTab: number;
		transcript: string;
		boxes: Record<string, { editor: Box; menu?: Box; contentBottom?: number }>;
		shots: Record<string, string>;
	};
	cli: { sessions: Run; tabs: Run; threads: Run };
	reload: { call: Entry; ordersBefore: number; ordersAfter: number; page: string; shot: string };
	panelErrors: string[];
	threadShown?: string;
	attempt?: number;
};

/** Facts the teapot page's body states and its tab title doesn't (scripts/demo/capture-agents.mjs). */
export const PAGE_FACTS = ["1 L", "$36", "infuser", "speckled", "glazed"];

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The messages of a `tabkyra threads show` record: "[n] role: text", text running to the next one. */
export const threadMessages = (shown: string) =>
	[...shown.matchAll(/^\[\d+\] (user|assistant|toolResult): ([\s\S]*?)(?=^\[\d+\] (?:user|assistant|toolResult): |(?![\s\S]))/gm)].map((m) => ({
		role: m[1],
		text: m[2].trim(),
	}));

const fail = (what: string): never => {
	throw new Error(`agents.json: ${what}`);
};

/** A recorded tab line: `* <id> "<title>" <url>` (the * marks the current tab). */
export const tabLines = (context: string) =>
	context
		.split("\n")
		.map((l) => l.match(/^([* ]) (\d+) "(.*)" (\S+)$/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => ({ line: m[0], current: m[1] === "*", id: Number(m[2]), title: m[3], url: m[4] }));

/**
 * Hook and "Separate": three agents of one harness in one project, each in its own group with a
 * distinct title and color, in the order the video names them (agent 1 is "… shop"), each
 * seeing only its own tab, and agent 2 refused on agent 1's tab.
 */
export function checkAgents(c: AgentsCapture) {
	const keys = ["agent1", "agent2", "agent3"];
	const expected = [`Tabkyra · claude · ${c.project}`, `Tabkyra · claude · ${c.project} 2`, `Tabkyra · claude · ${c.project} 3`];
	const agents = keys.map((k, i) => {
		const a = c.agents[k] ?? fail(`no ${k}`);
		const g = c.groups.find((x) => x.tabs.some((t) => t.id === a.tabId)) ?? fail(`${k}'s tab is in no group`);
		if (g.title !== expected[i] || a.group.title !== g.title) fail(`${k}'s group is "${g.title}", not "${expected[i]}"`);
		if (a.group.color !== g.color) fail(`${k}'s recorded color ${a.group.color} isn't its group's ${g.color}`);
		const lines = tabLines(a.context);
		if (lines.length !== 1 || lines[0].id !== a.tabId) fail(`${k}'s tabs_context doesn't list exactly its own tab`);
		const header = a.context.split("\n")[0];
		if (!header.includes(`group "${g.title}"`)) fail(`${k}'s tabs_context names another group: ${header}`);
		const url = new URL(a.navigate.args.url as string);
		if (lines[0].url !== url.href) fail(`${k}'s tab isn't at the URL it navigated to`);
		return { key: k, title: g.title, color: g.color, tabId: a.tabId, tabTitle: lines[0].title, url: url.href, path: url.pathname, shot: a.shot, context: a.context, header, line: lines[0].line };
	});
	if (new Set(agents.map((a) => a.color)).size !== 3) fail("two agents share a group color");
	for (const a of agents)
		for (const b of agents) if (a !== b && a.context.includes(String(b.tabId))) fail(`${a.key} sees ${b.key}'s tab`);
	// NOT YOURS: agent 2 asked for agent 1's tab by id and got an error, and the tab stayed in agent 1's group.
	const x = c.crossTalk;
	if (x.agent !== "agent2" || x.name !== "tabs_select" || x.args.tabId !== agents[0].tabId) fail("the cross-talk call isn't agent 2 selecting agent 1's tab");
	if (!x.isError || !/not owned by this session/.test(x.text)) fail(`agent 2 wasn't refused: ${x.text}`);
	const group1 = c.groups.find((g) => g.title === agents[0].title);
	if (x.agent1TabAfter.id !== agents[0].tabId || x.agent1TabAfter.groupId !== group1?.id) fail("agent 1's tab moved after the refusal");
	return { agents, refusal: { call: `tabs_select {"tabId":${x.args.tabId}}`, text: x.text } };
}

/** "Quit / Start it again": the group stays while the agent is gone and comes back with the same tabs. */
export function checkResume(c: AgentsCapture, title: string) {
	const r = c.resume;
	const before = tabLines(r.before);
	const after = tabLines(r.after);
	if (before.length < 2) fail("agent 1 had fewer than two tabs before it quit");
	const kept = c.resume.groupsWhileClosed.find((g) => g.title === title) ?? fail("agent 1's group was gone while it was closed");
	const ids = (l: { id: number }[]) => l.map((t) => t.id).join(",");
	if (ids(kept.tabs) !== ids(before)) fail(`agent 1's group held ${ids(kept.tabs)} while it was closed, not ${ids(before)}`);
	if (ids(before) !== ids(after)) fail(`the restarted agent got ${ids(after)}, not ${ids(before)}`);
	if (r.groupAfter.title !== title) fail("the resumed tabs are in another group");
	if (!r.after.split("\n")[0].includes(`group "${title}"`)) fail("the resumed session names another group");
	return { before, after, header: r.after.split("\n")[0], whileClosed: kept };
}

/** "Hand-off": the tab left the group, and the agent's next tabs_context said it's the user's now. */
export function checkHandoff(c: AgentsCapture, title: string) {
	const h = c.handoff;
	// Agent 1's: the group the tab left, and the session whose next tabs_context is shown.
	if (h.groupBefore.title !== title) fail(`the tab left "${h.groupBefore.title}", not agent 1's "${title}"`);
	if (!h.context.split("\n")[0].includes(`group "${title}"`)) fail("the hand-off news went to another agent's session");
	if (h.tabAfter.id !== h.tabId) fail("the tab read after the hand-off isn't the one handed off");
	const news = c.handoff.context.split("\n").find((l) => l.startsWith("News: ")) ?? fail("no News line after the hand-off");
	const m = news.match(/^News: The user took tab (\d+) \("(.*)"\) out of your group; it's theirs now/);
	if (!m || Number(m[1]) !== h.tabId) return fail(`the news isn't about tab ${h.tabId}: ${news}`);
	if (h.tabAfter.groupId !== -1) fail("the handed-off tab is still in a group");
	if (tabLines(h.context).some((t) => t.id === h.tabId)) fail("the agent still lists the tab it was told it lost");
	if (!h.groupBefore.tabs.some((t) => t.id === h.tabId)) fail("the tab wasn't in the agent's group before");
	return { news: news.replace(/^News: /, ""), tabTitle: m[2], remaining: tabLines(h.context), groupBefore: h.groupBefore };
}

/** "It asks": the question asked, the option clicked in the panel, the answer the agent got, then its next steps. */
export function checkAsk(c: AgentsCapture) {
	const a = c.ask;
	const q = a.call.args.questions[0] ?? fail("ask_user had no question");
	if (!q.options.some((o) => o.label === a.chosen)) fail(`the chosen "${a.chosen}" isn't an option`);
	if (!a.result.startsWith("The user answered:") || !a.result.includes(`"${q.question}" = "${a.chosen}"`)) fail(`the agent didn't get the chosen answer: ${a.result}`);
	const fills = a.after.fills;
	if (fills.length !== 2 || fills.some((f) => f.isError || !f.text.includes('"filled"'))) fail("the fills after the answer didn't all succeed");
	const values = fills.map((f) => String(f.args.value));
	// The payment filled is the answer given, without the "(Recommended)" tag.
	if (!values.includes(a.chosen.replace(/ \(Recommended\)$/, ""))) fail(`the agent didn't use the answer: filled ${values.join(", ")}`);
	return { header: q.header, question: q.question, options: q.options, chosen: a.chosen, resultLines: a.result.split("\n").slice(0, 2), fills: fills.map((f) => ({ ref: String(f.args.ref), value: String(f.args.value) })) };
}

/** "/ and @": the skill chosen, the tab referenced (the user's own), the others shown in use, and a run that read the tab. */
export function checkComposer(c: AgentsCapture, agentTitles: string[]) {
	const k = c.composer;
	if (!k.slashAll.length) fail("the / menu was empty");
	const skill = (k.slashFiltered[0] ?? "").split(" ")[0];
	if (skill !== "writing") fail(`the / menu's first match is "${skill}", not writing`);
	if (!k.composed.startsWith(`/writing @tab:${k.teapotTab} `)) fail(`the message isn't /writing with the teapot tab: ${k.composed}`);
	if (k.teapotTab !== c.handoff.tabId) fail("the referenced tab isn't the one the user took back");
	for (const t of agentTitles) {
		const label = t.replace(/^Tabkyra · /, "");
		// The whole label, then the host: "claude · shop" must not match the "claude · shop 2" row.
		const row = new RegExp(` used by agent ${escapeRe(label)} 127\\.0\\.0\\.1$`);
		if (!k.atAll.some((r) => row.test(r))) fail(`the @ menu doesn't show ${label}'s tab as in use`);
	}
	const free = k.atAll.find((row) => row.startsWith("Stoneware Teapot")) ?? fail("the teapot tab isn't in the @ menu");
	if (free.includes("used by")) fail("the user's teapot tab shows as in use");
	// From the chat's own record (tabkyra threads show): the agent went to the referenced tab's
	// page, a tool result carried the page body, and the final reply states facts only the page
	// body has (not the tab title "Stoneware Teapot · Fernhill Goods" the chip shows).
	const messages = threadMessages(c.threadShown ?? "");
	const teapotUrl = String(c.resume.tabsCreate.args.url);
	const went = messages.some(
		(m) => m.role === "assistant" && /^-> navigate\(/.test(m.text) && (m.text.includes(`"url":"${teapotUrl}"`) || m.text.includes(`"switchToTab":${k.teapotTab}`)),
	);
	if (!went) fail("the side panel's agent never went to the referenced tab's page");
	if (!messages.some((m) => m.role === "toolResult" && m.text.includes("steel infuser"))) fail("the side panel's agent never read the teapot page");
	const final = [...messages].reverse().find((m) => m.role === "assistant" && !m.text.startsWith("->"))?.text ?? "";
	const stated = PAGE_FACTS.filter((f) => final.includes(f));
	if (stated.length < 2) fail(`the side panel's agent never read the teapot page: its reply states ${stated.length} of its facts`);
	return { skill, task: k.task, free, reply: final, stated };
}

/** "Terminal": the three commands ran, exited 0, and show the three groups and the chat. */
export function checkCli(c: AgentsCapture, agentTitles: string[], word: string) {
	const { sessions, tabs, threads } = c.cli;
	for (const [r, args] of [
		[sessions, ["sessions"]],
		[tabs, ["tabs"]],
		[threads, ["threads", "search", word]],
	] as const) {
		if (r.args.join(" ") !== args.join(" ") || r.shown !== `tabkyra ${args.join(" ")}`) fail(`expected "tabkyra ${args.join(" ")}", got "${r.shown}"`);
		if (r.code !== 0) fail(`${r.shown} exited ${r.code}`);
	}
	for (const t of agentTitles) {
		// The whole title: "Tabkyra · claude · shop" must not match a "… shop 2" row.
		const whole = new RegExp(`${escapeRe(t)}(?! \\d)`);
		if (!whole.test(sessions.out) || !whole.test(tabs.out)) fail(`sessions or tabs doesn't show ${t}`);
	}
	if (!new RegExp(`^[1-9]\\d* threads? mentions? "${word}"`, "m").test(threads.out)) fail(`threads search didn't find "${word}"`);
	return { sessions, tabs, threads };
}

/** "Reload": the click was cut off by a reload, the agent was told to check the page, and the order ran once. */
export function checkReload(c: AgentsCapture) {
	const r = c.reload;
	if (r.call.name !== "actions") fail("the reload call isn't actions");
	if (!/^interrupted: /.test(r.call.text) || !/Check the page/i.test(r.call.text)) fail(`the cut-off call didn't say to check the page: ${r.call.text}`);
	const runs = r.ordersAfter - r.ordersBefore;
	if (runs !== 1) fail(`the order ran ${runs} times`);
	const placed = JSON.parse(r.page).text.split("\n").find((l: string) => /^Order #\d+ placed/.test(l)) ?? fail("the page shows no order");
	return { text: r.call.text, runs, placed };
}
