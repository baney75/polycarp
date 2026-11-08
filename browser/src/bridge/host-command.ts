import { UPDATE_STATUS_KEY } from "./protocol.js";

/**
 * What a person types to run the helper: "polycarp browser" when the helper is the one inside the Polycarp app, "polycarp-browser" for
 * an npm link or a checkout (an older helper reports "tabkyra", and that is shown as it reports it). The helper says which in its update status; until it has, the product's own name. Someone who just
 * installed from the store has neither, so the screens that show this also say how to get the helper.
 */
let command = "polycarp browser";
let known = false;

function take(status: unknown): void {
	const named = (status as { command?: unknown } | undefined)?.command;
	if (named === "polycarp browser" || named === "polycarp-browser" || named === "tabkyra") {
		command = named;
		known = true;
	}
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

/** A helper built from the setup prompt answers to `polycarp-browser`, and one that hasn't reported yet could be either. */
export function builtHelperCommand(subcommand: string): string | undefined {
	return known ? undefined : `polycarp-browser ${subcommand}`;
}

/** The command for a sentence: the one name once the helper has said which, and both until then. */
export function hostCommandText(subcommand: string): string {
	const built = builtHelperCommand(subcommand);
	return built
		? `${command} ${subcommand} (or ${built} if you built the helper yourself)`
		: `${command} ${subcommand}`;
}
