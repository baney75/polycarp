import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { deviceSetupPrompt, remoteSetupPrompt } from "../agent-setup-prompt.js";
import { Toast } from "../components/Toast.js";
import {
	connectApprovalCode,
	connectDeviceCode,
	connectJoinHub,
	connectSetBusy,
	connectStatus,
	isNoHost,
} from "../connect/client.js";
import { connectorUrl, countdown, lastSeen, linkCommand } from "../connect/format.js";
import type { ApprovalCode, ConnectStatus, DeviceCode } from "../connect/types.js";

const POLL_MS = 10_000;

function extensionVersion(): string {
	try {
		return chrome.runtime.getManifest().version;
	} catch {
		return "";
	}
}

async function copyText(text: string, done: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		Toast.success(done);
	} catch {
		Toast.error("Couldn't copy. Click the side panel first, then try again.");
	}
}

/**
 * Settings > Connect: use this browser from claude.ai, ChatGPT or grok.com, the devices behind one
 * connector, and joining a hub. Everything is asked of Tabkyra's helper (the native host) through
 * the background worker; the panel never holds a token or the passcode.
 */
@customElement("tabkyra-connect-tab")
export class ConnectTab extends SettingsTab {
	@state() private status?: ConnectStatus;
	@state() private noHost = false;
	@state() private error?: string;
	@state() private now = Date.now();
	@state() private approval?: ApprovalCode;
	@state() private device?: DeviceCode;
	@state() private minting?: "approval" | "device";
	@state() private codeError?: string;
	@state() private hubUrl = "";
	@state() private joinCode = "";
	@state() private joining?: string;
	@state() private joinMessage?: { ok: boolean; text: string };
	@state() private busyPending = false;
	private timer?: ReturnType<typeof setInterval>;
	private lastLoad = 0;
	private loading = false;

	getTabName(): string {
		return "Connect";
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.load();
		// One ticker: the countdown, and the 10-second refresh while this tab is the one showing.
		this.timer = setInterval(() => {
			this.now = Date.now();
			if (this.visible() && this.now - this.lastLoad >= POLL_MS) void this.load();
		}, 1000);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		clearInterval(this.timer);
	}

	private visible(): boolean {
		return this.isConnected && !this.closest("[hidden]") && !document.hidden;
	}

	private async load(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		try {
			this.status = await connectStatus();
			this.noHost = false;
			this.error = undefined;
		} catch (err) {
			if (isNoHost(err)) this.noHost = true;
			else this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.lastLoad = Date.now();
			this.loading = false;
		}
	}

	private async mint(kind: "approval" | "device"): Promise<void> {
		this.minting = kind;
		this.codeError = undefined;
		try {
			if (kind === "approval") this.approval = await connectApprovalCode();
			else this.device = await connectDeviceCode();
		} catch (err) {
			this.codeError = err instanceof Error ? err.message : String(err);
		} finally {
			this.minting = undefined;
		}
	}

	private async setBusy(busy: boolean): Promise<void> {
		this.busyPending = true;
		try {
			await connectSetBusy(busy);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		}
		this.busyPending = false;
		await this.load();
	}

	private async join(): Promise<void> {
		this.joinMessage = undefined;
		this.joining = "Checking the address and code...";
		try {
			const result = await connectJoinHub(this.hubUrl.trim(), this.joinCode.trim(), undefined, (step) => {
				this.joining = step === "service" ? "Starting the background service..." : "Contacting the hub...";
			});
			this.joinMessage = {
				ok: true,
				text: `Joined as ${result.name}. This computer now shows in your hub's device list.`,
			};
			this.joinCode = "";
		} catch (err) {
			if (isNoHost(err)) this.noHost = true;
			this.joinMessage = { ok: false, text: err instanceof Error ? err.message : String(err) };
		}
		this.joining = undefined;
		await this.load();
	}

	private command(label: string, text: string): TemplateResult {
		return html`
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-muted-foreground">${label}</span>
					<button
						type="button"
						class="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
						aria-label=${`Copy ${label}`}
						@click=${() => void copyText(text, "Copied.")}
					>
						Copy
					</button>
				</div>
				<code class="block rounded-md border border-border bg-muted px-2.5 py-2 text-foreground font-mono text-xs leading-5 break-words select-all [font-variant-ligatures:none]">${text}</code>
			</div>
		`;
	}

	/** A one-time code: large, monospace, with Copy and the time it has left. */
	private codeBox(code: string, expiresAt: number, label: string): TemplateResult {
		const left = countdown(expiresAt, this.now);
		return html`
			<div class="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3" data-code=${label}>
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-muted-foreground">${label}</span>
					${
						left
							? html`<span class="text-xs text-muted-foreground tabular-nums" role="timer" aria-label=${`Expires in ${left}`}>Expires in ${left}</span>`
							: html`<span class="text-xs font-medium text-foreground">Expired</span>`
					}
				</div>
				<div class="flex items-center justify-between gap-2">
					<code class="font-mono text-2xl font-semibold tracking-wider [font-variant-ligatures:none] text-foreground select-all ${left ? "" : "line-through opacity-60"}">${code}</code>
					${left ? Button({ size: "sm", variant: "secondary", children: "Copy", onClick: () => void copyText(code, "Code copied.") }) : nothing}
				</div>
			</div>
		`;
	}

	private noHostBox(): TemplateResult {
		return html`
			<div class="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3" data-connect-setup>
				<p class="text-xs text-foreground">Tabkyra's helper isn't connected. It runs on this computer and does the work here. Run this in a terminal, then reopen Settings.</p>
				${this.command("Set up Tabkyra", "tabkyra setup")}
			</div>
		`;
	}

	private section(title: string, body: TemplateResult, note?: string): TemplateResult {
		return html`
			<section class="flex flex-col gap-3 pt-5 border-t border-border">
				<div>
					<h3 class="text-sm font-semibold text-foreground">${title}</h3>
					${note ? html`<p class="text-xs text-muted-foreground mt-1">${note}</p>` : nothing}
				</div>
				${body}
			</section>
		`;
	}

	private assistants(s: ConnectStatus): TemplateResult {
		const origin = s.route === "link" ? s.link?.hubUrl : s.publicUrl;
		if (s.route === "none" || !origin) {
			return this.section(
				"Use from claude.ai, ChatGPT or grok.com",
				html`
					<p class="text-xs text-muted-foreground">
						This computer has no public address yet, so those assistants can't reach your browser. Pick one command: the first for this
						computer alone, the second for an always-on box that several of your computers connect to.
					</p>
					${this.command("One computer (needs Tailscale)", "tabkyra remote setup")}
					${this.command("Many devices, one address", "tabkyra hub setup --public-url https://ADDRESS")}
					<div class="flex flex-col gap-1.5 items-start">
						${Button({
							size: "sm",
							variant: "secondary",
							children: "Copy a setup prompt for your agent",
							onClick: () => {
								try {
									void copyText(
										remoteSetupPrompt(extensionVersion()),
										"Setup prompt copied. Paste it into your agent.",
									);
								} catch (err) {
									Toast.error(
										`Couldn't build the setup prompt: ${err instanceof Error ? err.message : String(err)}`,
									);
								}
							},
						})}
						<p class="text-xs text-muted-foreground">Your agent runs those steps for you and hands back a one-time code.</p>
					</div>
				`,
			);
		}
		const canMint = s.route !== "link" || s.link?.manage;
		return this.section(
			"Use from claude.ai, ChatGPT or grok.com",
			html`
				${this.command("Connector URL", connectorUrl(origin))}
				${this.approval ? this.codeBox(this.approval.code, this.approval.expiresAt, "Connect code") : nothing}
				<div class="flex flex-col gap-1.5 items-start">
					${
						canMint
							? Button({
									size: "sm",
									variant: this.approval ? "outline" : "default",
									disabled: this.minting === "approval",
									children: this.approval ? "Get a new connect code" : "Get a connect code",
									onClick: () => void this.mint("approval"),
								})
							: html`<p class="text-xs text-muted-foreground">This device can't make codes. Make one on your hub, or on a device linked as a manager.</p>`
					}
					${canMint ? html`<p class="text-xs text-muted-foreground">Paste the URL into the assistant's connector settings, then type this code on Tabkyra's approval page.</p>` : nothing}
				</div>
			`,
		);
	}

	private devices(s: ConnectStatus): TemplateResult | typeof nothing {
		const isHub = s.route === "hub";
		const isManager = s.route === "link" && s.link?.manage;
		if (!isHub && !isManager) return nothing;
		const list = s.hub?.devices;
		const hubUrl = s.route === "hub" ? s.publicUrl : s.link?.hubUrl;
		return this.section(
			"Your devices",
			html`
				${
					list
						? list.length === 0
							? html`<p class="text-xs text-muted-foreground">No devices yet. Add the first one below.</p>`
							: html`<ul class="flex flex-col divide-y divide-border rounded-md border border-border">
									${list.map(
										(d) => html`<li class="flex items-start gap-2 px-3 py-2">
											<span
												class="mt-1.5 h-2 w-2 shrink-0 rounded-full ${d.online ? "bg-green-500" : "bg-muted-foreground/40"}"
												aria-hidden="true"
											></span>
											<div class="min-w-0 flex-1">
												<div class="flex flex-wrap items-baseline gap-x-2">
													<span class="text-sm font-medium text-foreground break-words">${d.name}</span>
													<span class="text-xs text-muted-foreground">${d.online ? "Online" : "Offline"}</span>
													${d.busy ? html`<span class="rounded bg-secondary px-1.5 text-xs text-foreground">Busy</span>` : nothing}
												</div>
												<div class="text-xs text-muted-foreground">
													${d.sessions} session${d.sessions === 1 ? "" : "s"}${d.online ? (d.extensionConnected ? "" : ", browser not connected") : ""} · seen ${lastSeen(d.lastSeen, this.now)}
												</div>
											</div>
										</li>`,
									)}
								</ul>`
						: html`<p class="text-xs text-muted-foreground">This device manages the hub's codes. Open Settings > Connect on the hub's computer to see the device list.</p>`
				}
				${this.device ? this.codeBox(this.device.code, this.device.expiresAt, "Device code") : nothing}
				${
					this.device && countdown(this.device.expiresAt, this.now)
						? html`
								${this.command("On the other device, run", linkCommand(this.device.hubUrl, this.device.code))}
								<div class="flex flex-col gap-1.5 items-start">
									${Button({
										size: "sm",
										variant: "secondary",
										children: "Copy a setup prompt for an agent on that device",
										onClick: () => {
											const made = this.device;
											if (!made) return;
											try {
												void copyText(
													deviceSetupPrompt(extensionVersion(), made.hubUrl, made.code),
													"Setup prompt copied. Paste it into the agent on that device.",
												);
											} catch (err) {
												Toast.error(
													`Couldn't build the setup prompt: ${err instanceof Error ? err.message : String(err)}`,
												);
											}
										},
									})}
									<p class="text-xs text-muted-foreground">The prompt includes the code. It works once, for 10 minutes.</p>
								</div>
							`
						: nothing
				}
				<div>
					${Button({
						size: "sm",
						variant: this.device ? "outline" : "default",
						disabled: this.minting === "device" || !hubUrl,
						children: this.device ? "Add another device" : "Add a device",
						onClick: () => void this.mint("device"),
					})}
				</div>
			`,
		);
	}

	private thisDevice(s: ConnectStatus): TemplateResult | typeof nothing {
		if (s.route !== "link" || !s.link) return nothing;
		const link = s.link;
		return this.section(
			"This device",
			html`
				<div class="flex flex-col gap-1 text-sm">
					<div class="flex items-center gap-2">
						<span class="h-2 w-2 shrink-0 rounded-full ${link.online ? "bg-green-500" : "bg-muted-foreground/40"}" aria-hidden="true"></span>
						<span class="text-foreground">${link.name}</span>
						<span class="text-xs text-muted-foreground">${link.online ? "Online" : "Offline"}</span>
					</div>
					<div class="text-xs text-muted-foreground break-all">Linked to ${link.hubUrl}</div>
				</div>
				<label class="flex items-start justify-between gap-3 text-sm text-foreground cursor-pointer">
					<span>Busy: send new work to my other devices</span>
					<input
						type="checkbox"
						role="switch"
						class="tk-switch"
						.checked=${link.busy}
						?disabled=${this.busyPending}
						@change=${(e: Event) => void this.setBusy((e.target as HTMLInputElement).checked)}
					/>
				</label>
			`,
		);
	}

	private joinForm(s: ConnectStatus): TemplateResult | typeof nothing {
		if (s.route !== "none") return nothing;
		const inputClass =
			"w-full h-9 px-3 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
		return this.section(
			"Join a hub",
			html`
				<p class="text-xs text-muted-foreground">Already run a hub on another computer? Enter its address and a connect code from its Settings > Connect.</p>
				<label class="flex flex-col gap-1 text-xs text-muted-foreground">
					<span>Hub address</span>
					<input class=${inputClass} placeholder="https://hub.example.com" autocomplete="off" spellcheck="false" .value=${this.hubUrl} @input=${(
						e: Event,
					) => {
						this.hubUrl = (e.target as HTMLInputElement).value;
					}} />
				</label>
				<label class="flex flex-col gap-1 text-xs text-muted-foreground">
					<span>Connect code</span>
					<input class="${inputClass} font-mono" placeholder="TK-XXXX-XXXX" autocomplete="off" spellcheck="false" .value=${this.joinCode} @input=${(
						e: Event,
					) => {
						this.joinCode = (e.target as HTMLInputElement).value;
					}} />
				</label>
				<div class="flex items-center gap-3">
					${Button({
						size: "sm",
						disabled: Boolean(this.joining) || !this.hubUrl.trim() || !this.joinCode.trim(),
						children: "Join hub",
						onClick: () => void this.join(),
					})}
					${this.joining ? html`<span class="text-xs text-muted-foreground" role="status">${this.joining}</span>` : nothing}
				</div>
				${
					this.joinMessage
						? html`<p class="text-xs ${this.joinMessage.ok ? "text-foreground" : "text-destructive"}" role=${this.joinMessage.ok ? "status" : "alert"}>${this.joinMessage.text}</p>`
						: nothing
				}
			`,
		);
	}

	render(): TemplateResult {
		const s = this.status;
		return html`
			<div class="flex flex-col gap-5">
				<div class="space-y-1">
					<h3 class="text-lg font-semibold text-foreground">Connect</h3>
					<p class="text-sm text-muted-foreground">Let claude.ai, ChatGPT or grok.com use this browser, from your own computer, with no account of ours.</p>
				</div>
				${this.noHost ? this.noHostBox() : nothing}
				${this.error ? html`<p class="text-xs text-destructive" role="alert">${this.error}</p>` : nothing}
				${this.status?.problem ? html`<p class="text-xs text-destructive" role="alert">${this.status.problem}</p>` : nothing}
				${this.codeError ? html`<p class="text-xs text-destructive" role="alert">${this.codeError}</p>` : nothing}
				${
					s && !this.noHost
						? html`${this.assistants(s)}${this.devices(s)}${this.thisDevice(s)}${this.joinForm(s)}`
						: !this.noHost && !this.error
							? html`<p class="text-xs text-muted-foreground" role="status">Checking...</p>`
							: nothing
				}
			</div>
		`;
	}
}
