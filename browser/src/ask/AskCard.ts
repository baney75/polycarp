/**
 * The question card: the side panel's own agent shows it inline in the chat (src/tools/ask-user.ts)
 * and an external agent's question shows it above the chat (src/ask/bridge-panel.ts). Every piece
 * of question and answer text goes through lit text bindings, so it renders as text, never HTML.
 */

import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Check, CircleSlash, MessageCircleQuestionMark } from "lucide";
import { ASK_LIMITS, type AskOutcome, type AskQuestion, type AskSelection, type NoAnswerReason } from "./core.js";

const REASON_LABEL: Record<NoAnswerReason, string> = {
	skipped: "Skipped",
	aborted: "Stopped before an answer",
	timeout: "Timed out",
	closed: "Panel closed before an answer",
	disconnected: "Agent disconnected",
};

interface Draft {
	selected: Set<string>;
	otherOn: boolean;
	otherText: string;
}

export type AskCardMode = "preparing" | "asking" | "done";

@customElement("tabkyra-ask-card")
export class AskCard extends LitElement {
	@property({ attribute: false }) questions: AskQuestion[] = [];
	@property({ attribute: false }) mode: AskCardMode = "asking";
	/** Set in "done" mode: what came back. */
	@property({ attribute: false }) outcome?: AskOutcome;
	/** Who asks, for an external agent ("Claude Code"). The panel's own agent leaves it empty. */
	@property({ attribute: false }) agentName = "";
	/** When an external agent's question gives up (ms since epoch). */
	@property({ attribute: false }) expiresAt?: number;
	@property({ attribute: false }) onSubmit?: (selections: AskSelection[]) => void | Promise<void>;
	@property({ attribute: false }) onSkip?: () => void | Promise<void>;

	@state() private drafts: Draft[] = [];
	@state() private busy = false;
	@state() private error = "";
	@state() private now = Date.now();
	/** The questions the drafts belong to, by content: a re-render with an equal copy keeps them. */
	private draftsFor?: string;
	private ticker?: ReturnType<typeof setInterval>;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.ticker = setInterval(() => {
			if (this.expiresAt) this.now = Date.now();
		}, 1000);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		clearInterval(this.ticker);
	}

	private draft(i: number): Draft {
		const key = JSON.stringify(this.questions);
		if (this.draftsFor !== key) {
			this.draftsFor = key;
			this.drafts = this.questions.map(() => ({ selected: new Set(), otherOn: false, otherText: "" }));
		}
		return this.drafts[i];
	}

	private update1(i: number, change: (d: Draft) => void): void {
		const d = this.draft(i);
		const next: Draft = { selected: new Set(d.selected), otherOn: d.otherOn, otherText: d.otherText };
		change(next);
		this.drafts = this.drafts.map((old, j) => (j === i ? next : old));
		this.error = "";
	}

	private pick(i: number, label: string): void {
		const multi = this.questions[i].multiSelect === true;
		this.update1(i, (d) => {
			if (multi) {
				if (d.selected.has(label)) d.selected.delete(label);
				else d.selected.add(label);
			} else {
				d.selected = new Set([label]);
				d.otherOn = false;
			}
		});
	}

	private toggleOther(i: number, on: boolean): void {
		const multi = this.questions[i].multiSelect === true;
		this.update1(i, (d) => {
			d.otherOn = on;
			if (on && !multi) d.selected.clear();
		});
		if (on) requestAnimationFrame(() => this.querySelector<HTMLInputElement>(`[data-other-input="${i}"]`)?.focus());
	}

	private answered(i: number): boolean {
		const d = this.draft(i);
		return d.selected.size > 0 || (d.otherOn && d.otherText.trim().length > 0);
	}

	private selections(): AskSelection[] {
		return this.questions.map((_, i) => {
			const d = this.draft(i);
			const other = d.otherOn ? d.otherText.trim() : "";
			return other ? { selected: [...d.selected], other } : { selected: [...d.selected] };
		});
	}

	private async run(action: (() => void | Promise<void>) | undefined): Promise<void> {
		if (!action || this.busy) return;
		this.busy = true;
		try {
			await action();
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.busy = false;
		}
	}

	private renderOption(i: number, q: AskQuestion, label: string, description: string): TemplateResult {
		const d = this.draft(i);
		const checked = d.selected.has(label);
		const multi = q.multiSelect === true;
		return html`<button
			type="button"
			class="tk-ask-option"
			role=${multi ? "checkbox" : "radio"}
			aria-checked=${checked ? "true" : "false"}
			data-option=${label}
			?disabled=${this.busy}
			@click=${() => this.pick(i, label)}
		>
			<span class="tk-ask-mark ${multi ? "tk-ask-mark-box" : ""}" aria-hidden="true">
				${checked ? icon(Check, "xs") : nothing}
			</span>
			<span class="min-w-0 flex-1">
				<span class="block text-sm font-medium text-foreground break-words">${label}</span>
				${description ? html`<span class="block text-xs text-muted-foreground break-words">${description}</span>` : nothing}
			</span>
		</button>`;
	}

	private renderOther(i: number, q: AskQuestion): TemplateResult {
		const d = this.draft(i);
		const multi = q.multiSelect === true;
		return html`<div class="tk-ask-option tk-ask-other" aria-checked=${d.otherOn ? "true" : "false"}>
			<button
				type="button"
				class="tk-ask-mark ${multi ? "tk-ask-mark-box" : ""}"
				role=${multi ? "checkbox" : "radio"}
				aria-checked=${d.otherOn ? "true" : "false"}
				aria-label="Other"
				data-option="Other"
				?disabled=${this.busy}
				@click=${() => this.toggleOther(i, !d.otherOn)}
			>
				${d.otherOn ? icon(Check, "xs") : nothing}
			</button>
			${d.otherText ? html`<span class="shrink-0 text-sm text-muted-foreground" aria-hidden="true">Other:</span>` : nothing}
			<input
				type="text"
				class="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
				placeholder="Other: type your own answer"
				aria-label="Other answer"
				maxlength=${ASK_LIMITS.other}
				data-other-input=${i}
				.value=${d.otherText}
				?disabled=${this.busy}
				@input=${(e: Event) => {
					const value = (e.target as HTMLInputElement).value;
					this.update1(i, (n) => {
						n.otherText = value;
						if (value && !n.otherOn) {
							n.otherOn = true;
							if (!multi) n.selected.clear();
						}
					});
				}}
				@keydown=${(e: KeyboardEvent) => {
					if (e.key === "Enter" && !e.isComposing && this.questions.every((_, j) => this.answered(j))) {
						e.preventDefault();
						void this.run(() => this.onSubmit?.(this.selections()));
					}
				}}
			/>
		</div>`;
	}

	private renderTitle(text: string): TemplateResult {
		const remaining = this.expiresAt ? Math.max(0, Math.ceil((this.expiresAt - this.now) / 1000)) : undefined;
		return html`<div class="flex items-center gap-2 text-sm">
			<span class="tk-ask-icon" aria-hidden="true">${icon(MessageCircleQuestionMark, "sm")}</span>
			<span class="font-semibold text-foreground min-w-0 truncate">${text}</span>
			${
				remaining !== undefined && this.mode === "asking"
					? html`<span class="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" title="The question gives up after this"
							>${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}</span
						>`
					: nothing
			}
		</div>`;
	}

	private renderAsking(): TemplateResult {
		const all = this.questions.every((_, i) => this.answered(i));
		const title = this.agentName
			? `${this.agentName} asks`
			: this.questions.length > 1
				? "A few questions"
				: "A question for you";
		return html`<section class="tk-ask-card" role="group" aria-label=${title} data-testid="ask-card" data-state="asking">
			${this.renderTitle(title)}
			${this.questions.map(
				(q, i) => html`<fieldset class="mt-3 min-w-0" data-question=${i}>
					<legend class="contents">
						<span class="tk-ask-chip">${q.header}</span>
						<span class="mt-1.5 block text-sm text-foreground break-words">${q.question}</span>
					</legend>
					${q.multiSelect ? html`<span class="block text-xs text-muted-foreground mt-0.5">Pick any that apply</span>` : nothing}
					<div class="mt-2 flex flex-col gap-1.5" role=${q.multiSelect ? "group" : "radiogroup"}>
						${q.options.map((o) => this.renderOption(i, q, o.label, o.description))} ${this.renderOther(i, q)}
					</div>
				</fieldset>`,
			)}
			${this.error ? html`<p class="mt-2 text-xs text-destructive" role="alert">${this.error}</p>` : nothing}
			<div class="mt-3 flex items-center justify-end gap-2">
				<button
					type="button"
					class="tk-ask-btn tk-ask-btn-ghost"
					data-action="skip"
					?disabled=${this.busy}
					@click=${() => this.run(this.onSkip)}
				>
					Skip
				</button>
				<button
					type="button"
					class="tk-ask-btn tk-ask-btn-primary"
					data-action="submit"
					?disabled=${!all || this.busy}
					@click=${() => this.run(() => this.onSubmit?.(this.selections()))}
				>
					Submit
				</button>
			</div>
		</section>`;
	}

	private renderDone(): TemplateResult {
		const o = this.outcome;
		const questions = o?.questions ?? this.questions;
		const answered = o?.status === "answered";
		const title = this.agentName
			? `${this.agentName} asked`
			: answered
				? "You answered"
				: questions.length > 1
					? "Questions"
					: "Question";
		return html`<section
			class="tk-ask-card tk-ask-done"
			data-testid="ask-card"
			data-state=${answered ? "answered" : "no-answer"}
		>
			${this.renderTitle(title)}
			${questions.map((q, i) => {
				const s = answered ? o.selections[i] : undefined;
				return html`<div class="mt-2.5 min-w-0">
					<span class="tk-ask-chip">${q.header}</span>
					<span class="mt-1 block text-sm text-muted-foreground break-words">${q.question}</span>
					${
						s
							? html`<div class="mt-1 flex flex-wrap gap-1.5" data-answer=${i}>
									${s.selected.map((label) => html`<span class="tk-ask-answer">${icon(Check, "xs")}<span>${label}</span></span>`)}
									${s.other ? html`<span class="tk-ask-answer"><span class="text-muted-foreground">Other:</span><span>${s.other}</span></span>` : nothing}
								</div>`
							: nothing
					}
				</div>`;
			})}
			${
				o?.status === "no_answer"
					? html`<div class="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground" data-no-answer=${o.reason}>
							${icon(CircleSlash, "xs")}<span>No answer: ${REASON_LABEL[o.reason]}</span>
						</div>`
					: nothing
			}
		</section>`;
	}

	protected override render(): TemplateResult {
		if (this.mode === "preparing") {
			return html`<section class="tk-ask-card" data-testid="ask-card" data-state="preparing">
				${this.renderTitle("Preparing a question...")}
			</section>`;
		}
		return this.mode === "done" ? this.renderDone() : this.renderAsking();
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"tabkyra-ask-card": AskCard;
	}
}
