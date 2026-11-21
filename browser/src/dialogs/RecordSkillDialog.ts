import { i18n } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PageBase } from "../components/PageBase.js";
import { Toast } from "../components/Toast.js";
import { buildSkillFromRecording, type RecordingResult } from "../recording/recorder.js";
import { getTabkyraStorage } from "../storage/app-storage.js";

/**
 * Review a recording and save it as a site-scoped Skill. The agent will then
 * see the skill id on that site (via URL matching) and can retrieve/replay it.
 */
@customElement("record-skill-dialog")
export class RecordSkillDialog extends PageBase {
	@state() private rec!: RecordingResult;
	@state() private name = "";
	@state() private domains = "";
	@state() private showScreenshots = true;
	@state() private showSteps = true;
	private onSaved?: () => void;

	protected override fillsHeight = true;

	static open(rec: RecordingResult, onSaved?: () => void) {
		const dialog = new RecordSkillDialog();
		dialog.rec = rec;
		const shortHost = rec.hostname.replace(/^www\./, "").split(".")[0] || "site";
		dialog.name = `${shortHost}-workflow`;
		dialog.domains = rec.hostname;
		dialog.onSaved = onSaved;
		dialog.open();
	}

	private stepLabel(step: RecordingResult["steps"][number]): string {
		switch (step.type) {
			case "navigate":
				return `Navigate → ${step.url}`;
			case "click":
				return `Click ${step.text ? `"${step.text}"` : step.selector || ""}`;
			case "input":
				return `Type "${step.value || ""}" → ${step.selector || ""}`;
			case "submit":
				return `Submit ${step.selector || ""}`;
			default:
				return step.type;
		}
	}

	private sectionHeader(label: string, count: number, expanded: boolean, onToggle: () => void): TemplateResult {
		return html`
			<div class="flex items-center justify-between gap-3">
				<div class="min-w-0">
					<div class="text-sm font-semibold text-foreground">${label}</div>
					<div class="text-xs text-muted-foreground">${count} captured</div>
				</div>
				<button
					type="button"
					class="shrink-0 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
					aria-expanded=${expanded ? "true" : "false"}
					@click=${onToggle}
				>
					${expanded ? "Hide" : "Show"}
				</button>
			</div>
		`;
	}

	private renderScreenshots(): TemplateResult {
		const screenshots = this.rec?.screenshots ?? [];
		return html`
			<section class="rounded-md border border-border bg-card p-3">
				${this.sectionHeader("Screenshots", screenshots.length, this.showScreenshots, () => {
					this.showScreenshots = !this.showScreenshots;
				})}
				${
					this.showScreenshots
						? screenshots.length
							? html`
								<div class="mt-3 grid max-h-80 grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
									${screenshots.map(
										(src, index) => html`
											<figure class="overflow-hidden rounded-md border border-border bg-background">
												<img
													src=${src}
													class="block h-44 w-full object-cover"
													alt=${`Recording screenshot ${index + 1}`}
												/>
												<figcaption class="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
													Screenshot ${index + 1}
												</figcaption>
											</figure>
										`,
									)}
								</div>
							`
							: html`<div class="mt-3 rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
								No screenshots were captured for this recording.
							</div>`
						: ""
				}
			</section>
		`;
	}

	private renderSteps(steps: RecordingResult["steps"]): TemplateResult {
		return html`
			<section class="rounded-md border border-border bg-card p-3">
				${this.sectionHeader("Steps", steps.length, this.showSteps, () => {
					this.showSteps = !this.showSteps;
				})}
				${
					this.showSteps
						? html`
							<div
								class="mt-3 max-h-72 overflow-y-auto rounded-md border border-border bg-background text-sm font-mono text-foreground"
							>
								${
									steps.length === 0
										? html`<div class="p-3 text-muted-foreground">No interactions were captured.</div>`
										: steps.map(
												(step, i) => html`
												<div class="grid grid-cols-[2.5rem_1fr] gap-2 border-b border-border px-3 py-2 last:border-0">
													<span class="text-right font-semibold text-muted-foreground">${i + 1}.</span>
													<span class="min-w-0 whitespace-pre-wrap break-words text-foreground">${this.stepLabel(step)}</span>
												</div>
											`,
											)
								}
							</div>
						`
						: ""
				}
			</section>
		`;
	}

	private async save() {
		const name = this.name.trim();
		if (!name) {
			Toast.error("Please enter a skill name");
			return;
		}
		const storage = getTabkyraStorage();
		const existing = await storage.skills.get(name);
		if (existing && !confirm(`A skill named "${name}" already exists. Overwrite it?`)) return;

		const domainPatterns = this.domains
			.split(",")
			.map((d) => d.trim())
			.filter(Boolean);

		const skill = buildSkillFromRecording(this.rec, {
			name,
			domainPatterns: domainPatterns.length ? domainPatterns : undefined,
		});
		await storage.skills.save(skill);
		Toast.success(`Saved skill "${name}"`);
		this.onSaved?.();
		this.close();
	}

	protected pageTitle(): string {
		return i18n("Save recording as skill");
	}

	protected renderContent(): TemplateResult {
		const steps = this.rec?.steps ?? [];
		return html`
			<div class="tk-page-body min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-5">
					<p class="text-sm text-muted-foreground">${steps.length} step(s) captured on ${this.rec?.hostname ?? ""}</p>
					${Input({
						label: "Skill name (id)",
						type: "text",
						value: this.name,
						onInput: (e: Event) => {
							this.name = (e.target as HTMLInputElement).value;
						},
					})}
					${Input({
						label: "Domain patterns (comma-separated)",
						type: "text",
						value: this.domains,
						onInput: (e: Event) => {
							this.domains = (e.target as HTMLInputElement).value;
						},
					})}
					${this.renderScreenshots()} ${this.renderSteps(steps)}
				</div>
			</div>
			<div class="flex flex-shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
				${Button({ variant: "outline", onClick: () => this.close(), children: "Cancel" })}
				${Button({ variant: "default", onClick: () => this.save(), children: "Save skill", disabled: steps.length === 0 })}
			</div>
		`;
	}
}
