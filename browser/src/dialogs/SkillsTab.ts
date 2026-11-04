import { LIBRARY_SKILLS } from "virtual:library-skills";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import type { HostCommunityStatus } from "../bridge/protocol.js";
import {
	COMMUNITY_STATUS_KEY,
	type CommunityAction,
	communityLibrary,
	PANEL_COMMUNITY_MESSAGE,
	readCommunityStatus,
} from "../community/status.js";
import { Toast } from "../components/Toast.js";
import { getTabkyraStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { getFaviconUrl } from "../utils/favicon.js";
import { libraryRows, normalizeSkillQuery } from "./skill-list.js";

export class SkillsTab extends SettingsTab {
	label = "Skills";
	private skills: Skill[] = [];
	private filteredSkills: Skill[] = [];
	private searchQuery = "";
	private editingSkill: Skill | null = null;
	private importConflicts: { skill: Skill; selected: boolean }[] = [];
	private importedSkills: Skill[] = [];
	private community: HostCommunityStatus | undefined;
	private readonly onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area !== "local" || !(COMMUNITY_STATUS_KEY in changes)) return;
		this.community = changes[COMMUNITY_STATUS_KEY].newValue as HostCommunityStatus | undefined;
		this.requestUpdate();
	};

	getTabName(): string {
		return this.label;
	}

	async connectedCallback() {
		super.connectedCallback();
		chrome.storage.onChanged.addListener(this.onStorageChanged);
		this.community = await readCommunityStatus();
		this.requestUpdate();
		await this.loadSkills();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		chrome.storage.onChanged.removeListener(this.onStorageChanged);
	}

	private async sendCommunity(action: CommunityAction) {
		try {
			const reply = (await chrome.runtime.sendMessage({ type: PANEL_COMMUNITY_MESSAGE, action })) as
				| { ok: boolean; message?: string }
				| undefined;
			if (!reply?.ok) Toast.error(reply?.message ?? "The Tabkyra native host didn't answer.");
		} catch (error) {
			Toast.error((error as Error).message);
		}
	}

	private renderCommunity(): TemplateResult {
		const status = this.community;
		const checked = status?.enabled ?? true;
		const lastCheck = status?.lastCheck ? new Date(status.lastCheck).toLocaleString() : "never";
		return html`
			<section class="space-y-2" aria-labelledby="community-skills-heading">
				<h3 id="community-skills-heading" class="text-sm font-semibold text-foreground">Community skills</h3>
				<label class="flex items-start justify-between gap-3 text-sm text-foreground cursor-pointer">
					<span>Receive community skills</span>
					<input
						type="checkbox"
						role="switch"
						class="tk-switch"
						.checked=${checked}
						@change=${(e: Event) => this.sendCommunity((e.target as HTMLInputElement).checked ? "on" : "off")}
					/>
				</label>
				<p class="text-xs text-muted-foreground">
					Reviewed by a maintainer, signed, checked about once a day. Each is used only on the sites it names. Your own edits are kept and never overwritten.
				</p>
				${
					status
						? html`<div class="flex items-center gap-2 flex-wrap text-sm text-foreground">
								<span>Catalog ${status.serial ?? "none yet"}, checked ${lastCheck}</span>
								${Button({
									variant: "secondary",
									size: "sm",
									onClick: () => this.sendCommunity("sync"),
									children: "Check now",
								})}
							</div>`
						: html`<p class="text-xs text-muted-foreground">
								No word from the native host yet; community skills sync through it (tabkyra doctor).
							</p>`
				}
				${status?.error ? html`<p class="text-xs text-destructive">${status.error}</p>` : nothing}
				${
					status && status.skills.length > 0
						? html`<div class="flex flex-col gap-2">
								${status.skills.map(
									(skill) => html`<div class="space-y-1">
										<div class="font-semibold text-foreground">${skill.name}</div>
										<div class="text-xs text-muted-foreground font-mono">${skill.provenance}; ${skill.sites.join(", ")}</div>
										<p class="text-xs text-muted-foreground">${skill.description}</p>
									</div>`,
								)}
							</div>`
						: nothing
				}
				${status?.notes.map((note) => html`<p class="text-xs text-muted-foreground">${note}</p>`)}
				${status?.removed
					.slice(-5)
					.map((r) => html`<p class="text-xs text-muted-foreground">Removed ${r.name}: ${r.reason}</p>`)}
			</section>
		`;
	}

	async loadSkills() {
		const storage = getTabkyraStorage();
		this.skills = await storage.skills
			.list()
			.then((list) =>
				Promise.all(list.map((s) => storage.skills.get(s.name))).then(
					(skills) => skills.filter(Boolean) as Skill[],
				),
			);
		this.filterSkills();
	}

	filterSkills() {
		const query = normalizeSkillQuery(this.searchQuery);
		this.filteredSkills = this.skills.filter(
			(s) =>
				s.name.toLowerCase().includes(query) ||
				s.domainPatterns.some((p: string) => p.toLowerCase().includes(query)) ||
				s.shortDescription.toLowerCase().includes(query),
		);
		this.requestUpdate();
	}

	onSearchInput(e: Event) {
		this.searchQuery = (e.target as HTMLInputElement).value;
		this.filterSkills();
	}

	async deleteSkill(skill: Skill) {
		if (!confirm(`Delete skill "${skill.name}"?`)) return;

		const storage = getTabkyraStorage();
		await storage.skills.delete(skill.name);
		await this.loadSkills();
	}

	editSkill(skill: Skill) {
		this.editingSkill = { ...skill };
		this.requestUpdate();
	}

	cancelEdit() {
		this.editingSkill = null;
		this.requestUpdate();
	}

	async saveEdit() {
		if (!this.editingSkill) return;
		const storage = getTabkyraStorage();
		const toSave: Skill = {
			...this.editingSkill,
			lastUpdated: new Date().toISOString(),
		};
		await storage.skills.save(toSave);
		this.editingSkill = null;
		await this.loadSkills();
	}

	updateEditField(field: keyof Skill, value: string | string[]) {
		if (!this.editingSkill) return;
		this.editingSkill = { ...this.editingSkill, [field]: value };
		this.requestUpdate();
	}

	async exportSkills() {
		const storage = getTabkyraStorage();
		const allSkills = await storage.skills
			.list()
			.then((list) =>
				Promise.all(list.map((s) => storage.skills.get(s.name))).then(
					(skills) => skills.filter(Boolean) as Skill[],
				),
			);

		const json = JSON.stringify(allSkills, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `tabkyra-skills-${new Date().toISOString().split("T")[0]}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async importSkills() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "application/json,.json";
		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file) return;

			try {
				const text = await file.text();
				const imported = JSON.parse(text) as Skill[];

				if (!Array.isArray(imported)) {
					Toast.error("Invalid skills file: expected an array of skills");
					return;
				}

				// Store imported skills for later
				this.importedSkills = imported;

				// Check for conflicts
				const storage = getTabkyraStorage();
				const conflicts: { skill: Skill; selected: boolean }[] = [];

				for (const skill of imported) {
					const existing = await storage.skills.get(skill.name);
					if (existing) {
						conflicts.push({ skill, selected: true });
					}
				}

				if (conflicts.length > 0) {
					// Show conflict resolution UI
					this.importConflicts = conflicts;
					this.requestUpdate();
				} else {
					// No conflicts, import all
					await this.performImport(imported);
				}
			} catch (error) {
				Toast.error(`Failed to import skills: ${(error as Error).message}`);
			}
		};
		input.click();
	}

	async performImport(skills: Skill[]) {
		const storage = getTabkyraStorage();

		// Filter out skills that are in conflicts and not selected
		const conflictNames = new Set(this.importConflicts.filter((c) => !c.selected).map((c) => c.skill.name));
		const toImport = skills.filter((s) => !conflictNames.has(s.name));

		let imported = 0;
		for (const skill of toImport) {
			await storage.skills.save(skill);
			imported++;
		}

		this.importConflicts = [];
		await this.loadSkills();
		Toast.success(`Imported ${imported} skill(s)`);
	}

	toggleConflictSelection(index: number) {
		this.importConflicts[index].selected = !this.importConflicts[index].selected;
		this.requestUpdate();
	}

	cancelImport() {
		this.importConflicts = [];
		this.importedSkills = [];
		this.requestUpdate();
	}

	renderSkillInfo(skill: Skill) {
		return html`
			<div class="border border-border rounded-lg p-3 bg-card">
				<div class="flex items-start gap-3">
					<img src=${getFaviconUrl(skill.domainPatterns[0])} width="20" height="20" alt="" class="rounded mt-0.5" />
					<div class="flex-1 min-w-0 space-y-1">
						<h4 class="text-sm font-semibold text-foreground">${skill.name}</h4>
						<div class="text-xs text-muted-foreground font-mono break-words">
							${skill.domainPatterns.join(", ")}
						</div>
						<p class="text-xs text-muted-foreground">${skill.shortDescription}</p>
						<div class="flex gap-2 pt-1">
							${Button({
								variant: "outline",
								size: "sm",
								onClick: () => this.editSkill(skill),
								children: "Edit",
							})}
							<button
								type="button"
								class="h-8 rounded-md px-3 text-xs font-medium text-destructive hover:bg-destructive/10 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
								@click=${() => this.deleteSkill(skill)}
							>
								Delete
							</button>
						</div>
					</div>
				</div>
			</div>
		`;
	}

	renderSkillEditor(skill: Skill) {
		return html`
			<div class="border border-border rounded-lg p-4 bg-card space-y-4">
				<h3 class="font-semibold text-foreground">Edit Skill: ${skill.name}</h3>

				${Input({
					label: "Name (cannot be changed)",
					type: "text",
					value: skill.name,
					disabled: true,
				})}

				${Input({
					label: "Domain Patterns (comma-separated)",
					type: "text",
					value: skill.domainPatterns.join(", "),
					onInput: (e) => {
						const value = (e.target as HTMLInputElement).value;
						const patterns = value
							.split(",")
							.map((p) => p.trim())
							.filter((p) => p.length > 0);
						this.updateEditField("domainPatterns", patterns);
					},
				})}

				${Input({
					label: "Short Description",
					type: "text",
					value: skill.shortDescription,
					onInput: (e) => this.updateEditField("shortDescription", (e.target as HTMLInputElement).value),
				})}

				<div class="space-y-2">
					<label class="text-sm font-medium text-foreground">Description (Markdown)</label>
					<textarea
						class="w-full min-h-[100px] px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
						.value=${skill.description}
						@input=${(e: Event) => this.updateEditField("description", (e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>

				<div class="space-y-2">
					<label class="text-sm font-medium text-foreground">Examples (JavaScript)</label>
					<textarea
						class="w-full min-h-[100px] px-3 py-2 text-xs text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
						.value=${skill.examples}
						@input=${(e: Event) => this.updateEditField("examples", (e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>

				<div class="space-y-2">
					<label class="text-sm font-medium text-foreground">Library Code</label>
					<textarea
						class="w-full min-h-[200px] px-3 py-2 text-xs text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
						.value=${skill.library}
						@input=${(e: Event) => this.updateEditField("library", (e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>

				<div class="flex justify-end gap-2">
					${Button({
						variant: "outline",
						onClick: () => this.cancelEdit(),
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						onClick: () => this.saveEdit(),
						children: "Save",
					})}
				</div>
			</div>
		`;
	}

	renderConflictResolution() {
		return html`
			<div class="border border-border rounded-lg p-4 bg-card space-y-4">
				<h3 class="font-semibold text-foreground">Import Conflicts</h3>
				<p class="text-sm text-muted-foreground">
					The following skills already exist. Check the skills you want to overwrite:
				</p>

				<div class="space-y-2">
					${this.importConflicts.map(
						(conflict, index) => html`
						<label class="flex items-start gap-3 p-3 border border-border rounded cursor-pointer hover:bg-muted/50">
							<input
								type="checkbox"
								.checked=${conflict.selected}
								@change=${() => this.toggleConflictSelection(index)}
								class="mt-1"
							/>
							<div class="flex-1">
								<div class="font-medium text-foreground">${conflict.skill.name}</div>
								<div class="text-xs text-muted-foreground">${conflict.skill.domainPatterns.join(", ")}</div>
								<div class="text-sm text-muted-foreground mt-1">${conflict.skill.shortDescription}</div>
							</div>
						</label>
					`,
					)}
				</div>

				<div class="flex justify-end gap-2">
					${Button({
						variant: "outline",
						onClick: () => this.cancelImport(),
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						onClick: () => this.performImport(this.importedSkills),
						children: "Import Selected",
					})}
				</div>
			</div>
		`;
	}

	/** Every library skill: bundled with Tabkyra, then the community skills this browser receives. */
	private renderLibrary(): TemplateResult {
		const community = communityLibrary(this.community, new Set());
		const siteNames = new Set(this.skills.map((s) => s.name));
		const rows = libraryRows(LIBRARY_SKILLS, community, this.searchQuery, siteNames);
		const total = libraryRows(LIBRARY_SKILLS, community, "", siteNames).length;
		return html`
			<section class="flex flex-col gap-2" aria-labelledby="library-skills-heading">
				<div>
					<h3 id="library-skills-heading" class="text-sm font-semibold text-foreground mb-1">
						Library <span class="font-normal text-muted-foreground">· ${this.searchQuery ? `${rows.length} of ${total}` : total}</span>
					</h3>
					<p class="text-xs text-muted-foreground">
						Type / in the chat to run one. <code class="font-mono">tabkyra skill install</code> also installs them for Claude Code, Codex and OpenCode.
					</p>
				</div>
				${
					rows.length === 0
						? html`<p class="text-sm text-muted-foreground py-2">No library skill matches.</p>`
						: html`<ul class="flex flex-col divide-y divide-border rounded-lg border border-border" data-testid="library-skills">
								${rows.map(
									(row) => html`<li class="flex flex-col gap-0.5 px-3 py-2" data-skill=${row.name}>
										<span class="flex items-center gap-2">
											<span class="font-mono text-sm text-foreground">/${row.name}</span>
											${row.source === "community" ? html`<span class="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">community</span>` : nothing}
										</span>
										<span class="text-xs text-muted-foreground line-clamp-2" title=${row.description}>${row.summary}</span>
										${row.sharesNameWithSiteSkill ? html`<span class="text-[11px] text-muted-foreground">A site skill has this name; on its sites, /${row.name} runs the site skill.</span>` : nothing}
									</li>`,
								)}
							</ul>`
				}
			</section>
		`;
	}

	render() {
		// Show conflict resolution UI if there are conflicts
		if (this.importConflicts.length > 0) {
			return html`
				<div class="flex flex-col gap-6">
					${this.renderConflictResolution()}
				</div>
			`;
		}

		return html`
			<div class="flex flex-col gap-5">
				<input
					type="search"
					aria-label="Find a skill"
					placeholder="Find a skill"
					.value=${this.searchQuery}
					@input=${(e: Event) => this.onSearchInput(e)}
					class="w-full h-9 px-3 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				/>

				${this.renderLibrary()}

				<section class="flex flex-col gap-3 pt-5 border-t border-border" aria-labelledby="site-skills-heading">
					<div>
						<h3 id="site-skills-heading" class="text-sm font-semibold text-foreground mb-1">
							Site skills <span class="font-normal text-muted-foreground">· ${this.searchQuery ? `${this.filteredSkills.length} of ${this.skills.length}` : this.skills.length}</span>
						</h3>
						<p class="text-xs text-muted-foreground">JavaScript helpers the agent loads on the sites they name.</p>
					</div>
					<div class="flex gap-2">
						${Button({ variant: "outline", size: "sm", onClick: () => this.exportSkills(), children: "Export" })}
						${Button({ variant: "outline", size: "sm", onClick: () => this.importSkills(), children: "Import" })}
					</div>
					${
						this.filteredSkills.length === 0
							? html`<p class="text-sm text-muted-foreground py-2">
									${this.searchQuery ? "No site skill matches." : "No site skills yet. Record one from the side panel's More menu."}
								</p>`
							: html`<div class="flex flex-col gap-2">
									${this.filteredSkills.map((skill) =>
										this.editingSkill && this.editingSkill.name === skill.name
											? this.renderSkillEditor(this.editingSkill)
											: this.renderSkillInfo(skill),
									)}
								</div>`
					}
				</section>

				<div class="pt-5 border-t border-border">${this.renderCommunity()}</div>
			</div>
		`;
	}
}

customElements.define("skills-tab", SkillsTab);
