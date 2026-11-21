import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type SessionData, type SessionMetadata, SessionsStore } from "@mariozechner/pi-web-ui";
import { PRIVATE_MODE_KEY } from "../../privacy/private-mode.js";
import { THREAD_CHANGED } from "../../threads/events.js";

/** Tell the worker a thread changed. Best effort: no listener (tests, no worker yet) is fine. */
function announce(id: string): void {
	try {
		const p = globalThis.chrome?.runtime?.sendMessage?.({ type: THREAD_CHANGED, id }) as Promise<unknown> | undefined;
		p?.catch?.(() => undefined);
	} catch {
		/* no runtime */
	}
}

/**
 * Extended SessionsStore that migrates old tool result messages from output to content format.
 */
export class TabkyraSessionsStore extends SessionsStore {
	/**
	 * A thread saved while private mode is on is marked private, for good: the bridge never serves
	 * it and the local mirror never writes it (src/threads). Every save, rename and delete is
	 * announced to the worker.
	 */
	async save(data: SessionData, metadata: SessionMetadata): Promise<void> {
		const privateNow =
			(await this.getBackend()
				.get<boolean>("settings", PRIVATE_MODE_KEY)
				.catch(() => null)) === true;
		const before = privateNow ? undefined : await this.getMetadata(data.id).catch(() => null);
		if (privateNow || (before as { tabkyraPrivate?: boolean } | null | undefined)?.tabkyraPrivate) {
			(data as SessionData & { tabkyraPrivate?: boolean }).tabkyraPrivate = true;
			(metadata as SessionMetadata & { tabkyraPrivate?: boolean }).tabkyraPrivate = true;
		}
		await super.save(data, metadata);
		announce(data.id);
	}

	async delete(id: string): Promise<void> {
		await super.delete(id);
		announce(id);
	}

	async updateTitle(id: string, title: string): Promise<void> {
		await super.updateTitle(id, title);
		announce(id);
	}

	async loadSession(id: string): Promise<SessionData | null> {
		const session = await super.loadSession(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	async get(id: string): Promise<SessionData | null> {
		const session = await super.get(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	private migrateSession(session: SessionData): SessionData {
		return {
			...session,
			messages: this.migrateToolResultMessages(session.messages),
		};
	}

	private migrateToolResultMessages(messages: AgentMessage[]): AgentMessage[] {
		return messages.map((msg) => {
			if (msg.role === "toolResult" && "output" in msg && !msg.content) {
				// Old format detected - migrate it
				const { output, ...rest } = msg as any;
				return {
					...rest,
					content: [{ type: "text", text: output }],
				};
			}
			return msg;
		});
	}
}
