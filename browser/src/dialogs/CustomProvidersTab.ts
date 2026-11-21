import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { type CustomProvider, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { Toast } from "../components/Toast.js";
import { getTabkyraStorage } from "../storage/app-storage.js";
import { syncCustomProviderCorsRules } from "../utils/custom-provider-cors.js";
import { CustomProviderEditDialog } from "./CustomProviderEditDialog.js";

/**
 * Settings tab for managing custom (BYO base URL + key) providers.
 * Models defined here show up in the model selector alongside the built-in providers.
 */
export class CustomProvidersTab extends SettingsTab {
	private providers: CustomProvider[] = [];

	getTabName(): string {
		return "Custom Providers";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadProviders();
	}

	private async loadProviders() {
		try {
			this.providers = await getTabkyraStorage().customProviders.getAll();
			this.requestUpdate();
		} catch (error) {
			console.error("Failed to load custom providers:", error);
		}
	}

	private add() {
		CustomProviderEditDialog.open(undefined, () => this.loadProviders());
	}

	private edit(provider: CustomProvider) {
		CustomProviderEditDialog.open(provider, () => this.loadProviders());
	}

	private async removeProvider(provider: CustomProvider) {
		if (!confirm(`Delete custom provider "${provider.name}"?`)) return;
		try {
			const storage = getTabkyraStorage();
			await storage.customProviders.delete(provider.id);
			// Remove the mirrored key entry created on save.
			await storage.providerKeys.delete(provider.name);
			await syncCustomProviderCorsRules();
			await this.loadProviders();
			Toast.success("Provider deleted");
		} catch (error) {
			console.error("Failed to delete custom provider:", error);
			Toast.error("Failed to delete provider");
		}
	}

	private renderProvider(provider: CustomProvider): TemplateResult {
		const modelCount = provider.models?.length ?? 0;
		return html`
			<div class="flex items-center justify-between gap-2 rounded-md border border-border p-3">
				<div class="flex-1 min-w-0">
					<div class="text-sm font-medium text-foreground truncate">${provider.name}</div>
					<div class="text-xs text-muted-foreground mt-0.5 truncate">
						<span class="capitalize">${provider.type}</span>
						${provider.baseUrl ? html` • ${provider.baseUrl}` : ""}
						• ${modelCount} ${modelCount === 1 ? "model" : "models"}
					</div>
				</div>
				<div class="flex gap-2 flex-shrink-0">
					${Button({ variant: "outline", size: "sm", onClick: () => this.edit(provider), children: "Edit" })}
					${Button({ variant: "ghost", size: "sm", onClick: () => this.removeProvider(provider), children: "Delete" })}
				</div>
			</div>
		`;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-3">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-1">Custom providers</h3>
					<p class="text-xs text-muted-foreground">
						Any OpenAI- or Anthropic-compatible endpoint, such as Together or a server you run, by base URL and key.
						Its models join the model picker. Keys stay in this browser.
					</p>
				</div>
				${
					this.providers.length === 0
						? nothing
						: html`<div class="flex flex-col gap-2">${this.providers.map((p) => this.renderProvider(p))}</div>`
				}
				<div>${Button({ variant: "outline", size: "sm", onClick: () => this.add(), children: "Add Provider" })}</div>
			</div>
		`;
	}
}

if (!customElements.get("custom-providers-tab")) {
	customElements.define("custom-providers-tab", CustomProvidersTab);
}
