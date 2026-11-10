/**
 * The in-use veil as drawn in the page. `veilPage` is injected with chrome.scripting into the
 * extension's isolated world of the top document; Chrome serializes it, so it must not use
 * anything from outside its own body. `VEIL_CSS` goes with it as an argument.
 *
 * What the page sees, and what it doesn't:
 * - One element with a random tag (veil-shared.ts) and no attributes, appended to <html>, so it is
 *   outside <body> and its text. Everything else is in a closed shadow root, which no world but
 *   this one can open, so the agent and project names never reach the page's script.
 * - Its styles are `:host` rules marked important, which win over any important rule the page
 *   writes for it. It is fixed, covers the viewport, and has pointer-events: none, so it moves
 *   nothing and every click goes through, except on the pill's "Take over" button.
 * - The state lives in this isolated world's globals, which the page's own globals never see.
 */

/** Theme tokens the veil reads, for light and dark, from the side panel's own (appearance/tokens.ts). */
export interface VeilTheme {
	light: Record<string, string>;
	dark: Record<string, string>;
	/** "auto" follows the page's prefers-color-scheme. */
	scheme: "auto" | "light" | "dark";
	/** A Polycarp theme that turned motion off. */
	reduced: boolean;
}

export type VeilCommand =
	| {
			op: "show";
			tag: string;
			css: string;
			agent: string;
			detail: string;
			color: string;
			theme: VeilTheme;
			interactive: boolean;
			concealed: boolean;
	  }
	| { op: "set"; interactive?: boolean; concealed?: boolean }
	| { op: "hide"; fade: boolean };

export interface VeilPageResult {
	tag?: string;
	/** Why nothing was drawn: a PDF or a document that isn't HTML. */
	skipped?: string;
}

/** Chrome's tab group colors (light and dark tab strip), as custom properties. */
const GROUP_COLORS = `
.veil {
	--g-grey: #5f6368;
	--g-blue: #1a73e8;
	--g-red: #d93025;
	--g-yellow: #e37400;
	--g-green: #1e8e3e;
	--g-pink: #d01884;
	--g-purple: #9334e6;
	--g-cyan: #007b83;
	--g-orange: #fa7b17;
}
.veil.dark {
	--g-grey: #dadce0;
	--g-blue: #8ab4f8;
	--g-red: #f28b82;
	--g-yellow: #fdd663;
	--g-green: #81c995;
	--g-pink: #ff8bcb;
	--g-purple: #c58af9;
	--g-cyan: #78d9ec;
	--g-orange: #fcad70;
}`;

export const VEIL_CSS = `
:host {
	all: initial !important;
	display: block !important;
	position: fixed !important;
	inset: 0 !important;
	width: auto !important;
	height: auto !important;
	margin: 0 !important;
	padding: 0 !important;
	border: 0 !important;
	z-index: 2147483647 !important;
	pointer-events: none !important;
	contain: strict !important;
	visibility: visible !important;
	opacity: 1 !important;
	transform: none !important;
	filter: none !important;
	clip-path: none !important;
}
${GROUP_COLORS}
.veil {
	--session: var(--g-blue);
	--soft: color-mix(in srgb, var(--session) 42%, transparent);
	--clear: color-mix(in srgb, var(--session) 0%, transparent);
	position: absolute;
	inset: 0;
	pointer-events: none;
	opacity: 0;
	transition: opacity 220ms var(--tk-ease, ease-out);
	font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
}
.veil.on { opacity: 1; }
.veil.leaving { opacity: 0; transition-duration: 480ms; }
.veil.concealed { visibility: hidden; transition: none; }
.scrim {
	position: absolute;
	inset: 0;
	background: color-mix(in srgb, var(--session) 5%, transparent);
}
.edge {
	position: absolute;
	inset: 0;
	box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--session) 78%, transparent);
}
.glow {
	position: absolute;
	inset: 0;
	box-shadow: inset 0 0 34px 6px var(--soft);
	animation: breathe 2.8s ease-in-out infinite alternate;
}
.ring {
	position: absolute;
	inset: 0;
	padding: 3px;
	overflow: hidden;
	mask: linear-gradient(currentColor 0 0) content-box exclude, linear-gradient(currentColor 0 0);
}
.sweep {
	position: absolute;
	left: 50%;
	top: 50%;
	width: 200vmax;
	height: 200vmax;
	margin: -100vmax 0 0 -100vmax;
	background: conic-gradient(var(--clear) 0turn 0.6turn, var(--session) 0.8turn, var(--clear) 0.98turn);
	animation: spin 4.8s linear infinite;
}
.pill {
	position: absolute;
	top: 10px;
	left: 50%;
	transform: translateX(-50%);
	display: flex;
	align-items: center;
	gap: 7px;
	max-width: calc(100vw - 24px);
	box-sizing: border-box;
	padding: 4px 4px 4px 11px;
	border-radius: 999px;
	border: 1px solid color-mix(in srgb, var(--session) 45%, var(--border));
	background: color-mix(in srgb, var(--card) 90%, transparent);
	backdrop-filter: blur(10px) saturate(1.15);
	box-shadow: 0 6px 20px color-mix(in srgb, var(--foreground) 16%, transparent), 0 0 0 4px color-mix(in srgb, var(--session) 12%, transparent);
	color: var(--foreground);
	font-size: 12px;
	line-height: 18px;
	font-weight: 500;
	white-space: nowrap;
	user-select: none;
	-webkit-user-select: none;
}
.dot {
	flex: none;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--session);
	animation: pulse 1.6s ease-out infinite;
}
.who { font-weight: 650; }
.status, .detail, .sep { color: var(--muted-foreground); }
.detail { overflow: hidden; text-overflow: ellipsis; max-width: 30ch; }
.detail:empty, .detail:empty + .sep { display: none; }
.take {
	pointer-events: auto;
	appearance: none;
	margin: 0 0 0 3px;
	padding: 2px 10px;
	border-radius: 999px;
	border: 1px solid var(--border);
	background: var(--background);
	color: var(--foreground);
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}
.take:hover { background: var(--accent); }
.take:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.veil.locked .take, .veil.leaving .take, .veil.concealed .take { pointer-events: none; }
@keyframes spin { to { transform: rotate(1turn); } }
@keyframes breathe { from { opacity: 0.4; } to { opacity: 1; } }
@keyframes pulse {
	from { box-shadow: 0 0 0 0 var(--soft); }
	to { box-shadow: 0 0 0 7px var(--clear); }
}
.veil.reduced .ring, .veil.reduced .glow { display: none; }
.veil.reduced .dot { animation: none; }
.veil.reduced .edge { box-shadow: inset 0 0 0 3px var(--session); }
@media (prefers-reduced-motion: reduce) {
	.ring, .glow { display: none; }
	.dot { animation: none; }
	.edge { box-shadow: inset 0 0 0 3px var(--session); }
}
@media (prefers-reduced-transparency: reduce) {
	.scrim, .glow, .ring { display: none; }
	.edge { box-shadow: inset 0 0 0 3px var(--session); }
	.pill { background: var(--card); backdrop-filter: none; }
}
@media (forced-colors: active) {
	.scrim, .glow, .ring { display: none; }
	.edge { box-shadow: none; border: 3px solid Highlight; }
	.pill { background: Canvas; color: CanvasText; border-color: CanvasText; box-shadow: none; backdrop-filter: none; }
	.status, .detail, .sep { color: CanvasText; }
	.dot { background: Highlight; animation: none; }
	.take { background: ButtonFace; color: ButtonText; border-color: ButtonText; }
}
@media print { .veil { display: none; } }
`;

/** Runs in the page (isolated world). Self-contained: Chrome sends only this function's text. */
export function veilPage(cmd: VeilCommand): VeilPageResult {
	interface Live {
		host: HTMLElement;
		box: HTMLElement;
		tag: string;
		observer: MutationObserver;
		reattached: number;
		leaving?: ReturnType<typeof setTimeout>;
		media?: MediaQueryList;
		paint?: () => void;
	}
	const g = globalThis as unknown as { __polycarpVeil?: Live };
	const remove = (live: Live) => {
		live.observer.disconnect();
		if (live.leaving) clearTimeout(live.leaving);
		if (live.media && live.paint) live.media.removeEventListener("change", live.paint);
		live.host.remove();
		if (g.__polycarpVeil === live) g.__polycarpVeil = undefined;
	};
	const live = g.__polycarpVeil;

	if (cmd.op === "hide") {
		if (!live) return {};
		if (!cmd.fade) {
			remove(live);
			return {};
		}
		live.box.classList.add("leaving");
		live.box.classList.remove("on");
		if (live.leaving) clearTimeout(live.leaving);
		live.leaving = setTimeout(() => remove(live), 520);
		return { tag: live.tag };
	}

	if (cmd.op === "set") {
		if (!live) return {};
		if (cmd.interactive !== undefined) live.box.classList.toggle("locked", !cmd.interactive);
		if (cmd.concealed !== undefined) {
			live.box.classList.toggle("concealed", cmd.concealed);
			// Style now, so the capture that follows paints without the veil.
			live.host.getBoundingClientRect();
		}
		return { tag: live.tag };
	}

	if (document.contentType === "application/pdf") return { skipped: "pdf" };
	const html = document.documentElement;
	if (!(html instanceof HTMLElement)) return { skipped: "not an HTML document" };

	let cur = live;
	if (cur && (cur.tag !== cmd.tag || !cur.host.isConnected)) {
		// Another tag means a new document's veil was asked for; one the page removed is drawn again.
		if (cur.tag !== cmd.tag) {
			remove(cur);
			cur = undefined;
		}
	}
	if (!cur) {
		const host = document.createElement(cmd.tag);
		const shadow = host.attachShadow({ mode: "closed" });
		const style = document.createElement("style");
		style.textContent = cmd.css;
		const box = document.createElement("div");
		box.className = "veil";
		const layer = (name: string) => {
			const el = document.createElement("div");
			el.className = name;
			el.setAttribute("aria-hidden", "true");
			box.append(el);
			return el;
		};
		layer("scrim");
		layer("glow");
		layer("ring").append(Object.assign(document.createElement("div"), { className: "sweep" }));
		layer("edge");
		const pill = document.createElement("div");
		pill.className = "pill";
		pill.setAttribute("role", "status");
		const span = (name: string, text = "") => {
			const el = document.createElement("span");
			el.className = name;
			el.textContent = text;
			pill.append(el);
			return el;
		};
		span("dot").setAttribute("aria-hidden", "true");
		span("who");
		span("sep", "·").setAttribute("aria-hidden", "true");
		span("status", "working");
		span("sep", "·").setAttribute("aria-hidden", "true");
		span("detail");
		const take = document.createElement("button");
		take.className = "take";
		take.type = "button";
		take.tabIndex = -1;
		take.textContent = "Take over";
		take.title = "Give this tab back to you. The agent stops using it.";
		take.addEventListener("click", (e) => {
			// The page can't reach this button (closed root); a synthetic event is never the user.
			if (!e.isTrusted || box.classList.contains("locked") || box.classList.contains("concealed")) return;
			e.preventDefault();
			e.stopPropagation();
			box.classList.add("leaving");
			box.classList.remove("on");
			void chrome.runtime.sendMessage({ type: "polycarp-veil", action: "take-over" }).catch(() => undefined);
		});
		pill.append(take);
		box.append(pill);
		shadow.append(style, box);
		const made: Live = { host, box, tag: cmd.tag, observer: new MutationObserver(() => undefined), reattached: 0 };
		// A page that rewrites <html> drops the element; put it back, a few times at most.
		made.observer = new MutationObserver(() => {
			if (made.host.isConnected || made.reattached >= 5 || g.__polycarpVeil !== made) return;
			made.reattached++;
			document.documentElement?.append(made.host);
		});
		made.observer.observe(html, { childList: true });
		g.__polycarpVeil = made;
		cur = made;
	}
	if (!cur.host.isConnected) (document.documentElement ?? html).append(cur.host);

	const box = cur.box;
	const set = (cls: string, text: string) => {
		const el = box.querySelector(cls);
		if (el && el.textContent !== text) el.textContent = text;
	};
	set(".who", cmd.agent);
	set(".detail", cmd.detail);
	const colors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
	box.style.setProperty("--session", `var(--g-${colors.includes(cmd.color) ? cmd.color : "blue"})`);
	const theme = cmd.theme;
	const media = matchMedia("(prefers-color-scheme: dark)");
	const paint = () => {
		const dark = theme.scheme === "dark" || (theme.scheme === "auto" && media.matches);
		box.classList.toggle("dark", dark);
		for (const [name, value] of Object.entries(dark ? theme.dark : theme.light))
			if (/^--[a-z0-9-]+$/.test(name)) box.style.setProperty(name, value);
	};
	if (cur.media && cur.paint) cur.media.removeEventListener("change", cur.paint);
	cur.media = media;
	cur.paint = paint;
	media.addEventListener("change", paint);
	paint();
	box.classList.toggle("reduced", theme.reduced);
	box.classList.toggle("locked", !cmd.interactive);
	box.classList.toggle("concealed", cmd.concealed);
	if (cur.leaving) {
		clearTimeout(cur.leaving);
		cur.leaving = undefined;
	}
	box.classList.remove("leaving");
	if (!box.classList.contains("on")) {
		// Commit the hidden state first, so the fade-in runs.
		box.getBoundingClientRect();
		box.classList.add("on");
	}
	return { tag: cur.tag };
}
