/**
 * The composer's context meter: how full the model's window is for the next request (models/compactor.ts), as a small
 * ring with the percent. Pressing it summarizes the earlier messages now.
 */
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Meter } from "../models/compactor.js";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** The meter's words, also its accessible name. */
export function meterLabel(meter: Meter, busy = false): string {
	if (busy) return "Summarizing the earlier messages";
	return `Context: about ${fmt(meter.used)} of ${fmt(meter.window)} tokens (${meter.percent}%). Earlier messages are summarized past ${fmt(meter.threshold)}. Press to summarize them now.`;
}

@customElement("tabkyra-context-meter")
export class ContextMeter extends LitElement {
	@property({ attribute: false }) meter?: Meter;
	/** Set while a run is going: the button waits for it. */
	@property({ type: Boolean }) running = false;
	@property({ attribute: false }) onCompact?: () => Promise<void>;
	@state() private busy = false;

	protected createRenderRoot() {
		return this;
	}

	private async press() {
		if (this.busy || this.running || !this.onCompact) return;
		this.busy = true;
		try {
			await this.onCompact();
		} finally {
			this.busy = false;
		}
	}

	override render(): TemplateResult | typeof nothing {
		const m = this.meter;
		if (!m) return nothing;
		const share = Math.min(1, m.used / m.window);
		const near = m.used >= m.threshold;
		const r = 7;
		const length = 2 * Math.PI * r;
		const label = meterLabel(m, this.busy);
		return html`<button
			type="button"
			data-context-meter
			class="h-8 px-1.5 inline-flex items-center gap-1 rounded-md text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:cursor-wait hover:bg-accent ${
				near ? "text-destructive" : "text-muted-foreground"
			}"
			aria-label=${label}
			title=${label}
			?disabled=${this.busy || this.running}
			@click=${() => this.press()}
		>
			<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" class=${this.busy ? "animate-spin" : ""}>
				<circle cx="9" cy="9" r=${r} fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2.5"></circle>
				<circle
					cx="9"
					cy="9"
					r=${r}
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-dasharray=${`${(this.busy ? 0.25 : share) * length} ${length}`}
					transform="rotate(-90 9 9)"
				></circle>
			</svg>
			<span>${m.percent}%</span>
		</button>`;
	}
}
