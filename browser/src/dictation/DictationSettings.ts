/** Settings > Privacy > Dictation: which speech model runs on this device, and its download. */

import { html, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import {
	cachedModels,
	DEFAULT_SETTING,
	type DictationSetting,
	readSetting,
	removeCachedModels,
	writeSetting,
} from "./settings.js";
import { chooseModel, MODELS, type ModelKey, profileDevice } from "./tiers.js";

const LANGUAGES: Array<[string, string]> = [
	["auto", "Detect it"],
	["en", "English"],
	["es", "Spanish"],
	["fr", "French"],
	["de", "German"],
	["it", "Italian"],
	["pt", "Portuguese"],
	["nl", "Dutch"],
	["pl", "Polish"],
	["ru", "Russian"],
	["uk", "Ukrainian"],
	["tr", "Turkish"],
	["ar", "Arabic"],
	["hi", "Hindi"],
	["zh", "Chinese"],
	["ja", "Japanese"],
	["ko", "Korean"],
];

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

@customElement("tabkyra-dictation-settings")
export class DictationSettings extends LitElement {
	@state() private setting: DictationSetting = DEFAULT_SETTING;
	@state() private auto?: { key: ModelKey; why: string };
	@state() private gpu = false;
	@state() private stored = { files: 0, bytes: 0 };
	private device?: Awaited<ReturnType<typeof profileDevice>>;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override async connectedCallback(): Promise<void> {
		super.connectedCallback();
		this.setting = await readSetting();
		const device = await profileDevice();
		this.gpu = device.webgpu;
		this.device = device;
		this.auto = chooseModel(device, this.setting.language);
		this.stored = await cachedModels();
	}

	private async save(next: Partial<DictationSetting>): Promise<void> {
		this.setting = { ...this.setting, ...next };
		if (this.device) this.auto = chooseModel(this.device, this.setting.language);
		await writeSetting(this.setting);
	}

	private async removeModels(): Promise<void> {
		await removeCachedModels();
		this.stored = await cachedModels();
		Toast.success("Downloaded speech models removed. The next dictation downloads one again.");
	}

	override render(): TemplateResult {
		const auto = this.auto ? MODELS[this.auto.key] : undefined;
		const select =
			"h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
		return html`
			<div class="space-y-2" data-testid="dictation-settings">
				<h3 class="text-sm font-semibold text-foreground">Dictation</h3>
				<p class="text-xs text-muted-foreground">
					The microphone button turns speech into text on this computer. The audio never leaves the browser. The
					model is downloaded once from Hugging Face and kept here.
				</p>
				${
					auto
						? html`<p class="text-xs text-foreground">
								This device: <span class="font-medium">${auto.label}</span>, about ${auto.downloadMB} MB, for
								${this.auto?.why}.
							</p>`
						: html`<p class="text-xs text-muted-foreground">Checking this device…</p>`
				}
				<label class="flex flex-col gap-1 text-xs text-muted-foreground">
					Model
					<select
						class=${select}
						.value=${this.setting.model}
						@change=${(e: Event) => void this.save({ model: (e.target as HTMLSelectElement).value as DictationSetting["model"] })}
					>
						<option value="auto">Automatic for this device</option>
						${(Object.keys(MODELS) as ModelKey[]).map(
							(key) =>
								html`<option value=${key} ?disabled=${MODELS[key].device === "webgpu" && !this.gpu}>
									${MODELS[key].label}, ${MODELS[key].device === "webgpu" ? "GPU" : "processor"}, ${MODELS[key].downloadMB} MB
								</option>`,
						)}
					</select>
				</label>
				<label class="flex flex-col gap-1 text-xs text-muted-foreground">
					Language
					<select class=${select} .value=${this.setting.language} @change=${(e: Event) => void this.save({ language: (e.target as HTMLSelectElement).value })}>
						${LANGUAGES.map(([code, name]) => html`<option value=${code}>${name}</option>`)}
					</select>
				</label>
				${
					this.setting.model !== "auto" &&
					!MODELS[this.setting.model].multilingual &&
					(this.setting.language === "auto"
						? !/^en\b/i.test(navigator.language)
						: this.setting.language !== "en") &&
					auto
						? html`<p class="text-xs text-muted-foreground">
								${MODELS[this.setting.model].label} is English-only, so ${
									LANGUAGES.find(([code]) => code === this.setting.language)?.[1] ?? this.setting.language
								} dictation uses ${auto.label}.
							</p>`
						: ""
				}
				<div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
					<span>Downloaded: ${this.stored.files ? (this.stored.bytes ? mb(this.stored.bytes) : `${this.stored.files} files`) : "nothing yet"}</span>
					${
						this.stored.files
							? html`<button
									type="button"
									class="h-8 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive/10 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
									@click=${() => void this.removeModels()}
								>
									Remove
								</button>`
							: ""
					}
				</div>
			</div>
		`;
	}
}
