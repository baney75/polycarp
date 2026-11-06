import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { polycarpMark } from "../components/PolycarpMark.js";
import { BUG_REPORTS_KEY } from "../privacy/bug-reports.js";
import { setBugReports } from "../privacy/capture.js";
import { getTabkyraStorage } from "../storage/app-storage.js";

/** Where the dialog sends the person: the provider keys, or Connect (use Polycarp from claude.ai or ChatGPT). */
export type WelcomeChoice = "provider" | "connect";

/**
 * Shown on first launch when no API keys are configured.
 * Blocks until the person picks one of two ways in: add a provider key, or use Polycarp from claude.ai or ChatGPT. Pairs with a third, copying a prompt for their own agent.
 */
export class WelcomeSetupDialog extends DialogBase {
	private resolvePromise?: (choice: WelcomeChoice) => void;
	private choice: WelcomeChoice = "provider";

	protected modalWidth = "min(450px, 90vw)";
	protected modalHeight = "auto";

	/** Bug reports were already on (turned on earlier in Settings > Privacy). */
	private reportsOn = false;

	static async show(): Promise<WelcomeChoice> {
		const reportsOn = (await getTabkyraStorage().settings.get<boolean>(BUG_REPORTS_KEY)) === true;
		return new Promise<WelcomeChoice>((resolve) => {
			const dialog = new WelcomeSetupDialog();
			dialog.reportsOn = reportsOn;
			dialog.resolvePromise = resolve;
			dialog.open();
		});
	}

	override close() {
		super.close();
		this.resolvePromise?.(this.choice);
	}

	protected renderContent() {
		return html`
			${DialogContent({
				className: "flex flex-col gap-4",
				children: html`
					${polycarpMark(40, "tile", "rounded-[9px]")}
					${DialogHeader({
						title: "Welcome to Polycarp",
					})}
					<p class="text-sm text-foreground">
						To chat in this side panel, add an API key for at least one AI provider. API use is billed
						by the provider.
					</p>
					${agentSetupPromptButton("To let your own agent drive this browser, paste this prompt into Claude Code, Codex, pi, OMP or any agent. It needs no API key here.")}
					${
						this.reportsOn
							? html`<p class="text-xs text-muted-foreground">Error reports are on. Turn them off in Settings &gt; Privacy.</p>`
							: html`<label class="flex items-start justify-between gap-3 text-xs text-muted-foreground cursor-pointer">
									<span>Keep error reports I can choose to send (optional, off by default; Settings &gt; Privacy)</span>
									<input
										type="checkbox"
										role="switch"
										class="tk-switch"
										@change=${(e: Event) => void setBugReports(getTabkyraStorage(), (e.target as HTMLInputElement).checked)}
									/>
								</label>`
					}
					<div class="flex flex-wrap justify-end gap-2">
						${Button({
							variant: "outline",
							onClick: () => {
								this.choice = "connect";
								this.close();
							},
							children: "Use from claude.ai or ChatGPT",
						})}
						${Button({
							variant: "default",
							onClick: () => this.close(),
							children: "Set up provider",
						})}
					</div>
				`,
			})}
		`;
	}
}

if (!customElements.get("welcome-setup-dialog")) {
	customElements.define("welcome-setup-dialog", WelcomeSetupDialog);
}
