import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Check, Ellipsis, type IconNode } from "lucide";

export interface HeaderMenuItem {
	label: string;
	icon?: IconNode;
	/** Shown as a menuitemradio with a check when true or false. */
	checked?: boolean;
	/** Starts a new group with a divider above it. */
	separator?: boolean;
	run: () => void;
}

/**
 * The header's "More" button and its menu: the actions used now and then (record a skill,
 * copy the chat, theme) live here so the header keeps only what is used every chat.
 * Keyboard: Enter, Space or ArrowDown opens it on the first item; arrows, Home and End move;
 * Escape closes it and returns focus to the button; Tab closes it.
 */
@customElement("tk-header-menu")
export class HeaderMenu extends LitElement {
	@property({ attribute: false }) items: HeaderMenuItem[] = [];
	@property() label = "More";
	@state() private open = false;

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "inline-flex";
		this.style.position = "relative";
		document.addEventListener("pointerdown", this.onOutside, true);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener("pointerdown", this.onOutside, true);
	}

	private onOutside = (e: Event) => {
		if (this.open && !this.contains(e.target as Node)) this.open = false;
	};

	private menuItems(): HTMLElement[] {
		return [...this.querySelectorAll<HTMLElement>("[role^=menuitem]")];
	}

	private async show(focus: "first" | "last") {
		this.open = true;
		await this.updateComplete;
		const items = this.menuItems();
		(focus === "first" ? items[0] : items.at(-1))?.focus();
	}

	private hide(returnFocus: boolean) {
		this.open = false;
		if (returnFocus) this.querySelector<HTMLElement>("button[aria-haspopup]")?.focus();
	}

	private onButtonKey(e: KeyboardEvent) {
		if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			void this.show("first");
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			void this.show("last");
		}
	}

	private onMenuKey(e: KeyboardEvent) {
		const items = this.menuItems();
		const i = items.indexOf(document.activeElement as HTMLElement);
		const move = (to: number) => {
			e.preventDefault();
			items[(to + items.length) % items.length]?.focus();
		};
		if (e.key === "ArrowDown") move(i + 1);
		else if (e.key === "ArrowUp") move(i - 1);
		else if (e.key === "Home") move(0);
		else if (e.key === "End") move(items.length - 1);
		else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			this.hide(true);
		} else if (e.key === "Tab") this.hide(false);
	}

	private choose(item: HeaderMenuItem) {
		this.hide(true);
		item.run();
	}

	private renderItem(item: HeaderMenuItem): TemplateResult {
		const radio = item.checked !== undefined;
		return html`
			${item.separator ? html`<div role="separator" class="my-1 h-px bg-border"></div>` : nothing}
			<button
				type="button"
				role=${radio ? "menuitemradio" : "menuitem"}
				aria-checked=${radio ? String(item.checked) : nothing}
				tabindex="-1"
				class="tk-menu-item"
				@click=${() => this.choose(item)}
			>
				<span class="inline-flex w-4 shrink-0 justify-center">${item.icon ? icon(item.icon, "sm") : nothing}</span>
				<span class="flex-1 text-left">${item.label}</span>
				${radio && item.checked ? html`<span class="inline-flex text-[var(--tk-brass-text)]">${icon(Check, "sm")}</span>` : nothing}
			</button>
		`;
	}

	override render() {
		return html`
			<button
				type="button"
				class="tk-icon-btn"
				aria-label=${this.label}
				data-tip=${this.label}
				aria-haspopup="menu"
				aria-expanded=${this.open ? "true" : "false"}
				@click=${() => (this.open ? this.hide(false) : void this.show("first"))}
				@keydown=${(e: KeyboardEvent) => this.onButtonKey(e)}
			>
				${icon(Ellipsis, "sm")}
			</button>
			${
				this.open
					? html`<div role="menu" aria-label=${this.label} class="tk-menu" @keydown=${(e: KeyboardEvent) => this.onMenuKey(e)}>
							${this.items.map((item) => this.renderItem(item))}
						</div>`
					: nothing
			}
		`;
	}
}
