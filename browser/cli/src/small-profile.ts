/**
 * `polycarp mcp --profile small` (or POLYCARP_PROFILE=small): the same server with a short tool list for small models.
 * The core verbs are listed as usual; every other tool is registered, disabled (so it isn't listed) and reachable through
 * one `more_tools` call that lists them or runs one by name. A model that needs run_js or the library still has them,
 * without about 8,000 tokens of definitions on every turn (evals/weak-model/README.md).
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const MORE_TOOLS = "more_tools";

/** Listed in the small profile: the browser loop and the computer loop, each from first look to checked result. */
export const SMALL_CORE: ReadonlySet<string> = new Set([
	"tabs_context",
	"navigate",
	"read_page",
	"find",
	"click",
	"type",
	"fill",
	"press",
	"scroll",
	"get_page_text",
	"wait",
	"handle_dialog",
	"screenshot",
	"tabs_close",
	// The handoff when a page needs the user: a password, a sign-in, a captcha.
	"tabs_show",
	"computer_status",
	"computer_open",
	"computer_windows",
	"computer_snapshot",
	"computer_click",
	"computer_type",
	"computer_press",
	"computer_set_value",
	"devices",
	MORE_TOOLS,
]);

export const SMALL_INSTRUCTION =
	'More tools (tabs, run_js, files, hover, drag, page_markdown, library, past chats, skills, the rest of computer use) are behind more_tools: more_tools {} lists them; more_tools {"name":"run_js","arguments":{"code":"document.title"}} runs one.';

type Handler = (...a: unknown[]) => unknown;
type Content = { type: "text"; text: string };

/** The first sentence of a description, for the one-line list. */
function summary(description: string | undefined): string {
	const d = (description ?? "").replace(/\s+/g, " ").trim();
	const cut = d.search(/[.:;](\s|$)/);
	return (cut > 0 ? d.slice(0, cut) : d).slice(0, 110);
}

/** The argument names a tool takes, required ones marked, from its input schema (a zod object). */
function argNames(tool: RegisteredTool): string {
	const shape = (tool.inputSchema as { shape?: Record<string, { isOptional?: () => boolean }> } | undefined)?.shape;
	if (!shape) return "no arguments";
	const names = Object.entries(shape).map(([k, v]) => (v?.isOptional?.() ? k : `${k} (required)`));
	return names.length ? names.join(", ") : "no arguments";
}

/**
 * From here on, every tool registered on `server` outside the core is disabled as it is registered (computer tools arrive
 * late, when the helper lists them). Call the returned function once to add more_tools itself.
 */
export function hideOutsideCore(server: McpServer): () => void {
	const hidden = new Map<string, RegisteredTool>();
	const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
	(server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, ...rest: unknown[]) => {
		const tool = register(name, ...rest) as RegisteredTool | undefined;
		if (tool && !SMALL_CORE.has(String(name))) {
			tool.disable();
			hidden.set(String(name), tool);
		}
		return tool;
	};
	const reply = (body: string, isError = false): { content: Content[]; isError?: boolean } => ({ content: [{ type: "text", text: body }], ...(isError ? { isError } : {}) });
	return () =>
		server.registerTool(
			MORE_TOOLS,
			{
				title: "More tools",
				description:
					'The tools not listed here: {} lists them with what each does; {"name":"x"} shows what x takes; {"name":"x","arguments":{...}} runs x. Example: {"name":"tabs_create","arguments":{"url":"https://example.com"}}',
				inputSchema: {
					name: z.string().optional().describe("A tool from the list"),
					arguments: z.record(z.string(), z.unknown()).optional().describe("Its arguments, as you would pass them to it"),
				},
				annotations: { openWorldHint: true },
			},
			async (args, extra) => {
				const name = args.name?.trim();
				if (!name)
					return reply(
						`${[...hidden].map(([n, t]) => `${n}: ${summary(t.description)}`).join("\n")}\n\nRun one: more_tools {"name":"<tool>","arguments":{...}}.`,
					);
				const tool = hidden.get(name);
				if (!tool) {
					if (SMALL_CORE.has(name)) return reply(`${name} is already in your tool list: call it directly.`, true);
					const near = [...hidden.keys()].filter((n) => n.includes(name) || name.includes(n) || n.split("_").some((p) => p.length > 3 && name.includes(p)));
					return reply(`There's no tool ${JSON.stringify(name)}.${near.length ? ` Did you mean ${near.slice(0, 4).join(", ")}?` : ""} more_tools {} lists them all.`, true);
				}
				if (args.arguments === undefined)
					return reply(`${name}: ${(tool.description ?? "").trim()}\nArguments: ${argNames(tool)}.\nRun it: more_tools {"name":"${name}","arguments":{...}}.`);
				let input: unknown = args.arguments;
				const schema = tool.inputSchema as { safeParseAsync?: (v: unknown) => Promise<{ success: boolean; data?: unknown; error?: { issues?: Array<{ path: unknown[]; message: string }> } }> } | undefined;
				if (schema?.safeParseAsync) {
					const parsed = await schema.safeParseAsync(args.arguments);
					if (!parsed.success) {
						const issues = (parsed.error?.issues ?? []).map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
						return reply(`${name} can't take those arguments (${issues}). It takes: ${argNames(tool)}.`, true);
					}
					input = parsed.data;
				}
				const run = tool.handler as unknown as Handler;
				return (await (schema ? run(input, extra) : run(extra))) as { content: Content[]; isError?: boolean };
			},
		);
}
