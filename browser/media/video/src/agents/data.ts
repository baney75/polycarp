// The Agents video's recorded values, checked on first use. The Agents, AgentsVertical and
// AgentsPoster roots call agentsClaims() while rendering, so a recording that doesn't back a
// caption fails those renders; nothing runs at import, so Studio still loads.
import capture from "../../public/capture/agents/agents.json";
import { type AgentsCapture, checkAgents, checkAsk, checkCli, checkComposer, checkHandoff, checkReload, checkResume } from "./claims";

/** The word the terminal beat searched past chats for (scripts/demo/capture-agents.mjs). */
export const SEARCH_WORD = "teapot";

const compute = () => {
	const c = capture as unknown as AgentsCapture;
	const team = checkAgents(c);
	const titles = team.agents.map((a) => a.title);
	return {
		raw: c,
		team,
		resume: checkResume(c, titles[0]),
		handoff: checkHandoff(c, titles[0]),
		ask: checkAsk(c),
		composer: checkComposer(c, titles),
		cli: checkCli(c, titles, SEARCH_WORD),
		reload: checkReload(c),
	};
};

let cached: ReturnType<typeof compute> | undefined;
export const agentsClaims = () => {
	cached ??= compute();
	return cached;
};

/** Chrome's tab group colors (light theme), so a recorded color name draws as the browser draws it. */
export const GROUP_HEX: Record<string, string> = {
	grey: "#5F6368",
	blue: "#1A73E8",
	red: "#D93025",
	yellow: "#E8A400",
	green: "#188038",
	pink: "#D01884",
	purple: "#A142F4",
	cyan: "#007B83",
	orange: "#E8710A",
};
export const hex = (color: string) => GROUP_HEX[color] ?? GROUP_HEX.grey;
