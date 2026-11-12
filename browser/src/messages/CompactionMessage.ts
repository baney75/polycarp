/**
 * The transcript's quiet line where earlier messages were summarized (models/compaction.ts): it opens to the notes the
 * model now works from. The messages themselves stay above it, stored and exported in full.
 */
import { type MessageRenderer, registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { CompactionMessage } from "../models/compaction.js";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

@customElement("compaction-marker")
export class CompactionMarker extends LitElement {
	@property({ attribute: false }) record!: CompactionMessage;

	protected createRenderRoot() {
		return this;
	}

	override render(): TemplateResult {
		const r = this.record;
		const what = `${fmt(r.cut)} earlier message${r.cut === 1 ? "" : "s"}, about ${fmt(r.tokensBefore)} to ${fmt(r.tokensAfter)} tokens`;
		return html`<details class="mx-4 my-2 text-xs text-muted-foreground" data-compaction>
			<summary class="flex items-center gap-2 cursor-pointer select-none list-none outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
				<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
				<span title=${what}>Earlier messages summarized</span>
				<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
			</summary>
			<div class="mt-2 rounded-md border border-border bg-card p-3 text-card-foreground">
				<p class="mb-2 text-muted-foreground">
					The model now sees these notes in place of ${what}. Everything above stays saved in this chat.
				</p>
				<div class="whitespace-pre-wrap break-words leading-relaxed">${r.summary}</div>
			</div>
		</details>`;
	}
}

const compactionRenderer: MessageRenderer<CompactionMessage> = {
	render: (message) => html`<compaction-marker .record=${message}></compaction-marker>`,
};

export function registerCompactionRenderer() {
	registerMessageRenderer("compaction", compactionRenderer);
}
