import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { builtHelperCommand, hostCommand } from "../bridge/host-command.js";
import { COMMAND_BOX_CLASS } from "../components/command-box.js";
import { Toast } from "../components/Toast.js";
import { request, SubscriptionRequestError, type SubscriptionStatus, subscriptionStatus } from "./client.js";
import { COPILOT, cliMcpSetup, SIWC } from "./constants.js";
import { refreshSubscriptionModels } from "./stream.js";

/** chrome.storage.local flag: the "You're using your ChatGPT plan" note was shown once (no token in it). */
export const CHATGPT_WELCOME_KEY = "tabkyra.chatgptPlanWelcomeShown";

/**
 * Settings: the two subscription sign-ins Polycarp offers, and how to use a Claude or Gemini
 * subscription instead (run that CLI with Polycarp's MCP server; their terms forbid a sign-in here).
 * Self-contained so it drops into whichever settings tab lists providers.
 */
@customElement("tabkyra-subscriptions")
export class SubscriptionsSection extends LitElement {
	@state() private status?: SubscriptionStatus;
	@state() private error?: string;
	/** The native host isn't connected: the usual reason, and a setup step, not a failure. */
	@state() private noHost = false;
	@state() private busy?: "chatgpt" | "copilot";
	@state() private deviceCode?: { userCode: string; verificationUri: string };
	@state() private welcome = false;
	@state() private notice?: string;
	@state() private copied?: string;
	private copiedTimer?: ReturnType<typeof setTimeout>;
	/** The "Couldn't copy" toast, taken down as soon as a copy works. */
	private copyFailed?: Element;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			this.status = await subscriptionStatus(true);
			this.error = undefined;
			this.noHost = false;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			this.noHost = err instanceof SubscriptionRequestError && err.code === "no_host";
		}
	}

	private async signInChatGpt(): Promise<void> {
		this.busy = "chatgpt";
		this.notice = undefined;
		try {
			const result = await request<{ planUsage: boolean; firstPlanUsage?: boolean }>(
				"chatgpt.signin",
				(progress) => {
					// The sign-in page opens in a normal tab of this browser; the host's loopback listener gets the callback.
					if (
						typeof progress.authorizeUrl === "string" &&
						progress.authorizeUrl.startsWith(`${SIWC.authorizeUrl}?`)
					)
						void chrome.tabs.create({ url: progress.authorizeUrl, active: true });
				},
			);
			if (!result.planUsage)
				this.notice =
					"Signed in, but ChatGPT plan usage wasn't allowed. Choose Continue with ChatGPT again to allow it, or add an OpenAI API key.";
			if (result.firstPlanUsage) {
				const seen = await chrome.storage.local.get(CHATGPT_WELCOME_KEY);
				if (!seen[CHATGPT_WELCOME_KEY]) this.welcome = true;
			}
			await refreshSubscriptionModels();
		} catch (err) {
			this.notice = err instanceof Error ? err.message : String(err);
		}
		this.busy = undefined;
		await this.load();
	}

	private async signInCopilot(): Promise<void> {
		this.busy = "copilot";
		this.notice = undefined;
		try {
			await request("copilot.signin", (progress) => {
				if (typeof progress.userCode === "string" && typeof progress.verificationUri === "string") {
					this.deviceCode = { userCode: progress.userCode, verificationUri: progress.verificationUri };
					if (progress.verificationUri.startsWith("https://github.com/"))
						void chrome.tabs.create({ url: progress.verificationUri, active: true });
				}
			});
			await refreshSubscriptionModels();
		} catch (err) {
			this.notice = err instanceof Error ? err.message : String(err);
		}
		this.deviceCode = undefined;
		this.busy = undefined;
		await this.load();
	}

	private async cancel(which: "chatgpt" | "copilot"): Promise<void> {
		await request(`${which}.cancel`).catch(() => undefined);
	}

	private async signOut(which: "chatgpt" | "copilot"): Promise<void> {
		this.notice = undefined;
		try {
			const result = await request<{ revoked: boolean; revokeUrl?: string }>(`${which}.signout`);
			if (which === "chatgpt" && !result.revoked)
				this.notice =
					"Signed out here, but OpenAI didn't confirm the session was revoked. You can disconnect \"Tabkyra (Polycarp's earlier name)\" in ChatGPT Settings."; // product-name allowlist: the name the provider lists
			if (which === "copilot")
				this.notice = `Signed out: the token is deleted from this computer. To remove "Tabkyra (Polycarp's earlier name)" from GitHub too, revoke it at ${COPILOT.revokeUrl}.`; // product-name allowlist: the name the provider lists
			await refreshSubscriptionModels();
		} catch (err) {
			this.notice = err instanceof Error ? err.message : String(err);
		}
		await this.load();
	}

	private async dismissWelcome(): Promise<void> {
		this.welcome = false;
		await chrome.storage.local.set({ [CHATGPT_WELCOME_KEY]: true });
	}

	private copy(text: string): void {
		navigator.clipboard.writeText(text).then(
			() => {
				this.copyFailed?.remove();
				this.copyFailed = undefined;
				clearTimeout(this.copiedTimer);
				this.copied = text;
				this.copiedTimer = setTimeout(() => {
					this.copied = undefined;
				}, 1500);
			},
			// A toast, not the section's notice: it can't overwrite a sign-out message or outlive a later copy.
			() => {
				this.copyFailed = Toast.error("Couldn't copy. Click the side panel first, then try again.");
			},
		);
	}

	/** One shell command the user pastes into a terminal: labeled, monospace, with its own copy button. */
	private command(label: string, text: string): TemplateResult {
		return html`
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-muted-foreground">${label}</span>
					<button
						type="button"
						class="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
						aria-label=${`Copy the ${label} command`}
						@click=${() => this.copy(text)}
					>
						<span aria-hidden="true">${this.copied === text ? "Copied" : "Copy"}</span>
					</button>
					<span class="sr-only" role="status">${this.copied === text ? `Copied the ${label} command` : ""}</span>
				</div>
				<code class=${COMMAND_BOX_CLASS}>${text}</code>
			</div>
		`;
	}

	private row(opts: {
		title: string;
		note: TemplateResult;
		signedIn: boolean;
		who?: string;
		button: string;
		which: "chatgpt" | "copilot";
		onSignIn: () => void;
		extra?: TemplateResult | typeof nothing;
	}): TemplateResult {
		const busy = this.busy === opts.which;
		return html`
			<div class="flex flex-col gap-2 rounded-md border border-border p-3" data-subscription=${opts.which}>
				<div class="flex items-center justify-between gap-2">
					<span class="text-sm font-medium text-foreground">${opts.title}</span>
					${
						opts.signedIn
							? html`<span class="text-xs text-muted-foreground">Signed in${opts.who ? html` as ${opts.who}` : nothing}</span>`
							: nothing
					}
				</div>
				<p class="text-xs text-muted-foreground">${opts.note}</p>
				${opts.extra ?? nothing}
				<div class="flex gap-2">
					${
						opts.signedIn
							? Button({
									size: "sm",
									variant: "outline",
									children: "Sign out",
									onClick: () => void this.signOut(opts.which),
								})
							: busy
								? Button({
										size: "sm",
										variant: "outline",
										children: "Cancel",
										onClick: () => void this.cancel(opts.which),
									})
								: Button({
										size: "sm",
										variant: "outline",
										children: opts.button,
										onClick: opts.onSignIn,
										disabled: Boolean(this.busy) || !this.status,
									})
					}
				</div>
			</div>
		`;
	}

	override render(): TemplateResult {
		const s = this.status;
		const link = (href: string, text: string) =>
			html`<a class="underline" href=${href} target="_blank" rel="noopener">${text}</a>`;
		return html`
			<div class="flex flex-col gap-3">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-1">Use your subscription</h3>
					<p class="text-xs text-muted-foreground">
						Your tokens stay on this computer, in files only you can read. The browser never holds them.
					</p>
				</div>
				${
					this.error
						? html`<div class="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3" data-subscription-setup>
								<p class="text-xs text-foreground">
									${
										this.noHost
											? "Subscription sign-ins run in Polycarp's helper on this computer, which isn't connected. Run this in a terminal, then reopen Settings."
											: html`Subscription sign-ins aren't available: ${this.error?.replace(/\.?$/, ".")} Running this in a terminal usually fixes it.`
									}
								</p>
								${this.command("Set up Polycarp", `${hostCommand()} setup`)}
								${builtHelperCommand("setup") ? this.command("If you built the helper yourself", builtHelperCommand("setup") as string) : nothing}
							</div>`
						: nothing
				}
				${
					this.welcome
						? html`<div class="rounded-md border border-border p-3 flex flex-col gap-2" role="dialog" aria-label="You're using your ChatGPT plan">
								<span class="text-sm font-medium">You're using your ChatGPT plan</span>
								<span class="text-xs text-muted-foreground">Eligible usage in this app uses your ChatGPT plan. Manage usage in your ${link(SIWC.usageUrl, "ChatGPT settings")}.</span>
								<div>${Button({ size: "sm", variant: "default", children: "Got it", onClick: () => void this.dismissWelcome() })}</div>
							</div>`
						: nothing
				}
				${this.row({
					title: "ChatGPT plan",
					which: "chatgpt",
					button: "Continue with ChatGPT",
					signedIn: Boolean(s?.chatgpt.signedIn),
					who: s?.chatgpt.email,
					onSignIn: () => void this.signInChatGpt(),
					note: html`Uses your own ChatGPT plan; allowed by ${link(SIWC.termsUrl, "OpenAI's terms for open-source apps")}; sign out anytime. ${link(SIWC.usageUrl, "Manage usage")}`,
					extra:
						s?.chatgpt.signedIn && !s.chatgpt.planUsage
							? html`<p class="text-xs text-muted-foreground">ChatGPT plan usage isn't enabled for this sign-in. Sign out and choose Continue with ChatGPT to allow it, or use an OpenAI API key.</p>`
							: nothing,
				})}
				${this.row({
					title: "GitHub Copilot plan",
					which: "copilot",
					button: "Sign in with GitHub Copilot",
					signedIn: Boolean(s?.copilot.signedIn),
					who: s?.copilot.login,
					onSignIn: () => void this.signInCopilot(),
					note: html`Uses your own Copilot plan through GitHub's Copilot SDK; allowed by ${link(COPILOT.termsUrl, "GitHub's Copilot SDK docs")}; sign out anytime.`,
					extra: html`${
						this.deviceCode
							? html`<p class="text-xs">Enter <code class="font-mono font-semibold text-foreground" data-device-code>${this.deviceCode.userCode}</code> at ${link(this.deviceCode.verificationUri, this.deviceCode.verificationUri)}
									${Button({ size: "sm", variant: "ghost", children: "Copy code", onClick: () => this.copy(this.deviceCode?.userCode ?? "") })}</p>`
							: nothing
					}${
						s && !s.copilot.sdkInstalled
							? html`<p class="text-xs text-muted-foreground">Copilot needs GitHub's Copilot SDK on this computer (about 160 MB).</p>
									${this.command("Install the Copilot SDK", `${hostCommand()} copilot-sdk install`)}`
							: nothing
					}`,
				})}
				<div class="flex flex-col gap-2 rounded-md border border-border p-3" data-subscription="cli">
					<span class="text-sm font-medium text-foreground">Claude and Gemini</span>
					<p class="text-xs text-muted-foreground">
						Use your Claude Code or Gemini CLI subscription by running it with Polycarp's MCP server. Anthropic's and Google's
						terms don't allow other apps to sign in with those plans, so Polycarp doesn't.
					</p>
					${this.command("Claude Code", cliMcpSetup("claude", hostCommand()))}
					${this.command("Gemini CLI", cliMcpSetup("gemini", hostCommand()))}
					${builtHelperCommand("mcp") ? html`<p class="text-xs text-muted-foreground">Built the helper yourself? Use <code class="font-mono">polycarp-browser</code> in place of <code class="font-mono">${hostCommand()}</code>.</p>` : nothing}
				</div>
				${this.notice ? html`<p class="text-xs text-muted-foreground" role="status">${this.notice}</p>` : nothing}
			</div>
		`;
	}
}
