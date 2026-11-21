import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { probeUserScripts } from "../browser/userscripts-status.js";
import {
	change,
	load,
	removed,
	type SiteEdit,
	type SiteEditsState,
	STORAGE_KEY,
	switched,
} from "../site-edits/store.js";

const KIND_LABEL: Record<SiteEdit["kind"], string> = { hide: "Hides", block: "Blocks", script: "Script" };

/**
 * Settings > Sites: what agents (or you) changed on each site, every one undoable, ad blocking, and scripts waiting for
 * your OK. A switch here is the only way a script turns on.
 */
@customElement("site-edits-tab")
export class SiteEditsTab extends SettingsTab {
	@state() private state: SiteEditsState = { edits: [], adBlock: false };
	@state() private scriptsReady = true;
	@state() private open = new Set<string>();

	private storageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area === "local" && changes[STORAGE_KEY]) void this.load();
	};

	getTabName(): string {
		return "Sites";
	}

	override async connectedCallback() {
		super.connectedCallback();
		chrome.storage.onChanged.addListener(this.storageListener);
		await this.load();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		chrome.storage.onChanged.removeListener(this.storageListener);
	}

	private async load() {
		this.state = await load();
		if (this.state.edits.some((e) => e.kind === "script"))
			this.scriptsReady = (await probeUserScripts()).state === "ready";
	}

	private async setAdBlock(on: boolean) {
		await change((s) => ({ state: { ...s, adBlock: on }, result: undefined }));
	}

	/** The person's click: the one path that turns a script on. */
	private async setOn(id: string, on: boolean) {
		await change((s) => ({ state: switched(s, id, on, "person"), result: undefined }));
	}

	private async removeEdit(id: string) {
		await change((s) => ({ state: removed(s, id), result: undefined }));
	}

	private toggleOpen(id: string) {
		const next = new Set(this.open);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		this.open = next;
	}

	private row(e: SiteEdit): TemplateResult {
		const waiting = e.kind === "script" && !e.on;
		const shown = this.open.has(e.id);
		const by = e.addedBy === "you" ? "you" : e.addedBy.replace(/^agent:/, "");
		return html`
			<div class="py-2 border-b border-border last:border-b-0">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0 space-y-0.5">
						<div class="text-sm text-foreground">
							<span class="font-medium">${KIND_LABEL[e.kind]}</span>
							${e.note ? html`<span>: ${e.note}</span>` : ""}
						</div>
						<div class="text-xs text-muted-foreground">
							Added by ${by}${waiting ? html` · <span class="text-foreground">waiting for you</span>` : ""}
						</div>
						${
							e.kind === "script"
								? html`<button class="text-xs underline text-muted-foreground" @click=${() => this.toggleOpen(e.id)}>
										${shown ? "Hide code" : "Read the code"}
									</button>`
								: html`<code class="block text-xs text-muted-foreground truncate" title=${e.value}>${e.value}</code>`
						}
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<input
							type="checkbox"
							role="switch"
							class="tk-switch"
							aria-label=${`${KIND_LABEL[e.kind]} on ${e.host}`}
							.checked=${e.on}
							@change=${(ev: Event) => this.setOn(e.id, (ev.target as HTMLInputElement).checked)}
						/>
						${Button({ size: "sm", variant: "ghost", children: "Remove", onClick: () => this.removeEdit(e.id) })}
					</div>
				</div>
				${
					e.kind === "script" && shown
						? html`
							<pre class="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-xs text-foreground whitespace-pre-wrap">${e.value}</pre>
							<p class="mt-1 text-xs text-muted-foreground">
								It runs on ${e.host} after each page loads, signed in as you. Turn it on only if you'd run this code yourself.
							</p>`
						: ""
				}
			</div>
		`;
	}

	render(): TemplateResult {
		const sites = [...new Set(this.state.edits.map((e) => e.host))].sort();
		const waiting = this.state.edits.filter((e) => e.kind === "script" && !e.on).length;
		return html`
			<div class="flex flex-col gap-5">
				<div class="space-y-1">
					<h3 class="text-lg font-semibold text-foreground">Site edits</h3>
					<p class="text-sm text-muted-foreground">
						What agents changed on each site, applied on every visit. Ask one to hide something, block it, or clean a page up.
					</p>
				</div>

				<label class="flex items-start justify-between gap-3 text-sm text-foreground cursor-pointer">
					<span class="space-y-0.5">
						<span class="block">Block ads</span>
						<span class="block text-xs text-muted-foreground">Requests to known ad networks, on every site. Sites that serve their own ads, like YouTube, still show them.</span>
					</span>
					<input
						type="checkbox"
						role="switch"
						class="tk-switch"
						.checked=${this.state.adBlock}
						@change=${(e: Event) => this.setAdBlock((e.target as HTMLInputElement).checked)}
					/>
				</label>

				${
					waiting
						? html`<p class="text-sm text-foreground">
								${waiting === 1 ? "A script is" : `${waiting} scripts are`} waiting for you. Read the code before you turn one on.
							</p>`
						: ""
				}
				${
					waiting && !this.scriptsReady
						? html`<p class="text-xs text-muted-foreground">
								Scripts need user scripts allowed: Settings > Agents > Page scripts.
							</p>`
						: ""
				}
				${
					sites.length
						? sites.map(
								(host) => html`
									<div class="space-y-1">
										<div class="text-sm font-medium text-foreground">${host}</div>
										<div>${this.state.edits.filter((e) => e.host === host).map((e) => this.row(e))}</div>
									</div>
								`,
							)
						: html`<p class="text-sm text-muted-foreground">No site edits yet.</p>`
				}
			</div>
		`;
	}
}
