import { icon } from "@mariozechner/mini-lit";
import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentInterface, MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { helmMark } from "../components/HelmMark.js";
import type { StarterPrompt } from "../tutorials.js";
import "../utils/i18n-extension.js";

export type TutorialPrompt = StarterPrompt;

export interface WelcomeMessage {
	role: "welcome";
	tutorials: TutorialPrompt[];
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		welcome: WelcomeMessage;
	}
}

@customElement("welcome-message")
export class WelcomeMessageElement extends LitElement {
	@property({ type: Array }) tutorials!: TutorialPrompt[];
	@property({ attribute: false }) agent!: Agent;
	@property({ attribute: false }) agentInterface!: AgentInterface;
	@property({ attribute: false }) message!: WelcomeMessage;

	protected createRenderRoot() {
		return this;
	}

	private async selectTutorial(starter: TutorialPrompt) {
		if (starter.mode === "compose") {
			// Into the chat input with the caret at the end; the input event lets the composer
			// open its "@" tab menu for a prompt that ends in "@".
			const textarea = this.agentInterface.querySelector<HTMLTextAreaElement>("message-editor textarea");
			if (!textarea) return;
			textarea.value = starter.prompt;
			textarea.focus();
			textarea.setSelectionRange(starter.prompt.length, starter.prompt.length);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
			return;
		}
		// Remove this welcome message
		const messages = this.agent.state.messages.filter((m) => m !== this.message);
		this.agent.replaceMessages(messages);

		// Send the prompt
		await this.agentInterface.sendMessage(starter.prompt);
	}

	override render(): TemplateResult {
		return html`
			<div class="welcome-container my-8 flex flex-col items-center justify-center">
				<div class="flex flex-col items-center text-center mb-6 px-6">
					${helmMark(64, "tile", "mb-4 rounded-[15px] shadow-[0_10px_30px_-12px_rgba(227,169,59,0.55)]")}
					<h1 class="text-2xl font-semibold tracking-tight mb-1.5">Tabkyra</h1>
					<p class="text-sm text-muted-foreground max-w-xs">${i18n("You steer. Tabkyra works the tabs.")}</p>
				</div>

				<!-- Starter chips -->
				<div class="grid grid-cols-2 gap-2 w-full max-w-md px-4">
					${this.tutorials.map(
						(starter, index) => html`
							<button
								type="button"
								class="tutorial-pill flex items-start gap-2.5 px-3 py-2.5 text-left rounded-xl cursor-pointer min-h-14"
								data-starter=${starter.mode}
								@click=${() => this.selectTutorial(starter)}
								style="animation-delay: ${index * 0.05}s;"
							>
								${starter.icon ? html`<span class="tk-starter-icon inline-flex shrink-0 mt-0.5">${icon(starter.icon, "sm")}</span>` : ""}
								<span class="min-w-0">
									<span class="block text-sm font-medium text-foreground leading-snug">${starter.label}</span>
									${starter.hint ? html`<span class="block text-xs text-muted-foreground leading-snug mt-0.5">${starter.hint}</span>` : ""}
								</span>
							</button>
						`,
					)}
				</div>
			</div>
		`;
	}
}

export function createWelcomeRenderer(agent: Agent, agentInterface: AgentInterface): MessageRenderer<WelcomeMessage> {
	return {
		render: (message) => {
			// Only show if no conversation started yet
			const hasConversation = agent.state.messages.some((m) => m.role === "user" || m.role === "assistant");

			if (hasConversation) return html``;

			return html`<welcome-message
				.tutorials=${message.tutorials}
				.agent=${agent}
				.agentInterface=${agentInterface}
				.message=${message}
			></welcome-message>`;
		},
	};
}

export function registerWelcomeRenderer(agent: Agent, agentInterface: AgentInterface) {
	registerMessageRenderer("welcome", createWelcomeRenderer(agent, agentInterface));
}

export function createWelcomeMessage(tutorials: TutorialPrompt[]): WelcomeMessage {
	return { role: "welcome", tutorials };
}
