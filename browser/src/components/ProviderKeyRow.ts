import { i18n } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { type Context, complete, getModel } from "@mariozechner/pi-ai";
import { applyProxyIfNeeded, getAppStorage } from "@mariozechner/pi-web-ui";
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { Check } from "lucide";
import { type KeyFailure, keyFailure } from "../models/key-reason.js";
import { Toast } from "./Toast.js";

/** A cheap model per provider, sent one short message to check a key before it's saved. */
const TEST_MODELS: Record<string, string> = {
	anthropic: "claude-haiku-4-5",
	openai: "gpt-4o-mini",
	google: "gemini-2.5-flash",
	groq: "openai/gpt-oss-20b",
	openrouter: "z-ai/glm-4.6",
	"vercel-ai-gateway": "anthropic/claude-opus-4.5",
	cerebras: "gpt-oss-120b",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.5-air",
};

/** Whether Tabkyra can check this provider's keys before saving them. */
export function canCheckKey(provider: string): boolean {
	return provider in TEST_MODELS;
}

/** How long a key check may take before Tabkyra gives up on it. */
const CHECK_TIMEOUT_MS = 30_000;
const TIMED_OUT: KeyFailure = { kind: "unchecked", reason: "the provider didn't answer within 30 seconds." };

/**
 * Sends one short message with the key. Returns undefined when the key works (or the provider
 * can't be checked), else what went wrong.
 */
export async function checkKey(
	provider: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<KeyFailure | undefined> {
	const modelId = TEST_MODELS[provider];
	if (!modelId) return undefined;
	const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
	try {
		let model = getModel(provider as never, modelId as never);
		if (!model) return { kind: "unchecked", reason: `Tabkyra has no model to test ${provider} keys with.` };
		const settings = getAppStorage().settings;
		const proxyUrl = (await settings.get<boolean>("proxy.enabled"))
			? (await settings.get<string>("proxy.url")) || undefined
			: undefined;
		model = applyProxyIfNeeded(model, apiKey, proxyUrl);
		const context: Context = { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] };
		const result = await complete(model, context, {
			apiKey,
			maxTokens: 200,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		} as never);
		if (timeout.aborted) return TIMED_OUT;
		// A reasoning model can spend the 200 tokens thinking and stop at the length limit; the key
		// still worked.
		if (result.stopReason === "error" || result.stopReason === "aborted") return keyFailure(result.errorMessage);
		return undefined;
	} catch (error) {
		if (timeout.aborted) return TIMED_OUT;
		return keyFailure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * One provider in Settings > Providers > API keys: a single line with its name, whether a key is
 * saved, and Add key, or Replace and Remove. The key field opens only when asked for, so the list
 * reads at a glance instead of as a wall of empty boxes. Fires provider-key-saved and
 * provider-key-removed (bubbling, detail: the provider id).
 */
export class ProviderKeyRow extends LitElement {
	@property() provider = "";
	@property() label = "";
	/** Opens with the key field showing, for a prompt that exists to take a key. */
	@property({ type: Boolean }) startOpen = false;
	@state() private hasKey = false;
	@state() private editing = false;
	@state() private checking = false;
	@state() private value = "";
	/** What went wrong with the last check. It stays until the key is edited. */
	@state() private problem?: KeyFailure;
	/** A note about the saved key, such as an account out of credit. */
	@state() private note?: string;
	private abort?: AbortController;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		// The search filtered the row out or Settings closed: a check in progress stops, and the
		// editor doesn't come back half done.
		if (this.abort) {
			this.abort.abort();
			this.editing = false;
			this.value = "";
		}
	}

	protected override willUpdate(changed: PropertyValues<this>) {
		if (!changed.has("provider")) return;
		// A row given another provider drops whatever it was doing for the old one.
		if (changed.get("provider")) {
			this.abort?.abort();
			this.editing = false;
			this.value = "";
			this.problem = undefined;
			this.note = undefined;
			this.hasKey = false;
		}
		if (this.provider) void this.loadStatus(this.provider);
	}

	private async loadStatus(provider: string) {
		try {
			const has = Boolean(await getAppStorage().providerKeys.get(provider));
			if (provider !== this.provider) return;
			this.hasKey = has;
		} catch (error) {
			console.error("Failed to read the key status:", error);
		}
		if (this.startOpen && !this.hasKey && !this.editing) void this.edit();
	}

	private async edit() {
		this.editing = true;
		this.note = undefined;
		this.value = "";
		this.problem = undefined;
		await this.updateComplete;
		this.querySelector<HTMLInputElement>("input[type=password]")?.focus();
	}

	private async cancel() {
		this.abort?.abort();
		this.editing = false;
		this.problem = undefined;
		this.value = "";
		await this.updateComplete;
		this.querySelector<HTMLElement>("[data-key-action]")?.focus();
	}

	/** Checks the key, then saves it; `force` saves without the check. */
	private async save(force = false) {
		const key = this.value.trim();
		const provider = this.provider;
		if (!key || this.checking) return;
		const abort = new AbortController();
		this.abort = abort;
		this.checking = true;
		this.problem = undefined;
		let problem: KeyFailure | undefined;
		try {
			problem = force ? undefined : await checkKey(provider, key, abort.signal);
			// Cancel closed the editor while the check ran: nothing to save or show.
			if (abort.signal.aborted) return;
			// A key the provider knows but whose account is out of credit or over a limit is still
			// the right key (a free OpenRouter key has no credit): it's saved, with the reason as a note.
			if (!problem || problem.kind === "limited") {
				await getAppStorage().providerKeys.set(provider, key);
				this.note = !problem
					? undefined
					: provider === "openrouter"
						? `Saved. ${capitalize(problem.reason)} Free mode still works with this key; paid models need credit.`
						: `Saved, but ${problem.reason}`;
				problem = undefined;
			}
		} catch (error) {
			problem = {
				kind: "unchecked",
				reason: `saving failed (${error instanceof Error ? error.message : String(error)}).`,
			};
		} finally {
			this.checking = false;
			if (this.abort === abort) this.abort = undefined;
		}
		this.problem = problem;
		if (!problem) {
			this.hasKey = true;
			this.editing = false;
			this.value = "";
			this.dispatchEvent(new CustomEvent("provider-key-saved", { detail: provider, bubbles: true }));
		}
		await this.updateComplete;
		// The field was disabled during the check and lost focus: it gets it back to fix the key,
		// or the row's button does once the key is saved.
		if (problem) this.querySelector<HTMLInputElement>("input[type=password]")?.focus();
		else this.querySelector<HTMLElement>("[data-key-action]")?.focus();
	}

	private async removeKey() {
		if (!confirm(`Remove the ${this.label} key from this browser? You'll need the key again to use ${this.label}.`))
			return;
		try {
			await getAppStorage().providerKeys.delete(this.provider);
			this.hasKey = false;
			this.note = undefined;
			this.dispatchEvent(new CustomEvent("provider-key-removed", { detail: this.provider, bubbles: true }));
		} catch (error) {
			console.error("Failed to remove the key:", error);
			Toast.error(`Couldn't remove the ${this.label} key`);
		}
		// The Remove button is gone: Add key (or Replace, if removing failed) takes focus.
		await this.updateComplete;
		this.querySelector<HTMLElement>("[data-key-action]")?.focus();
	}

	private renderEditor(): TemplateResult {
		const id = `key-${this.provider}`;
		return html`
			<div class="flex flex-col gap-2 pb-3">
				<div class="flex items-center gap-2">
					<input
						id=${id}
						type="password"
						autocomplete="off"
						spellcheck="false"
						aria-label=${`${this.label} API key`}
						aria-invalid=${this.problem ? "true" : "false"}
						aria-describedby=${`${id}-note`}
						placeholder=${this.hasKey ? "Paste the new key" : "Paste your API key"}
						.value=${this.value}
						?disabled=${this.checking}
						@input=${(e: Event) => {
							this.value = (e.target as HTMLInputElement).value;
							this.problem = undefined;
						}}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter") void this.save();
						}}
						class="min-w-0 flex-1 h-9 px-3 text-sm rounded-md border bg-background text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 ${
							this.problem ? "border-destructive" : "border-input"
						}"
					/>
					${Button({
						size: "sm",
						onClick: () => void this.save(),
						disabled: !this.value.trim() || this.checking,
						children: this.checking ? "Checking…" : "Save",
					})}
					${Button({
						size: "sm",
						variant: "ghost",
						onClick: () => void this.cancel(),
						children: "Cancel",
					})}
				</div>
				${
					this.problem
						? html`<div id=${`${id}-note`} role="alert" class="flex flex-wrap items-center gap-x-3 gap-y-1">
								<p class="text-xs text-destructive break-words">
									${this.problem.kind === "rejected" ? "That key didn't work: " : "Couldn't check the key: "}${this.problem.reason}
								</p>
								${
									this.problem.kind === "unchecked"
										? html`<button type="button" class=${QUIET} @click=${() => void this.save(true)}>Save anyway</button>`
										: nothing
								}
							</div>`
						: html`<p id=${`${id}-note`} class="text-xs text-muted-foreground">
								${
									canCheckKey(this.provider)
										? "Tabkyra sends the provider one short test message to check the key, then saves it in this browser."
										: "Saved in this browser as is: Tabkyra can't check this provider's keys first."
								}
							</p>`
				}
			</div>
		`;
	}

	override render(): TemplateResult {
		return html`
			<div class="flex min-h-11 items-center gap-2 py-1.5">
				<span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">${this.label}</span>
				${
					this.hasKey
						? html`<span class="inline-flex flex-shrink-0 items-center gap-1 text-xs font-medium text-[var(--tk-brass-text)]"
								>${icon(Check, "sm")}${i18n("Key saved")}</span
							>`
						: nothing
				}
				${
					this.editing
						? nothing
						: this.hasKey
							? html`<div class="flex flex-shrink-0 gap-1">
									<button type="button" data-key-action class=${QUIET} aria-label=${`Replace the ${this.label} key`} @click=${() => void this.edit()}>
										Replace
									</button>
									<button type="button" class=${QUIET} aria-label=${`Remove the ${this.label} key`} @click=${() => void this.removeKey()}>
										Remove
									</button>
								</div>`
							: html`<button
									type="button"
									data-key-action
									class="flex-shrink-0 h-8 rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
									aria-label=${`Add ${this.label} key`}
									@click=${() => void this.edit()}
								>
									Add key
								</button>`
				}
			</div>
			${this.editing ? this.renderEditor() : nothing}
			${
				this.note && this.hasKey && !this.editing
					? html`<p class="pb-2 text-xs text-muted-foreground" role="status">${this.note}</p>`
					: nothing
			}
		`;
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A quiet text button for the less common actions on a saved key. */
const QUIET =
	"h-8 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

if (!customElements.get("tabkyra-provider-key")) customElements.define("tabkyra-provider-key", ProviderKeyRow);
