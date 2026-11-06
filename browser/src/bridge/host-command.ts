import { UPDATE_STATUS_KEY } from "./protocol.js";

/**
 * What a person types to run the helper: "polycarp browser" when the helper is the one inside the Polycarp app, "tabkyra" for an
 * npm link or a checkout. The helper says which in its update status; until it has, "tabkyra" is the name that works everywhere.
 */
let command = "tabkyra";

function take(status: unknown): void {
	const named = (status as { command?: unknown } | undefined)?.command;
	if (named === "polycarp browser" || named === "tabkyra") command = named;
}

try {
	void chrome.storage.local.get(UPDATE_STATUS_KEY).then((r) => take(r[UPDATE_STATUS_KEY]));
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes[UPDATE_STATUS_KEY]) take(changes[UPDATE_STATUS_KEY].newValue);
	});
} catch {
	/* not an extension page (tests) */
}

export function hostCommand(): string {
	return command;
}
