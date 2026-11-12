// A long side panel chat in the stored shape: the person asks, the assistant reads pages (get_page_text,
// extract_document), takes screenshots, and answers. Deterministic, so the tests replay the same
// turns. It is built to the shape of real panel transcripts, not recorded from one.

const FILLER =
	"The committee reviewed the proposal in detail and noted several points on cost, schedule and risk that the team should weigh before the next meeting.";

let seq = 0;
const id = () => `call_${++seq}`;

/** A page's text: a title line, `lines` lines of filler, and `fact` on line `at`. */
export function pageText(title, lines, fact, at = Math.floor(lines / 2)) {
	const out = [`${title}`];
	for (let i = 0; i < lines; i++) out.push(i === at ? fact : `${FILLER} (line ${i})`);
	return out.join("\n");
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const person = (text) => ({ role: "user", content: text, timestamp: 0 });

export const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "stub", model: "stub", usage, stopReason: "stop", timestamp: 0 });

export function call(name, args) {
	const callId = id();
	return {
		callId,
		message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], api: "openai-completions", provider: "stub", model: "stub", usage, stopReason: "toolUse", timestamp: 0 },
	};
}

export const result = (callId, toolName, text, extra = {}) => ({
	role: "toolResult",
	toolCallId: callId,
	toolName,
	content: [{ type: "text", text }, ...(extra.image ? [{ type: "image", data: "A".repeat(4000), mimeType: "image/png" }] : [])],
	details: extra.details,
	isError: false,
	timestamp: 0,
});

/**
 * `turns` turns of browsing. Turn t reads a page of `lines` lines whose line 7 holds FACT t, the assistant quotes that
 * fact, and every third turn adds a screenshot. A navigation note sits between the call and its result in turn 2, as
 * the panel stores one when the page changes mid-call.
 */
export function browsingChat(turns = 12, lines = 60) {
	seq = 0;
	const messages = [person("Find the 2026 budget figures for the river project across these sites. Always cite the page URL. Never sign in anywhere.")];
	for (let t = 1; t <= turns; t++) {
		if (t > 1) messages.push(person(`Now check source ${t}, and keep the numbers in one list.`));
		const url = `https://example.org/source-${t}`;
		const read = call("get_page_text", { url });
		messages.push(read.message);
		if (t === 2) messages.push({ role: "navigation", url, title: `Source ${t}`, tabId: 40 + t, skillsOutput: "" });
		const fact = `FACT ${t}: the river project budget line ${t} is ${t * 1000} thousand dollars for fiscal 2026.`;
		messages.push(result(read.callId, "get_page_text", pageText(`Source ${t} | Budget office`, lines, fact, 7), { details: { url, title: `Source ${t}` } }));
		if (t % 3 === 0) {
			const shot = call("screenshot", {});
			messages.push(shot.message);
			messages.push(result(shot.callId, "screenshot", "Screenshot of the page", { image: true }));
		}
		messages.push(say(`Source ${t} (${url}) says the river project budget line ${t} is ${t * 1000} thousand dollars for fiscal 2026.`));
	}
	return messages;
}
