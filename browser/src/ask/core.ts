/**
 * ask_user: an agent asks the user one to four multiple-choice questions and waits for the
 * answer. Shared by the side panel tool (src/tools/ask-user.ts), the bridge in the service
 * worker (src/ask/bridge-worker.ts) and the MCP server (cli/src/ask.ts), which imports this
 * file directly. No imports, no chrome.*: tests and the CLI load it as plain TypeScript.
 *
 * Question and answer text is always data. It renders as text, never HTML, and the answer goes
 * back only to the agent that asked.
 */

export const ASK_LIMITS = {
	minQuestions: 1,
	maxQuestions: 4,
	minOptions: 2,
	maxOptions: 4,
	header: 24,
	question: 500,
	label: 60,
	description: 200,
	other: 2000,
} as const;

/** How long a bridge question waits for the user before it returns a no-answer result. */
export const ASK_BRIDGE_TIMEOUT_MS = 5 * 60 * 1000;

export interface AskOption {
	label: string;
	description: string;
}

export interface AskQuestion {
	/** A short chip label, e.g. "Format". */
	header: string;
	question: string;
	options: AskOption[];
	/** The user may pick more than one option. */
	multiSelect?: boolean;
}

export interface AskParams {
	questions: AskQuestion[];
}

/** What the user picked for one question: option labels, and the "Other" text if they typed one. */
export interface AskSelection {
	selected: string[];
	other?: string;
}

export type NoAnswerReason = "skipped" | "aborted" | "timeout" | "closed" | "disconnected";

export interface AskAnswered {
	status: "answered";
	/** Question text -> answer text ("PDF", "Intro, Methods", "Other: ..."). */
	answers: Record<string, string>;
	selections: AskSelection[];
	questions: AskQuestion[];
}

export interface AskNoAnswer {
	status: "no_answer";
	reason: NoAnswerReason;
	questions: AskQuestion[];
}

export type AskOutcome = AskAnswered | AskNoAnswer;

/** "Other" is the free-text choice every question gets; an option may not take its name. */
export const OTHER_LABEL = "Other";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, field: string, max: number, allowEmpty = false): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const trimmed = value.trim();
	if (!allowEmpty && !trimmed) throw new Error(`${field} must not be empty`);
	if (trimmed.length > max) throw new Error(`${field} is longer than ${max} characters`);
	return trimmed;
}

/**
 * Check and normalize ask_user arguments. Throws an Error whose message tells the model what to
 * fix. Returns a fresh copy holding only the known fields, trimmed.
 */
export function validateAskParams(input: unknown): AskParams {
	if (!isRecord(input)) throw new Error("ask_user takes an object with a questions array");
	const raw = input.questions;
	if (!Array.isArray(raw)) throw new Error("questions must be an array");
	if (raw.length < ASK_LIMITS.minQuestions || raw.length > ASK_LIMITS.maxQuestions)
		throw new Error(`Ask ${ASK_LIMITS.minQuestions} to ${ASK_LIMITS.maxQuestions} questions (got ${raw.length})`);
	const seenQuestions = new Set<string>();
	const questions = raw.map((q, i): AskQuestion => {
		const at = `questions[${i}]`;
		if (!isRecord(q)) throw new Error(`${at} must be an object`);
		const header = str(q.header, `${at}.header`, ASK_LIMITS.header);
		const question = str(q.question, `${at}.question`, ASK_LIMITS.question);
		if (seenQuestions.has(question)) throw new Error(`${at}.question repeats an earlier question`);
		seenQuestions.add(question);
		if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")
			throw new Error(`${at}.multiSelect must be true or false`);
		if (!Array.isArray(q.options)) throw new Error(`${at}.options must be an array`);
		if (q.options.length < ASK_LIMITS.minOptions || q.options.length > ASK_LIMITS.maxOptions)
			throw new Error(
				`${at} needs ${ASK_LIMITS.minOptions} to ${ASK_LIMITS.maxOptions} options (got ${q.options.length}); the user can always type "Other"`,
			);
		const seenLabels = new Set<string>();
		const options = q.options.map((o, j): AskOption => {
			const oat = `${at}.options[${j}]`;
			if (!isRecord(o)) throw new Error(`${oat} must be an object with label and description`);
			const label = str(o.label, `${oat}.label`, ASK_LIMITS.label);
			if (label.toLowerCase() === OTHER_LABEL.toLowerCase())
				throw new Error(`${oat}.label: "Other" is added automatically; leave it out`);
			if (seenLabels.has(label)) throw new Error(`${oat}.label repeats an earlier option`);
			seenLabels.add(label);
			const description =
				o.description === undefined ? "" : str(o.description, `${oat}.description`, ASK_LIMITS.description, true);
			return { label, description };
		});
		return { header, question, options, multiSelect: q.multiSelect === true };
	});
	return { questions };
}

/**
 * Check what the user picked against the questions asked, and map it question -> answer.
 * Throws when a selection names an option the question doesn't have, picks two on a
 * single-choice question, or leaves a question unanswered.
 */
export function buildAnswer(questions: AskQuestion[], input: unknown): AskAnswered {
	if (!Array.isArray(input) || input.length !== questions.length)
		throw new Error("One selection per question is required");
	const selections: AskSelection[] = [];
	const answers: Record<string, string> = {};
	questions.forEach((q, i) => {
		const s = input[i];
		if (!isRecord(s) || !Array.isArray(s.selected)) throw new Error(`Selection ${i + 1} is malformed`);
		const labels = new Set(q.options.map((o) => o.label));
		const selected: string[] = [];
		for (const label of s.selected) {
			if (typeof label !== "string" || !labels.has(label))
				throw new Error(`Selection ${i + 1} names an unknown option`);
			if (!selected.includes(label)) selected.push(label);
		}
		// Keep the order the options were offered in, not the order they were clicked.
		selected.sort((a, b) => q.options.findIndex((o) => o.label === a) - q.options.findIndex((o) => o.label === b));
		const other =
			s.other === undefined || s.other === null
				? ""
				: str(s.other, `Selection ${i + 1} Other`, ASK_LIMITS.other, true);
		const picks = selected.length + (other ? 1 : 0);
		if (picks === 0) throw new Error(`Question ${i + 1} has no answer`);
		if (!q.multiSelect && picks > 1) throw new Error(`Question ${i + 1} takes one answer`);
		selections.push(other ? { selected, other } : { selected });
		const parts = [...selected];
		if (other) parts.push(`Other: ${other}`);
		answers[q.question] = parts.join(", ");
	});
	return { status: "answered", answers, selections, questions };
}

const REASON_TEXT: Record<NoAnswerReason, string> = {
	skipped: "the user skipped the question",
	aborted: "the user stopped the run before answering",
	timeout: "no answer came before the question timed out",
	closed: "the side panel was closed or reloaded before an answer",
	disconnected: "the connection to the browser closed before an answer",
};

export function noAnswer(questions: AskQuestion[], reason: NoAnswerReason): AskNoAnswer {
	return { status: "no_answer", reason, questions };
}

/** The tool result text the model reads. */
export function outcomeText(outcome: AskOutcome): string {
	if (outcome.status === "no_answer") {
		return (
			`No answer: ${REASON_TEXT[outcome.reason]}. Do not assume an answer or pick one yourself. ` +
			"Continue only with work that doesn't depend on it, or tell the user what you need to know and stop."
		);
	}
	const lines = Object.entries(outcome.answers).map(([q, a]) => `${JSON.stringify(q)} = ${JSON.stringify(a)}`);
	return `The user answered:\n${lines.join("\n")}\nAct on these answers. Text after "Other:" is what the user typed.`;
}

/** A display name for a bridge client ("claude" -> "Claude Code"). Plain text; never HTML. */
export function agentDisplayName(clientName: string): string {
	const known: Record<string, string> = {
		claude: "Claude Code",
		codex: "Codex",
		omp: "omp",
		pi: "pi",
		mcp: "An MCP agent",
	};
	const name = clientName.trim().slice(0, 40);
	return known[name.toLowerCase()] ?? (name || "An agent");
}

export const ASK_USER_DESCRIPTION =
	"Ask the user 1 to 4 multiple-choice questions and wait for the answer. Use it only when the answer changes what you do next " +
	"and you can't find it yourself: an ambiguous request, a choice between real alternatives, or a preference only the user knows. " +
	"Don't use it for routine confirmations, for progress updates, or to ask permission for something the user already asked for. " +
	"Each question has a short header (a few words), the question, 2 to 4 options (label and a one-line description) and multiSelect. " +
	'The user can always type an "Other" answer, so don\'t add an Other option. Put a recommended option first and end its label with "(Recommended)". ' +
	"The result maps each question to the answer. If it says \"No answer\", don't guess: continue only with work that doesn't depend on it, or stop and say what you need.";
