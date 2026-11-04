import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import { helmMark } from "../components/HelmMark.js";
import "../utils/i18n-extension.js";

const link = (href: string, label: string) =>
	html`<a href=${href} target="_blank" rel="noopener" class="text-foreground underline decoration-border underline-offset-2 hover:decoration-current">${label}</a>`;

@customElement("about-tab")
export class AboutTab extends SettingsTab {
	getTabName(): string {
		return i18n("About");
	}

	render(): TemplateResult {
		const version = chrome.runtime.getManifest().version;

		return html`
			<div class="flex flex-col gap-5">
				<div class="flex items-center gap-3">
					${helmMark(44, "tile", "rounded-[10px]")}
					<div>
						<h3 class="text-lg font-semibold tracking-tight text-foreground leading-tight">Tabkyra</h3>
						<p class="text-sm text-muted-foreground">${i18n("Version:")} ${version}</p>
					</div>
				</div>

				<div class="text-sm text-muted-foreground space-y-1">
					<p class="text-foreground">${i18n("You steer. Tabkyra works the tabs.")}</p>
					<p>${i18n("An AI agent in your side panel, and a browser your coding agents can drive.")}</p>
					<p>${i18n("The name joins tab and kyra, from Greek kybernētēs, “helmsman”.")}</p>
				</div>

				<div class="rounded-lg border border-border p-3 text-sm space-y-2">
					<p class="font-medium text-foreground">${i18n("Built on the work of")}</p>
					<p class="text-muted-foreground">
						${link("https://github.com/0xSero", "0xSero")}
						(${link("https://github.com/0xSero/sitegeist", "0xSero/sitegeist")}):
						${i18n("the agent bridge, the CLI and MCP server, agent tab groups, per-tab side panels and the foreground guard.")}
					</p>
					<p class="text-muted-foreground">
						${link("https://github.com/badlogic", "Mario Zechner")}
						(${link("https://github.com/badlogic/sitegeist", "badlogic/sitegeist")}):
						${i18n("the original Sitegeist extension and the pi agent libraries it runs on.")}
					</p>
				</div>

				<p class="text-xs text-muted-foreground">
					${link("https://github.com/baney75/tabkyra", "github.com/baney75/tabkyra")} · AGPL-3.0
				</p>
			</div>
		`;
	}
}
