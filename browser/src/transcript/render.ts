/**
 * Draws the grouped transcript (group.ts) through pi-web-ui's transcript hook: the agent's text
 * stays full size, and the work between texts is one compact list of rows. A row expands to
 * the full tool card, the reasoning behind it and its usage.
 */
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { renderMessage, type TranscriptContext, type TranscriptRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { Brain, Check, ChevronRight, CircleAlert, Code, FileText, Globe, Loader2, Sparkles } from "lucide";
import { SkillPill } from "../components/SkillPill.js";
import { getTabkyraStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { escapeCurrency } from "./currency.js";
import {
	type Block,
	callInFlight,
	currentRunAssistant,
	FULL_CARD_TOOLS,
	groupTranscript,
	type Step,
	stepLabel,
	stepRows,
	stepState,
	type TMessage,
	type TToolCall,
	usageText,
} from "./group.js";

/** The page's own favicon from the tab; no third-party favicon service ever sees the host. */
function faviconFor(_url: string | undefined, favicon?: string): string | undefined {
	return favicon && /^(https?:|data:image\/)/.test(favicon) ? favicon : undefined;
}

const statusIcon = (s: "running" | "done" | "error") =>
	s === "running"
		? html`<span class="inline-flex text-muted-foreground animate-spin" aria-label="Running">${icon(Loader2, "xs")}</span>`
		: s === "error"
			? html`<span class="inline-flex text-destructive" aria-label="Failed">${icon(CircleAlert, "xs")}</span>`
			: html`<span class="inline-flex text-green-600 dark:text-green-500" aria-label="Done">${icon(Check, "xs")}</span>`;

/** Site skills for a page the agent landed on by itself (a navigation message). */
@customElement("tk-site-skills")
export class SiteSkills extends LitElement {
	@property() url = "";
	@state() private skills: Skill[] = [];

	protected override createRenderRoot() {
		return this;
	}

	/** Load on every URL change (a row can be reused for another page); a stale answer is dropped. */
	override willUpdate(changed: Map<string, unknown>) {
		if (!changed.has("url")) return;
		const url = this.url;
		this.skills = [];
		if (!url) return;
		void getTabkyraStorage()
			.skills.getSkillsForUrl(url)
			.then((skills) => {
				if (this.url === url) this.skills = skills;
			})
			.catch(() => undefined);
	}

	override render() {
		if (this.skills.length === 0) return nothing;
		return html`<div class="flex flex-wrap gap-1.5 pl-6 py-1">${this.skills.map((s) => SkillPill(s, true))}</div>`;
	}
}

@customElement("tk-steps")
export class StepList extends LitElement {
	@property({ attribute: false }) steps: Step[] = [];
	@property({ attribute: false }) tools: AgentTool[] = [];
	@property({ attribute: false }) pending?: Set<string>;
	@property({ type: Boolean }) running = false;
	/** The list belongs to the message still streaming (see callInFlight). */
	@property({ type: Boolean }) streaming = false;
	/** The transcript's last assistant message: its calls may still be about to run. */
	@property({ attribute: false }) lastAssistant?: TMessage;
	@state() private open = new Set<string>();
	@state() private showAll = false;

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private toggle(key: string) {
		const next = new Set(this.open);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		this.open = next;
	}

	private row(
		key: string,
		parts: { lead: TemplateResult | typeof nothing; label: string; detail?: string; title?: string; usage?: string },
		body: () => TemplateResult | typeof nothing,
	) {
		const expanded = this.open.has(key);
		return html`
			<li class="group">
				<button
					type="button"
					class="w-full flex items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
					aria-expanded=${expanded ? "true" : "false"}
					title=${[parts.title ?? parts.label, parts.usage].filter(Boolean).join("\n")}
					@click=${() => this.toggle(key)}
				>
					<span class="inline-flex shrink-0 transition-transform ${expanded ? "rotate-90" : ""}">${icon(ChevronRight, "xs")}</span>
					${parts.lead}
					<span class="truncate min-w-0">${parts.label}</span>
					${parts.detail ? html`<span class="shrink-0 text-xs">${parts.detail}</span>` : nothing}
				</button>
				${expanded ? html`<div class="pl-6 pr-1 pb-2 pt-1 flex flex-col gap-2">${body()}</div>` : nothing}
			</li>
		`;
	}

	private thinkingBody(thinking: string | undefined) {
		return thinking
			? html`<div class="text-xs text-muted-foreground border-l-2 border-border pl-2">
					<markdown-block .content=${thinking} .isThinking=${true}></markdown-block>
				</div>`
			: nothing;
	}

	private toolCard(step: Extract<Step, { kind: "tool" }>) {
		const tool = this.tools.find((t) => t.name === step.call.name);
		const aborted = step.message.stopReason === "aborted" && !step.result;
		return html`<tool-message
			.tool=${tool}
			.toolCall=${step.call}
			.result=${step.result as ToolResultMessage | undefined}
			.pending=${this.pending?.has(step.call.id) ?? false}
			.aborted=${aborted}
			.isStreaming=${callInFlight(step, {
				live: this.streaming,
				running: this.running,
				pending: this.pending?.has(step.call.id) ?? false,
				lastAssistant: this.lastAssistant,
			})}
		></tool-message>`;
	}

	private renderStep(step: Step): TemplateResult {
		if (step.kind === "thought") {
			const first = step.thinking.split("\n")[0];
			return this.row(
				step.key,
				{
					lead: html`<span class="inline-flex shrink-0">${icon(Brain, "xs")}</span>`,
					label: first.length > 80 ? `${first.slice(0, 79)}…` : first,
					title: "Reasoning",
					usage: usageText(step.usage),
				},
				() => html`${this.thinkingBody(step.thinking)}${usageLine(step.usage)}`,
			);
		}
		if (step.kind === "nav") {
			const nav = step.message as TMessage & { title?: string; favicon?: string };
			const fav = faviconFor(nav.url, nav.favicon);
			return html`
				${this.row(
					step.key,
					{
						lead: fav
							? html`<img src=${fav} alt="" class="w-3.5 h-3.5 shrink-0" @error=${hideImg} />`
							: html`<span class="inline-flex shrink-0">${icon(Globe, "xs")}</span>`,
						label: nav.title || nav.url || "Page changed",
						title: nav.url,
					},
					() =>
						html`<a class="text-xs underline break-all" href=${nav.url ?? ""} target="_blank" rel="noopener">${nav.url}</a>`,
				)}
				${step.showSkills && nav.url ? html`<tk-site-skills .url=${nav.url}></tk-site-skills>` : nothing}
			`;
		}
		// Output cards (artifacts) stay whole: the card is how the user opens what was made.
		if (FULL_CARD_TOOLS.has(step.call.name)) return html`<li class="py-1">${this.toolCard(step)}</li>`;

		const state = stepState(step, this.running);
		const { label, detail } = stepLabel(step.call as TToolCall, step.result);
		const details = (step.result?.details ?? {}) as {
			favicon?: string;
			finalUrl?: string;
			skills?: Array<{ fullDetails?: Skill; name: string }>;
		};
		const isNav = step.call.name === "navigate" && !!details.finalUrl;
		const fav = isNav ? faviconFor(details.finalUrl, details.favicon) : undefined;
		const lead = html`${statusIcon(state)}${
			fav
				? html`<img src=${fav} alt="" class="w-3.5 h-3.5 shrink-0" @error=${hideImg} />`
				: html`<span class="inline-flex shrink-0">${icon(step.call.name === "navigate" ? Globe : step.call.name === "skill" ? Sparkles : step.call.name.startsWith("extract") ? FileText : Code, "xs")}</span>`
		}`;
		const skills = step.showSkills ? (details.skills ?? []).map((s) => s.fullDetails ?? s.name) : [];
		return html`
			${this.row(
				step.key,
				{ lead, label, detail, usage: usageText(step.usage) },
				() => html`
				${this.thinkingBody(step.thinking)}
				${this.toolCard(step)}
				${usageLine(step.usage)}
			`,
			)}
			${skills.length ? html`<li class="flex flex-wrap gap-1.5 pl-6 py-1">${skills.map((s) => SkillPill(s, true))}</li>` : nothing}
		`;
	}

	override render() {
		return html`
			<ul class="mx-4 flex flex-col border-l border-border pl-1.5" aria-label="Agent steps">
				${repeat(
					stepRows(this.steps, this.showAll),
					(r) => (r.kind === "step" ? r.step.key : r.key),
					(r) =>
						r.kind === "step"
							? this.renderStep(r.step)
							: html`<li>
									<button
										type="button"
										class="w-full text-left rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
										@click=${() => {
											this.showAll = true;
										}}
									>
										${r.count} earlier ${r.count === 1 ? "step" : "steps"}
									</button>
								</li>`,
				)}
			</ul>
		`;
	}
}

/** Per-step usage: in the expanded row (and the row's tooltip), never as its own line in the log. */
function usageLine(usage: Parameters<typeof usageText>[0]) {
	return usage ? html`<div class="text-[11px] text-muted-foreground tabular-nums">${usageText(usage)}</div>` : nothing;
}

function hideImg(e: Event) {
	(e.target as HTMLImageElement).style.display = "none";
}

/** The agent's own words, full size. Its step usage is a tooltip; the run total stays below the composer. */
function textBlock(text: string, usage?: string): TemplateResult {
	return html`<div class="px-4" title=${usage || nothing}>
		<markdown-block .content=${escapeCurrency(text)}></markdown-block>
	</div>`;
}

function renderBlock(
	block: Block,
	ctx: TranscriptContext,
	live = false,
	lastAssistant?: TMessage,
): TemplateResult | undefined {
	switch (block.kind) {
		case "message": {
			const m = block.message as AgentMessage;
			const custom = renderMessage(m);
			if (custom) return custom;
			if (m.role === "user" || m.role === "user-with-attachments")
				return html`<user-message .message=${m}></user-message>`;
			return undefined;
		}
		case "text":
			return textBlock(block.text, usageText(block.usage));
		case "steps":
			return html`<tk-steps
				.steps=${block.steps}
				.tools=${ctx.tools}
				.pending=${ctx.pendingToolCalls}
				.running=${ctx.isStreaming}
				.streaming=${live}
				.lastAssistant=${lastAssistant}
			></tk-steps>`;
		case "status":
			return block.status === "error"
				? html`<div class="mx-4 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden" role="alert">
						<strong>Error:</strong> ${block.text ?? "The request failed."}
					</div>`
				: html`<div class="mx-4 text-sm text-destructive italic">Request aborted</div>`;
	}
}

/** The transcript renderer Tabkyra installs with setTranscriptRenderer. */
/** The site of the last page change in the stable list, so the live message continues the count. */
let stableLastSite: string | undefined;

export const tabkyraTranscript: TranscriptRenderer = {
	items(messages, ctx) {
		const { blocks, lastSite } = groupTranscript(messages as unknown as TMessage[], {
			results: ctx.toolResultsById as unknown as Map<string, TMessage>,
		});
		stableLastSite = lastSite;
		const items: Array<{ key: string; template: TemplateResult }> = [];
		const lastAssistant = currentRunAssistant(messages as unknown as TMessage[]);
		for (const b of blocks) {
			const template = renderBlock(b, ctx, false, lastAssistant);
			if (template) items.push({ key: b.key, template });
		}
		return items;
	},
	live(message: AssistantMessage, ctx) {
		const { blocks } = groupTranscript([message as unknown as TMessage], {
			results: ctx.toolResultsById as unknown as Map<string, TMessage>,
			lastSite: stableLastSite,
		});
		const content = Array.isArray(message.content) ? message.content : [];
		const reasoningOnly = content.length > 0 && content.every((c) => c.type === "thinking");
		const parts = blocks
			.filter((b) => b.kind !== "status")
			.map((b) =>
				b.kind === "steps"
					? renderBlock({ ...b, steps: b.steps.filter((s) => s.kind !== "thought") }, ctx, true)
					: renderBlock(b, ctx, true),
			);
		return html`<div class="flex flex-col gap-3 mb-3">
			${parts}
			${
				reasoningOnly || content.length === 0
					? html`<div class="mx-4 text-[13px] text-muted-foreground animate-pulse" aria-live="polite">Thinking…</div>`
					: html`<span class="mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse"></span>`
			}
		</div>`;
	},
};
