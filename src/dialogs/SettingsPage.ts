import { i18n } from "@mariozechner/mini-lit";
import type { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { PageBase } from "../components/PageBase.js";

/**
 * Settings as a page that fills the side panel, with a back arrow. Its tabs are chips that all
 * fit the panel's width: an even grid (two rows of equal columns) until one row fits, so no tab
 * is hidden off the edge or left alone on a line.
 */
export class SettingsPage extends PageBase {
	private tabs: SettingsTab[] = [];
	private active = 0;

	/** The open Settings page, or a new one with these tabs. */
	static open(tabs: SettingsTab[]): SettingsPage {
		const current = document.querySelector<SettingsPage>("tabkyra-settings");
		if (current) return current;
		const page = new SettingsPage();
		page.tabs = tabs;
		page.open();
		return page;
	}

	/** Show the tab with this name, and scroll to the element with `anchor` inside it when given. */
	showTab(name: string, anchor?: string): void {
		const index = this.tabs.findIndex((tab) => tab.getTabName() === name);
		if (index < 0) return;
		this.select(index);
		if (!anchor) return;
		// The tab's content renders after it is shown; look for the anchor once it has.
		void this.updateComplete.then(() =>
			requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" })),
		);
	}

	protected pageTitle(): string {
		return i18n("Settings");
	}

	private select(index: number) {
		this.active = index;
		this.requestUpdate();
		this.querySelector(".tk-page-body")?.scrollTo(0, 0);
		// A chip scrolled out of a narrow strip comes back into view.
		void this.updateComplete.then(() =>
			this.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({
				block: "nearest",
				inline: "nearest",
			}),
		);
	}

	private renderTab(tab: SettingsTab, index: number): TemplateResult {
		const selected = this.active === index;
		return html`
			<button
				type="button"
				role="tab"
				aria-selected=${selected ? "true" : "false"}
				class="min-w-0 truncate whitespace-nowrap h-8 px-1.5 @[28rem]:px-3 rounded-full text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
					selected
						? "bg-secondary text-foreground"
						: "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
				}"
				@click=${() => this.select(index)}
			>
				${tab.getTabName()}
			</button>
		`;
	}

	protected override fillsHeight = true;

	protected renderContent(): TemplateResult {
		const columns = this.tabs.length > 3 ? Math.ceil(this.tabs.length / 2) : this.tabs.length;
		return html`
			<div class="@container flex-shrink-0 border-b border-border px-3 py-2">
				<div
					role="tablist"
					aria-label="Settings sections"
					class="grid gap-1 @[28rem]:flex @[28rem]:flex-wrap"
					style="grid-template-columns: repeat(${columns}, minmax(0, 1fr))"
				>
					${this.tabs.map((tab, index) => this.renderTab(tab, index))}
				</div>
			</div>
			<div class="tk-page-body min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto max-w-2xl px-4 py-5">
					${this.tabs.map(
						(tab, index) => html`<div role="tabpanel" ?hidden=${this.active !== index}>${tab}</div>`,
					)}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("tabkyra-settings")) customElements.define("tabkyra-settings", SettingsPage);
