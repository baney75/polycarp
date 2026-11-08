// What a case's solve(t) gets: the MCP tools through the harness, a call counter, and helpers
// that find a target by meaning (the find tool with a phrase, or a read_page snapshot searched
// by role and visible label). Nothing here accepts a CSS selector or an element id.
import assert from "node:assert/strict";

/** Parse the element lines of find / read_page output. */
export function parseNodes(text) {
	const nodes = [];
	const body = text.split(/\n\s*\nText:\n/)[0];
	for (const line of body.split("\n")) {
		const m = /^(\S+) (\S+) ("(?:[^"\\]|\\.)*")(.*)$/.exec(line);
		if (!m) continue;
		let name;
		try {
			name = JSON.parse(m[3]);
		} catch {
			continue;
		}
		const rest = m[4];
		const value = /^ value=("(?:[^"\\]|\\.)*")/.exec(rest);
		nodes.push({
			ref: m[1],
			role: m[2],
			name,
			value: value ? JSON.parse(value[1]) : undefined,
			states: (/ \[([^\]]*)\]/.exec(rest)?.[1] ?? "").split(", ").filter(Boolean),
			offscreen: rest.includes("(offscreen)"),
			frame: /\(in frame "((?:[^"\\]|\\.)*)"\)/.exec(rest)?.[1],
			line,
		});
	}
	return nodes;
}

const test = (pattern, value) => (pattern === undefined ? true : pattern instanceof RegExp ? pattern.test(value ?? "") : (value ?? "").toLowerCase().includes(String(pattern).toLowerCase()));

export function makeT(h) {
	let calls = 0;
	let cancelled = false;
	const t = {
		get calls() {
			return calls;
		},
		/** An MCP tool call; throws on a tool error. */
		/** After a timeout: the solve may still be running, and must not act on the next case's page. */
		cancel() {
			cancelled = true;
		},
		async tool(name, args = {}) {
			if (cancelled) throw new Error("cancelled after timeout");
			calls++;
			return h.tool(name, args);
		},
		/** An MCP tool call that reports instead of throwing. */
		async try(name, args = {}) {
			if (cancelled) throw new Error("cancelled after timeout");
			calls++;
			return h.call(name, args);
		},
		/** The find tool; returns parsed nodes. */
		async find(query, limit) {
			return parseNodes(await t.tool("find", limit ? { query, limit } : { query }));
		},
		/** The read_page tool; returns { nodes, raw, text }. */
		async read(filter = "all", extra = {}) {
			const raw = await t.tool("read_page", { filter, ...extra });
			return { nodes: parseNodes(raw), raw, text: raw.split(/\n\s*\nText:\n/)[1] ?? "" };
		},
		/**
		 * Locate one element by meaning. `query` is the phrase for find; `role` and `name` narrow the
		 * match (string = case-insensitive substring, RegExp = test). When find has no match, a
		 * read_page snapshot is searched for the same role and name. Throws, with the tool output,
		 * when neither finds it.
		 */
		async locate(query, { role, name, nth = 0, scroll = false } = {}) {
			// Without a role, skip the non-controls that share a control's name (its label, a heading).
			const want = (n) => (role === undefined ? !/^(label|heading|text|paragraph|generic|img|list|listitem|row|cell|columnheader|rowheader|table)$/i.test(n.role) : test(role, n.role)) && test(name, n.name);
			let hits = (await t.find(query)).filter(want);
			let frames = [];
			if (hits.length <= nth) {
				const snap = await t.read("all", { maxNodes: 2000 });
				hits = snap.nodes.filter(want);
				frames = snap.nodes.filter((n) => n.role === "iframe").map((n) => n.line);
			}
			if (hits.length <= nth)
				throw new Error(`could not locate "${query}" (role ${role ?? "any"}, name ${name ?? "any"}): find and read_page list no such element${frames.length ? `; the page has ${frames.join(" | ")}` : ""}`);
			return hits[nth];
		},
		/** locate + click. */
		async click(query, opts = {}) {
			const n = await t.locate(query, opts);
			await t.tool("click", { ref: n.ref, ...(opts.click ?? {}) });
			return n;
		},
		/** locate + type. */
		async type(query, text, opts = {}) {
			const n = await t.locate(query, opts);
			await t.tool("type", { ref: n.ref, text, ...(opts.type ?? {}) });
			return n;
		},
		/** locate + fill. */
		async fill(query, value, opts = {}) {
			const n = await t.locate(query, opts);
			await t.tool("fill", { ref: n.ref, value });
			return n;
		},
		/**
		 * Where an element is, from the tool itself: hover answers with the point it moved to (CSS px,
		 * which are screenshot pixels while no scaled screenshot was taken).
		 */
		async point(ref) {
			const r = JSON.parse(await t.tool("hover", { ref }));
			return r.hovered;
		},
		/** Wheel-scroll the scroller under an element, at the point hover reports for it. */
		async wheel(ref, dy, dx = 0) {
			const p = await t.point(ref);
			// The scroll tool's schema takes no x/y; an actions scroll step does. The wheel animates, so wait.
			await t.tool("actions", { steps: [{ scroll: { x: p.x, y: p.y, dy, dx } }, { wait: 400 }] });
		},
		/** Page text through get_page_text (reading results back is allowed). */
		async text() {
			const raw = await t.tool("get_page_text");
			try {
				return JSON.parse(raw).text ?? raw;
			} catch {
				return raw;
			}
		},
		/** Poll get_page_text until it matches. */
		async waitText(pattern, ms = 5000) {
			const end = Date.now() + ms;
			let last = "";
			while (Date.now() < end) {
				last = await t.text();
				if (test(pattern, last)) return last;
				await new Promise((r) => setTimeout(r, 200));
			}
			throw new Error(`text ${pattern} never appeared; page text was: ${last.slice(0, 200)}`);
		},
		assert,
	};
	return t;
}
