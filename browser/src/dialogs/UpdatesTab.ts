import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
	phaseLabel,
	requestUpdate,
	updateRunning,
	updateState,
	watchUpdateStatus,
} from "../components/UpdateNotice.js";
import { BUILD, describeBuild } from "../update/build.js";
import { POLICY_LABELS, type UpdatePolicy } from "../update/logic.js";

const MODE_LABELS: Record<string, string> = {
	release: "Signed release (~/.local/share/tabkyra/app)",
	checkout: "Git checkout (pull, build, reload)",
	unmanaged: "Neither (update in a terminal)",
};

function when(ms: number | undefined): string {
	if (!ms) return "never";
	const d = new Date(ms);
	const mins = Math.round((Date.now() - ms) / 60000);
	const rel =
		mins >= 0
			? mins < 1
				? "just now"
				: mins < 60
					? `${mins} min ago`
					: `${Math.round(mins / 60)} h ago`
			: -mins < 60
				? `in ${-mins} min`
				: `in ${Math.round(-mins / 60)} h`;
	return `${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (${rel})`;
}

/**
 * Settings > Updates: what runs, how it updates, the last and next check, and the buttons.
 * Every button is a fixed action name sent to the native host (docs/updates.md).
 */
@customElement("updates-tab")
export class UpdatesTab extends SettingsTab {
	@state() private tick = 0;
	private unwatch?: () => void;

	getTabName(): string {
		return "Updates";
	}

	override async connectedCallback() {
		super.connectedCallback();
		this.unwatch = await watchUpdateStatus(() => {
			this.tick++;
		});
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.unwatch?.();
	}

	private row(label: string, value: TemplateResult | string, testid?: string): TemplateResult {
		return html`<div class="flex gap-3 text-sm">
			<div class="w-28 shrink-0 text-muted-foreground">${label}</div>
			<div class="min-w-0 break-words text-foreground" data-testid=${testid ?? nothing}>${value}</div>
		</div>`;
	}

	render(): TemplateResult {
		const s = updateState.status;
		const p = updateState.progress;
		const busy = updateRunning();
		const policy: UpdatePolicy = s?.policy ?? "notify";
		const current =
			s?.mode === "checkout" ? describeBuild(BUILD) : (BUILD?.version ?? chrome.runtime.getManifest().version);
		return html`
			<div class="flex flex-col gap-5" data-tick=${this.tick}>
				<div class="space-y-1">
					<h3 class="text-lg font-semibold text-foreground">Updates</h3>
					<p class="text-sm text-muted-foreground">
						Tabkyra checks once a day. An update downloads or builds while you work, then installs and reloads
						Tabkyra when no agent is running in any side panel or bridge session.
					</p>
				</div>

				${
					s
						? html`<div class="space-y-1.5">
								${this.row("Running", current, "updates-current")}
								${this.row("Installed", s.current)}
								${this.row("Mode", MODE_LABELS[s.mode ?? "release"] ?? s.mode ?? "release", "updates-mode")}
								${s.root ? this.row("Folder", html`<span class="font-mono text-xs">${s.root}</span>`) : nothing}
								${this.row("Channel", s.mode === "checkout" ? "main (origin/main)" : s.channel)}
								${this.row("Last check", when(s.checkedAt))}
								${this.row("Next check", s.policy === "off" ? "off" : when(s.nextCheckAt))}
								${this.row(
									"Status",
									s.error
										? html`<span class="text-destructive">${s.error}</span>`
										: s.available
											? s.mode === "checkout"
												? s.behind
													? `${s.behind} new commit${s.behind === 1 ? "" : "s"} on origin/main (${s.latest})`
													: "The build is behind the checkout; Update now builds it"
												: `Update available: ${s.latest}`
											: s.policy === "off"
												? "Checks are off"
												: "Up to date",
									"updates-status",
								)}
								${s.blocked ? this.row("Can't update", html`<span class="text-destructive">${s.blocked}</span>`) : nothing}
								${s.mismatch ? this.row("Mismatch", s.mismatch.reason) : nothing}
							</div>`
						: html`<p class="text-sm text-muted-foreground">
								The native host hasn't reported yet. Updates need the Tabkyra CLI: run
								<code class="font-mono">tabkyra doctor</code> in a terminal.
							</p>`
				}

				<div class="flex gap-2 flex-wrap">
					${Button({ size: "sm", variant: "secondary", children: "Check now", disabled: busy || !s, onClick: () => requestUpdate("check") })}
					${
						s?.staged
							? Button({
									size: "sm",
									variant: "default",
									children: `Install ${s.staged} now`,
									disabled: busy,
									onClick: () => requestUpdate("install"),
								})
							: Button({
									size: "sm",
									variant: "default",
									children: "Update now",
									disabled: busy || !s || !!s.blocked,
									onClick: () => requestUpdate("update"),
								})
					}
					${Button({
						size: "sm",
						variant: "outline",
						children: s?.rollbackTo ? `Roll back to ${s.rollbackTo}` : "Roll back",
						disabled: busy || !s?.canRollback,
						onClick: () => requestUpdate("rollback"),
					})}
				</div>

				${
					p && !p.action.startsWith("policy-")
						? html`<div class="text-sm ${p.phase === "failed" ? "text-destructive" : "text-muted-foreground"}" data-testid="updates-progress">
								<span class="font-medium">${phaseLabel(p.phase)}:</span>
								<span class="whitespace-pre-wrap">${p.message}</span>
							</div>`
						: nothing
				}

				<fieldset class="space-y-2">
					<legend class="text-sm font-medium text-foreground mb-2">When there's an update</legend>
					${(Object.keys(POLICY_LABELS) as UpdatePolicy[]).map(
						(value) => html`<label class="flex items-start gap-2 text-sm text-foreground cursor-pointer">
							<input
								type="radio"
								name="update-policy"
								value=${value}
								.checked=${policy === value}
								?disabled=${!s}
								@change=${() => requestUpdate(`policy-${value}`)}
							/>
							${POLICY_LABELS[value]}
						</label>`,
					)}
					<p class="text-xs text-muted-foreground">
						Install automatically waits until no agent has run for a few minutes, and checks again right before it
						reloads.
					</p>
				</fieldset>
			</div>
		`;
	}
}
