import { FileText, Globe, type IconNode, PanelsTopLeft, TextCursorInput } from "lucide";

export interface StarterPrompt {
	label: string;
	/** One short line under the label: what the chip does. */
	hint: string;
	icon: IconNode;
	prompt: string;
	/**
	 * "send" runs the prompt at once. "compose" puts it in the chat input for the user to finish
	 * (the topic, the form's details, the tabs); a trailing "@" opens the tab menu.
	 */
	mode: "send" | "compose";
}

/** The empty chat's starter chips: what Tabkyra does best, each a task that runs as is. */
export const starters: StarterPrompt[] = [
	{
		label: "Summarize this page",
		hint: "The tab you're on",
		icon: FileText,
		mode: "send",
		prompt:
			"Read the page in my current tab and summarize it: what it is, the key points, and anything I should act on. Quote the page where it matters.",
	},
	{
		label: "Research with sources",
		hint: "Every claim linked",
		icon: Globe,
		mode: "compose",
		prompt: "Research this and link a source for every claim: ",
	},
	{
		label: "Fill a form",
		hint: "Stops before submit",
		icon: TextCursorInput,
		mode: "compose",
		prompt: "Fill in the form on this page with these details, then stop before submitting so I can check it: ",
	},
	{
		label: "Compare tabs",
		hint: "Pick tabs with @",
		icon: PanelsTopLeft,
		mode: "compose",
		prompt: "Compare these tabs side by side in a table: @",
	},
];
