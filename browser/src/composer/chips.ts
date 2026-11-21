/**
 * Chips for composer references: above the text box while typing, and on a sent message.
 * The tab titles come from the "@" menu (remembered here) or, once sent, from the frozen refs.
 */
import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { AppWindow, CircleAlert, Sparkles, X } from "lucide";
import { type ComposerRefs, leadingSkill, parseRefs, removeTabToken, type TabRef } from "./refs.js";

export interface KnownTab {
	title: string;
	url: string;
	favIconUrl?: string;
}

/** Tabs the "@" menu listed, by id, so a chip can show a title without another lookup. */
export const knownTabs = new Map<number, KnownTab>();
/** Skill names the "/" menu listed: only a real skill gets a chip. */
export const knownSkills = new Set<string>();

const chipClass =
	"inline-flex items-center gap-1.5 max-w-[16rem] rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs text-foreground";

function tabChip(id: number, info: Partial<TabRef> & { favIconUrl?: string }, onRemove?: () => void): TemplateResult {
	const blocked = info.status && !["shared", "already-shared"].includes(info.status);
	const title = info.title || `Tab ${id}`;
	const why =
		info.status === "other-agent"
			? `Stays with ${info.owner ?? "another agent"}; not shared`
			: info.status === "unavailable"
				? "This page can't be shared"
				: info.status === "private"
					? "Private tab; not shared"
					: info.status === "gone"
						? "Tab was closed"
						: info.url;
	return html`<span class="${chipClass} ${blocked ? "border-destructive/50 text-destructive" : ""}" title=${why ?? title}>
		${
			blocked
				? html`<span class="inline-flex shrink-0">${icon(CircleAlert, "xs")}</span>`
				: info.favIconUrl
					? html`<img src=${info.favIconUrl} alt="" class="w-3.5 h-3.5 shrink-0" />`
					: html`<span class="inline-flex shrink-0">${icon(AppWindow, "xs")}</span>`
		}
		<span class="truncate">${title}</span>
		${blocked && info.status === "other-agent" ? html`<span class="shrink-0 opacity-80">· in use</span>` : nothing}
		${
			onRemove
				? html`<button type="button" class="shrink-0 opacity-70 hover:opacity-100" aria-label="Remove ${title}" @click=${onRemove}>
						${icon(X, "xs")}
					</button>`
				: nothing
		}
	</span>`;
}

function skillChip(name: string, onRemove?: () => void): TemplateResult {
	return html`<span class="${chipClass}" title="Runs the ${name} skill">
		<span class="inline-flex shrink-0">${icon(Sparkles, "xs")}</span>
		<span class="truncate">${name}</span>
		${
			onRemove
				? html`<button type="button" class="shrink-0 opacity-70 hover:opacity-100" aria-label="Remove skill ${name}" @click=${onRemove}>
						${icon(X, "xs")}
					</button>`
				: nothing
		}
	</span>`;
}

/** The composer accessory: one chip per reference in the text being typed. */
export function composerChips(value: string, setValue: (v: string) => void): unknown {
	const { tabIds } = parseRefs(value);
	const skill = leadingSkill(value, knownSkills);
	const showSkill = skill !== undefined;
	if (!showSkill && tabIds.length === 0) return nothing;
	return html`<div class="px-3 pt-3 flex flex-wrap gap-1.5" aria-label="References">
		${showSkill ? skillChip(skill, () => setValue(value.trimStart().replace(`/${skill}`, "").trimStart())) : nothing}
		${tabIds.map((id) => {
			const t = knownTabs.get(id);
			return tabChip(id, { title: t?.title, url: t?.url, favIconUrl: t?.favIconUrl }, () =>
				setValue(removeTabToken(value, id)),
			);
		})}
	</div>`;
}

/**
 * Chips on a sent message: the frozen refs when it has them, else (not resolved yet) what the
 * menu knew. `null` means resolved to nothing: the text went as typed, so no chips.
 */
export function sentChips(text: string, refs: ComposerRefs | null | undefined): TemplateResult | typeof nothing {
	if (refs === null) return nothing;
	const parsed = parseRefs(text);
	const skill = refs ? refs.skill?.name : leadingSkill(text, knownSkills);
	const tabs = refs
		? refs.tabs
		: parsed.tabIds.map(
				(id) => ({ id, title: knownTabs.get(id)?.title ?? "", url: knownTabs.get(id)?.url ?? "" }) as TabRef,
			);
	if (!skill && tabs.length === 0) return nothing;
	return html`<div class="mb-1.5 flex flex-wrap gap-1.5">
		${skill ? skillChip(skill) : nothing}
		${tabs.map((t) => tabChip(t.id, { ...t, favIconUrl: knownTabs.get(t.id)?.favIconUrl }))}
	</div>`;
}
