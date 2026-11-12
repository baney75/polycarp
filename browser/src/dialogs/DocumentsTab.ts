import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import type { DocumentService } from "../documents/service.js";
import type { DocMeta } from "../documents/store.js";

const size = (n: number) =>
	n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Settings > Privacy > Documents: what the document store holds on this computer, and buttons to delete one or all.
 * The agents' documents never leave the machine; this is where the person sees them.
 */
@customElement("tabkyra-documents-tab")
export class DocumentsTab extends SettingsTab {
	@state() private docs: DocMeta[] = [];
	@state() private loaded = false;

	constructor(private readonly service: () => Promise<DocumentService>) {
		super();
	}

	getTabName(): string {
		return "Documents";
	}

	async connectedCallback() {
		super.connectedCallback();
		await this.load();
	}

	private async load() {
		try {
			this.docs = await (await this.service()).list();
		} catch {
			this.docs = [];
		}
		this.loaded = true;
	}

	private async deleteDoc(m: DocMeta) {
		if (!confirm(`Delete "${m.title}" from the document store?`)) return;
		await (await this.service()).remove(m.id);
		await this.load();
		Toast.success("Deleted.");
	}

	private async clearAll() {
		if (!confirm(`Delete all ${this.docs.length} stored documents? Chats keep what they already read.`)) return;
		await (await this.service()).clear();
		await this.load();
		Toast.success("The document store is empty.");
	}

	render(): TemplateResult {
		const total = this.docs.reduce((n, m) => n + m.bytes, 0);
		return html`
			<div class="space-y-2">
				<p class="text-xs text-muted-foreground">
					Files the agents brought in to search and read: on this computer only, in this browser profile's own
					storage. Nothing here is uploaded.
				</p>
				${
					!this.loaded
						? ""
						: this.docs.length === 0
							? html`<p class="text-sm text-muted-foreground">No documents stored.</p>`
							: html`
								<p class="text-xs text-muted-foreground">
									${this.docs.length} document${this.docs.length === 1 ? "" : "s"}, ${size(total)}.
								</p>
								<ul class="flex flex-col gap-1">
									${this.docs.map(
										(m) => html`<li class="flex items-center justify-between gap-2 text-sm text-foreground">
											<span class="min-w-0 truncate" title=${m.url || m.fileName}
												>${m.title}
												<span class="text-xs text-muted-foreground"
													>${m.format.toUpperCase()}, ${m.units} ${m.kind}s, ${size(m.bytes)}</span
												></span
											>
											${Button({ size: "sm", variant: "ghost", onClick: () => this.deleteDoc(m), children: "Delete" })}
										</li>`,
									)}
								</ul>
								${Button({ size: "sm", variant: "secondary", onClick: () => this.clearAll(), children: "Delete all documents" })}
							`
				}
			</div>
		`;
	}
}
