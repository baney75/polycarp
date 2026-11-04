import { icon } from "@mariozechner/mini-lit";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { getAppStorage, type SessionData, type SessionMetadata } from "@mariozechner/pi-web-ui";
import Fuse from "fuse.js";
import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Download, FileDown, FileUp, Pencil, Trash2 } from "lucide";
import "../components/HeaderMenu.js";
import type { HeaderMenuItem } from "../components/HeaderMenu.js";
import { Toast } from "../components/Toast.js";

type ExportedSession = {
	session: SessionData;
	metadata: SessionMetadata;
};

@customElement("tabkyra-session-list-dialog")
export class TabkyraSessionListDialog extends DialogBase {
	@state() private sessions: SessionMetadata[] = [];
	@state() private loading = true;
	@state() private searchQuery = "";
	/** The row whose title is being edited in place. */
	@state() private renamingId?: string;

	private onSelectCallback?: (sessionId: string) => void;
	private onDeleteCallback?: (sessionId: string) => void;
	private onRenameCallback?: (sessionId: string, title: string) => void;
	private currentId?: string;
	private deletedSessions = new Set<string>();
	private closedViaSelection = false;

	protected modalWidth = "min(600px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(
		onSelect: (sessionId: string) => void,
		onDelete?: (sessionId: string) => void,
		onRename?: (sessionId: string, title: string) => void,
		currentId?: string,
	) {
		const dialog = new TabkyraSessionListDialog();
		dialog.onSelectCallback = onSelect;
		dialog.onDeleteCallback = onDelete;
		dialog.onRenameCallback = onRename;
		dialog.currentId = currentId;
		dialog.open();
		// Typing finds a chat at once; Enter opens the top match.
		await dialog.updateComplete;
		dialog.querySelector<HTMLInputElement>("input[type=search]")?.focus();
		await dialog.loadSessions();
	}

	private async loadSessions() {
		this.loading = true;
		try {
			// Load sessions (already sorted by lastModified index)
			const storage = getAppStorage();
			this.sessions = await storage.sessions.getAllMetadata();
		} catch (err) {
			console.error("Failed to load sessions:", err);
			this.sessions = [];
		} finally {
			this.loading = false;
		}
	}

	/** Deletes at once and offers Undo, instead of a browser confirm box for every chat. */
	private async handleDelete(sessionId: string) {
		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;
			const data = await storage.sessions.loadSession(sessionId);
			const metadata = this.sessions.find((s) => s.id === sessionId);
			await storage.sessions.deleteSession(sessionId);
			this.deletedSessions.add(sessionId);
			await this.loadSessions();
			const title = metadata?.title || i18n("Untitled chat");
			Toast.show(i18n("Deleted “{title}”").replace("{title}", title), "info", 8000, {
				label: i18n("Undo"),
				run: () => {
					if (!data || !metadata) return;
					void storage.sessions
						.save(data, metadata)
						.then(() => {
							this.deletedSessions.delete(sessionId);
							return this.loadSessions();
						})
						.catch((err) => console.error("Failed to restore session:", err));
				},
			});
		} catch (err) {
			console.error("Failed to delete session:", err);
			Toast.error(i18n("Could not delete the chat"));
		}
	}

	private async saveRename(sessionId: string, value: string) {
		const title = value.trim();
		this.renamingId = undefined;
		const current = this.sessions.find((s) => s.id === sessionId);
		if (!title || !current || title === current.title) return;
		try {
			await getAppStorage().sessions.updateTitle(sessionId, title);
			await this.loadSessions();
			this.onRenameCallback?.(sessionId, title);
		} catch (err) {
			console.error("Failed to rename session:", err);
			Toast.error(i18n("Could not rename the chat"));
		}
	}

	private async startRename(sessionId: string) {
		this.renamingId = sessionId;
		await this.updateComplete;
		const input = this.querySelector<HTMLInputElement>(
			`[data-session="${CSS.escape(sessionId)}"] input[data-rename]`,
		);
		input?.focus();
		input?.select();
	}

	override close() {
		super.close();

		// Only notify about deleted sessions if dialog wasn't closed via selection
		if (!this.closedViaSelection && this.onDeleteCallback && this.deletedSessions.size > 0) {
			for (const sessionId of this.deletedSessions) {
				this.onDeleteCallback(sessionId);
			}
		}
	}

	private handleSelect(sessionId: string) {
		this.closedViaSelection = true;
		if (this.onSelectCallback) {
			this.onSelectCallback(sessionId);
		}
		this.close();
	}

	private formatDate(isoString: string): string {
		const date = new Date(isoString);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (days === 0) {
			return i18n("Today");
		}
		if (days === 1) {
			return i18n("Yesterday");
		}
		if (days < 7) {
			return i18n("{days} days ago").replace("{days}", days.toString());
		}
		return date.toLocaleDateString();
	}

	private async handleExport(sessionId?: string) {
		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			const exported: ExportedSession[] = [];

			if (sessionId) {
				// Export single session
				const session = await storage.sessions.loadSession(sessionId);
				const metadata = this.sessions.find((s) => s.id === sessionId);
				if (session && metadata) {
					exported.push({ session, metadata });
				}
			} else {
				// Export all sessions
				for (const metadata of this.sessions) {
					const session = await storage.sessions.loadSession(metadata.id);
					if (session) {
						exported.push({ session, metadata });
					}
				}
			}

			// Always export as array
			const blob = new Blob([JSON.stringify(exported, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			const filename = sessionId
				? `tabkyra-session-${exported[0]?.metadata.title?.replace(/[^a-z0-9]/gi, "-").toLowerCase() || "export"}.json`
				: `tabkyra-sessions-${new Date().toISOString().split("T")[0]}.json`;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error("Failed to export sessions:", err);
			alert(i18n("Export failed. Check console for details."));
		}
	}

	private getFilteredSessions(): SessionMetadata[] {
		if (!this.searchQuery.trim()) {
			return this.sessions;
		}

		// Use Fuse.js for fuzzy search
		const fuse = new Fuse(this.sessions, {
			keys: ["title", "preview"],
			threshold: 0.4, // 0 = exact match, 1 = match anything
			ignoreLocation: true,
			minMatchCharLength: 2,
		});

		const results = fuse.search(this.searchQuery);
		return results.map((result) => result.item);
	}

	private async handleDeleteAll() {
		if (this.sessions.length === 0) {
			alert(i18n("No sessions to delete"));
			return;
		}

		const confirmed = confirm(
			i18n(`Delete ALL {count} sessions? This cannot be undone!`).replace(
				"{count}",
				this.sessions.length.toString(),
			),
		);

		if (!confirmed) return;

		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			for (const session of this.sessions) {
				await storage.sessions.deleteSession(session.id);
				this.deletedSessions.add(session.id);
			}

			await this.loadSessions();
		} catch (err) {
			console.error("Failed to delete all sessions:", err);
			alert(i18n("Failed to delete sessions. Check console for details."));
		}
	}

	private async handleDeleteOlderThan(days: number) {
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - days);
		const cutoffISO = cutoffDate.toISOString();

		const oldSessions = this.sessions.filter((s) => s.lastModified < cutoffISO);

		if (oldSessions.length === 0) {
			alert(i18n(`No sessions older than {days} days`).replace("{days}", days.toString()));
			return;
		}

		const confirmed = confirm(
			i18n(`Delete {count} sessions older than {days} days?`)
				.replace("{count}", oldSessions.length.toString())
				.replace("{days}", days.toString()),
		);

		if (!confirmed) return;

		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			for (const session of oldSessions) {
				await storage.sessions.deleteSession(session.id);
				this.deletedSessions.add(session.id);
			}

			await this.loadSessions();
		} catch (err) {
			console.error("Failed to delete old sessions:", err);
			alert(i18n("Failed to delete sessions. Check console for details."));
		}
	}

	private async handleImport() {
		try {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = "application/json";
			input.onchange = async (e: Event) => {
				const file = (e.target as HTMLInputElement).files?.[0];
				if (!file) return;

				const text = await file.text();
				const importData = JSON.parse(text);

				// Import expects array of ExportedSession
				const sessionsToImport: ExportedSession[] = importData;

				// Validate format
				if (!sessionsToImport.every((s) => s.session && s.metadata)) {
					alert(i18n("Invalid import file format"));
					return;
				}

				const storage = getAppStorage();
				if (!storage.sessions) return;

				// Check for duplicates
				const existingIds = new Set(this.sessions.map((s) => s.id));
				const duplicates = sessionsToImport.filter((s) => existingIds.has(s.metadata.id));

				let duplicateAction: "skip" | "overwrite" | null = null;
				if (duplicates.length > 0) {
					const choice = confirm(
						i18n(`Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.`).replace(
							"{count}",
							duplicates.length.toString(),
						),
					);
					duplicateAction = choice ? "overwrite" : "skip";
				}

				let imported = 0;
				let skipped = 0;

				// Set import time to now, with offsets to preserve order
				const baseTime = new Date();

				for (let i = 0; i < sessionsToImport.length; i++) {
					const { session, metadata } = sessionsToImport[i];
					try {
						const isDuplicate = existingIds.has(metadata.id);

						if (isDuplicate && duplicateAction === "skip") {
							skipped++;
							continue;
						}

						// Set timestamps to now with offset based on position
						// First session gets most recent time, subsequent ones get older
						const offsetSeconds = i * 10; // 10 second intervals
						const importTime = new Date(baseTime.getTime() - offsetSeconds * 1000);
						const importTimeISO = importTime.toISOString();

						// Update metadata timestamps
						const updatedMetadata = {
							...metadata,
							lastModified: importTimeISO,
							createdAt: importTimeISO,
						};

						// Save with updated metadata
						await storage.sessions.save(session, updatedMetadata);
						imported++;
					} catch (err) {
						console.error(`Failed to import session ${metadata.title}:`, err);
					}
				}

				const message =
					skipped > 0
						? i18n(`Imported {imported} sessions, skipped {skipped} duplicates`)
								.replace("{imported}", imported.toString())
								.replace("{skipped}", skipped.toString())
						: i18n(`Imported {count} sessions`).replace("{count}", imported.toString());

				alert(message);
				await this.loadSessions();
			};
			input.click();
		} catch (err) {
			console.error("Failed to import sessions:", err);
			alert(i18n("Import failed. Check console for details."));
		}
	}

	private menuItems(): HeaderMenuItem[] {
		return [
			{ label: i18n("Import chats"), icon: FileUp, run: () => this.handleImport() },
			{ label: i18n("Export all chats"), icon: FileDown, run: () => this.handleExport() },
			{
				label: i18n("Delete chats older than 30 days"),
				icon: Trash2,
				separator: true,
				run: () => this.handleDeleteOlderThan(30),
			},
			{ label: i18n("Delete chats older than 90 days"), icon: Trash2, run: () => this.handleDeleteOlderThan(90) },
			{ label: i18n("Delete all chats"), icon: Trash2, run: () => this.handleDeleteAll() },
		];
	}

	private rowAction(label: string, iconNode: typeof Pencil, action: string, run: () => void, danger = false) {
		return html`<button
			type="button"
			class="tk-icon-btn ${danger ? "hover:!text-destructive" : ""}"
			aria-label=${label}
			data-tip=${label}
			data-action=${action}
			@click=${run}
		>
			${icon(iconNode, "sm")}
		</button>`;
	}

	private renderRow(session: SessionMetadata) {
		const cost = session.usage.cost.total;
		const current = session.id === this.currentId;
		const meta = [
			this.formatDate(session.lastModified),
			`${session.messageCount} ${i18n("messages")}`,
			cost > 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		const renaming = this.renamingId === session.id;
		return html`
			<li data-session=${session.id} class="flex items-start gap-1 rounded-lg border ${current ? "border-[var(--tk-brass)]/60" : "border-border"} hover:bg-secondary/50">
				${
					renaming
						? html`<div class="flex-1 min-w-0 p-2">
								<input
									data-rename
									type="text"
									aria-label=${i18n("Chat name")}
									.value=${session.title}
									class="w-full h-9 px-2 text-sm rounded-md border border-input bg-background text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									@keydown=${(e: KeyboardEvent) => {
										if (e.key === "Enter")
											void this.saveRename(session.id, (e.target as HTMLInputElement).value);
										else if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											this.renamingId = undefined;
										}
									}}
									@blur=${(e: FocusEvent) => void this.saveRename(session.id, (e.target as HTMLInputElement).value)}
								/>
							</div>`
						: html`<button
								type="button"
								class="flex-1 min-w-0 text-left px-3 py-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
								@click=${() => this.handleSelect(session.id)}
							>
								<div class="flex items-center gap-2">
									<span class="font-medium text-sm text-foreground truncate">${session.title || i18n("Untitled chat")}</span>
									${current ? html`<span class="shrink-0 text-[11px] font-semibold text-[var(--tk-brass-text)]">${i18n("Open now")}</span>` : nothing}
								</div>
								<div class="text-xs text-muted-foreground mt-0.5">${meta}</div>
								${session.preview ? html`<div class="text-xs text-muted-foreground mt-1 line-clamp-1">${session.preview}</div>` : nothing}
							</button>`
				}
				<div class="flex shrink-0 gap-0.5 p-1.5 tk-tips-end">
					${this.rowAction(i18n("Rename"), Pencil, "rename", () => void this.startRename(session.id))}
					${this.rowAction(i18n("Export"), Download, "export", () => void this.handleExport(session.id))}
					${this.rowAction(i18n("Delete"), Trash2, "delete", () => void this.handleDelete(session.id), true)}
				</div>
			</li>
		`;
	}

	protected override renderContent() {
		const filteredSessions = this.getFilteredSessions();

		return html`
			${DialogContent({
				className: "h-full flex flex-col",
				children: html`
					${DialogHeader({ title: i18n("Past chats") })}

					<div class="mt-3 flex items-center gap-1.5">
					<input
						type="search"
						aria-label=${i18n("Search chats")}
						placeholder=${i18n("Search chats")}
						.value=${this.searchQuery}
						@input=${(e: InputEvent) => {
							this.searchQuery = (e.target as HTMLInputElement).value;
						}}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter" && !e.isComposing) {
								const top = this.getFilteredSessions()[0];
								if (top) this.handleSelect(top.id);
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								this.querySelector<HTMLElement>("li[data-session] button")?.focus();
							}
						}}
						class="flex-1 min-w-0 h-9 px-3 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
						<tk-header-menu .items=${this.menuItems()} label=${i18n("More actions")}></tk-header-menu>
					</div>

					<ul class="flex-1 overflow-y-auto mt-3 space-y-2" aria-label=${i18n("Past chats")}>
						${
							this.loading
								? html`<li class="text-center py-8 text-sm text-muted-foreground">${i18n("Loading...")}</li>`
								: filteredSessions.length === 0
									? html`<li class="text-center py-8 text-sm text-muted-foreground">
											${this.searchQuery ? i18n("No matching chats") : i18n("No chats yet")}
										</li>`
									: filteredSessions.map((session) => this.renderRow(session))
						}
					</ul>
				`,
			})}
		`;
	}
}
