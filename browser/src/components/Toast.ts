import { icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { AlertCircle, CheckCircle, Info, X } from "lucide";

type ToastType = "success" | "error" | "info";

export interface ToastAction {
	label: string;
	run: () => void;
}

@customElement("toast-notification")
export class Toast extends LitElement {
	@property() message = "";
	@property() type: ToastType = "info";
	@property() duration = 3000;
	@property({ type: Boolean }) isExiting = false;
	/** One optional button, such as Undo. */
	@property({ attribute: false }) action?: ToastAction;

	private timeoutId?: number;

	connectedCallback() {
		super.connectedCallback();
		// Auto-dismiss after duration
		if (this.duration > 0) {
			this.timeoutId = window.setTimeout(() => this.dismiss(), this.duration);
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
		}
	}

	dismiss() {
		this.isExiting = true;
		this.requestUpdate();
		setTimeout(() => this.remove(), 300);
	}

	render() {
		const iconEl =
			this.type === "success"
				? html`<span class="inline-flex shrink-0 text-green-700 dark:text-green-400">${icon(CheckCircle, "sm")}</span>`
				: this.type === "error"
					? html`<span class="inline-flex shrink-0 text-destructive">${icon(AlertCircle, "sm")}</span>`
					: html`<span class="inline-flex shrink-0 text-[var(--tk-brass-text)]">${icon(Info, "sm")}</span>`;
		const accent =
			this.type === "success" ? "#16a34a" : this.type === "error" ? "var(--color-destructive)" : "var(--tk-brass)";

		// Below the header and inside the panel: the old fixed 300 px box sat on the header's
		// buttons in a narrow panel, and its white text on the light theme's muted gray was unreadable.
		return html`
			<div
				class="fixed top-14 inset-x-3 z-[9999] flex justify-center pointer-events-none ${this.isExiting ? "animate-out fade-out duration-200" : "animate-in fade-in slide-in-from-top-2 duration-200"}"
			>
				<div
					role=${this.type === "error" ? "alert" : "status"}
					class="pointer-events-auto w-full max-w-sm flex items-center gap-2.5 pl-3 pr-1.5 py-2 bg-popover text-popover-foreground rounded-lg shadow-lg border border-border"
					style="border-left: 3px solid ${accent}"
				>
					${iconEl}
					<span class="flex-1 min-w-0 text-sm">${this.message}</span>
					${
						this.action
							? html`<button
								type="button"
								class="shrink-0 h-8 px-2.5 rounded-md text-sm font-semibold text-foreground hover:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
								@click=${() => {
									this.action?.run();
									this.dismiss();
								}}
							>
								${this.action.label}
							</button>`
							: ""
					}
					<button
						type="button"
						aria-label="Dismiss"
						@click=${() => this.dismiss()}
						class="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
					>
						${icon(X, "sm")}
					</button>
				</div>
			</div>
		`;
	}

	createRenderRoot() {
		return this;
	}

	/**
	 * Static method to show a toast notification
	 */
	static show(message: string, type: ToastType = "info", duration = 3000, action?: ToastAction) {
		// One toast at a time: a new one replaces the last instead of stacking on top of it.
		for (const old of document.querySelectorAll<Toast>("toast-notification")) old.remove();
		const toast = document.createElement("toast-notification") as Toast;
		toast.message = message;
		toast.type = type;
		toast.duration = duration;
		toast.action = action;
		document.body.appendChild(toast);
		return toast;
	}

	static info(message: string, duration = 3000) {
		return Toast.show(message, "info", duration);
	}

	static success(message: string, duration = 3000) {
		return Toast.show(message, "success", duration);
	}

	static error(message: string, duration = 5000) {
		return Toast.show(message, "error", duration);
	}
}
