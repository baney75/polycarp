import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { polycarpMark } from "../components/PolycarpMark.js";

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

	static async show(): Promise<WelcomeChoice> {
		return new Promise<WelcomeChoice>((resolve) => {
			const dialog = new WelcomeSetupDialog();
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
					<div class="flex items-center gap-3">
						${polycarpMark(40, "tile", "rounded-[9px]")}
						${DialogHeader({ title: "Welcome to Polycarp" })}
					</div>
					<p class="text-sm text-foreground">How do you want to use it?</p>
					<div class="flex flex-col gap-1.5">
						${Button({
							variant: "default",
							className: "w-full",
							onClick: () => this.close(),
							children: "Chat here",
						})}
						<p class="text-xs text-muted-foreground">Add a key from any AI provider, or a free one.</p>
					</div>
					<div class="flex flex-col gap-1.5">
						${agentSetupPromptButton("Claude Code, Codex and other agents can drive this browser. Paste this prompt into yours.")}
					</div>
					<button
						type="button"
						class="self-start text-xs text-muted-foreground underline underline-offset-2 cursor-pointer"
						@click=${() => {
							this.choice = "connect";
							this.close();
						}}
					>
						Use from claude.ai or ChatGPT
					</button>
				`,
			})}
		`;
	}
}

if (!customElements.get("welcome-setup-dialog")) {
	customElements.define("welcome-setup-dialog", WelcomeSetupDialog);
}
