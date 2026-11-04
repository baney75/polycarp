/**
 * Free mode in the side panel: the pinned selector entry, the composer label, the Settings
 * switch and the per-request swap in the stream gate. Decisions: docs/decisions.md D26.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { setPinnedModels } from "@mariozechner/pi-web-ui";
import { ApiKeyDialog } from "../dialogs/ApiKeyDialog.js";
import { FREE_KEY_NOTE, FREE_MODEL_NAME, freeLabel, OPENROUTER_FREE_ROUTER } from "./free-mode.js";
import {
	type FreeList,
	freeChains,
	freeModeModel,
	isFreeModeModel,
	loadFreeList,
	resolveFreeModel,
	type SettingsLike,
	streamFreeChains,
} from "./free-runtime.js";

export interface FreePanelHost {
	settings: SettingsLike;
	hasOpenRouterKey(): Promise<boolean>;
	currentModel(): Model<Api> | undefined;
	setModel(model: Model<Api>): Promise<void>;
	/** Leave Free mode for the model used before it, or the usual default when there was none. */
	leaveFreeMode(previous: Model<Api> | undefined): Promise<void>;
}

/** The model in use before Free mode was turned on; turning it off goes back to it. */
const PREVIOUS_MODEL_KEY = "freeMode.previousModel";

let host: FreePanelHost | undefined;
/** Names from the last free list, for the composer label (which must render synchronously). */
const names = new Map<string, string>();

function remember(list: FreeList) {
	for (const m of list.models) if (m.name) names.set(m.id, m.name);
}

/** The model that answered the latest Free mode reply in this chat, if any. */
export function lastFreeAnswer(messages: AgentMessage[]): { id: string; name?: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; provider?: string; model?: string; responseModel?: string };
		if (m.role !== "assistant") continue;
		if (m.provider !== "openrouter") return undefined;
		const id = m.responseModel ?? m.model;
		if (!id || !(id.endsWith(":free") || id === OPENROUTER_FREE_ROUTER)) return undefined;
		return { id, name: names.get(id) };
	}
	return undefined;
}

/** The composer's label in Free mode ("Free" or "Free · <model>"); undefined for other models. */
export function freeComposerText(
	model: { provider: string; id: string },
	messages: AgentMessage[],
): string | undefined {
	return isFreeModeModel(model) ? freeLabel(lastFreeAnswer(messages)) : undefined;
}

export function installFreeMode(panelHost: FreePanelHost): void {
	host = panelHost;
	setPinnedModels(() => [
		{
			model: freeModeModel(),
			title: FREE_MODEL_NAME,
			subtitle: "Free · OpenRouter · providers may log prompts",
		},
	]);
	// Warm the list (and its names) in the background; a day-old cache is refreshed.
	loadFreeList(panelHost.settings)
		.then(remember)
		.catch(() => {});
}

export function isFreeModeOn(): boolean {
	return isFreeModeModel(host?.currentModel());
}

/**
 * Turn Free mode on or off. With no OpenRouter key, the key prompt opens with one line on
 * getting a free key, and Free mode stays off unless a key is added. Returns the new state.
 */
export async function setFreeMode(on: boolean): Promise<boolean> {
	if (!host) return false;
	if (!on) {
		if (isFreeModeOn())
			await host.leaveFreeMode((await host.settings.get<Model<Api>>(PREVIOUS_MODEL_KEY)) ?? undefined);
		return false;
	}
	if (!(await host.hasOpenRouterKey()) && !(await ApiKeyDialog.prompt("openrouter", FREE_KEY_NOTE))) return false;
	const current = host.currentModel();
	if (current && !isFreeModeModel(current)) await host.settings.set(PREVIOUS_MODEL_KEY, current);
	await host.setModel(freeModeModel());
	return true;
}

type Inner = Parameters<typeof streamFreeChains>[0];

/**
 * The stream gate's Free mode step: pick the chains from the live list, then stream them in
 * turn. Throws (nothing is sent) when the list can't be loaded, no free model is usable, or
 * private mode is on and no free model has zero data retention.
 */
export async function streamFree(
	model: Model<Api>,
	context: unknown,
	options: Parameters<typeof streamFreeChains>[4],
	privateMode: boolean,
	inner: Inner,
	/** Applied to every real model sent: private mode adds its zero-data-retention routing here. */
	finish: (model: Model<Api>) => Model<Api>,
	settings: SettingsLike,
) {
	const list = await loadFreeList(settings);
	remember(list);
	const chains = freeChains(list, privateMode);
	return streamFreeChains(
		inner,
		(chain) => finish(resolveFreeModel(model, chain, list)),
		chains,
		context,
		options,
		(message) => {
			// A pulled model: refresh the list so the next turn doesn't ask for it again.
			if (/not a valid model/i.test(message ?? ""))
				loadFreeList(settings, { force: true })
					.then(remember)
					.catch(() => {});
		},
	);
}
