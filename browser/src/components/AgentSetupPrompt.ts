import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, type TemplateResult } from "lit";
import { agentSetupPrompt } from "../agent-setup-prompt.js";
import { Toast } from "./Toast.js";

function extensionVersion(): string {
	try {
		return chrome.runtime.getManifest().version;
	} catch {
		return "";
	}
}

async function copy(): Promise<void> {
	let prompt: string;
	try {
		prompt = agentSetupPrompt(extensionVersion());
	} catch (err) {
		Toast.error(`Couldn't build the setup prompt: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	try {
		await navigator.clipboard.writeText(prompt);
		Toast.success("Setup prompt copied. Paste it into your agent.");
	} catch {
		Toast.error("Couldn't copy. Click the side panel first, then try again.");
	}
}

/** Button plus one line of context, for the settings tabs and the welcome dialog. */
export function agentSetupPromptButton(
	note = "Paste it into Claude Code, Codex, pi, OMP or any agent to connect it to this browser.",
): TemplateResult {
	return html`
		<div class="flex flex-col gap-1.5 items-start">
			${Button({ size: "sm", variant: "secondary", onClick: () => void copy(), children: "Copy setup prompt for your agent" })}
			<p class="text-xs text-muted-foreground">${note}</p>
		</div>
	`;
}
