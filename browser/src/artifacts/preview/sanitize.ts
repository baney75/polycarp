/**
 * Allow-list HTML sanitizer for untrusted fragments (notebook outputs). The input is parsed in
 * an inert document (no scripts run, no images load), then rebuilt element by element in the
 * target document with only the tags and attributes below. Styles, scripts, event handlers,
 * forms, frames and remote images never make it across.
 */

const ALLOWED_TAGS = new Set(
	"a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strong sub summary sup table tbody td tfoot th thead tr u ul var".split(
		" ",
	),
);

/** Elements dropped with everything inside them. */
const DROP_WITH_CONTENT = new Set(
	"script style template iframe frame frameset object embed applet noscript svg math form input button select textarea audio video source track link meta base title head canvas".split(
		" ",
	),
);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
	"*": new Set(["title", "colspan", "rowspan", "align", "valign", "dir", "lang"]),
	a: new Set(["href"]),
	img: new Set(["src", "alt", "width", "height"]),
	ol: new Set(["start", "type"]),
	td: new Set(["headers", "scope"]),
	th: new Set(["headers", "scope"]),
};

const SAFE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_LINK = /^(https?:|mailto:)/i;

export const MAX_SANITIZE_CHARS = 5_000_000;
const MAX_NODES = 50_000;

/** Nodes several sanitizeHtml calls may still create together, e.g. all outputs of one notebook. */
export interface NodeBudget {
	nodes: number;
}

/**
 * `resolveImage` maps an img src such as `attachment:name` to a data URL the caller already
 * validated (base64 of a PNG, JPEG, GIF or WebP); any other src must pass SAFE_IMAGE.
 */
export function sanitizeHtml(
	html: string,
	target: Document,
	budget: NodeBudget = { nodes: MAX_NODES },
	resolveImage?: (src: string) => string | undefined,
): DocumentFragment {
	const out = target.createDocumentFragment();
	if (html.length > MAX_SANITIZE_CHARS) {
		const p = target.createElement("p");
		p.textContent = "[Output too large to display]";
		out.appendChild(p);
		return out;
	}
	const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
	const copy = (src: Node, dest: Node, depth: number) => {
		for (const node of Array.from(src.childNodes)) {
			if (--budget.nodes < 0 || depth > 64) return;
			if (node.nodeType === Node.TEXT_NODE) {
				dest.appendChild(target.createTextNode(node.textContent ?? ""));
				continue;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			const el = node as Element;
			const tag = el.localName;
			if (DROP_WITH_CONTENT.has(tag)) continue;
			if (!ALLOWED_TAGS.has(tag)) {
				// Unknown wrapper: keep its children, drop the element.
				copy(el, dest, depth + 1);
				continue;
			}
			const clean = target.createElement(tag);
			for (const a of Array.from(el.attributes)) {
				const name = a.name.toLowerCase();
				if (!ALLOWED_ATTRS["*"].has(name) && !ALLOWED_ATTRS[tag]?.has(name)) continue;
				let value = a.value.trim();
				if (tag === "img" && name === "src") {
					const resolved = resolveImage?.(value);
					// A resolved image is still checked: its prefix here, its base64 body when it was parsed.
					if (typeof resolved === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(resolved))
						value = resolved;
					else if (!SAFE_IMAGE.test(value)) continue;
				}
				if (tag === "a" && name === "href" && !SAFE_LINK.test(value)) continue;
				clean.setAttribute(name, value);
			}
			if (tag === "img" && !clean.hasAttribute("src")) {
				const alt = el.getAttribute("alt");
				dest.appendChild(target.createTextNode(alt ? `[Image: ${alt}]` : "[Image]"));
				continue;
			}
			if (tag === "a" && clean.hasAttribute("href")) {
				clean.setAttribute("target", "_blank");
				clean.setAttribute("rel", "noopener noreferrer");
			}
			copy(el, clean, depth + 1);
			dest.appendChild(clean);
		}
	};
	copy(parsed.body, out, 0);
	return out;
}
