import type { NavigationMessage } from "./NavigationMessage";

export interface ContinueMessage {
	role: "continue";
}

// Extend CustomAgentMessages interface via declaration merging
declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		navigation: NavigationMessage;
		continue: ContinueMessage;
	}
}
