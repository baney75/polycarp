/**
 * Redraws what's on screen after a library arrives. A code block or formula drawn before its library loaded shows as
 * plain text for that moment; this replaces it. Everything these libraries draw is in light DOM.
 */
export function redrawAfterLoad(): void {
	for (const element of document.querySelectorAll<HTMLElement & { requestUpdate?: () => void }>("*")) {
		element.requestUpdate?.();
	}
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
