/**
 * Words for document search: tokens, stop words and the Porter stemmer (M. F. Porter, 1980, "An algorithm for suffix
 * stripping"), so "contemplation", "contemplative" and "contemplate" are one term. English only; other languages are
 * matched by their lower-cased words.
 */

const c = "[^aeiou]";
const v = "[aeiouy]";
const C = `${c}[^aeiouy]*`;
const V = `${v}[aeiou]*`;
const mgr0 = new RegExp(`^(${C})?${V}${C}`);
const meq1 = new RegExp(`^(${C})?${V}${C}(${V})?$`);
const mgr1 = new RegExp(`^(${C})?${V}${C}${V}${C}`);
const sV = new RegExp(`^(${C})?${v}`);
const cvc = new RegExp(`^${C}${v}[^aeiouwxy]$`);

const STEP2: Record<string, string> = {
	ational: "ate",
	tional: "tion",
	enci: "ence",
	anci: "ance",
	izer: "ize",
	bli: "ble",
	alli: "al",
	entli: "ent",
	eli: "e",
	ousli: "ous",
	ization: "ize",
	ation: "ate",
	ator: "ate",
	alism: "al",
	iveness: "ive",
	fulness: "ful",
	ousness: "ous",
	aliti: "al",
	iviti: "ive",
	biliti: "ble",
	logi: "log",
};
const STEP3: Record<string, string> = {
	icate: "ic",
	ative: "",
	alize: "al",
	iciti: "ic",
	ical: "ic",
	ful: "",
	ness: "",
};

/** The Porter stem of one lower-case word. */
export function porter(word: string): string {
	let w = word;
	if (w.length < 3 || !/^[a-z]+$/.test(w)) return w;
	const y = w[0] === "y";
	if (y) w = `Y${w.slice(1)}`;
	// 1a
	const a1 = /^(.+?)(ss|i)es$/.exec(w) ?? /^(.+?)([^s])s$/.exec(w);
	if (a1) w = a1[1] + a1[2];
	// 1b
	const eed = /^(.+?)eed$/.exec(w);
	const ing = eed ? null : /^(.+?)(ed|ing)$/.exec(w);
	if (eed) {
		if (mgr0.test(eed[1])) w = w.slice(0, -1);
	} else if (ing && sV.test(ing[1])) {
		w = ing[1];
		if (/(at|bl|iz)$/.test(w)) w += "e";
		else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
		else if (cvc.test(w)) w += "e";
	}
	// 1c
	const c1 = /^(.+?)y$/.exec(w);
	if (c1 && sV.test(c1[1])) w = `${c1[1]}i`;
	// 2
	const s2 =
		/^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(
			w,
		);
	if (s2 && mgr0.test(s2[1])) w = s2[1] + STEP2[s2[2]];
	// 3
	const s3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w);
	if (s3 && mgr0.test(s3[1])) w = s3[1] + STEP3[s3[2]];
	// 4
	const s4 = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w);
	const ion = s4 ? null : /^(.+?)(s|t)(ion)$/.exec(w);
	if (s4) {
		if (mgr1.test(s4[1])) w = s4[1];
	} else if (ion && mgr1.test(ion[1] + ion[2])) w = ion[1] + ion[2];
	// 5
	const s5 = /^(.+?)e$/.exec(w);
	if (s5 && (mgr1.test(s5[1]) || (meq1.test(s5[1]) && !cvc.test(s5[1])))) w = s5[1];
	if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);
	if (y) w = `y${w.slice(1)}`;
	return w;
}

export const STOP_WORDS = new Set(
	"a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves says say said tell tells told where page pages find show book document".split(
		" ",
	),
);

/** Negations count in a query: "needs no external things" is not "needs external things". */
const KEEP = new Set(["no", "not", "nor", "none", "never", "without"]);

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

export interface Token {
	term: string;
	/** Character offset in the text. */
	at: number;
}

/** A word as the index keeps it: lower case, no possessive, Porter stem. */
export function term(word: string): string {
	const w = word.toLowerCase().replace(/['’]s$/, "");
	return porter(w);
}

/** Every word of a text as an index term, stop words left out, with where it is. */
export function tokens(text: string): Token[] {
	const out: Token[] = [];
	for (const m of text.matchAll(WORD)) {
		const w = m[0].toLowerCase();
		if (w.length < 2 || STOP_WORDS.has(w)) continue;
		out.push({ term: term(w), at: m.index ?? 0 });
	}
	return out;
}

/** The terms of a query, in order, without repeats. Negation words are kept as their own terms. */
export function queryTerms(query: string): { terms: string[]; negated: boolean } {
	const terms: string[] = [];
	let negated = false;
	for (const m of query.matchAll(WORD)) {
		const w = m[0].toLowerCase();
		if (KEEP.has(w)) {
			negated = true;
			continue;
		}
		if (w.length < 2 || STOP_WORDS.has(w)) continue;
		const t = term(w);
		if (!terms.includes(t)) terms.push(t);
	}
	return { terms, negated };
}
