import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CONNECT_CODE } from "../agent-setup-prompt.js";
import { COMMAND_BOX_CLASS } from "../components/command-box.js";
import { Toast } from "../components/Toast.js";
import {
	connectApprovalCode,
	connectRemoteFix,
	connectRemoteFixPlan,
	connectRemoteFunnel,
	connectRemoteSetup,
	connectRemoteState,
	connectRemoteTest,
	connectSetupTunnel,
	isNoHost,
} from "../connect/client.js";
import {
	countdown,
	helperOutOfDateMessage,
	parseTunnelProgress,
	safeHelpUrl,
	safeSignInUrl,
	TUNNEL_STEP_LABELS,
	type TunnelProgressView,
	validApprovalCode,
} from "../connect/format.js";
import {
	APPROVAL_STEP,
	ASSISTANT_STEPS,
	CHECK_LABELS,
	checksFailed,
	FLOW_STEPS,
	REMOTE_TITLE,
	RESULT_COPY,
	type RemoteActionKind,
	ROUTE_COPY,
	routeStatus,
	STEP_COPY,
} from "../connect/remote-copy.js";
import {
	type ChosenRoute,
	type FlowInput,
	type FlowScreen,
	FUNNEL_POLL_MS,
	flowScreen,
	pollFor,
	sameAnswer,
	settleRun,
} from "../connect/remote-flow.js";
import {
	type ConnectStatus,
	type RemoteAnswer,
	type RemoteCheckView,
	type RemoteFixAnswer,
	TUNNEL_STEPS,
	type TunnelStepId,
} from "../connect/types.js";

/** Funnel is retried by itself for this long after a refusal; then the button is the way to try again. */
export const FUNNEL_RETRY_FOR_MS = 10 * 60_000;

async function copyText(text: string, done: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		Toast.success(done);
	} catch {
		Toast.error("Couldn't copy. Click the side panel first, then try again.");
	}
}

const errorText = (err: unknown): string => {
	const text = err instanceof Error ? err.message : String(err);
	// A helper from before this flow refuses the method by name.
	return text.startsWith("Unknown method") ? helperOutOfDateMessage() : text;
};

const FOCUS =
	"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";
const INPUT_CLASS =
	"w-full h-9 px-3 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * "Use Polycarp from Claude, ChatGPT and Grok" in Settings > Connect: choose a way, get it and sign in, turn on, then the
 * result. The screen comes from remote-flow.ts and every sentence from remote-copy.ts, the same strings the Mac app shows.
 *
 * The connect code lives only in this element's memory: never in chrome.storage, localStorage or a log, and it is dropped
 * when the element leaves the page. The panel never sees a passcode (D33); setups started here make none.
 */
@customElement("tabkyra-remote-flow")
export class RemoteFlow extends LitElement {
	/** Connect's latest status. Connect polls it; this element asks for the rest. */
	@property({ attribute: false }) status?: ConnectStatus;
	@state() private remote?: RemoteAnswer;
	@state() private chosen?: ChosenRoute;
	@state() private run?: RemoteAnswer;
	@state() private busy?: "setup" | "tunnel";
	@state() private code?: { code: string; expiresAt: number };
	@state() private codeProblem?: string;
	@state() private minting = false;
	@state() private checks?: RemoteCheckView[];
	@state() private checking = false;
	@state() private fix?: RemoteFixAnswer;
	@state() private fixing = false;
	@state() private error?: string;
	@state() private now = Date.now();
	@state() private tunnelHost = "";
	@state() private tunnelSteps?: Partial<Record<TunnelStepId, TunnelProgressView>>;
	@state() private tunnelError?: string;
	private ticker?: ReturnType<typeof setInterval>;
	private lastPoll = 0;
	private polling = false;
	private funnelSince?: number;
	private opened = new Set<string>();
	private checkedOnce = false;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.ask("remoteState");
		this.ticker = setInterval(() => this.tick(), 1000);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		clearInterval(this.ticker);
		// The code was shown once; leaving the page forgets it.
		this.code = undefined;
		this.run = undefined;
	}

	private input(): FlowInput {
		return {
			...(this.status ? { status: this.status } : {}),
			...(this.remote ? { remote: this.remote } : {}),
			...(this.chosen ? { chosen: this.chosen } : {}),
			...(this.run ? { run: this.run } : {}),
			...(this.busy ? { busy: this.busy } : {}),
		};
	}

	private visible(): boolean {
		return this.isConnected && !this.closest("[hidden]") && !document.hidden;
	}

	/** Once a second: the code's countdown (only while one is shown) and the poll the screen asks for. */
	private tick(): void {
		const now = Date.now();
		if (this.code && countdown(this.code.expiresAt, this.now) !== countdown(this.code.expiresAt, now)) this.now = now;
		if (!this.visible() || this.polling) return;
		const input = this.input();
		const screen = flowScreen(input);
		const poll = pollFor(screen, input);
		if (!poll || now - this.lastPoll < poll.everyMs) return;
		if (poll.method === "remoteFunnel") {
			this.funnelSince ??= now;
			if (now - this.funnelSince > FUNNEL_RETRY_FOR_MS) return;
		} else this.funnelSince = undefined;
		void this.ask(poll.method);
	}

	/** A poll. Its answer replaces what is drawn only when it says something new, so a quiet poll moves nothing. */
	private async ask(method: "remoteState" | "remoteFunnel" | "remoteTest"): Promise<void> {
		this.polling = true;
		this.lastPoll = Date.now();
		try {
			if (method === "remoteState") {
				const answer = await connectRemoteState();
				if (!sameAnswer(answer, this.remote)) this.remote = answer;
				const kept = settleRun(this.run, answer, this.status);
				if (kept !== this.run) this.run = kept;
			} else if (method === "remoteFunnel") {
				const answer = await connectRemoteFunnel();
				if (!sameAnswer(answer, this.run)) this.takeRun(answer);
			} else {
				this.checking = true;
				const answer = await connectRemoteTest();
				this.takeChecks(answer.checks);
				if (!sameAnswer(answer, this.remote))
					this.remote = { ...answer, ...(this.remote?.routes ? { routes: this.remote.routes } : {}) };
			}
			if (this.error) this.error = undefined;
		} catch (err) {
			if (isNoHost(err)) this.dispatchEvent(new CustomEvent("remote-changed", { bubbles: true }));
			const text = errorText(err);
			if (text !== this.error) this.error = text;
		} finally {
			this.checking = false;
			this.polling = false;
			this.lastPoll = Date.now();
		}
	}

	/** A run's answer: its code moves into `code` (the run keeps no copy) and its checks into the checklist. */
	private takeRun(answer: RemoteAnswer): void {
		const { connectCode, connectCodeExpiresAt, connectCodeProblem, ...rest } = answer;
		// The panel checks the code's shape itself, as it does for every code it shows.
		if (connectCode && CONNECT_CODE.test(connectCode) && Number.isFinite(connectCodeExpiresAt)) {
			this.code = { code: connectCode, expiresAt: connectCodeExpiresAt as number };
			this.now = Date.now();
		}
		this.codeProblem = connectCodeProblem;
		if (rest.checks) this.takeChecks(rest.checks);
		this.run = rest;
		if (rest.state === "on" || rest.state === "no_browser_connected") {
			this.chosen = undefined;
			this.funnelSince = undefined;
			this.dispatchEvent(new CustomEvent("remote-changed", { bubbles: true }));
		}
		// Tailscale's page to allow Funnel opens once by itself; the button opens it again.
		if (rest.state === "funnel_not_allowed") this.openOnce(rest.next?.url);
	}

	private takeChecks(checks: RemoteCheckView[] | undefined): void {
		if (!checks || sameAnswer(checks, this.checks)) return;
		this.checks = checks;
		if (checks.some((c) => c.status === "fail") && !this.fix) void this.planFix();
	}

	/** Repair shows only when this helper has `remote fix` and the plan has something to do. */
	private async planFix(): Promise<void> {
		try {
			this.fix = await connectRemoteFixPlan();
		} catch {
			this.fix = { available: false };
		}
	}

	private openOnce(url: unknown): void {
		const safe = safeHelpUrl(url);
		if (!safe || this.opened.has(safe)) return;
		this.opened.add(safe);
		this.openTab(safe);
	}

	private openTab(url: string): void {
		try {
			void chrome.tabs.create({ url });
		} catch {
			/* the link under the button still works */
		}
	}

	private async turnOn(): Promise<void> {
		if (this.busy) return;
		this.busy = "setup";
		this.error = undefined;
		this.funnelSince = undefined;
		try {
			this.takeRun(await connectRemoteSetup());
		} catch (err) {
			this.error = errorText(err);
		} finally {
			this.busy = undefined;
			// Setup may have saved the route even when it stopped (Funnel not allowed yet): Connect reads it now, so the
			// Funnel retry starts at once instead of at Connect's next 10-second refresh.
			this.dispatchEvent(new CustomEvent("remote-changed", { bubbles: true }));
		}
	}

	private async openFunnel(): Promise<void> {
		this.funnelSince = undefined;
		this.lastPoll = 0;
		await this.ask("remoteFunnel");
	}

	private async setupTunnel(host: string): Promise<void> {
		if (!host || this.busy) return;
		this.busy = "tunnel";
		this.tunnelError = undefined;
		this.tunnelSteps = {};
		this.run = undefined;
		let signInOpened = false;
		try {
			const result = await connectSetupTunnel(host, (p) => {
				const view = parseTunnelProgress(p);
				if (!view) return;
				this.tunnelSteps = { ...this.tunnelSteps, [view.step]: view };
				const url = view.step === "signin" && view.state === "waiting" ? safeSignInUrl(view.url) : undefined;
				if (url && !signInOpened) {
					signInOpened = true;
					this.openTab(url);
				}
			});
			this.tunnelSteps = undefined;
			this.takeRun({ state: "on", message: "", ...result });
		} catch (err) {
			if (isNoHost(err)) this.dispatchEvent(new CustomEvent("remote-changed", { bubbles: true }));
			const failed = Object.values(this.tunnelSteps ?? {}).some((x) => x?.state === "failed");
			this.tunnelError = failed ? undefined : errorText(err);
		} finally {
			this.busy = undefined;
		}
	}

	private async newCode(): Promise<void> {
		this.minting = true;
		try {
			const made = await connectApprovalCode();
			if (!validApprovalCode(made)) throw new Error("The helper sent a code this page can't read. Update Polycarp.");
			this.code = { code: made.code, expiresAt: made.expiresAt };
			this.codeProblem = undefined;
			this.now = Date.now();
		} catch (err) {
			this.codeProblem = errorText(err);
		} finally {
			this.minting = false;
		}
	}

	private async repair(): Promise<void> {
		this.fixing = true;
		try {
			const done = await connectRemoteFix();
			this.fix = done;
			if (done.checks) this.takeChecks(done.checks);
			this.lastPoll = 0;
			this.dispatchEvent(new CustomEvent("remote-changed", { bubbles: true }));
		} catch (err) {
			this.error = errorText(err);
		} finally {
			this.fixing = false;
		}
	}

	private async checkAgain(method: "remoteState" | "remoteTest" = "remoteState"): Promise<void> {
		this.run = undefined;
		await this.ask(method);
	}

	/** The one button on a step does what its kind says; the label is the shared copy's. */
	private act(kind: RemoteActionKind, answer: RemoteAnswer): void {
		switch (kind) {
			case "open_url": {
				const url = safeHelpUrl(answer.next?.url);
				if (url) this.openTab(url);
				return;
			}
			case "copy_command":
				if (answer.next?.command) void copyText(answer.next.command, RESULT_COPY.copied);
				return;
			case "turn_on":
			case "try_again":
				if (this.routeNow() === "cloudflare") {
					this.run = undefined;
					this.chosen = "cloudflare";
				} else void this.turnOn();
				return;
			case "download":
			case "sign_in_cloudflare": {
				const host = this.status?.publicUrl ? new URL(this.status.publicUrl).hostname : this.tunnelHost.trim();
				this.chosen = "cloudflare";
				this.tunnelHost = host;
				void this.setupTunnel(host);
				return;
			}
			case "check_again":
				void this.checkAgain(answer.code === "dns" ? "remoteTest" : "remoteState");
				return;
			case "use_cloudflare":
				this.run = undefined;
				this.chosen = "cloudflare";
				return;
			case "open_funnel":
				void this.openFunnel();
				return;
			case "new_code":
				void this.newCode();
				return;
			case "repair":
				void this.repair();
				return;
			case "choose":
				this.run = undefined;
				this.chosen = undefined;
				return;
		}
	}

	private routeNow(): ChosenRoute | undefined {
		const s = this.status;
		if (s?.route === "remote")
			return s.remoteKind === "cloudflare" ? "cloudflare" : s.remoteKind === "funnel" ? "tailscale" : undefined;
		return this.chosen;
	}

	private stepHeader(n: 1 | 2 | 3): TemplateResult {
		return html`<p class="text-xs font-medium text-muted-foreground" data-flow-step=${n}>Step ${n} of 3: ${FLOW_STEPS[n - 1]}</p>`;
	}

	private copyBox(label: string, text: string, attr: string): TemplateResult {
		return html`
			<div class="flex flex-col gap-1" data-copy=${attr}>
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-muted-foreground">${label}</span>
					<button type="button" class="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer ${FOCUS}" aria-label=${`Copy ${label}`} @click=${() => void copyText(text, RESULT_COPY.copied)}>
						${RESULT_COPY.copy}
					</button>
				</div>
				<code class=${COMMAND_BOX_CLASS}>${text}</code>
			</div>
		`;
	}

	private choose(screen: Extract<FlowScreen, { kind: "choose" }>): TemplateResult {
		const card = (id: ChosenRoute) => {
			const copy = ROUTE_COPY[id];
			const r = screen.routes?.[id];
			const recommended = screen.recommended === id;
			return html`
				<button
					type="button"
					class="flex w-full flex-col items-start gap-1 rounded-md border ${recommended ? "border-primary" : "border-border"} bg-background p-3 text-left hover:bg-accent cursor-pointer ${FOCUS}"
					aria-label=${`${copy.use}. ${copy.detail}${recommended ? ` ${ROUTE_COPY.recommended}.` : ""}`}
					data-route=${id}
					@click=${() => {
						this.chosen = id;
						this.run = undefined;
						this.lastPoll = 0;
					}}
				>
					<span class="flex w-full items-center justify-between gap-2">
						<span class="text-sm font-semibold text-foreground">${copy.name}</span>
						${recommended ? html`<span class="rounded bg-primary px-1.5 text-xs font-medium text-primary-foreground">${ROUTE_COPY.recommended}</span>` : nothing}
					</span>
					<span class="text-xs text-foreground">${copy.detail}</span>
					<span class="text-xs text-muted-foreground">${r ? routeStatus(r.installed, r.signedIn) : " "}</span>
				</button>
			`;
		};
		return html`
			${this.stepHeader(1)}
			<p class="text-sm font-medium text-foreground">${ROUTE_COPY.chooseTitle}</p>
			<p class="text-xs text-muted-foreground">${ROUTE_COPY.chooseBody}</p>
			<div class="flex flex-col gap-2">${card("tailscale")}${card("cloudflare")}</div>
		`;
	}

	private step(screen: Extract<FlowScreen, { kind: "step" }>): TemplateResult {
		const { copy, answer } = screen;
		const action = copy.action;
		const command = action?.kind === "copy_command" ? answer.next?.command : undefined;
		const url = action?.kind === "open_url" ? safeHelpUrl(answer.next?.url) : undefined;
		// A step whose button would have nothing to do draws no button.
		const showAction = action && (action.kind !== "copy_command" || command) && (action.kind !== "open_url" || url);
		// The helper's own words help only when something went wrong; on a calm step they repeat the sentence above.
		const detail =
			copy.key !== "unknown" && (answer.state === "problem" || answer.state === "port_busy") && answer.message
				? answer.message
				: undefined;
		const turning = copy.key === "turning_on";
		const gaveUp =
			copy.key === "funnel_not_allowed" &&
			this.funnelSince !== undefined &&
			Date.now() - this.funnelSince > FUNNEL_RETRY_FOR_MS;
		return html`
			${this.stepHeader(screen.step)}
			<div class="flex flex-col gap-2" role="group" aria-labelledby="remote-step-title" data-remote-step=${copy.key}>
				<p id="remote-step-title" class="text-sm font-medium text-foreground">${copy.title}</p>
				<p class="text-xs text-foreground">${copy.body}</p>
				${command ? this.copyBox("Command", command, "command") : nothing}
				${
					showAction && action
						? html`<div class="flex items-center gap-2">
								${Button({ size: "sm", disabled: Boolean(this.busy) || (this.polling && action.kind === "open_funnel"), children: action.label, onClick: () => this.act(action.kind, answer) })}
								${url ? html`<a class="text-xs text-muted-foreground underline [overflow-wrap:anywhere] ${FOCUS}" href=${url} target="_blank" rel="noopener noreferrer">${new URL(url).hostname}</a>` : nothing}
							</div>`
						: nothing
				}
				<p class="min-h-4 text-xs text-muted-foreground" role="status" aria-live="polite" data-remote-wait>
					${turning ? "Working..." : copy.waits && !gaveUp ? "Waiting for you. This page checks by itself." : " "}
				</p>
				${
					detail
						? html`<details class="text-xs text-muted-foreground">
								<summary class="cursor-pointer ${FOCUS}">Details</summary>
								<p class="mt-1 [overflow-wrap:anywhere]">${detail}</p>
							</details>`
						: nothing
				}
				${screen.route === "tailscale" && copy.key !== "turning_on" ? html`<button type="button" class="self-start text-xs text-muted-foreground underline cursor-pointer ${FOCUS}" @click=${() => this.act("choose", answer)}>${ROUTE_COPY.chooseAgain}</button>` : nothing}
			</div>
		`;
	}

	private cloudflare(): TemplateResult {
		const steps = this.tunnelSteps;
		const running = this.busy === "tunnel";
		const signedIn = steps?.signin?.state === "done";
		const signIn = steps?.signin;
		return html`
			${this.stepHeader(signedIn ? 3 : 2)}
			<div class="flex flex-col gap-2" data-tunnel-form>
				<p class="text-sm font-medium text-foreground">Pick this computer's address</p>
				<p class="text-xs text-foreground">Any name on a domain in your Cloudflare account. Polycarp gets cloudflared for you (Cloudflare's own release, fingerprint checked) and opens Cloudflare's sign-in in a new tab.</p>
				<label class="flex flex-col gap-1 text-xs text-muted-foreground">
					<span>Address</span>
					<input class=${INPUT_CLASS} placeholder="polycarp.yourdomain.com" autocomplete="off" spellcheck="false" ?disabled=${running} .value=${this.tunnelHost} @input=${(
						e: Event,
					) => {
						this.tunnelHost = (e.target as HTMLInputElement).value;
					}} />
				</label>
				<div class="flex items-center gap-2">
					${Button({ size: "sm", disabled: running || !this.tunnelHost.trim(), children: "Turn on", onClick: () => void this.setupTunnel(this.tunnelHost.trim()) })}
					${running ? nothing : html`<button type="button" class="text-xs text-muted-foreground underline cursor-pointer ${FOCUS}" @click=${() => this.act("choose", { state: "", message: "" })}>${ROUTE_COPY.chooseAgain}</button>`}
				</div>
				<ol class="flex flex-col gap-1 text-xs" aria-live="polite" data-tunnel-steps>
					${steps ? TUNNEL_STEPS.map((id) => this.tunnelRow(id, steps[id])) : nothing}
				</ol>
				${
					signIn?.state === "waiting" && safeSignInUrl(signIn.url)
						? html`<p class="text-xs text-muted-foreground">Didn't a tab open? <a class="underline ${FOCUS}" href=${safeSignInUrl(signIn.url) as string} target="_blank" rel="noopener noreferrer">Sign in to Cloudflare</a></p>`
						: nothing
				}
				${this.tunnelError ? html`<p class="text-xs text-destructive" role="alert">${this.tunnelError}</p>` : nothing}
			</div>
		`;
	}

	private tunnelRow(id: TunnelStepId, p: TunnelProgressView | undefined): TemplateResult {
		const st = p?.state === "waiting" ? "running" : (p?.state ?? "pending");
		const mark = st === "done" ? "Done" : st === "failed" ? "Failed" : st === "running" ? "Working" : "Waiting";
		return html`<li class="${st === "failed" ? "text-destructive" : st === "pending" ? "text-muted-foreground" : "text-foreground"}" data-step=${id} data-state=${st}>
			<span class="font-medium">${TUNNEL_STEP_LABELS[id]}</span>: ${mark}${p?.state === "waiting" ? " for you to sign in" : ""}
			${p?.state === "failed" && p.detail ? html`<span class="block [overflow-wrap:anywhere]">${p.detail}</span>` : nothing}
		</li>`;
	}

	private result(screen: Extract<FlowScreen, { kind: "result" }>): TemplateResult {
		const code = this.code;
		const left = code ? countdown(code.expiresAt, this.now) : undefined;
		const checks = this.checks;
		const failed = checks?.filter((c) => c.status === "fail") ?? [];
		const canRepair = failed.length > 0 && this.fix?.available === true && (this.fix.actions?.length ?? 0) > 0;
		const summary = this.checking
			? RESULT_COPY.checksRunning
			: !checks
				? RESULT_COPY.checksNone
				: failed.length
					? checksFailed(failed.length)
					: RESULT_COPY.checksPassed;
		const head = failed.length
			? STEP_COPY.check_failed
			: screen.answer?.state === "no_browser_connected"
				? STEP_COPY.no_browser_connected
				: STEP_COPY.on;
		return html`
			<div class="flex flex-col gap-3" data-remote-result>
				<div>
					<p class="text-sm font-medium text-foreground" data-result-title>${head.title}</p>
					<p class="text-xs text-muted-foreground">${head.body}</p>
				</div>
				<div class="flex flex-col gap-1.5">
					<p class="text-xs font-medium text-foreground">${RESULT_COPY.assistantsStep}</p>
					<ul class="flex flex-col gap-1 rounded-md border border-border p-2" data-assistants>
						${ASSISTANT_STEPS.map(
							(a) =>
								html`<li class="text-xs" data-assistant=${a.id}><span class="font-medium text-foreground">${a.name}</span> <span class="text-muted-foreground">${a.where}</span></li>`,
						)}
					</ul>
					<p class="text-xs text-muted-foreground">${APPROVAL_STEP}</p>
				</div>
				<div class="flex flex-col gap-1.5">
					<p class="text-xs font-medium text-foreground">${RESULT_COPY.addressStep}</p>
					${this.copyBox(RESULT_COPY.addressLabel, screen.connectorUrl, "address")}
				</div>
				<div class="flex flex-col gap-1.5">
					<p class="text-xs font-medium text-foreground">${RESULT_COPY.codeStep}</p>
					<div class="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3" data-code=${RESULT_COPY.codeLabel}>
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-muted-foreground">${RESULT_COPY.codeLabel}</span>
							<span class="text-xs text-muted-foreground tabular-nums" role="timer" aria-live="off" aria-label=${left ? `${RESULT_COPY.expiresIn} ${left}` : RESULT_COPY.expired}>
								${code ? (left ? `${RESULT_COPY.expiresIn} ${left}` : RESULT_COPY.expired) : " "}
							</span>
						</div>
						<div class="flex items-center justify-between gap-2">
							<code class="min-w-0 [overflow-wrap:anywhere] font-mono text-2xl font-semibold tracking-wider [font-variant-ligatures:none] text-foreground select-all ${left ? "" : "opacity-60"}" data-connect-code>${code ? code.code : "----"}</code>
							${code && left ? Button({ size: "sm", variant: "secondary", children: RESULT_COPY.copy, onClick: () => void copyText(code.code, "Code copied.") }) : nothing}
						</div>
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs text-muted-foreground">${RESULT_COPY.codeNote}</span>
							${Button({ size: "sm", variant: "outline", disabled: this.minting, children: RESULT_COPY.newCode, onClick: () => void this.newCode() })}
						</div>
						${this.codeProblem ? html`<p class="text-xs text-destructive" role="alert" data-code-problem>${this.codeProblem}</p>` : nothing}
					</div>
					<p class="text-xs text-muted-foreground" data-no-passcode>${RESULT_COPY.noPasscode}</p>
				</div>
				<details class="rounded-md border border-border p-2 text-xs" data-checks ?open=${failed.length > 0}>
					<summary class="cursor-pointer text-foreground ${FOCUS}"><span class="font-medium">${RESULT_COPY.checksTitle}:</span> <span aria-live="polite">${summary}</span></summary>
					<ul class="mt-2 flex flex-col gap-1">
						${(checks ?? []).map(
							(
								c,
							) => html`<li class=${c.status === "fail" ? "text-destructive" : "text-foreground"} data-check=${c.name} data-status=${c.status}>
								<span class="font-medium">${c.status === "ok" ? "Passed" : c.status === "warn" ? "Warning" : "Failed"}:</span> ${CHECK_LABELS[c.name] ?? c.name}
								${c.status !== "ok" && c.detail ? html`<span class="block text-muted-foreground [overflow-wrap:anywhere]">${c.detail}</span>` : nothing}
							</li>`,
						)}
					</ul>
					<div class="mt-2 flex items-center gap-2">
						${Button({ size: "sm", variant: "outline", disabled: this.checking, children: RESULT_COPY.checkAgain, onClick: () => void this.checkAgain("remoteTest") })}
						${canRepair ? Button({ size: "sm", disabled: this.fixing, children: this.fixing ? RESULT_COPY.repairing : RESULT_COPY.repair, onClick: () => void this.repair() }) : nothing}
					</div>
				</details>
				${this.routeNow() === "tailscale" ? html`<button type="button" class="self-start text-xs text-muted-foreground underline cursor-pointer ${FOCUS}" @click=${() => this.act("use_cloudflare", { state: "", message: "" })}>Use Cloudflare instead</button>` : nothing}
			</div>
		`;
	}

	protected override updated(): void {
		// The result checks itself from the internet once per visit, unless the run that turned it on already did.
		const screen = flowScreen(this.input());
		if (screen.kind === "result" && !this.checks && !this.checkedOnce && !this.polling) {
			this.checkedOnce = true;
			void this.ask("remoteTest");
		}
	}

	override render(): TemplateResult {
		const screen = flowScreen(this.input());
		if (screen.kind === "other") return html``;
		return html`
			<section class="flex flex-col gap-3 pt-5 border-t border-border" aria-labelledby="remote-flow-title" data-remote-flow=${screen.kind}>
				<h3 id="remote-flow-title" class="text-sm font-semibold text-foreground">${REMOTE_TITLE}</h3>
				${this.error ? html`<p class="text-xs text-destructive" role="alert" data-remote-error>${this.error}</p>` : nothing}
				${
					screen.kind === "loading"
						? html`<p class="text-xs text-muted-foreground" role="status">Checking...</p>`
						: screen.kind === "choose"
							? this.choose(screen)
							: screen.kind === "step"
								? this.step(screen)
								: screen.kind === "cloudflare"
									? this.cloudflare()
									: this.result(screen)
				}
			</section>
		`;
	}
}

/** Exported for the panel tests: how long the Funnel retry runs and how often. */
export const FUNNEL_RETRY = { everyMs: FUNNEL_POLL_MS, forMs: FUNNEL_RETRY_FOR_MS } as const;
