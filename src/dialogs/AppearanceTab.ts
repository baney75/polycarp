import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { currentAppearance, onAppearance, setAppearance } from "../appearance/apply.js";
import { currentMode, type Mode, setMode } from "../appearance/mode.js";
import { PRESETS, textOn } from "../appearance/palettes.js";
import { connectSetTheme } from "../connect/client.js";

const PRESET_LABELS: Record<string, string> = {
	tabkyra: "Tabkyra",
	slate: "Slate",
	forest: "Forest",
	rose: "Rose",
	midnight: "Midnight",
};
const MODES: Array<[Mode, string]> = [
	["light", "Light"],
	["dark", "Dark"],
	["system", "Match system"],
];
const HEX = /^#[0-9a-f]{6}$/i;

/** Expands #rgb to #rrggbb; anything else is returned as typed. */
export function normalizeHex(text: string): string {
	const t = text.trim().toLowerCase();
	const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
	return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : t;
}

/**
 * Settings > Appearance: the five presets (the same ones the approval and hub pages use), a custom
 * accent, and Light / Dark / Match system. Applies at once, keeps the choice in extension storage and
 * tells Tabkyra's helper so the approval and hub pages match (skipped quietly when it isn't connected).
 */
@customElement("tabkyra-appearance-tab")
export class AppearanceTab extends SettingsTab {
	@state() private mode: Mode = currentMode();
	@state() private accentText = "";
	@state() private accentError?: string;
	@state() private shared = true;
	private off?: () => void;

	getTabName(): string {
		return "Appearance";
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.accentText = currentAppearance().accent ?? "";
		this.off = onAppearance((c) => {
			this.accentText = c.accent ?? "";
			this.requestUpdate();
		});
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.off?.();
	}

	private async choose(preset: string, accent: string | undefined): Promise<void> {
		await setAppearance({ preset, ...(accent ? { accent } : {}) });
		// The pages served from this computer follow; no helper means nothing to tell.
		this.shared = await connectSetTheme(preset, accent ?? null).then(
			() => true,
			() => false,
		);
	}

	private commitAccent(): void {
		const text = this.accentText.trim();
		if (!text) {
			this.accentError = undefined;
			void this.choose(currentAppearance().preset, undefined);
			return;
		}
		const hex = normalizeHex(text);
		if (!HEX.test(hex)) {
			this.accentError = "Use a color like #3b82f6.";
			return;
		}
		this.accentError = undefined;
		this.accentText = hex;
		void this.choose(currentAppearance().preset, hex);
	}

	private swatch(name: string): TemplateResult {
		const choice = currentAppearance();
		const dark = document.documentElement.classList.contains("dark");
		const palette = PRESETS[name][dark ? "dark" : "light"];
		const selected = choice.preset === name;
		return html`
			<button
				type="button"
				aria-pressed=${selected ? "true" : "false"}
				data-preset=${name}
				class="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-foreground" : "border-border hover:bg-secondary/60"}"
				@click=${() => void this.choose(name, choice.accent)}
			>
				<span class="flex h-6 w-9 shrink-0 overflow-hidden rounded border border-border" aria-hidden="true">
					<span class="w-1/2" style="background:${palette.bg}"></span>
					<span class="w-1/2" style="background:${choice.accent ?? palette.accent}"></span>
				</span>
				<span class="min-w-0 truncate text-foreground">${PRESET_LABELS[name] ?? name}</span>
			</button>
		`;
	}

	render(): TemplateResult {
		const choice = currentAppearance();
		const hex = HEX.test(normalizeHex(this.accentText))
			? normalizeHex(this.accentText)
			: (choice.accent ?? "#000000");
		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-1">
					<h3 class="text-lg font-semibold text-foreground">Appearance</h3>
					<p class="text-sm text-muted-foreground">Colors for this panel and for the approval and hub pages Tabkyra serves from your computer.</p>
				</div>

				<div class="space-y-2" role="group" aria-label="Color preset">
					<div class="text-sm font-medium text-foreground">Colors</div>
					<div class="grid grid-cols-2 gap-2">${Object.keys(PRESETS).map((name) => this.swatch(name))}</div>
				</div>

				<div class="space-y-2">
					<label for="tk-accent-text" class="text-sm font-medium text-foreground">Custom accent</label>
					<div class="flex items-center gap-2">
						<input
							type="color"
							aria-label="Pick an accent color"
							class="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
							.value=${hex}
							@input=${(e: Event) => {
								this.accentText = (e.target as HTMLInputElement).value;
								this.accentError = undefined;
								void this.choose(currentAppearance().preset, this.accentText);
							}}
						/>
						<input
							id="tk-accent-text"
							class="h-9 w-32 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
							placeholder="#3b82f6"
							spellcheck="false"
							autocomplete="off"
							aria-invalid=${this.accentError ? "true" : "false"}
							aria-describedby="tk-accent-help"
							.value=${this.accentText}
							@input=${(e: Event) => {
								this.accentText = (e.target as HTMLInputElement).value;
							}}
							@blur=${() => this.commitAccent()}
							@keydown=${(e: KeyboardEvent) => {
								if (e.key === "Enter") this.commitAccent();
							}}
						/>
						${
							choice.accent
								? html`<button
										type="button"
										class="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
										@click=${() => {
											this.accentText = "";
											this.accentError = undefined;
											void this.choose(choice.preset, undefined);
										}}
									>
										Use the preset's
									</button>`
								: ""
						}
					</div>
					<p id="tk-accent-help" class="text-xs ${this.accentError ? "text-destructive" : "text-muted-foreground"}" role=${this.accentError ? "alert" : "note"}>
						${this.accentError ?? `Buttons and highlights. Text on it turns ${textOn(hex) === "#000000" ? "dark" : "light"} so it stays readable.`}
					</p>
				</div>

				<div class="space-y-2" role="radiogroup" aria-label="Light or dark">
					<div class="text-sm font-medium text-foreground">Mode</div>
					${MODES.map(
						([
							value,
							label,
						]) => html`<label class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
							<input type="radio" name="tk-mode" .checked=${this.mode === value} @change=${() => {
								setMode(value);
								this.mode = value;
								this.requestUpdate();
							}} />
							${label}
						</label>`,
					)}
				</div>

				${this.shared ? "" : html`<p class="text-xs text-muted-foreground">Saved for this panel. Tabkyra's helper isn't connected, so the approval and hub pages keep their colors.</p>`}
			</div>
		`;
	}
}
