/**
 * What the side panel sends the host's loopback proxy for one Copilot turn, and the events it
 * streams back (server-sent events, one JSON object per `data:` line). The host runs the turn in
 * a Copilot SDK session (cli/src/subscriptions/copilot-turns.ts); the side panel turns the events
 * into pi-ai stream events (src/subscriptions/stream.ts).
 */

export interface WireImage {
	data: string;
	mimeType: string;
}

export type WireMessage =
	| { role: "user"; text: string; images?: WireImage[] }
	| { role: "assistant"; text: string; toolCalls: Array<{ id: string; name: string; arguments: unknown }> }
	| { role: "toolResult"; toolCallId: string; toolName: string; text: string; images?: WireImage[]; isError: boolean };

export interface WireTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface CopilotTurnRequest {
	/** Stable for one chat, so turns continue the same SDK session. */
	conversation: string;
	model: string;
	systemPrompt: string;
	tools: WireTool[];
	messages: WireMessage[];
	reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export type CopilotTurnEvent =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| { type: "tool_call"; id: string; name: string; arguments: unknown }
	| { type: "done"; reason: "stop" | "toolUse"; usage?: { input: number; output: number } }
	| { type: "error"; message: string };
