import type { Attachment, MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer, type UserMessageWithAttachments } from "@mariozechner/pi-web-ui";
import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { knownSkills, sentChips } from "../composer/chips.js";
import { type ComposerRefs, displayText, leadingSkill, REFS_RESOLVED } from "../composer/refs.js";

/**
 * Custom user message component for Tabkyra with fancy pill styling.
 * Duplicates the web-ui UserMessage but with our custom styling.
 */
@customElement("tabkyra-user-message")
export class TabkyraUserMessage extends LitElement {
	@property({ type: Object }) message!: UserMessageWithAttachments;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private onRefsResolved = () => this.requestUpdate();

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		window.addEventListener(REFS_RESOLVED, this.onRefsResolved);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener(REFS_RESOLVED, this.onRefsResolved);
	}

	override render() {
		const content =
			typeof this.message.content === "string"
				? this.message.content
				: (this.message.content.find((c) => c.type === "text") as { type: "text"; text: string } | undefined)
						?.text || "";

		// References typed in the composer (/skill, @tab:<id>) show as chips, not raw tokens.
		const refs = (this.message as { tabkyraRefs?: ComposerRefs | null }).tabkyraRefs;
		const chips = sentChips(content, refs);
		// Only a real skill's token is hidden: "/deploy staging" stays as typed.
		const skill = refs ? refs.skill?.name : leadingSkill(content, knownSkills);
		const shown = chips === nothing ? content : displayText(content, skill);

		return html`
			<div class="flex justify-start ml-4">
				<div class="user-message-container py-2 px-4 rounded-xl">
					${chips}
					${shown ? html`<markdown-block .content=${shown}></markdown-block>` : nothing}
					${
						this.message.attachments && this.message.attachments.length > 0
							? html`
								<div class="mt-3 flex flex-wrap gap-2">
									${this.message.attachments.map(
										(attachment: Attachment) =>
											html` <attachment-tile .attachment=${attachment}></attachment-tile> `,
									)}
								</div>
							`
							: ""
					}
				</div>
			</div>
		`;
	}
}

export function createUserMessageRenderer(): MessageRenderer<UserMessageWithAttachments> {
	return {
		render: (message) => {
			return html`<tabkyra-user-message .message=${message}></tabkyra-user-message>`;
		},
	};
}

export function registerUserMessageRenderer() {
	registerMessageRenderer("user", createUserMessageRenderer());
	registerMessageRenderer("user-with-attachments", createUserMessageRenderer());
}
