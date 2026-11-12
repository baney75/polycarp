/**
 * The message the service worker sends the offscreen page for outside agents' document calls (bridge/documents.ts to
 * offscreen/documents.ts), and the budgets their answers keep: an outside agent's window isn't known here, so these are
 * fixed and well under the MCP server's 100,000 character net (cli/src/mcp.ts).
 */
export const DOCUMENTS_MESSAGE = "polycarp:documents";

export const MCP_READ_CHARS = 20_000;
export const MCP_SEARCH_CHARS = 8_000;
/** The most an agent may ask for in one answer. */
export const MCP_MAX_CHARS = 60_000;

export type DocumentsReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };
