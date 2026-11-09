import { html, type TemplateResult } from "lit";

/** How someone with no helper gets one, for screens that give a helper command (a store install starts with none). */
export function helperInstallHint(): TemplateResult {
	return html`Don't have Polycarp's helper? Copy the setup prompt in Settings > Agents into your coding agent, or
		<a class="underline" href="https://dbaney.com/polycarp/" target="_blank" rel="noopener noreferrer">get Polycarp for Mac</a>.`;
}
