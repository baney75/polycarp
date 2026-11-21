import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { html } from "lit";
import { DomainPill } from "../components/DomainPill.js";
import { PageBase } from "../components/PageBase.js";
import type { Skill } from "../storage/stores/skills-store.js";

/** A skill's details, as a page over the chat with a back arrow. */
export class SkillDialog extends PageBase {
	private skill: Skill | null = null;

	static open(skill: Skill) {
		const page = new SkillDialog();
		page.skill = skill;
		page.open();
	}

	protected pageTitle(): string {
		return this.skill?.name ?? i18n("Skill");
	}

	protected override renderContent() {
		if (!this.skill) return html``;

		const skill = this.skill;

		return html`
			<div class="mx-auto max-w-2xl px-4 py-5">
				${
					skill.domainPatterns.length || skill.shortDescription
						? html`<div class="mb-4 flex flex-col gap-2 border-b border-border pb-4">
								${skill.domainPatterns.length ? html`<div class="flex flex-wrap gap-2">${skill.domainPatterns.map((pattern) => DomainPill(pattern))}</div>` : ""}
								${skill.shortDescription ? html`<p class="text-sm text-muted-foreground">${skill.shortDescription}</p>` : ""}
							</div>`
						: ""
				}
				<div>
					<div class="flex flex-col gap-4">

						<!-- Description -->
						${
							skill.description
								? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">Description</div>
										<markdown-block .content=${skill.description}></markdown-block>
									</div>
							  `
								: ""
						}

						<!-- Examples -->
						${
							skill.examples
								? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Examples")}</div>
										<code-block .code=${skill.examples} language="javascript"></code-block>
									</div>
							  `
								: ""
						}

						<!-- Library Code -->
						${
							skill.library
								? html`
									<div>
										<div class="text-sm font-medium text-muted-foreground mb-2">${i18n("Library")}</div>
										<code-block .code=${skill.library} language="javascript"></code-block>
									</div>
							  `
								: ""
						}
					</div>
				</div>
			</div>
		`;
	}
}

customElements.define("skill-dialog", SkillDialog);
