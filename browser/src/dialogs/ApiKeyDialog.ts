import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { getAppStorage } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { API_BILLING_NOTE, REMOVED_SIGN_IN_PROVIDERS } from "../auth/policy.js";
import "../components/ProviderKeyRow.js";
import { providerDisplayName } from "../models/display.js";

/**
 * Prompt dialog shown when trying to use a provider with no key. API keys only:
 * see docs/auth-policy.md for why there is no subscription sign-in.
 */
export class ApiKeyDialog extends DialogBase {
	private provider = "";
	/** One line shown in place of the default description (Free mode explains its free key). */
	private note?: string;
	private resolvePromise?: (success: boolean) => void;
	private checkInterval?: ReturnType<typeof setInterval>;

	protected modalWidth = "min(500px, 90vw)";
	protected modalHeight = "auto";

	static async prompt(provider: string, note?: string): Promise<boolean> {
		const dialog = new ApiKeyDialog();
		dialog.provider = provider;
		dialog.note = note;
		dialog.open();

		return new Promise((resolve) => {
			dialog.resolvePromise = resolve;
		});
	}

	override connectedCallback() {
		super.connectedCallback();

		// Poll for key existence
		this.checkInterval = setInterval(async () => {
			const hasKey = !!(await getAppStorage().providerKeys.get(this.provider));
			if (hasKey) {
				if (this.checkInterval) clearInterval(this.checkInterval);
				this.resolvePromise?.(true);
				this.resolvePromise = undefined;
				this.close();
			}
		}, 500);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.checkInterval) clearInterval(this.checkInterval);
	}

	override close() {
		super.close();
		if (this.resolvePromise) {
			this.resolvePromise(false);
		}
	}

	protected renderContent() {
		const removed = REMOVED_SIGN_IN_PROVIDERS.has(this.provider);
		return html`
			${DialogContent({
				className: "flex flex-col gap-4",
				children: html`
					${DialogHeader({
						title: `Connect to ${providerDisplayName(this.provider)}`,
						description: removed
							? "Subscription sign-in for this provider was removed. Pick a provider that takes an API key in Settings."
							: (this.note ?? "Add an API key to use this provider's models."),
					})}
					${
						removed
							? ""
							: html`
								<div class="flex flex-col gap-3">
									<tabkyra-provider-key .provider=${this.provider} .label=${providerDisplayName(this.provider)} .startOpen=${true}></tabkyra-provider-key>
									<p class="text-xs text-muted-foreground">${API_BILLING_NOTE}</p>
								</div>
							`
					}
				`,
			})}
		`;
	}
}

if (!customElements.get("api-key-dialog")) {
	customElements.define("api-key-dialog", ApiKeyDialog);
}
