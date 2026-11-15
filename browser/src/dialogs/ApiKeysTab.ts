import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { getProviders } from "@mariozechner/pi-ai";
import { getAppStorage, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { API_BILLING_NOTE, REMOVED_SIGN_IN_PROVIDERS } from "../auth/policy.js";
import { providerDisplayName } from "../models/display.js";
import { FREE_PRIVACY_NOTE } from "../models/free-mode.js";
import { isFreeModeOn, setFreeMode } from "../models/free-panel.js";
import { SUBSCRIPTION_PROVIDERS } from "../subscriptions/constants.js";
import { CustomProvidersTab } from "./CustomProvidersTab.js";
import "../components/ProviderKeyRow.js";
import { getTabkyraStorage } from "../storage/app-storage.js";
import { SUBSCRIPTIONS_LOADED } from "../subscriptions/SubscriptionsSection.js";
import { knownProvidersWithKeys, providersWithKeys } from "./provider-key-status.js";

// Providers to hide from the API key list: removed sign-ins, and clouds that need more than a key.
const HIDDEN_PROVIDERS = new Set([
	...REMOVED_SIGN_IN_PROVIDERS,
	// Signed in under "Use your subscription"; they never take a key.
	...SUBSCRIPTION_PROVIDERS,
	"amazon-bedrock",
	"azure-openai-responses",
	"google-vertex",
	"opencode",
	"opencode-go",
	"kimi-coding",
]);

/**
 * Settings > Providers, in four sections: Free mode, subscriptions (and connecting your own
 * agent), API keys for the built-in providers, then custom providers. Each provider is one line
 * (its key field opens on Add key), providers with a key come first, a search box narrows the
 * list, and saving a key offers "Choose a model" right there.
 */
/** Shown without asking. The rest wait behind "Show all providers" or a search. */
const COMMON_PROVIDERS = new Set(["anthropic", "openai", "google", "openrouter"]);
/** The longest the tab stays hidden waiting on the helper's subscription answer. */
export const PROVIDERS_SHOW_CAP_MS = 300;

export class ApiKeysTab extends SettingsTab {
	/** Opens the model picker (the composer's own); set by the side panel. */
	onChooseModel?: () => void;
	private query = "";
	/** Providers with a key when the tab opened. They sort first; a key saved now doesn't move its
	 * row out from under the pointer. */
	private withKeys = new Set<string>();
	/** Providers with a key now: a row drawn later (a search, Show all) starts from this instead of reading. */
	private saved = new Set<string>();
	/** The provider whose key was just saved: it gets the "Choose a model" prompt. */
	private justSaved?: string;
	private readonly custom = new CustomProvidersTab();
	private showAll = false;
	/** Custom providers someone set up never hide behind a button. */
	private hasCustom = false;
	/** The saved keys have been read: the list is drawn in its final order. */
	private keysLoaded = false;
	/** The tab shows once its keys and the subscription answer are in (or after PROVIDERS_SHOW_CAP_MS), so nothing in it jumps. */
	private shown = false;
	private showTimer?: ReturnType<typeof setTimeout>;
	private subscriptionsLoaded = false;

	getTabName(): string {
		return "Providers";
	}

	override async connectedCallback() {
		super.connectedCallback();
		this.addEventListener("provider-key-saved", this.onSaved);
		this.addEventListener("provider-key-removed", this.onRemoved);
		this.addEventListener(SUBSCRIPTIONS_LOADED, this.onSubscriptionsLoaded);
		this.showTimer = setTimeout(() => this.show(), PROVIDERS_SHOW_CAP_MS);
		// The panel read the keys when it started: the rows are drawn in order now, and checked again below.
		const known = knownProvidersWithKeys();
		if (known) this.takeKeys(known);
		// Nothing takes focus when Settings opens: a focused search box far down the tab drew a ring
		// and caught typing while out of sight.
		const [keys, custom] = await Promise.all([
			providersWithKeys(getAppStorage().providerKeys).catch((error) => {
				console.error("Failed to load provider keys:", error);
				return new Set<string>();
			}),
			getTabkyraStorage()
				.customProviders.getAll()
				.catch((error) => {
					console.error("Failed to load custom providers:", error);
					return [];
				}),
		]);
		this.takeKeys(keys);
		this.hasCustom = custom.length > 0;
		this.requestUpdate();
	}

	/** Keys read now: they sort first, and each row starts from whether its provider has one. */
	private takeKeys(keys: ReadonlySet<string>) {
		for (const p of keys) this.withKeys.add(p);
		this.saved = new Set(keys);
		this.keysLoaded = true;
		this.requestUpdate();
		if (this.subscriptionsLoaded) this.show();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.removeEventListener("provider-key-saved", this.onSaved);
		this.removeEventListener("provider-key-removed", this.onRemoved);
		this.removeEventListener(SUBSCRIPTIONS_LOADED, this.onSubscriptionsLoaded);
		clearTimeout(this.showTimer);
	}

	private onSubscriptionsLoaded = () => {
		this.subscriptionsLoaded = true;
		if (this.keysLoaded) this.show();
	};

	private show() {
		clearTimeout(this.showTimer);
		if (this.shown) return;
		this.shown = true;
		this.requestUpdate();
	}

	private onSaved = (e: Event) => {
		this.justSaved = (e as CustomEvent<string>).detail;
		// It stays in the short list once a search is cleared.
		this.withKeys.add(this.justSaved);
		this.saved.add(this.justSaved);
		this.requestUpdate();
	};

	private onRemoved = (e: Event) => {
		this.saved.delete((e as CustomEvent<string>).detail);
		if (this.justSaved === (e as CustomEvent<string>).detail) this.justSaved = undefined;
		this.requestUpdate();
	};

	private providers(): string[] {
		const q = this.query.trim().toLowerCase();
		return (
			getProviders()
				.filter((p) => !HIDDEN_PROVIDERS.has(p))
				.filter((p) => !q || p.includes(q) || providerDisplayName(p).toLowerCase().includes(q))
				// With no search, what you use and the common four. Everything else is one click away.
				.filter((p) => q || this.showAll || this.withKeys.has(p) || COMMON_PROVIDERS.has(p))
				.sort(
					(a, b) =>
						Number(this.withKeys.has(b)) - Number(this.withKeys.has(a)) ||
						providerDisplayName(a).localeCompare(providerDisplayName(b)),
				)
		);
	}

	private async toggleFree(e: Event) {
		const input = e.target as HTMLInputElement;
		input.checked = await setFreeMode(input.checked);
		this.requestUpdate();
	}

	render(): TemplateResult {
		const providers = this.providers();
		return html`
			<div class="flex flex-col gap-5 ${this.shown ? "" : "invisible"}" data-providers-shown=${this.shown ? "true" : "false"}>
				<div class="flex flex-col gap-1.5">
					<label class="flex items-start justify-between gap-3 text-sm font-medium text-foreground cursor-pointer">
						<span>Free mode: use the best free model (OpenRouter)</span>
						<input
							type="checkbox"
							role="switch"
							class="tk-switch"
							.checked=${isFreeModeOn()}
							@change=${(e: Event) => this.toggleFree(e)}
						/>
					</label>
					<p class="text-xs text-muted-foreground">
						Never costs money. Needs a free OpenRouter key and is limited per day. ${FREE_PRIVACY_NOTE}
					</p>
				</div>
				<section class="flex flex-col gap-3 pt-5 border-t border-border" aria-labelledby="api-keys-heading">
					<div>
						<h3 id="api-keys-heading" class="text-sm font-semibold text-foreground mb-1">API keys</h3>
						<p class="text-xs text-muted-foreground">For the side panel's agent. Keys stay in this browser. ${API_BILLING_NOTE}</p>
					</div>
					${
						this.justSaved
							? html`<div
									role="status"
									class="flex items-center justify-between gap-3 rounded-lg border border-[var(--tk-brass)]/50 bg-[var(--tk-brass)]/10 px-3 py-2"
								>
									<span class="text-sm text-foreground">${providerDisplayName(this.justSaved)} key saved.</span>
									${Button({
										size: "sm",
										onClick: () => this.onChooseModel?.(),
										children: "Choose a model",
									})}
								</div>`
							: nothing
					}
					<input
						type="search"
						aria-label="Find a provider"
						placeholder="Find a provider"
						.value=${this.query}
						@input=${(e: Event) => {
							this.query = (e.target as HTMLInputElement).value;
							this.requestUpdate();
						}}
						class="w-full h-9 px-3 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
					/>
					<div class="flex flex-col divide-y divide-border">
						${
							!this.keysLoaded
								? nothing
								: providers.length === 0
									? html`<p class="text-sm text-muted-foreground">No provider matches. Add any OpenAI- or Anthropic-compatible endpoint under Custom providers below.</p>`
									: repeat(
											providers,
											(provider) => provider,
											(provider) =>
												html`<tabkyra-provider-key .provider=${provider} .label=${providerDisplayName(provider)} .knownHasKey=${this.saved.has(provider)}></tabkyra-provider-key>`,
										)
						}
					</div>
				</section>
				<section class="flex flex-col gap-4 pt-5 border-t border-border">
					<tabkyra-subscriptions></tabkyra-subscriptions>
				</section>
				${
					this.showAll || this.query.trim()
						? nothing
						: html`<button
								type="button"
								class="self-start text-sm text-muted-foreground underline underline-offset-2 cursor-pointer"
								@click=${() => {
									this.showAll = true;
									this.requestUpdate();
								}}
							>
								Show all providers
							</button>`
				}
				${this.showAll || this.hasCustom || this.query.trim() ? html`<div class="pt-5 border-t border-border">${this.custom}</div>` : nothing}
			</div>
		`;
	}
}

if (!customElements.get("tabkyra-api-keys-tab")) {
	customElements.define("tabkyra-api-keys-tab", ApiKeysTab);
}
