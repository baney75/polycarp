/**
 * Ranked full-text search over stored documents: BM25 (k1 1.2, b 0.75) over each page or section, then a rerank of the
 * best candidates by how close the query words sit together and whether they appear as a phrase. All local: no network
 * and no model call. `also` takes other wordings of the query (the chat model's paraphrases), which is how a question
 * phrased differently from the book still finds its page.
 */

import { queryTerms, tokens } from "./words.js";

/** A document's inverted index: term to a flat list of [unit, count, unit, count, ...], and each unit's length in terms. */
export interface DocIndex {
	terms: Record<string, number[]>;
	lengths: number[];
}

export function buildIndex(units: readonly string[]): DocIndex {
	const terms: Record<string, number[]> = Object.create(null);
	const lengths: number[] = [];
	units.forEach((text, n) => {
		const counts = new Map<string, number>();
		const toks = tokens(text);
		lengths.push(toks.length);
		for (const t of toks) counts.set(t.term, (counts.get(t.term) ?? 0) + 1);
		for (const [t, k] of counts) {
			const list = terms[t] ?? [];
			list.push(n, k);
			terms[t] = list;
		}
	});
	return { terms, lengths };
}

export interface SearchDoc {
	id: string;
	index: DocIndex;
	/** A unit's text, for the rerank and the snippet. */
	text(unit: number): Promise<string> | string;
}

export interface SearchHit {
	doc: string;
	unit: number;
	score: number;
	snippet: string;
}

export interface SearchOptions {
	limit?: number;
	/** Other wordings of the same question. Their new words count for less than the query's own. */
	also?: readonly string[];
	/** Characters of context in each snippet. */
	snippetChars?: number;
}

const K1 = 1.2;
const B = 0.75;
const RERANK = 40;
const ALSO_WEIGHT = 0.6;

interface Weighted {
	term: string;
	weight: number;
}

/** The weighted terms of a query and its other wordings. */
export function weightedTerms(query: string, also: readonly string[] = []): Weighted[] {
	const out = new Map<string, number>();
	for (const t of queryTerms(query).terms) out.set(t, 1);
	for (const alt of also) for (const t of queryTerms(alt).terms) if (!out.has(t)) out.set(t, ALSO_WEIGHT);
	return [...out].map(([term, weight]) => ({ term, weight }));
}

export async function search(
	docs: readonly SearchDoc[],
	query: string,
	options: SearchOptions = {},
): Promise<SearchHit[]> {
	const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
	const terms = weightedTerms(query, options.also);
	if (!terms.length) return [];
	let units = 0;
	let length = 0;
	const df = new Map<string, number>();
	for (const d of docs) {
		units += d.index.lengths.length;
		for (const l of d.index.lengths) length += l;
		for (const { term } of terms) df.set(term, (df.get(term) ?? 0) + (d.index.terms[term]?.length ?? 0) / 2);
	}
	if (!units) return [];
	const avg = length / units || 1;
	const idf = new Map(
		terms.map(({ term }) => [term, Math.log(1 + (units - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))]),
	);

	const scored: { doc: SearchDoc; unit: number; score: number; matched: number }[] = [];
	for (const d of docs) {
		const acc = new Map<number, { score: number; matched: number }>();
		for (const { term, weight } of terms) {
			const list = d.index.terms[term];
			if (!list) continue;
			const w = (idf.get(term) ?? 0) * weight;
			for (let i = 0; i < list.length; i += 2) {
				const unit = list[i];
				const tf = list[i + 1];
				const dl = d.index.lengths[unit] ?? 0;
				const s = (w * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * dl) / avg));
				const a = acc.get(unit) ?? { score: 0, matched: 0 };
				a.score += s;
				a.matched += weight;
				acc.set(unit, a);
			}
		}
		for (const [unit, a] of acc) scored.push({ doc: d, unit, ...a });
	}
	scored.sort((a, b) => b.score - a.score);

	const top = scored.slice(0, Math.max(RERANK, limit));
	const wanted = new Map(terms.map((t) => [t.term, t.weight]));
	const total = terms.reduce((s, t) => s + t.weight, 0);
	const reranked: SearchHit[] = [];
	for (const c of top) {
		const text = await c.doc.text(c.unit);
		const best = densest(text, wanted, total);
		reranked.push({
			doc: c.doc.id,
			unit: c.unit,
			score: c.score * (1 + best.bonus),
			snippet: snippet(text, best.from, best.to, options.snippetChars ?? 320),
		});
	}
	reranked.sort((a, b) => b.score - a.score);
	return reranked.slice(0, limit).map((h) => ({ ...h, score: Math.round(h.score * 100) / 100 }));
}

const WINDOW = 40;

/**
 * The stretch of a unit where the query's words crowd together most: a sliding window of WINDOW terms, scored by the
 * weight of distinct query terms inside it, with a bonus when two query terms sit next to each other in query order.
 * Returns the bonus (0 to 1) and the character span to quote.
 */
export function densest(
	text: string,
	wanted: Map<string, number>,
	total: number,
): { bonus: number; from: number; to: number } {
	const toks = tokens(text);
	const order = [...wanted.keys()];
	let best = { value: 0, from: 0, to: Math.min(text.length, 200) };
	const inWindow = new Map<string, number>();
	let weight = 0;
	let start = 0;
	let adjacent = 0;
	const hits: number[] = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i].term;
		if (wanted.has(t)) {
			hits.push(i);
			const k = inWindow.get(t) ?? 0;
			if (!k) weight += wanted.get(t) ?? 0;
			inWindow.set(t, k + 1);
			const prev = i > 0 ? order.indexOf(toks[i - 1].term) : -1;
			if (prev >= 0 && order.indexOf(t) === prev + 1) adjacent++;
		}
		while (hits.length && hits[0] <= i - WINDOW) {
			const old = toks[hits.shift() as number].term;
			const k = (inWindow.get(old) ?? 1) - 1;
			if (k) inWindow.set(old, k);
			else {
				inWindow.delete(old);
				weight -= wanted.get(old) ?? 0;
			}
		}
		start = hits[0] ?? i;
		if (weight > best.value) best = { value: weight, from: toks[start].at, to: toks[i].at + 20 };
	}
	const cover = total ? best.value / total : 0;
	return { bonus: cover * cover + Math.min(adjacent, 3) * 0.1, from: best.from, to: best.to };
}

/** About `chars` of text around [from, to), cut at word edges, with an ellipsis where it was cut. */
export function snippet(text: string, from: number, to: number, chars: number): string {
	const span = Math.max(0, to - from);
	const pad = Math.max(40, Math.floor((chars - Math.min(span, chars)) / 2));
	let a = Math.max(0, from - pad);
	let b = Math.min(text.length, Math.max(to, from + Math.min(span, chars)) + pad);
	if (b - a > chars + 80) b = a + chars + 80;
	if (a > 0) a = text.indexOf(" ", a) + 1 || a;
	if (b < text.length) b = text.lastIndexOf(" ", b) > a ? text.lastIndexOf(" ", b) : b;
	const body = text.slice(a, b).replace(/\s+/g, " ").trim();
	return `${a > 0 ? "..." : ""}${body}${b < text.length ? "..." : ""}`;
}
