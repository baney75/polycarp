/**
 * ask_user for the side panel's own agent: shows a question card in the chat and returns the
 * user's answer as the tool result. The card answers through src/ask/pending.ts.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../ask/AskCard.js";
import {
	ASK_LIMITS,
	ASK_USER_DESCRIPTION,
	type AskOutcome,
	type AskQuestion,
	noAnswer,
	outcomeText,
	validateAskParams,
} from "../ask/core.js";
import { answerWaiting, isWaiting, onPendingChange, skipWaiting, waitForAnswer, wasAskedHere } from "../ask/pending.js";

const askUserSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			header: Type.String({ description: 'A short label for the question, a few words, e.g. "Format"' }),
			question: Type.String({ description: "The question, as a full sentence" }),
			options: Type.Array(
				Type.Object({
					label: Type.String({
						description: 'The choice, 1 to 5 words. Add "(Recommended)" to the one you recommend',
					}),
					description: Type.String({ description: "One line on what this choice means or leads to" }),
				}),
				{ minItems: ASK_LIMITS.minOptions, maxItems: ASK_LIMITS.maxOptions },
			),
			multiSelect: Type.Optional(Type.Boolean({ description: "true lets the user pick more than one option" })),
		}),
		{ minItems: ASK_LIMITS.minQuestions, maxItems: ASK_LIMITS.maxQuestions },
	),
});

export type AskUserParams = Static<typeof askUserSchema>;

export class AskUserTool implements AgentTool<typeof askUserSchema, AskOutcome> {
	label = "Ask User";
	name = "ask_user";
	description = ASK_USER_DESCRIPTION;
	parameters = askUserSchema;

	async execute(
		toolCallId: string,
		args: AskUserParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: AskOutcome }> {
		// Throws with a message the model can act on; the loop turns it into an error result.
		const { questions } = validateAskParams(args);
		const outcome = await waitForAnswer(toolCallId, questions, signal);
		return { content: [{ type: "text", text: outcomeText(outcome) }], details: outcome };
	}
}

/** The arguments as far as they are valid; undefined while they still stream in or are wrong. */
function questionsOf(params: unknown): AskQuestion[] | undefined {
	try {
		return validateAskParams(params).questions;
	} catch {
		return undefined;
	}
}

/**
 * The live card for a call without a result. It reads the tool call id from the enclosing
 * <tool-message> (pi-web-ui renderers don't get it), so it answers exactly that call.
 */
@customElement("tabkyra-ask-tool-card")
export class AskToolCard extends LitElement {
	@property({ attribute: false }) params: unknown;
	@property({ attribute: false }) streaming = false;
	private unsubscribe?: () => void;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.unsubscribe = onPendingChange(() => this.requestUpdate());
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.unsubscribe?.();
	}

	private get toolCallId(): string | undefined {
		const host = this.closest("tool-message") as (Element & { toolCall?: { id?: string } }) | null;
		return host?.toolCall?.id;
	}

	protected override render(): TemplateResult {
		const questions = questionsOf(this.params);
		const id = this.toolCallId;
		if (id && questions && isWaiting(id)) {
			return html`<tabkyra-ask-card
				.questions=${questions}
				.mode=${"asking"}
				.onSubmit=${(selections: unknown) => answerWaiting(id, selections)}
				.onSkip=${() => skipWaiting(id)}
			></tabkyra-ask-card>`;
		}
		// Answered here and the result is on its way, or still streaming: not a cut-off question.
		if (this.streaming || !questions || (id !== undefined && wasAskedHere(id))) {
			return html`<tabkyra-ask-card .questions=${[]} .mode=${"preparing"}></tabkyra-ask-card>`;
		}
		// No result and nobody waiting: the panel was closed or reloaded while the question was open.
		return html`<tabkyra-ask-card .mode=${"done"} .outcome=${noAnswer(questions, "closed")}></tabkyra-ask-card>`;
	}
}

function isOutcome(value: unknown): value is AskOutcome {
	const v = value as { status?: unknown; questions?: unknown } | undefined;
	return (v?.status === "answered" || v?.status === "no_answer") && Array.isArray(v.questions);
}

export const askUserRenderer: ToolRenderer<AskUserParams, AskOutcome> = {
	render(
		params: AskUserParams | undefined,
		result: ToolResultMessage<AskOutcome> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		let content: TemplateResult;
		if (result && isOutcome(result.details)) {
			content = html`<tabkyra-ask-card .mode=${"done"} .outcome=${result.details}></tabkyra-ask-card>`;
		} else if (result) {
			// An error result: the arguments were refused, or the run was stopped before the tool ran.
			const questions = questionsOf(params);
			const message = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			content =
				questions && !message
					? html`<tabkyra-ask-card .mode=${"done"} .outcome=${noAnswer(questions, "aborted")}></tabkyra-ask-card>`
					: html`<div class="tk-ask-card tk-ask-done text-sm text-muted-foreground" data-testid="ask-card" data-state="error">
							Question not asked: ${message || "the run stopped"}
						</div>`;
		} else {
			content = html`<tabkyra-ask-tool-card .params=${params} .streaming=${isStreaming === true}></tabkyra-ask-tool-card>`;
		}
		return { content: html`<div class="my-2">${content}</div>`, isCustom: true };
	},
};

registerToolRenderer("ask_user", askUserRenderer);
