/**
 * Chrome updates a copy from the Web Store itself and adds `update_url` to its manifest; an
 * unpacked copy has none (static/manifest.chrome.json declares none). So a store copy has nothing
 * for Polycarp's own updater to do, and must not run code that replaces its files.
 */
export function isStoreInstall(manifest: { update_url?: unknown }): boolean {
	return typeof manifest.update_url === "string" && manifest.update_url.length > 0;
}

/** This running copy. False wherever `chrome` is missing (tests run outside a browser). */
export function runningFromStore(): boolean {
	return (
		typeof chrome !== "undefined" && !!chrome.runtime?.getManifest && isStoreInstall(chrome.runtime.getManifest())
	);
}
