import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { hostCommand } from "../bridge/host-command.js";
import {
	allowHost,
	getAllowedHosts,
	getPendingRequests,
	getPermissionMode,
	isBridgeEnabled,
	normalizeHostInput,
	type PendingRequest,
	type PermissionMode,
	recordDecision,
	revokeHost,
	setBridgeEnabled,
	setPermissionMode,
} from "../bridge/permissions.js";
import type { UserScriptsStatus } from "../bridge/protocol.js";
import { listSessions } from "../browser/session.js";
import { probeUserScripts, userScriptsHiddenHelp } from "../browser/userscripts-status.js";
import { isVeilEnabled, setVeilEnabled } from "../browser/veil-shared.js";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { runningFromStore } from "../update/store-install.js";

/**
 * Settings > Agents: who may drive the browser from outside (omp, pi, Claude
 * Code, Codex through `tabkyra mcp`), which hosts they may open, and pending
 * permission requests.
 */
const fileSize = (n: number) =>
	n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;

@customElement("bridge-tab")
export class BridgeTab extends SettingsTab {
	@state() private enabled = true;
	@state() private veil = true;
	@state() private mode: PermissionMode = "ask";
	@state() private hosts: string[] = [];
	@state() private pending: PendingRequest[] = [];
	@state() private sessions: Array<{ id: string; label: string; tabs: number }> = [];
	@state() private newHost = "";
	@state() private newHostError = "";
	@state() private userScripts?: UserScriptsStatus;
	@state() private userScriptsNote = "";

	private storageListener = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area === "session" || area === "local") this.load();
	};

	getTabName(): string {
		return "Agents";
	}

	private permissionListener = () => this.load();

	override async connectedCallback() {
		super.connectedCallback();
		chrome.storage.onChanged.addListener(this.storageListener);
		chrome.permissions.onAdded.addListener(this.permissionListener);
		chrome.permissions.onRemoved.addListener(this.permissionListener);
		await this.load();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		chrome.storage.onChanged.removeListener(this.storageListener);
		chrome.permissions.onAdded.removeListener(this.permissionListener);
		chrome.permissions.onRemoved.removeListener(this.permissionListener);
	}

	private async load() {
		this.enabled = await isBridgeEnabled();
		this.veil = await isVeilEnabled();
		this.mode = await getPermissionMode();
		this.hosts = await getAllowedHosts();
		this.pending = await getPendingRequests();
		this.sessions = (await listSessions())
			.filter((s) => s.id.startsWith("bridge-"))
			.map((s) => ({ id: s.id, label: s.label, tabs: s.tabIds.length }));
		const userScripts = await probeUserScripts();
		// A note answers one click; it goes once the state moves on.
		if (userScripts.state !== this.userScripts?.state) this.userScriptsNote = "";
		this.userScripts = userScripts;
	}

	/**
	 * Called straight from the click: chrome.permissions.request must be the first await to keep
	 * the user gesture. No extension reload here: that would cut off every agent session.
	 */
	private async grantUserScripts() {
		let note = "";
		try {
			const granted = await chrome.permissions.request({ permissions: ["userScripts"] });
			if (!granted) note = "The browser did not grant the permission. Click Allow again and accept the prompt.";
		} catch (err) {
			note = `Couldn't ask for the permission: ${err instanceof Error ? err.message : String(err)}`;
		}
		await this.load();
		this.userScriptsNote = note;
	}

	private renderUserScripts(): TemplateResult {
		const status = this.userScripts;
		if (!status) return html``;
		const line = (text: string) => html`<div class="text-xs text-muted-foreground">${text}</div>`;
		/** The detail stays one click away, for the person who needs the browser's own wording. */
		const details = (text: string) => html`
			<details class="text-xs text-muted-foreground">
				<summary class="cursor-pointer text-foreground">Details</summary>
				<p class="mt-1">${text}</p>
			</details>
		`;
		let body: TemplateResult;
		switch (status.state) {
			case "ready":
				body = html`${line("On: agents' page scripts run faster.")}${details("Agents run page scripts through the browser's userScripts API.")}`;
				break;
			case "not_granted":
				body = html`
					${line("Turning this on makes agents' page scripts run faster.")}
					<div>${Button({ size: "sm", variant: "secondary", children: "Allow", onClick: () => this.grantUserScripts() })}</div>
					${details(
						'Polycarp has not been granted the userScripts permission. The "Allow user scripts" toggle on the extension\'s Details page is not enough on its own. Without it, page scripts run through the debugger, which is slower.',
					)}
				`;
				break;
			case "toggle_off":
				body = html`
					${line("Page scripts are slower than they could be: one more switch is needed in the browser.")}
					${details(
						status.apiPresent
							? 'The permission is granted, but "Allow user scripts" is off. Turn it on at chrome://extensions > Polycarp > Details.'
							: userScriptsHiddenHelp(runningFromStore(), hostCommand()),
					)}
				`;
				break;
			case "probe_error":
				body = line(`Couldn't check: ${status.error ?? "unknown error"}`);
				break;
		}
		return html`
			<div class="space-y-2">
				<div class="text-sm font-medium text-foreground">Page scripts</div>
				${body}
				${this.userScriptsNote ? line(this.userScriptsNote) : ""}
			</div>
		`;
	}

	private async decide(request: PendingRequest, decision: "allow_once" | "allow_host" | "deny") {
		await recordDecision(request.requestId, decision);
		await this.load();
	}

	private async addHost() {
		if (!this.newHost.trim()) return;
		const result = normalizeHostInput(this.newHost);
		if ("error" in result) {
			this.newHostError = result.error;
			return;
		}
		await allowHost(result.host);
		this.newHost = "";
		this.newHostError = "";
		await this.load();
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-5">
				<div class="space-y-1">
					<h3 class="text-lg font-semibold text-foreground">Agents</h3>
					<p class="text-sm text-muted-foreground">
						Lets coding agents on this computer (Claude Code, Codex, omp, pi) drive the browser through
						Polycarp. Each agent gets its own tab group and works in the background.
					</p>
				</div>
				${agentSetupPromptButton()}

				<label class="flex items-start justify-between gap-3 text-sm text-foreground cursor-pointer">
					<span>Allow external agents to use the browser</span>
					<input
						type="checkbox"
						role="switch"
						class="tk-switch"
						.checked=${this.enabled}
						@change=${async (e: Event) => {
							await setBridgeEnabled((e.target as HTMLInputElement).checked);
							await this.load();
						}}
					/>
				</label>

				<label class="flex items-start justify-between gap-3 text-sm text-foreground cursor-pointer">
					<span class="space-y-1">
						<span class="block">Show when an agent is using a tab</span>
						<span class="block text-xs text-muted-foreground">
							A soft glow in the group's color and a small label at the top of the page while an agent
							works in it. Clicks go through to the page; Take over in the label gives you the tab back.
						</span>
					</span>
					<input
						type="checkbox"
						role="switch"
						class="tk-switch"
						.checked=${this.veil}
						@change=${async (e: Event) => {
							await setVeilEnabled((e.target as HTMLInputElement).checked);
							await this.load();
						}}
					/>
				</label>

				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Site access</div>
					<label class="flex items-start gap-2 text-sm text-foreground cursor-pointer">
						<input type="radio" name="bridge-mode" value="ask" .checked=${this.mode === "ask"} @change=${async () => {
							await setPermissionMode("ask");
							await this.load();
						}} />
						Ask before opening a new site (the agent prompts you, or you answer here)
					</label>
					<label class="flex items-start gap-2 text-sm text-foreground cursor-pointer">
						<input type="radio" name="bridge-mode" value="allow_all" .checked=${this.mode === "allow_all"} @change=${async () => {
							await setPermissionMode("allow_all");
							await this.load();
						}} />
						Always allow: agents can open any site except Polycarp's own pages, its approval page and its local services
					</label>
				</div>

				${
					this.pending.length > 0
						? html`
							<div class="space-y-2">
								<div class="text-sm font-medium text-foreground">Waiting for your answer</div>
								${this.pending.map(
									(p) => html`
										<div class="p-3 rounded-lg border border-orange-500/40 bg-orange-500/10 space-y-2">
											${
												p.upload
													? html`
														<div class="text-sm text-foreground"><span class="font-medium">${p.clientName}</span> wants to upload ${p.upload.files.length === 1 ? "a file from this computer" : `${p.upload.files.length} files from this computer`} to <span class="font-mono">${p.host}</span></div>
														<div class="text-xs text-muted-foreground break-all">${p.upload.files.map((f) => `${f.name} (${fileSize(f.bytes)})`).join(", ")}</div>
														<div class="flex gap-2 flex-wrap">
															${Button({ size: "sm", variant: "default", children: "Upload this once", onClick: () => this.decide(p, "allow_once") })}
															${Button({ size: "sm", variant: "outline", children: "Deny", onClick: () => this.decide(p, "deny") })}
														</div>
													`
													: html`
														<div class="text-sm text-foreground"><span class="font-medium">${p.clientName}</span> wants to open <span class="font-mono">${p.host}</span></div>
														<div class="text-xs text-muted-foreground break-all">${p.url}</div>
														<div class="flex gap-2 flex-wrap">
															${Button({ size: "sm", variant: "default", children: "Allow site", onClick: () => this.decide(p, "allow_host") })}
															${Button({ size: "sm", variant: "secondary", children: "Allow once", onClick: () => this.decide(p, "allow_once") })}
															${Button({ size: "sm", variant: "outline", children: "Deny", onClick: () => this.decide(p, "deny") })}
														</div>
													`
											}
										</div>
									`,
								)}
							</div>
						`
						: ""
				}

				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Allowed sites</div>
					${
						this.hosts.length === 0
							? html`<div class="text-xs text-muted-foreground">None yet. Sites you allow show up here; subdomains are included.</div>`
							: this.hosts.map(
									(h) => html`
										<div class="flex items-center justify-between gap-2 text-sm">
											<span class="font-mono text-foreground">${h}</span>
											${Button({
												size: "sm",
												variant: "ghost",
												children: "Remove",
												onClick: async () => {
													await revokeHost(h);
													await this.load();
												},
											})}
										</div>
									`,
								)
					}
					<div class="flex gap-2 items-center">
						${Input({
							placeholder: "example.com",
							value: this.newHost,
							className: "text-sm flex-1",
							onInput: (e: Event) => {
								this.newHost = (e.target as HTMLInputElement).value;
								this.newHostError = "";
							},
							onKeyDown: (e: KeyboardEvent) => {
								if (e.key === "Enter") this.addHost();
							},
						})}
						${Button({ size: "sm", variant: "secondary", children: "Add", onClick: () => this.addHost() })}
					</div>
					${this.newHostError ? html`<div class="text-xs text-destructive" role="alert">${this.newHostError}</div>` : ""}
				</div>

				${this.renderUserScripts()}

				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Agent sessions in this browser</div>
					${
						this.sessions.length === 0
							? html`<div class="text-xs text-muted-foreground">No external agent has connected since the browser started.</div>`
							: this.sessions.map(
									(s) =>
										html`<div class="text-sm text-foreground">${s.label} <span class="text-muted-foreground">(${s.tabs} tab${s.tabs === 1 ? "" : "s"})</span></div>`,
								)
					}
				</div>
			</div>
		`;
	}
}
