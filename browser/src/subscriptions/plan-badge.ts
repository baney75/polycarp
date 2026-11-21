import { html, nothing, type TemplateResult } from "lit";
import { CHATGPT_PROVIDER, COPILOT_PROVIDER, SIWC } from "./constants.js";

/**
 * "Using ChatGPT plan" with a Manage usage link while a ChatGPT plan model is selected, as OpenAI's
 * SIWC UI guidelines ask; the same line for Copilot. Nothing for any other model.
 */
export function planBadge(provider: string | undefined): TemplateResult | typeof nothing {
	if (provider === CHATGPT_PROVIDER)
		return html`<div class="px-3 py-1 text-xs text-muted-foreground border-b border-border shrink-0" data-testid="plan-badge">
			Using ChatGPT plan ·
			<a class="underline" href=${SIWC.usageUrl} target="_blank" rel="noopener">Manage usage</a>
		</div>`;
	if (provider === COPILOT_PROVIDER)
		return html`<div class="px-3 py-1 text-xs text-muted-foreground border-b border-border shrink-0" data-testid="plan-badge">
			Using your GitHub Copilot plan
		</div>`;
	return nothing;
}
