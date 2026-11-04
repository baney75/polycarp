import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import { noAnswer, outcomeText, validateAskParams } from "../ask/core.js";
import { type ComposerRefs, refsForModel } from "../composer/refs.js";
import type { NavigationMessage } from "./NavigationMessage.js";

// Helper: Check if a message has toolCall blocks
function hasToolCalls(msg: Message): boolean {
	if (msg.role !== "assistant") return false;
	return msg.content.some((block) => block.type === "toolCall");
}

// Helper: Get all toolCall IDs from an assistant message
function getToolCallIds(msg: Message): Set<string> {
	const ids = new Set<string>();
	if (msg.role !== "assistant") return ids;

	for (const block of msg.content) {
		if (block.type === "toolCall") {
			ids.add(block.id);
		}
	}
	return ids;
}

// Helper: Check if a toolResult message matches the given tool call IDs
function isToolResultFor(msg: Message, toolCallIds: Set<string>): boolean {
	if (msg.role !== "toolResult") return false;
	return toolCallIds.has(msg.toolCallId);
}

// Reorder messages so assistant tool calls are immediately followed by their tool results
// This moves navigation and other user messages after the tool results
function reorderMessages(messages: Message[]): Message[] {
	const result: Message[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === "assistant" && hasToolCalls(msg)) {
			// Found assistant with tool calls
			result.push(msg);
			i++;

			// Collect tool call IDs from this assistant message
			const toolCallIds = getToolCallIds(msg);

			// Scan forward and collect messages until next assistant or end
			const toolResultMessages: Message[] = [];
			const otherMessages: Message[] = [];

			while (i < messages.length && messages[i].role !== "assistant") {
				const nextMsg = messages[i];

				if (isToolResultFor(nextMsg, toolCallIds)) {
					toolResultMessages.push(nextMsg);
				} else {
					otherMessages.push(nextMsg);
				}
				i++;
			}

			// Add tool result messages first, then other messages (like nav)
			result.push(...toolResultMessages);
			result.push(...otherMessages);
		} else {
			// Not an assistant with tool calls, just add it
			result.push(msg);
			i++;
		}
	}

	return result;
}

// Custom message transformer for browser extension
// Handles navigation messages and app-specific message types
export async function browserMessageTransformer(messages: AgentMessage[]): Promise<Message[]> {
	const transformed = [];

	for (const m of messages) {
		// Filter out UI-only messages
		if (m.role === "artifact" || m.role === "welcome") {
			continue;
		}

		// Filter non-LLM messages
		if (
			m.role !== "user" &&
			m.role !== "user-with-attachments" &&
			m.role !== "assistant" &&
			m.role !== "toolResult" &&
			m.role !== "navigation"
		) {
			continue;
		}

		// Files and images sent with a message: the text, then each image and each document's text.
		if (m.role === "user-with-attachments") {
			const { tabkyraRefs, attachments, content, timestamp } = m as {
				tabkyraRefs?: ComposerRefs;
				attachments?: AttachmentLike[];
				content: string | Array<{ type: string; text?: string }>;
				timestamp: number;
			};
			const base = withRefs({ role: "user", content, timestamp } as Message & { role: "user" }, tabkyraRefs);
			const parts: Array<TextContent | ImageContent> =
				typeof base.content === "string"
					? [{ type: "text", text: base.content }]
					: [...(base.content as Array<TextContent | ImageContent>)];
			for (const a of attachments ?? []) {
				if (a.type === "image") parts.push({ type: "image", data: a.content, mimeType: a.mimeType });
				else if (a.type === "document" && a.extractedText)
					parts.push({ type: "text", text: `\n\n[Document: ${a.fileName}]\n${a.extractedText}` });
			}
			transformed.push({ ...base, content: parts } as Message);
			continue;
		}

		if (m.role === "navigation") {
			const nav = m as NavigationMessage;
			const tabInfo = nav.tabId !== undefined ? ` (tab id: ${nav.tabId})` : "";

			// Use cached skills output (formatted at message creation time)
			const skillsInfo = nav.skillsOutput;

			transformed.push({
				role: "user",
				content: `<browser-context>
✓ Navigation succeeded: ${nav.title}${tabInfo}
✓ URL: ${nav.url}
</browser-context>

<skills>
${skillsInfo}
</skills>

<instructions>
- DO NOT STOP - This is informational only. CONTINUE IMMEDIATELY with the next step of your multi-step workflow. This message does NOT mean you should wait for user input.
- DO NOT REPEAT THIS MESSAGE BACK TO THE USER!
</instructions>`,
			} as Message);
		} else if (m.role === "user") {
			const { attachments, tabkyraRefs, ...rest } = m as any;
			transformed.push(withRefs(rest as Message & { role: "user" }, tabkyraRefs as ComposerRefs | undefined));
		} else {
			transformed.push(m as Message);
		}
	}

	return reorderMessages(answerCutOffQuestions(transformed));
}

/**
 * An ask_user call left without a result (the panel closed or reloaded while the question was
 * open) gets an explicit no-answer result, so the model is told not to assume one instead of
 * the provider layer's generic "No result provided".
 */
function answerCutOffQuestions(messages: Message[]): Message[] {
	const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
	const out: Message[] = [];
	for (const m of messages) {
		out.push(m);
		// pi-ai drops an aborted or failed assistant message with its tool calls before the provider
		// sees it, so a result for one of its calls would be an orphan.
		if (m.role !== "assistant" || m.stopReason === "aborted" || m.stopReason === "error") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.name !== "ask_user" || answered.has(block.id)) continue;
			let questions: ReturnType<typeof validateAskParams>["questions"] = [];
			try {
				questions = validateAskParams(block.arguments).questions;
			} catch {
				// The text doesn't depend on the questions.
			}
			const outcome = noAnswer(questions, "closed");
			out.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: outcomeText(outcome) }],
				details: outcome,
				isError: false,
				timestamp: m.timestamp,
			});
		}
	}
	return out;
}

/** The fields of pi-web-ui's Attachment the transformer reads. */
interface AttachmentLike {
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	content: string;
	extractedText?: string;
}

/** A user message whose composer references were resolved: the model gets the expanded text. */
function withRefs(m: Message & { role: "user" }, refs: ComposerRefs | undefined): Message {
	if (!refs) return m;
	if (typeof m.content === "string") return { ...m, content: refsForModel(m.content, refs) };
	const text = m.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n");
	const others = m.content.filter((c) => c.type !== "text");
	return { ...m, content: [{ type: "text", text: refsForModel(text, refs) }, ...others] };
}
