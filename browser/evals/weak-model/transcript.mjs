// A claude -p run's stream-json, read event by event. Each tool result is read whole before it is clipped for the record,
// so an app copy the run started is known the moment its computer_open answer arrives, however long that answer is.

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}... [${s.length - n} more chars]` : s);

/** The tool a call really ran: its own name, or the one it named through more_tools (as signup-rule.mjs reads it). */
export const toolOf = (c) => (c.tool === "more_tools" ? c.args?.name : c.tool);

/** The pid of a copy a computer_open answer says it started (reused false), or undefined. */
export function startedCopy(text) {
	try {
		const d = JSON.parse(text)?.data;
		if (d?.reused === false && Number.isInteger(d.pid) && d.pid > 0) return d.pid;
	} catch {}
	return undefined;
}

export class Transcript {
	/** `onStarted(pid)` is called as soon as a computer_open answer reports a copy this run started. */
	constructor({ onStarted = () => {} } = {}) {
		this.onStarted = onStarted;
		/** Pids of the copies this run's answers reported, filled as each answer arrives. */
		this.started = new Set();
		this.calls = [];
		this.byId = new Map();
		this.final = "";
		this.result = undefined;
		this.mcpStatus = undefined;
		this.toolCount = undefined;
	}

	push(e) {
		if (e.type === "system" && e.subtype === "init") {
			this.mcpStatus = e.mcp_servers?.find((s) => s.name === "polycarp")?.status;
			this.toolCount = e.tools?.filter((t) => t.startsWith("mcp__polycarp__")).length;
		}
		if (e.type === "assistant")
			for (const c of e.message?.content ?? []) {
				if (c.type === "tool_use") {
					const call = { tool: c.name.replace(/^mcp__polycarp__/, ""), args: c.input };
					this.byId.set(c.id, call);
					this.calls.push(call);
				}
				if (c.type === "text") this.final = c.text;
			}
		if (e.type === "user")
			for (const c of e.message?.content ?? []) {
				if (c.type !== "tool_result") continue;
				const call = this.byId.get(c.tool_use_id);
				if (!call) continue;
				const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
				call.error = c.is_error === true;
				call.chars = text.length;
				if (!call.error && toolOf(call) === "computer_open") {
					const pid = startedCopy(text);
					if (pid) {
						call.startedPid = pid;
						this.started.add(pid);
						this.onStarted(pid);
					}
				}
				call.result = clip(text, 1200);
			}
		if (e.type === "result") this.result = e;
	}

	/** computer_open calls whose window may still attach: no answer yet, or an answer that says window_identified false. */
	pendingOpens() {
		return this.calls.filter((c) => {
			if (toolOf(c) !== "computer_open" || c.error) return false;
			return c.result === undefined || /"window_identified":\s*false/.test(c.result);
		}).length;
	}

	/** The compact record of the run. */
	done({ timedOut, ms, stderr }) {
		const r = this.result;
		return {
			calls: this.calls,
			final: r?.result ?? this.final,
			stop: timedOut ? "timeout" : (r?.subtype ?? "no_result"),
			turns: r?.num_turns,
			ms,
			mcpStatus: this.mcpStatus,
			toolCount: this.toolCount,
			apiError: r?.is_error ? clip(String(r.result ?? ""), 400) : undefined,
			stderr: timedOut || !r ? stderr : undefined,
		};
	}
}

