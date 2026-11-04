import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";

/**
 * One settings tab made of several, one after the other: fewer tabs to scan in a narrow
 * panel, and related settings in one place (Privacy and the network proxy; About and updates).
 * Each part keeps its own element and state.
 */
export class CombinedTab extends SettingsTab {
	constructor(
		private readonly name: string,
		private readonly parts: Array<{ tab: SettingsTab; heading?: string }>,
	) {
		super();
	}

	getTabName(): string {
		return this.name;
	}

	render(): TemplateResult {
		return html`<div class="flex flex-col">
			${this.parts.map(
				(part, i) => html`<section class="${i > 0 ? "mt-6 pt-6 border-t border-border" : ""}">
					${part.heading ? html`<h3 class="text-sm font-semibold text-foreground mb-2">${part.heading}</h3>` : nothing}
					${part.tab}
				</section>`,
			)}
		</div>`;
	}
}

if (!customElements.get("tabkyra-combined-tab")) {
	customElements.define("tabkyra-combined-tab", CombinedTab);
}
