import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { currentAppearance, onAppearance, previewAppearance, setAppearance } from "../appearance/apply.js";
import { currentMode, type Mode, setMode } from "../appearance/mode.js";
import { PRESETS, textOn } from "../appearance/palettes.js";
import { effectiveAccent } from "../appearance/tokens.js";
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
	/** What the person has typed in the hex box and not yet applied; undefined shows the accent in use. */
	@state() private draft?: string;
	@state() private accentError?: string;
	@state() private shared = true;
	private off?: () => void;

	getTabName(): string {
		return "Appearance";
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.off = onAppearance(() => {
			this.draft = undefined;
			this.accentError = undefined;
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
		this.shared = await connectSetTheme(preset, accent ?? null, currentMode()).then(
			() => true,
			() => false,
		);
	}

	private isDark(): boolean {
		return document.documentElement.classList.contains("dark");
	}

	private commitAccent(): void {
		if (this.draft === undefined) return;
		const text = this.draft.trim();
		const choice = currentAppearance();
		if (!text) {
			// An emptied box goes back to the preset's own accent.
			this.draft = undefined;
			this.accentError = undefined;
			if (choice.accent) void this.choose(choice.preset, undefined);
			return;
		}
		const hex = normalizeHex(text);
		if (!HEX.test(hex)) {
			this.accentError = "Use a color like #3b82f6.";
			return;
		}
		this.accentError = undefined;
		this.draft = undefined;
		// Typing the accent already in use changes nothing, and must not turn the preset's into a custom one.
		if (hex === effectiveAccent(choice, this.isDark())) return;
		void this.choose(choice.preset, hex);
	}

	private swatch(name: string): TemplateResult {
		const choice = currentAppearance();
		const dark = this.isDark();
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
		const inUse = effectiveAccent(choice, this.isDark());
		const shown = this.draft ?? inUse;
		const hex = HEX.test(normalizeHex(shown)) ? normalizeHex(shown) : inUse;
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
								// Dragging in the picker fires this many times a second: paint only. Saving and telling the helper wait for "change", when the picker closes.
								this.draft = undefined;
								this.accentError = undefined;
								previewAppearance({
									preset: currentAppearance().preset,
									accent: (e.target as HTMLInputElement).value.toLowerCase(),
								});
							}}
							@change=${(e: Event) => {
								void this.choose(
									currentAppearance().preset,
									(e.target as HTMLInputElement).value.toLowerCase(),
								);
							}}
						/>
						<input
							id="tk-accent-text"
							class="h-9 w-32 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
							placeholder="e.g. #3b82f6"
							spellcheck="false"
							autocomplete="off"
							aria-invalid=${this.accentError ? "true" : "false"}
							aria-describedby="tk-accent-help"
							.value=${shown}
							@input=${(e: Event) => {
								this.draft = (e.target as HTMLInputElement).value;
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
											this.draft = undefined;
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
						${this.accentError ?? `${choice.accent ? "Your accent" : "The preset's accent"} for buttons and highlights. Type another color to change it; text on it turns ${textOn(hex) === "#000000" ? "dark" : "light"} so it stays readable.`}
					</p>
				</div>

				<div class="space-y-2" role="radiogroup" aria-label="Light or dark">
					<div class="text-sm font-medium text-foreground">Mode</div>
					${MODES.map(
						([
							value,
							label,
						]) => html`<label class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
							<input type="radio" name="tk-mode" .checked=${this.mode === value} @change=${async () => {
								setMode(value);
								this.mode = value;
								this.requestUpdate();
								const choice = currentAppearance();
								this.shared = await connectSetTheme(choice.preset, choice.accent ?? null, value).then(
									() => true,
									() => false,
								);
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
