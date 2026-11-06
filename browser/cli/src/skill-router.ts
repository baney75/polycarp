/**
 * The skill router: given a task, which skill (if any) should the agent load? Offline and
 * dependency-free, so it runs in the MCP server on every call and in CI with no model.
 *
 * Each skill is indexed from three fields of its SKILL.md: the name, the description
 * (what the skill does, then its "Use when" triggers) and the bullets under
 * "## When to use". Matching is BM25F over light-stemmed words, plus three signals of
 * word order: a slash command (`/rsi`), a quoted trigger phrase from the description
 * ("learn from this"), and pairs of neighbouring words ("literature review"). Sentences
 * that send the reader elsewhere ("Not for ...", "For news, use `news-research`") are left
 * out, so they don't pull those tasks in.
 *
 * A match needs MIN_SCORE and two pieces of evidence, or one word specific enough to reach
 * SINGLE_SCORE alone. Otherwise the answer is "none": a small model does better with no
 * skill than with the wrong one (docs/decisions.md D12). The constants are calibrated on
 * skills-eval/router-cases.jsonl; `tabkyra skill eval` reports how well they hold.
 */

export interface RouterSkill {
	name: string;
	/** The SKILL.md text, frontmatter included. */
	text: string;
}

export interface SkillMatch {
	name: string;
	/** Higher is a better match; MIN_SCORE is the floor for any match. */
	score: number;
	/** The first sentence of the skill's description. */
	description: string;
}

type Field = "name" | "what" | "when";

interface Doc {
	name: string;
	description: string;
	/** Term frequencies and length per field. */
	tf: Record<Field, Map<string, number>>;
	len: Record<Field, number>;
	/**
	 * Trigger phrases as word sequences (unstemmed, stopwords kept). `strong` when the phrase
	 * holds a word specific enough to count as evidence; "what's going on with" is all
	 * stopwords, so it ranks but can't make a match on its own.
	 */
	phrases: Array<{ seq: string[]; strong: boolean }>;
	/** Pairs of neighbouring words within a clause ("literature review", "search operators"). */
	pairs: Set<string>;
}

export interface RouterIndex {
	docs: Doc[];
	idf: Map<string, number>;
	/** Words held by few enough skills to count as evidence. */
	specific: ReadonlySet<string>;
	/** The score one piece of evidence needs: SINGLE_SCORE, or SINGLE_SCORE_LARGE past REFERENCE_SKILLS (growing past 32 skills). */
	single: number;
	avg: Record<Field, number>;
	/**
	 * A mention: one skill name, or a list of them ("osint and dorks", "maps, osint or dorks"),
	 * then "skill" or "skills". Hyphenated names also match with a space or nothing between parts.
	 */
	mention: RegExp;
	/** Each name with its hyphens removed, to read a matched name back: "video editing" is video-editing. */
	nameKeys: ReadonlyMap<string, string>;
	names: ReadonlySet<string>;
	/** Inverse document frequency of each word pair, as for words. */
	pairIdf: Map<string, number>;
}

/** Field weights, BM25 constants and bonuses, calibrated on skills-eval/router-cases.jsonl. */
const WEIGHT: Record<Field, number> = { name: 1.5, what: 1, when: 1.5 };
const B: Record<Field, number> = { name: 0, what: 0.6, when: 0.6 };
const K1 = 1.2;
const COMMAND_BONUS = 6;
const PHRASE_BONUS = 2.5;
const PAIR_BONUS = 2;
/** The floor for any match. */
export const MIN_SCORE = 2.5;
/** A match on one piece of evidence alone needs a word this specific ("osint", "dorks"). */
export const SINGLE_SCORE = 4.5;
/**
 * The same bar past REFERENCE_SKILLS. Scaled IDF still lets a mid-frequency word in an old skill
 * score a little higher than it did at 13 skills, so one such word needs a little more.
 */
export const SINGLE_SCORE_LARGE = 4.8;
/** A word with lower IDF is too common to count as evidence: held by more than two of 13 skills (see buildRouterIndex). */
const EVIDENCE_IDF = 1.5;

const STOPWORDS = new Set(
	(
		"a an the and or but nor of to in on at by for with from as into onto over under about against between through during " +
		"is are was were be been being am do does did done doing have has had having will would shall should can could may might must " +
		"i me my mine myself you your yours yourself we us our ours they them their theirs he him his she her hers it its itself " +
		"this that these those there here what which whom whose why how where when while if then than so too very just only also even " +
		"all any each every some such no not own same other another more most less few much one ones " +
		"please let get got give gave make made want wants wanted need needs like use used using user users ask asks asked tell " +
		"help show look try see go goes going gone went put take thing things way whether last first next new after before until since " +
		"something anything everything someone really actually return returns returned " +
		"s t d ll re ve m don doesn didn isn aren wasn weren won wouldn can't don't it's i'm i've that's what's"
	).split(" "),
);

/** Words the suffix rules would merge with another word ("news" is not "new"). */
const KEEP = new Set(["news", "series", "analytics", "always"]);

/** Derivational endings, longest first: "investigation", "investigative" and "investigate" meet. */
const DERIVED = ["ational", "ization", "isation", "ations", "ation", "ition", "ement", "ment", "ness", "ions", "ion", "ity", "ive", "ous", "ance", "ence", "able", "ible", "ate", "ize", "ise", "ful", "al", "ic"];

/**
 * Light stemming: plurals, -ing, -ed, -er, -ly, one derivational ending, and a final e or
 * y, so "reviewer", "reviews" and "reviewing" meet. Both sides are stemmed alike, so a
 * stem need not be a word.
 */
export function stem(word: string): string {
	let w = word;
	if (w.length <= 3 || KEEP.has(w)) return w;
	if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
	else if (w.endsWith("sses")) w = w.slice(0, -2);
	else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
	for (const suffix of ["ing", "ed", "er", "ly"]) {
		if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
			w = w.slice(0, -suffix.length);
			if (/([^aeiouls])\1$/.test(w)) w = w.slice(0, -1);
			break;
		}
	}
	for (const suffix of DERIVED) {
		if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
			w = w.slice(0, -suffix.length);
			break;
		}
	}
	if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
	if (w.length > 3 && w.endsWith("y")) w = `${w.slice(0, -1)}i`;
	return w;
}

/** Lowercase words in order; apostrophes kept inside words, everything else splits. */
function words(text: string): string[] {
	return (
		text
			.toLowerCase()
			.replace(/[‘’]/g, "'")
			.match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []
	);
}

function terms(text: string): string[] {
	return words(text)
		.map((w) => w.replace(/'s$/, ""))
		.filter((w) => !STOPWORDS.has(w))
		.map(stem);
}

function count(list: string[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
	return m;
}

/** Sentences that point to another tool or skill describe what the skill is not. */
const REDIRECT = /^(not for|use a plain|don't write a skill)/i;
/** "Use `x` ..." or "For ..., use `x`" sends the reader to x only when x is a skill; "Use `pass-cli run` when ..." is a trigger. */
const USE_OTHER = /^(?:for [^.]*\b)?use `([^`]+)`/i;

function redirects(sentence: string, names: ReadonlySet<string>): boolean {
	const t = sentence.trim();
	if (REDIRECT.test(t)) return true;
	const m = USE_OTHER.exec(t);
	return m !== null && names.has(m[1]);
}

function frontmatterDescription(text: string): string {
	return /^description: (.*)$/m.exec(text)?.[1]?.trim() ?? "";
}

/** The "## When to use" bullets, each with its wrapped lines. Paragraphs between them are skipped. */
function whenToUse(text: string): string[] {
	const m = /^## When to use[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
	if (!m) return [];
	const items: string[] = [];
	let open = false;
	for (const line of m[1].split("\n")) {
		if (/^\s*[-*] /.test(line)) {
			items.push(line.replace(/^\s*[-*] /, ""));
			open = true;
		} else if (open && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
		else open = false;
	}
	return items;
}

function sentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+(?=[A-Z`/"])/);
}

/** The first sentence of a description: what `skill list` and skill_match show. */
export function oneLine(description: string): string {
	const first = description.split(/(?<=\.)\s/)[0] ?? description;
	return first.endsWith(".") ? first : `${first}.`;
}

/** Remove backticked mentions of other skills: "use `news-research`" is not about this skill. */
function withoutOtherSkills(text: string, self: string, names: ReadonlySet<string>): string {
	return text.replace(/`([a-z0-9-]+)`/g, (whole, inner: string) => (inner !== self && names.has(inner) ? " " : whole));
}

/**
 * Quoted phrases of two or more words from the kept sentences and bullets. Quotes inside
 * excluded sentences ("Not for "invoice triage"") never count, and a one-word quote is just
 * a word, which the term score already counts.
 */
function phrasesOf(name: string, sources: string[]): string[][] {
	const out: string[][] = [];
	for (const source of sources) {
		for (const m of source.matchAll(/"([^"]{3,60})"/g)) {
			// A trailing placeholder ("what is known about X") matches any topic, so it's dropped.
			const seq = words(m[1]);
			while (seq.length > 1 && seq[seq.length - 1].length === 1) seq.pop();
			if (seq.length >= 2 && seq.join(" ") !== name) out.push(seq);
		}
	}
	return out;
}

/**
 * Neighbouring stemmed words within each clause, as order-free keys. In a list of one-word
 * items that ends on a phrase ("write, draft or port a skill"), each item also pairs with
 * the phrase's last word, the way a reader distributes it: write skill, draft skill.
 */
function pairsOf(text: string): Set<string> {
	const out = new Set<string>();
	const add = (a: string, b: string) => {
		if (a !== b) out.add([a, b].sort().join(" "));
	};
	for (const clause of text.split(/[;:()?!]|\.(?=\s|$)|\s[-\u2013\u2014]\s/)) {
		const items = clause.split(/,|\bor\b|\band\b/).map(terms).filter((t) => t.length);
		items.forEach((t, k) => {
			for (let i = 0; i + 1 < t.length; i++) add(t[i], t[i + 1]);
			if (t.length < 2) return;
			for (let j = k - 1; j >= 0 && items[j].length === 1; j--) add(items[j][0], t[t.length - 1]);
		});
	}
	return out;
}

/**
 * The name's words. A hyphenated name also counts joined ("protonpass"), and a run-together
 * name counts the words of its own description it is made of ("kyraskillmaker": skill, make).
 */
function nameTerms(name: string, vocabulary: Set<string>): string[] {
	const out = terms(name.replace(/-/g, " "));
	if (name.includes("-")) out.push(name.replace(/-/g, ""));
	for (const part of name.split("-")) {
		if (part.length < 8) continue;
		for (const word of vocabulary) if (word.length >= 4 && word !== part && part.includes(word)) out.push(word);
	}
	return out;
}

function parse(skill: RouterSkill, names: ReadonlySet<string>): Doc {
	const description = frontmatterDescription(skill.text);
	const clean = (t: string) => withoutOtherSkills(t, skill.name, names);
	const kept = sentences(description).filter((s) => !redirects(s, names));
	const useAt = kept.findIndex((s) => /\bUse when\b/.test(s));
	const whatText = useAt < 0 ? kept : kept.slice(0, useAt);
	const triggers = useAt < 0 ? [] : kept.slice(useAt);
	const bullets = whenToUse(skill.text).filter((b) => !redirects(b, names));
	const what = terms(clean(whatText.join(" ")));
	const when = terms(clean([...triggers, ...bullets].join(" ")));
	const fields: Record<Field, string[]> = { name: nameTerms(skill.name, new Set([...what, ...when])), what, when };
	return {
		name: skill.name,
		description,
		tf: { name: count(fields.name), what: count(fields.what), when: count(fields.when) },
		len: { name: fields.name.length, what: fields.what.length, when: fields.when.length },
		phrases: phrasesOf(skill.name, [...kept, ...bullets].map(clean)).map((seq) => ({ seq, strong: false })),
		pairs: pairsOf(clean([...kept, ...bullets].join(". "))),
	};
}

/** The catalog size the score thresholds were calibrated on (skills-eval, 2026-10-25). */
const REFERENCE_SKILLS = 13;

function idfOf(n: number, k: number): number {
	return Math.log(1 + (n - k + 0.5) / (k + 0.5));
}

/** Build the index once; matching is then a few map lookups per word. */
export function buildRouterIndex(skills: RouterSkill[]): RouterIndex {
	const names = new Set(skills.map((s) => s.name));
	const docs = skills.map((s) => parse(s, names));
	const df = new Map<string, number>();
	for (const d of docs) {
		const seen = new Set([...d.tf.name.keys(), ...d.tf.what.keys(), ...d.tf.when.keys()]);
		for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const n = docs.length;
	// Plain IDF grows with the number of skills: in a larger catalog a word unique to one skill
	// weighs more, and a word in three skills turns into evidence. Past REFERENCE_SKILLS, IDF is
	// scaled so a word unique to one skill weighs what it did there, and a word or word pair
	// counts as evidence only if it would have at REFERENCE_SKILLS (held by at most two skills).
	// MIN_SCORE, the single-evidence bar and EVIDENCE_IDF keep their meaning as skills are added.
	// The bar is SINGLE_SCORE up to REFERENCE_SKILLS and SINGLE_SCORE_LARGE past it. A catalog of
	// REFERENCE_SKILLS or fewer scores and matches exactly as before.
	const ref = Math.min(n, REFERENCE_SKILLS);
	const scale = n > REFERENCE_SKILLS ? idfOf(REFERENCE_SKILLS, 1) / idfOf(n, 1) : 1;
	const idf = new Map([...df].map(([t, k]) => [t, idfOf(n, k) * scale]));
	const specific = new Set([...df].filter(([, k]) => idfOf(ref, k) >= EVIDENCE_IDF).map(([t]) => t));
	for (const d of docs) for (const p of d.phrases) p.strong = terms(p.seq.join(" ")).some((t) => specific.has(t));
	const pairDf = new Map<string, number>();
	for (const d of docs) for (const p of d.pairs) pairDf.set(p, (pairDf.get(p) ?? 0) + 1);
	const pairIdf = new Map([...pairDf].map(([p, k]) => [p, idfOf(ref, k)]));
	const mean = (f: Field) => (n ? docs.reduce((s, d) => s + d.len[f], 0) / n : 1) || 1;
	// Names are lowercase-kebab-case (assertName), so they're safe inside a pattern. Longest first,
	// so "proton-pass skill" isn't read as "proton" followed by something else.
	const one = [...names]
		.sort((a, b) => b.length - a.length)
		.map((name) => name.replace(/-/g, "[- ]?"))
		.join("|");
	const mention = new RegExp(`\\b((?:${one})(?:\\s*(?:,\\s*(?:and|or)\\b|,|\\band\\b|\\bor\\b)\\s*(?:${one}))*)\\s+(skills?)\\b`, "g");
	const nameKeys = new Map([...names].map((name) => [name.replace(/-/g, ""), name]));
	// Past REFERENCE_SKILLS, a word held by two skills (still evidence) gains weight as skills are
	// added, so the bar grows with it from SINGLE_SCORE_LARGE: one such word clears it no more easily
	// at 52 skills than at 32.
	const single = n > REFERENCE_SKILLS ? SINGLE_SCORE_LARGE * Math.max(1, (idfOf(n, 2) * scale) / (idfOf(32, 2) * (idfOf(REFERENCE_SKILLS, 1) / idfOf(32, 1)))) : SINGLE_SCORE;
	return { docs, idf, specific, single, avg: { name: mean("name"), what: mean("what"), when: mean("when") }, mention, nameKeys, names, pairIdf };
}

function containsSequence(haystack: string[], needle: string[]): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

/** Verbs that, aimed at a named skill, make the task about changing it rather than using it. */
const EDIT_VERB = "(?:fix(?:es|ed|ing)?|repair\\w*|edit\\w*|updat\\w*|rewrit\\w*|rewrote|improv\\w*|review\\w*|chang\\w*|correct\\w*|tweak\\w*|shorten\\w*|port(?:s|ed|ing)?|debug\\w*|refin\\w*|lint\\w*)";
/** "<verb> [to|of|on|for] [the|this|my|our|that|your] [up to two words]" right before the mention. */
const GOVERNS = new RegExp(`\\b${EDIT_VERB}\\s+(?:(?:to|of|on|for)\\s+)?(?:(?:the|this|my|our|that|your)\\s+)?(?:[a-z0-9'-]+\\s+){0,2}$`);
/** "..., fix it" after the mention, pointing back at it. */
const POINTS_BACK = new RegExp(`\\b${EDIT_VERB}\\s+(?:it|them)\\b`);
/** "use the osint skill", "run my dorks skill": a use-verb governs the mention, so a later "debug it" is about something else. */
const USE_GOVERNS = /\b(?:use|run|apply|follow|invoke|load)\s+(?:(?:the|this|that|my|our|your)\s+)?(?:[a-z0-9'-]+\s+)?$/;
/**
 * A negation that governs the mention, within a few words before it: "don't use the osint
 * skill", "never run my dorks skill", "without the osint skill", "instead of the dorks skill",
 * "skip the tabkyra skill", "not the osint skill". A "no" or "not" elsewhere ("no rush, use
 * the osint skill", "why not use the osint skill") doesn't.
 */
const DET = "(?:(?:the|this|that|my|our|your|any)\\s+)?(?:[a-z0-9'-]+\\s+)?";
const EXCLUDES = new RegExp(
	[
		`\\b(?:don'?t|do not|never)\\s+(?:use|run|apply|follow|invoke|load)\\s+${DET}$`,
		`\\b(?:without|instead of|rather than|skip(?:ping)?|avoid(?:ing)?)\\s+(?:(?:using|running|use|run)\\s+)?${DET}$`,
		"\\bnot\\s+(?:(?:the|this|that|my|our|your)\\s+)?$",
	].join("|"),
);
/** `tabkyra skill <subcommand>` is the Tabkyra CLI (read as "tabkyra cli"), not a mention of the tabkyra skill. */
const CLI_SUBCOMMAND = /^\s+(?:install|list|print|lint|apply|revert|edit|eval|match|versions|rollback)\b/;

/** "the osint skill", "this dorks skill": a determiner, and at most one word, right before the mention. */
const POINTS_AT = /\b(?:the|this|that|these|those)\s+(?:[a-z0-9'-]+\s+)?$/;
/**
 * "improve my writing skill", "refine our chemistry skills": a verb that also means growing a
 * person's ability, with no determiner pointing at a skill. On its own it isn't a skill edit.
 */
const GROWS = /\b(?:improv\w*|refin\w*)\s+(?:(?:to|of|on|for)\s+)?(?:(?:my|our|your)\s+)?(?:[a-z0-9'-]+\s+){0,2}$/;

interface ReadTask {
	/** A slash command naming a skill, as the task's first token. */
	command?: string;
	/** Skills the task asks to use by name ("use the osint skill"). */
	invoked: Set<string>;
	/** Skills the task rules out ("don't use the osint skill"); never returned. */
	excluded: Set<string>;
	/** The task is about changing a skill it names ("fix the osint skill", "/fix osint"). */
	changesSkill: boolean;
	/** The text left to score. */
	content: string;
}

/**
 * Read what a task says about skills before scoring its words.
 * - A slash command counts only as the first token ("/rsi", "/fix osint"), and only when it
 *   isn't followed by "/" or ".": "ls /fix" and "cat /bug/report.txt" are paths.
 * - Path-like words (starting with "/", "./", "../" or "~/") are data, not intent, and are
 *   dropped.
 * - "<name> skill" (or a list of names before "skills") names a skill only when something points
 *   at it: "the/this/that" before a singular or a list, a use, edit or negation verb, a slash
 *   command or backticks. Otherwise ("my biology skill", "what chemistry skills do employers
 *   want", "improve my writing skill") it is a subject and scores for no skill.
 * - "<name> skill" is the object of a change when an edit verb governs it ("fix the osint
 *   skill", "rewrite my old dorks skill", "the osint skill failed, repair it") or a slash
 *   command comes first: the name is dropped so it doesn't score for itself. An edit-like
 *   word elsewhere ("the latest updates", "review what you find") doesn't count.
 * - It is ruled out when a negation governs it ("don't use the osint skill", "instead of the
 *   dorks skill", see EXCLUDES): that skill is never returned.
 * - `tabkyra skill install` and the other subcommands are the CLI, not the tabkyra skill.
 * - Otherwise ("use the osint skill on this landlord") it is a request for that skill.
 */
function readTask(index: RouterIndex, task: string): ReadTask {
	// Curly apostrophes and quotes (smart punctuation) read as straight ones: "don’t" is "don't".
	let text = task.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
	// Inline code around a skill name ("the `osint` skill", "`dorks` skill") reads as the bare name,
	// and points at the skill: a name in code is never a person's ability.
	text = text.replace(/`([a-z0-9-]+)`/g, (whole, inner: string) => (index.names.has(inner) ? `the ${inner}` : whole));
	let command: string | undefined;
	let changesSkill = false;
	const lead = /^\s*\/([a-z0-9-]+)(?=$|[\s:,;!?])/.exec(text);
	if (lead && index.names.has(lead[1])) {
		command = lead[1];
		text = text.slice(lead[0].length);
		// "/fix news-research": the skill after a command is its object.
		const object = /^\s+([a-z0-9-]+)\b/.exec(text);
		if (object && index.names.has(object[1])) {
			text = text.slice(object[0].length);
			changesSkill = true;
		}
	}
	text = text.replace(/(^|\s)(~|\.{1,2})?\/\S*/g, "$1 ");
	const invoked = new Set<string>();
	const excluded = new Set<string>();
	text = text.replace(index.mention, (whole: string, list: string, noun: string, offset: number, all: string) => {
		const found = [...new Set(list.split(/\s*(?:,|\band\b|\bor\b)\s*/).map((t) => index.nameKeys.get(t.replace(/[- ]/g, ""))))];
		const named = found.filter((name): name is string => name !== undefined);
		const after = all.slice(offset + whole.length);
		if (named.length === 1 && named[0] === "tabkyra" && CLI_SUBCOMMAND.test(after)) return "tabkyra cli";
		const before = all.slice(0, offset);
		if (EXCLUDES.test(before)) {
			for (const name of named) excluded.add(name);
			return " ";
		}
		// Several names are a list of skills; "the osint skill" points at one. A plural with one name
		// ("my writing skills", "the chemistry skills employers want") is a person's abilities.
		const pointsAt = POINTS_AT.test(before) && (noun === "skill" || named.length > 1);
		const edits = GOVERNS.test(before) && (pointsAt || !GROWS.test(before));
		const uses = USE_GOVERNS.test(before);
		// Nothing points the mention at a skill: "my biology skill", "what chemistry skills do
		// employers want", "improve my writing skill". It names a subject, so it scores for neither
		// that skill nor the skills whose job is skills.
		if (command === undefined && !pointsAt && !edits && !uses) {
			// "a Tabkyra skill", "an osint skill": a kind of skill to make, so the word "skill" stays.
			return /\ban?\s+$/.test(before) ? ` ${list} ${noun} ` : " abilities ";
		}
		// "..., fix it" points back at the mention, unless a use-verb governs the mention: in
		// "use the tabkyra skill to open the app and debug it", "it" is the app. Not limited to
		// the clause: "The autoresearch skill gave a weak report. Fix it" is a fix request.
		const backReference = !uses && POINTS_BACK.test(after);
		if (command !== undefined || edits || backReference) {
			changesSkill = true;
			return " skill ";
		}
		for (const name of named) invoked.add(name);
		return whole;
	});
	for (const name of excluded) invoked.delete(name);
	return { command, invoked, excluded, changesSkill, content: text };
}

export interface RawScore {
	name: string;
	score: number;
	/** Pieces of evidence: one per specific matched word or word pair, two per command or specific trigger phrase. */
	evidence: number;
}

/** Every skill's unfiltered score for a task, best first. */
export function scoreSkills(index: RouterIndex, task: string): RawScore[] {
	const { command, invoked, excluded, changesSkill, content } = readTask(index, task);
	const skillTerm = stem("skill");
	const query = [...new Set(terms(content))];
	const seq = words(content);
	const queryPairs = pairsOf(content);
	const out: RawScore[] = [];
	for (const d of index.docs) {
		if (excluded.has(d.name)) continue;
		let score = 0;
		let evidence = 0;
		for (const t of query) {
			const idf = index.idf.get(t);
			if (idf === undefined) continue;
			let tf = 0;
			for (const f of ["name", "what", "when"] as const) {
				const raw = d.tf[f].get(t) ?? 0;
				if (raw) tf += (WEIGHT[f] * raw) / (1 - B[f] + (B[f] * d.len[f]) / index.avg[f]);
			}
			if (tf > 0) {
				score += (idf * tf * (K1 + 1)) / (K1 + tf);
				if (index.specific.has(t)) evidence++;
			}
		}
		if (command === d.name || invoked.has(d.name)) {
			score += COMMAND_BONUS;
			evidence += 2;
		}
		// A task about changing a named skill is evidence for the skills whose job is skills.
		if (changesSkill && d.tf.what.has(skillTerm)) evidence++;
		for (const p of queryPairs) {
			if (d.pairs.has(p)) {
				score += PAIR_BONUS;
				// A pair shared by many skills ranks a skill but isn't evidence, like a common word.
				if ((index.pairIdf.get(p) ?? 0) >= EVIDENCE_IDF) evidence++;
			}
		}
		for (const p of d.phrases) {
			if (containsSequence(seq, p.seq)) {
				score += PHRASE_BONUS;
				if (p.strong) evidence += 2;
			}
		}
		out.push({ name: d.name, score, evidence });
	}
	return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Whether a raw score counts as a match: two pieces of evidence, or one that reaches the
 * single-evidence bar of the index the score came from (`index.single`: SINGLE_SCORE, or
 * SINGLE_SCORE_LARGE past 13 skills). The bar comes only from the index, so no caller can judge
 * a 32-skill score by the 13-skill bar. Common words alone never match, however many there are,
 * and one ordinary shared word ("fix the test", "a bug in my code") is a coincidence.
 */
export function isMatch(index: RouterIndex, s: RawScore): boolean {
	return s.score >= MIN_SCORE && (s.evidence >= 2 || (s.evidence >= 1 && s.score >= index.single));
}

/** Ranked matches for a task, best first; an empty list means no skill fits. */
export function matchSkills(index: RouterIndex, task: string, top = 3): SkillMatch[] {
	const byName = new Map(index.docs.map((d) => [d.name, d]));
	return scoreSkills(index, task)
		.filter((s) => isMatch(index, s))
		.slice(0, Math.max(1, top))
		.map((s) => ({ name: s.name, score: Math.round(s.score * 100) / 100, description: oneLine(byName.get(s.name)?.description ?? "") }));
}
