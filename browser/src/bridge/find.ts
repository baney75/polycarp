/**
 * Ranking for the `find` tool. Words are matched against an element's accessible name first:
 * the whole name, then whole words of it, then pieces of words. Role and value count for less,
 * and a link found only by a piece of its URL is an answer only when nothing better matched.
 */

export interface FindNode {
	role: string;
	name: string;
	value?: string;
	href?: string;
	visible?: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Points for one node, and whether its name, role or value matched (not just its URL). */
function score(node: FindNode, query: string, words: string[]): { points: number; direct: boolean } {
	const name = node.name.toLowerCase();
	const role = node.role.toLowerCase();
	const value = (node.value ?? "").toLowerCase();
	const href = (node.href ?? "").toLowerCase();
	let points = 0;
	let direct = false;
	if (name === query) {
		points += 200;
		direct = true;
	} else if (query && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(query)}($|[^\\p{L}\\p{N}])`, "u").test(name)) {
		points += 80;
		direct = true;
	}
	for (const w of words) {
		const whole = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, "u");
		if (whole.test(name)) {
			points += 30 + w.length;
			direct = true;
		} else if (name.includes(w)) {
			points += 10;
			direct = true;
		}
		if (role === w) {
			points += 12;
			direct = true;
		}
		if (value.includes(w)) {
			points += 4;
			direct = true;
		}
		if (href.includes(w)) points += 1;
	}
	return { points, direct };
}

/** The nodes that match `query`, best first. */
export function rankMatches<T extends FindNode>(nodes: T[], query: string, limit: number): T[] {
	const q = query.trim().toLowerCase();
	const words = q.split(/\s+/).filter(Boolean);
	const scored = nodes.map((node, order) => ({ node, order, ...score(node, q, words) })).filter((s) => s.points > 0);
	// A match on the URL alone (a fragment, a path segment) is the weakest kind: keep it only
	// when no element matched by what it shows.
	const shown = scored.filter((s) => s.direct);
	const pool = shown.length > 0 ? shown : scored;
	return (
		pool
			// Equal matches: what is on screen first, then page order.
			.sort(
				(a, b) =>
					b.points - a.points ||
					Number(b.node.visible === true) - Number(a.node.visible === true) ||
					a.order - b.order,
			)
			.slice(0, limit)
			.map((s) => s.node)
	);
}
