import { icon } from "@mariozechner/mini-lit";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { LIBRARY_SKILLS } from "virtual:library-skills";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, getModels, type Model } from "@mariozechner/pi-ai";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	ModelSelector,
	ProxyTab,
	// PersistentStorageDialog,
	setAppStorage,
	setArtifactViewerFactory,
	setShowJsonMode,
	setTranscriptRenderer,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { CircleDot, Copy, FileCode2, History, type IconNode, Palette, Plus, Settings } from "lucide";
import { isBlockedModel, purgeRemovedSignIns, RemovedSignInError, resolveApiKey } from "./auth/policy.js";
import { isRestrictedUrl } from "./browser/cdp.js";
import { setCurrentBrowserSession } from "./browser/current.js";
import { dispatchToSandbox, setCdpMessageHandler } from "./browser/inject.js";
import { BrowserSession, listSessions, sessionIdForTab, sessionOwningTab } from "./browser/session.js";
import { shareActiveTab } from "./browser/share-tab.js";
import { communityLibrary, readCommunityStatus } from "./community/status.js";
import { helmMark } from "./components/HelmMark.js";
import "./components/HeaderMenu.js";
import { startAppearance } from "./appearance/apply.js";
import { followSystem } from "./appearance/mode.js";
import type { HeaderMenuItem } from "./components/HeaderMenu.js";
import { Toast } from "./components/Toast.js";
import { composerChips, knownSkills, knownTabs } from "./composer/chips.js";
import { skillMenuItems, tabMenuItems } from "./composer/menus.js";
import {
	type ComposerRefs,
	displayText,
	failedRefs,
	hasRefTokens,
	leadingSkill,
	REFS_RESOLVED,
	resolveRefs,
	type SkillRun,
} from "./composer/refs.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyDialog } from "./dialogs/ApiKeyDialog.js";
import { ApiKeysTab } from "./dialogs/ApiKeysTab.js";
import { AppearanceTab } from "./dialogs/AppearanceTab.js";
import { BridgeTab } from "./dialogs/BridgeTab.js";
import { CombinedTab } from "./dialogs/CombinedTab.js";
import { ConnectTab } from "./dialogs/ConnectTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { PrivacyTab } from "./dialogs/PrivacyTab.js";
import { RecordSkillDialog } from "./dialogs/RecordSkillDialog.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { TabkyraSessionListDialog } from "./dialogs/SessionListDialog.js";
import { SettingsPage } from "./dialogs/SettingsPage.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UpdatesTab } from "./dialogs/UpdatesTab.js";
import { type WelcomeChoice, WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { modelLabelParts } from "./models/display.js";
import { FREE_KEY_NOTE, FREE_PRIVACY_NOTE, FREE_SHORT_NOTE } from "./models/free-mode.js";
import { freeComposerText, installFreeMode, setFreeMode, streamFree } from "./models/free-panel.js";
import { isFreeModeModel } from "./models/free-runtime.js";
import { refreshDiscoveredModels } from "./models/registry.js";
import { installBugCapture } from "./privacy/capture.js";
import { assertPrivateProxy, PRIVATE_MODE_KEY, privateModel, TRUSTED_HOSTS_KEY } from "./privacy/private-mode.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { Recorder } from "./recording/recorder.js";
import { TabkyraAppStorage } from "./storage/app-storage.js";
import type { Skill } from "./storage/stores/skills-store.js";
import { trySubscriptionStatus } from "./subscriptions/client.js";
import { CHATGPT_PROVIDER } from "./subscriptions/constants.js";
import { planBadge } from "./subscriptions/plan-badge.js";
import {
	explainErrors,
	isSubscriptionProvider,
	refreshSubscriptionModels,
	registerSubscriptionApis,
	routeSubscriptionModel,
} from "./subscriptions/stream.js";
import { DebuggerTool } from "./tools/debugger.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserTool, AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, NavigateTool } from "./tools/navigate.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import { syncCustomProviderCorsRules } from "./utils/custom-provider-cors.js";
import { chatToMarkdown } from "./utils/export-chat.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import { createArtifactViewer } from "./artifacts/viewers.js";
import "./utils/live-reload.js";
import { bridgeQuestions, watchBridgeQuestions } from "./ask/bridge-panel.js";
import { updateNotice, watchUpdateStatus } from "./components/UpdateNotice.js";
import { tabkyraTranscript } from "./transcript/render.js";
import { starters } from "./tutorials.js";
import "./dictation/DictationButton.js";
import { BUSY_BEAT_PREFIX, reserveRun } from "./update/gate.js";

// Previews for more file types in the artifacts panel (src/artifacts/)
setArtifactViewerFactory(createArtifactViewer);

// The transcript reads as a log: agent text in full, the work between texts as compact rows.
setTranscriptRenderer(tabkyraTranscript);

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();

// Listen for abort messages from REPL overlay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl") {
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// Messages from code injected through the debugger path (no userScripts API) arrive
// here instead of chrome.runtime.onMessage; route them exactly the same way.
setCdpMessageHandler(async (message) => {
	if (message.type === "abort-repl") {
		if (agent?.state.isStreaming) {
			agent.abort();
			return { success: true };
		}
		return { success: false, reason: "not-streaming" };
	}
	return dispatchToSandbox(message);
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new TabkyraAppStorage();
setAppStorage(storage);
installBugCapture(storage);

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
// Use Set with message object identity (not cleared on session switch - persists in memory)
const recordedCostMessages = new Set<AgentMessage>();

// Interaction recorder (record → save as site-scoped skill)
let recorder: Recorder | undefined;
let isRecording = false;

// Tells the service worker whether the agent is mid-run, so the panel is not hidden
// (and its document destroyed) on other tabs while work is in progress.
let lastPublishedBusy: boolean | undefined;
function publishBusyState(): void {
	// A send that holds a reservation counts as busy until it has started its run or given up.
	const busy = agent?.state.isStreaming === true || sendReserving;
	// Agent events beat too: a hidden panel's timers can be throttled to once a minute.
	if (busy && Date.now() - lastBeatAt > 10000) beatBusy();
	if (busy === lastPublishedBusy) return;
	lastPublishedBusy = busy;
	// The value names the running task's home tab so the worker keeps exactly that panel up.
	chrome.storage.session
		.set({ [`sidepanel_busy_${currentWindowId}`]: busy ? (homeTabId ?? true) : false })
		.catch(() => undefined);
	// A heartbeat while the run goes, so the update idle gate can tell a run from a flag a
	// crashed panel left behind (src/update/worker.ts).
	if (busy && !busyBeat) {
		beatBusy();
		busyBeat = setInterval(beatBusy, BUSY_BEAT_MS);
	} else if (!busy && busyBeat) {
		clearInterval(busyBeat);
		busyBeat = undefined;
	}
}
const BUSY_BEAT_MS = 15000;
let busyBeat: ReturnType<typeof setInterval> | undefined;
let lastBeatAt = 0;
function beatBusy(): void {
	lastBeatAt = Date.now();
	chrome.storage.session.set({ [`${BUSY_BEAT_PREFIX}${currentWindowId}`]: lastBeatAt }).catch(() => undefined);
}

/**
 * Mark this panel busy before a run starts (under the install gate, see onBeforeSend), through
 * the same state publishBusyState keeps, so it clears the flag again if no run starts.
 */
let sendReserving = false;
async function markBusyForSend(): Promise<void> {
	sendReserving = true;
	lastPublishedBusy = true;
	lastBeatAt = Date.now();
	await chrome.storage.session.set({
		[`sidepanel_busy_${currentWindowId}`]: homeTabId ?? true,
		[`${BUSY_BEAT_PREFIX}${currentWindowId}`]: lastBeatAt,
	});
	busyBeat ??= setInterval(beatBusy, BUSY_BEAT_MS);
}
window.addEventListener("pagehide", () => {
	chrome.storage.session
		.remove([`sidepanel_busy_${currentWindowId}`, `${BUSY_BEAT_PREFIX}${currentWindowId}`])
		.catch(() => undefined);
});

// The tabs this chat session owns (its own tab group; never the user's tabs)
let browserSession: BrowserSession | undefined;
// The tab this panel is bound to (Claude-style per-tab binding), from ?tabId= in the URL.
let homeTabId: number | undefined;

/** First-save relabel and rename run one after the other, in the order they were asked for. */
let browserSessionOps: Promise<unknown> = Promise.resolve();
function queueBrowserSessionOp(op: () => Promise<unknown> | undefined): void {
	browserSessionOps = browserSessionOps.then(op).catch((err) => console.error("Browser session update failed:", err));
}

/** Browser-session id for an unsaved chat: stable per home tab so reopening the tab restores it. */
function unsavedSessionId(): string {
	return homeTabId !== undefined ? `tab-${homeTabId}` : `temp-${crypto.randomUUID()}`;
}

function sessionLabel(): string {
	const title = currentTitle.trim();
	if (!title) return "chat";
	return title.length > 28 ? `${title.slice(0, 27)}…` : title;
}

async function openBrowserSession(id: string): Promise<void> {
	browserSession = await BrowserSession.open(id, sessionLabel(), currentWindowId);
	setCurrentBrowserSession(browserSession);
	// Bind this panel's tab to the session (exclusive) and put it in the task's group so the
	// group exists from the start and the agent has a page to work with. The tab keeps showing
	// this task's panel; other tabs are unaffected.
	if (homeTabId !== undefined) {
		await browserSession.setHomeTab(homeTabId);
		// A tab an external agent is driving stays with that agent; the panel only binds to it.
		const owner = await sessionOwningTab(homeTabId);
		if (!owner || owner.id === browserSession.id || !owner.id.startsWith("bridge-"))
			// Only start on the home tab; re-opening (e.g. the rename on first save) must not yank
			// the agent back from a tab it switched to.
			await browserSession.adopt(homeTabId, browserSession.currentTabId === undefined, { group: false });
	}
	renderApp();
}

/** Unsaved browser sessions that never got a tab are noise; drop them at startup. */
async function pruneEmptyUnsavedSessions(): Promise<void> {
	for (const s of await listSessions()) {
		if ((s.id.startsWith("temp-") || s.id.startsWith("tab-")) && s.tabIds.length === 0) {
			// The foreground guard may have adopted a tab into it meanwhile; then it stays.
			await BrowserSession.dropIfEmpty(s.id);
		}
	}
}

/**
 * The tab the user is looking at goes to the agent with their message, no button needed. A tab
 * another agent is driving stays with that agent. Mid-run ("Send now") the tab is added without
 * becoming current, so the run's own page isn't swapped out under it.
 */
async function shareActiveTabOnSend(makeCurrent: boolean): Promise<void> {
	if (!browserSession) return;
	try {
		const shared = await shareActiveTab(browserSession, currentWindowId, makeCurrent);
		if (shared?.heldBy) Toast.info(`This tab stays with ${shared.heldBy}, which is working in it`);
	} catch (err) {
		console.error("Sharing the active tab failed:", err);
	}
}

/** The URL of the page the agent is on (the session's current tab), if it has one. */
async function currentPageUrl(): Promise<string | undefined> {
	try {
		return (await browserSession?.currentTab())?.url;
	} catch {
		return undefined;
	}
}

/** The bundled library, then community skills whose names it doesn't use. */
async function libraryWithCommunity() {
	return [
		...LIBRARY_SKILLS,
		...communityLibrary(await readCommunityStatus(), new Set(LIBRARY_SKILLS.map((s) => s.name))),
	];
}

/**
 * "/" in the chat input: site skills for the current page, then the bundled library, then site
 * skills for other sites. Choosing one inserts `/<name>`; on send the skill runs with the rest
 * of the message as its task (src/composer/refs.ts).
 */
function buildSkillSlashProvider() {
	return async (query: string) => {
		const url = await currentPageUrl();
		const all = await storage.skills.list();
		const onSite = new Set(url ? (await storage.skills.list(url)).map((s) => s.name) : []);
		const items = skillMenuItems(query, all, onSite, await libraryWithCommunity());
		for (const item of items) knownSkills.add(item.id);
		return items;
	};
}

/** "@" in the chat input: the open tabs in this window, this chat's own first. */
function buildTabMentionProvider() {
	return async (query: string) => {
		const tabs = await chrome.tabs.query({ windowId: currentWindowId });
		const otherOwners = new Map<number, string>();
		for (const s of await listSessions()) {
			if (s.id === browserSession?.id) continue;
			for (const id of s.tabIds) otherOwners.set(id, s.id.startsWith("bridge-") ? `agent ${s.label}` : s.label);
		}
		const items = tabMenuItems(query, tabs, {
			sessionTabIds: new Set(browserSession?.tabIds ?? []),
			otherOwners,
			isRestricted: isRestrictedUrl,
		});
		for (const t of tabs)
			if (t.id !== undefined && !t.incognito)
				knownTabs.set(t.id, { title: t.title ?? "", url: t.url ?? "", favIconUrl: t.favIconUrl });
		return items;
	};
}

function siteSkillRun(s: Skill): SkillRun {
	return {
		name: s.name,
		source: "site",
		instructions: `${s.description}

Its library functions are available inside browserjs() on pages matching: ${s.domainPatterns.join(", ")}.

## Examples
\`\`\`javascript
${s.examples}
\`\`\``,
	};
}

/** A skill chosen with "/": the current page's site skills first, then the library, then other site skills. */
async function findSkill(name: string): Promise<SkillRun | undefined> {
	const url = await currentPageUrl();
	const onSite = url ? (await storage.skills.list(url)).find((s) => s.name === name) : undefined;
	if (onSite) return siteSkillRun(onSite);
	const lib = LIBRARY_SKILLS.find((s) => s.name === name);
	if (lib) return { name, source: "library", instructions: lib.text };
	const community = (await libraryWithCommunity()).find((s) => s.name === name);
	if (community) return { name, source: "library", instructions: community.text };
	const site = await storage.skills.get(name);
	return site ? siteSkillRun(site) : undefined;
}

type RefMessage = AgentMessage & { tabkyraRefs?: ComposerRefs | null };

/**
 * Resolve the composer references of user messages sent from this panel, once each, the first
 * time they go to the model (prompt, queue and Send now all pass through here). The result is
 * frozen on the message so a reload sends the same thing. Messages loaded with a saved chat
 * are never resolved again.
 */
async function freezeRefs(messages: AgentMessage[], loaded: WeakSet<object>): Promise<void> {
	for (const m of messages as RefMessage[]) {
		if ((m.role !== "user" && m.role !== "user-with-attachments") || loaded.has(m) || m.tabkyraRefs !== undefined)
			continue;
		const text =
			typeof m.content === "string"
				? m.content
				: m.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		if (!hasRefTokens(text)) {
			m.tabkyraRefs = null;
			continue;
		}
		let refs = await resolveRefs(text, {
			getTab: (id) => chrome.tabs.get(id).catch(() => undefined),
			ownerOf: async (id) => {
				const o = await sessionOwningTab(id);
				return o ? { id: o.id, label: o.label } : undefined;
			},
			// The live session: the first save renames it while this runs.
			sessionId: () => browserSession?.id ?? "",
			windowId: currentWindowId,
			adopt: async (id, makeCurrent) => {
				if (!browserSession) throw new Error("No browser session");
				return browserSession.adoptIfFree(id, makeCurrent, { group: false });
			},
			isRestricted: isRestrictedUrl,
			findSkill,
			skillNames: async () => [
				...(await storage.skills.list()).map((s) => s.name),
				...(await libraryWithCommunity()).map((s) => s.name),
			],
		}).catch((err) => {
			// Nothing was shared and no skill loaded; say so rather than show chips that look fine.
			console.error("Resolving references failed:", err);
			Toast.error("Couldn't share the referenced tabs or load the skill");
			return failedRefs(text);
		});
		if (refs && !refs.skill && refs.tabs.length === 0) refs = undefined;
		m.tabkyraRefs = refs ?? null;
		for (const t of refs?.tabs ?? []) {
			const name = `"${t.title || `Tab ${t.id}`}"`;
			if (t.status === "other-agent")
				Toast.error(`${name} stays with ${t.owner}, which is working in it, so it was not shared.`);
			else if (t.status === "unavailable") Toast.error(`${name} can't be shared with the agent`);
			else if (t.status === "gone") Toast.error(`Tab ${t.id} was closed before the message was sent`);
		}
		// Sent messages already on screen redraw their chips with the outcome.
		window.dispatchEvent(new Event(REFS_RESOLVED));
	}
}

async function toggleRecording() {
	if (isRecording && recorder) {
		const current = recorder;
		recorder = undefined;
		isRecording = false;
		renderApp();
		try {
			const result = await current.stop();
			RecordSkillDialog.open(result);
		} catch (err) {
			console.error("Failed to stop recording:", err);
			Toast.error("Failed to stop recording");
		}
		return;
	}

	const next = new Recorder();
	try {
		await next.start();
		recorder = next;
		isRecording = true;
		Toast.success("Recording — interact with the page, then click stop");
		renderApp();
	} catch (err) {
		console.error("Failed to start recording:", err);
		Toast.error("Cannot record this page");
	}
}

async function copyCurrentChat() {
	if (!agent) return;
	const messages = agent.state.messages.filter((m) => m.role !== "welcome");
	if (messages.length === 0) {
		Toast.error("Nothing to copy yet");
		return;
	}
	try {
		await navigator.clipboard.writeText(chatToMarkdown(messages, currentTitle || "Polycarp chat", agent.state.model));
		Toast.success("Chat copied as Markdown");
	} catch {
		Toast.error("Couldn't copy the chat");
	}
}

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	google: "gemini-2.5-flash",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

/** A navigation note when the session's tab shows a different page than the agent last saw. */
async function pageChangeNote(): Promise<NavigationMessage | undefined> {
	if (!agent) return undefined;

	// The session's current tab (nothing if the session has no tab yet)
	const tab = await browserSession?.currentTab();
	if (!tab?.url || isRestrictedUrl(tab.url)) return undefined;

	// Find most recent navigation (either nav message or nav tool result)
	let lastUrl: string | undefined;
	for (let i = agent.state.messages.length - 1; i >= 0; i--) {
		const msg = agent.state.messages[i];
		if (msg.role === "navigation") {
			lastUrl = (msg as NavigationMessage).url;
			break;
		}
		if (msg.role === "toolResult" && (msg as any).toolName === "navigate") {
			lastUrl = (msg as any).details?.finalUrl;
			break;
		}
	}

	// Only add if URL changed
	if (lastUrl && lastUrl === tab.url) return undefined;
	return await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
}

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider as any, modelId);
			if (model) {
				agent.setModel(model);
				await storage.settings.set("lastUsedModel", model);
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first provider with a key
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) {
			agent.setModel(models[0]);
			await storage.settings.set("lastUsedModel", models[0]);
			renderApp();
			return;
		}
	}

	// Fall back to the first model of a custom provider (not in the built-in registry)
	const customProviders = await storage.customProviders.getAll();
	for (const customProvider of customProviders) {
		const model = customProvider.models?.[0];
		if (model) {
			agent.setModel(model);
			await storage.settings.set("lastUsedModel", model);
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.push(provider);
	}
	return result;
}

/** No provider key and no subscription sign-in: the model button says what to do instead of naming a model. */
let providerless = false;
async function refreshProviderless(): Promise<void> {
	const none =
		(await getProvidersWithKeys()).length === 0 && (await refreshSubscriptionModels().catch(() => [])).length === 0;
	if (none === providerless) return;
	providerless = none;
	refreshModelLabel(true);
	chatPanel?.agentInterface?.requestUpdate();
}

/** The composer's model button text; Free mode names the model that answered last. */
let modelLabelKey: string | undefined;
function refreshModelLabel(force = false) {
	const ai = chatPanel?.agentInterface;
	if (!ai || !agent) return;
	const free = freeComposerText(agent.state.model, agent.state.messages);
	const key = `${providerless ? "none:" : ""}${free ?? ""}`;
	if (!force && key === modelLabelKey) return;
	modelLabelKey = key;
	// A new function each time: the composer re-renders only when the property changes.
	ai.modelLabel = (model) => {
		if (providerless)
			return { content: "Add a provider", title: "No provider is set up yet. Click to open Settings." };
		const text = freeComposerText(model, agent.state.messages);
		if (text) return { content: `${text} · ${FREE_SHORT_NOTE}`, title: `${text}. ${FREE_PRIVACY_NOTE}` };
		const parts = modelLabelParts(model);
		return {
			content: html`${parts.name}<span class="text-muted-foreground font-normal"> · ${parts.provider}</span>`,
			title: parts.title,
		};
	};
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

/**
 * Settings, a page over the chat with eight tabs: Providers (keys and custom providers), Agents (who
 * may drive the browser from outside), Connect (use it from claude.ai, ChatGPT or grok.com, and your
 * devices), Skills, Privacy (with the network proxy), Appearance, Costs, About (with updates). Settles
 * when it closes; an open Settings page is reused, not opened twice, and `show` moves it to a tab.
 */
function openApiKeysDialog(show?: { tab: string; anchor?: string }): Promise<void> {
	const open = document.querySelector<SettingsPage>("tabkyra-settings");
	if (open) {
		if (show) open.showTab(show.tab, show.anchor);
		return open.closed;
	}
	const providers = new ApiKeysTab();
	const page = SettingsPage.open([
		providers,
		new BridgeTab(),
		new ConnectTab(),
		new SkillsTab(),
		new CombinedTab("Privacy", [{ tab: new PrivacyTab() }, { tab: new ProxyTab(), heading: "CORS proxy" }]),
		new AppearanceTab(),
		new CostsTab(),
		new CombinedTab("About", [{ tab: new AboutTab() }, { tab: new UpdatesTab() }]),
	]);
	providers.onChooseModel = () => {
		page.close();
		void chatPanel?.agentInterface?.onModelSelect?.();
	};
	if (show) page.showTab(show.tab, show.anchor);
	return page.closed.then(() => refreshProviderless());
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg || firstUserMsg.role !== "user") return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	// A chosen skill or tab shows as a chip; the title reads the words, not the tokens.
	text = displayText(text, leadingSkill(text, knownSkills)).trim() || text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	if (homeTabId !== undefined) url.searchParams.set("tabId", String(homeTabId));
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

/**
 * Self-hosted OpenAI-compatible endpoints (custom providers: Local Studio, vLLM, SGLang,
 * llama.cpp) get no max_tokens: the dialog's per-model default was 8192, which cut
 * thinking models off mid-answer. The server then applies the model's full context.
 */
function uncappedStreamFn<F extends (model: Model<any>, ...rest: any[]) => any>(inner: F): F {
	return (async (model: Model<any>, ...rest: any[]) => {
		// A removed subscription sign-in must not run, whatever left the model selected.
		if (isBlockedModel(model)) throw new RemovedSignInError(model.provider);
		// Private mode: only zero-data-retention OpenRouter routes and local models.
		const privateMode = (await storage.settings.get<boolean>(PRIVATE_MODE_KEY)) === true;
		const trusted = privateMode ? ((await storage.settings.get<string[]>(TRUSTED_HOSTS_KEY)) ?? []) : [];
		if (privateMode) {
			// The CORS proxy would see every prompt, so it must be on the user's own machines too.
			assertPrivateProxy(
				await storage.settings.get<boolean>("proxy.enabled"),
				await storage.settings.get<string>("proxy.url"),
				trusted,
			);
		}
		// Free mode: the best free OpenRouter models, every one checked free; private mode still applies to each.
		if (isFreeModeModel(model)) {
			const [context, options] = rest;
			return streamFree(
				model,
				context,
				options,
				privateMode,
				inner as never,
				(m) => (privateMode ? privateModel(m, trusted) : m),
				storage.settings,
			);
		}
		if (privateMode) model = privateModel(model, trusted);
		// ChatGPT and Copilot plans run through the native host's loopback proxy, which holds the tokens.
		const routed = await routeSubscriptionModel(model, rest[1]);
		if (routed) return explainErrors(await inner(routed.model, rest[0], routed.options), model.provider);
		if (model.api === "openai-completions") {
			const custom = await storage.customProviders.getAll().catch(() => []);
			if (custom.some((p) => p.name === model.provider)) {
				model = { ...model, compat: { ...(model.compat ?? {}), omitMaxTokens: true } };
			}
		}
		return inner(model, ...rest);
	}) as F;
}

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	// Mark all loaded messages as already recorded (by object identity)
	for (const msg of initialState?.messages || []) {
		if (msg.role === "assistant" && msg.usage?.cost?.total > 0) {
			recordedCostMessages.add(msg);
		}
	}

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Every chat owns a browser session; unsaved chats use a temporary id until first save
	await openBrowserSession(currentSessionId ?? unsavedSessionId());

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// A chat saved on a removed subscription provider reopens on a working model instead.
	if (initialState?.model && isBlockedModel(initialState.model)) initialState = { ...initialState, model: undefined };

	// Determine default model: saved > default for a provider with key > gemini flash fallback
	let defaultModel: Model<any> | undefined;
	if (!initialState?.model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel && !isBlockedModel(savedModel)) {
			defaultModel = savedModel;
		} else {
			// Try to find a default model for a provider the user already has a key for
			const providersWithKeys = await getProvidersWithKeys();
			for (const provider of providersWithKeys) {
				const modelId = DEFAULT_MODELS[provider];
				if (modelId) {
					const model = getModel(provider as any, modelId);
					if (model) {
						defaultModel = model;
						break;
					}
				}
			}
		}
	}
	// Final fallback
	if (!defaultModel && !initialState?.model) {
		defaultModel = getModel("anthropic", "claude-sonnet-4-6");
	}

	// Messages from a saved chat keep what they were sent with; only new ones get references resolved.
	const loadedMessages = new WeakSet<object>(initialState?.messages ?? []);
	agent = new Agent({
		initialState: initialState
			? { ...initialState, model: initialState.model ?? defaultModel }
			: {
					systemPrompt: SYSTEM_PROMPT,
					model: defaultModel,
					thinkingLevel: "medium",
					messages: [],
					tools: [],
				},
		convertToLlm: async (messages) => {
			await freezeRefs(messages, loadedMessages);
			return browserMessageTransformer(messages);
		},
		toolExecution: "sequential",
		streamFn: uncappedStreamFn(
			createStreamFn(async () => {
				const enabled = await storage.settings.get<boolean>("proxy.enabled");
				if (!enabled) return undefined;
				return (await storage.settings.get<string>("proxy.url")) || undefined;
			}),
		),
		getApiKey: async (provider: string) => {
			const stored = await storage.providerKeys.get(provider);
			if (!stored) return undefined;
			return resolveApiKey(stored, provider);
		},
	});

	if (shouldSave) {
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			const messages = agent.state.messages;
			publishBusyState();

			storage.settings
				.set("lastUsedModel", agent.state.model)
				.catch((err) => console.error("Failed to save lastUsedModel:", err));

			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.usage?.cost?.total > 0
			) {
				if (!recordedCostMessages.has(event.message)) {
					recordedCostMessages.add(event.message);
					storage.costs
						.recordCost(agent.state.model.provider, agent.state.model.id, event.message.usage.cost.total)
						.catch((err) => console.error("Failed to record cost:", err));
				}
			}

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				const session = browserSession;
				const label = sessionLabel();
				queueBrowserSessionOp(() => session?.setLabel(label));
			}

			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				// Rename the unsaved browser session (id "tab-<homeTab>") to the saved id, keeping
				// its home-tab binding and tab group, so the panel stays bound to the same tab.
				// Queued after the relabel above so the two never interleave.
				// The live id, not a recomputed one: a panel without a home tab has a random temp- id.
				const unsavedId = browserSession?.id;
				const savedId = currentSessionId;
				queueBrowserSessionOp(async () => {
					if (unsavedId) await BrowserSession.rename(unsavedId, savedId);
					await openBrowserSession(savedId);
				});
				updateUrl(savedId);
			}

			if (currentSessionId) {
				saveSession();
			}

			refreshModelLabel();
			renderApp();
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			// A subscription provider has no key: it is ready when its sign-in is.
			if (isSubscriptionProvider(provider)) {
				const status = await trySubscriptionStatus(true);
				const ready =
					provider === CHATGPT_PROVIDER
						? Boolean(status?.chatgpt.signedIn && status.chatgpt.planUsage)
						: Boolean(status?.copilot.signedIn && status.copilot.sdkInstalled);
				if (!ready) openApiKeysDialog();
				return ready;
			}
			return await ApiKeyDialog.prompt(provider, isFreeModeModel(agent.state.model) ? FREE_KEY_NOTE : undefined);
		},
		onModelSelect: async () => {
			const providers = [...(await getProvidersWithKeys()), ...(await refreshSubscriptionModels().catch(() => []))];
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			// Cached lists are already registered; give stale providers a moment to refresh.
			await refreshDiscoveredModels(storage, { wait: true, timeoutMs: 4000 }).catch(() => {});
			ModelSelector.open(
				agent.state.model,
				(model) => {
					// Free mode checks for an OpenRouter key first and explains how to get a free one.
					if (isFreeModeModel(model)) {
						void setFreeMode(true);
						return;
					}
					agent.setModel(model);
					chatPanel.agentInterface?.requestUpdate();
					renderApp();
				},
				providers,
				{
					level: agent.state.thinkingLevel,
					onChange: (level) => {
						agent.setThinkingLevel(level);
						chatPanel.agentInterface?.requestUpdate();
						saveSession();
						renderApp();
					},
				},
			);
		},
		onBeforeSend: async () => {
			// Polycarp may be swapping in an update and about to reload; a run started then would be cut
			// off. Marking the panel busy under the gate makes the update wait for this run instead.
			// Everything that waits comes first, so nothing async lies between the reservation and
			// the run starting (AgentInterface calls prompt() right after this hook, synchronously).
			// While a run is going, this message queues: the tab joins without becoming the
			// agent's page, so the run's next steps stay on the page it is working on.
			await shareActiveTabOnSend(agent?.state.isStreaming !== true);
			const note = await pageChangeNote();
			const reserved = await reserveRun(markBusyForSend);
			if (!reserved) {
				throw new Error(
					"Polycarp is installing an update and reloads in a moment. Send it again after the reload.",
				);
			}
			if (note && agent) agent.appendMessage(note);
			// After this hook the send either starts its run (streaming) or queues; either way the
			// reservation ends there, and publishBusyState keeps or clears the busy mark.
			setTimeout(() => {
				sendReserving = false;
				publishBusyState();
			}, 0);
		},
		// "Send now" mid-run: the same note, delivered with the message.
		steerContext: async () => {
			await shareActiveTabOnSend(false);
			const note = await pageChangeNote();
			return note ? [note] : [];
		},
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
				];
			};

			const extractImageTool = new ExtractImageTool();

			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				new AskUserTool(),
				replTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool);
			}

			return tools;
		},
	});

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface);

		// Thinking level now lives inside the model picker, not as a separate
		// dropdown in the input toolbar.
		chatPanel.agentInterface.enableThinkingSelector = false;
		// "/" in the chat input lists skills (recordings included) for the site.
		chatPanel.agentInterface.slashCommandProvider = buildSkillSlashProvider();
		// "@" lists the window's tabs; a chosen one is shared with the agent on send.
		chatPanel.agentInterface.mentionProvider = buildTabMentionProvider();
		chatPanel.agentInterface.composerAccessory = composerChips;
		// The microphone: speech to text on this device (src/dictation/).
		chatPanel.agentInterface.composerActions = (value, setValue) =>
			html`<tabkyra-dictation .value=${value} .setValue=${setValue}></tabkyra-dictation>`;
		refreshModelLabel(true);
		void refreshProviderless();
		// ArrowUp in an empty composer recalls the last prompt for editing or resending.
		chatPanel.agentInterface.historyProvider = () => {
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const m = agent.state.messages[i];
				if (m.role !== "user") continue;
				const text =
					typeof m.content === "string"
						? m.content
						: m.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n");
				if (text.trim()) return text;
			}
			return undefined;
		};
		chatPanel.agentInterface.requestUpdate();

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some((m) => m.role === "user");
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.search = "";
	if (homeTabId !== undefined) url.searchParams.set("tabId", String(homeTabId));
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = () => {
	// A new task on the same tab: keep the tabId, force a fresh session bound to it.
	const url = new URL(window.location.href);
	url.search = "";
	if (homeTabId !== undefined) url.searchParams.set("tabId", String(homeTabId));
	url.searchParams.set("new", "true");
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================
/** An icon-only header button: its name is the tooltip, shown on hover and on keyboard focus. */
function headerButton(label: string, iconNode: IconNode, onClick: () => void, badge?: number) {
	return html`<button type="button" class="tk-icon-btn" aria-label=${label} data-tip=${label} @click=${onClick}>
		${icon(iconNode, "sm")}
		${
			badge
				? html`<span
					class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] leading-4 text-center tabular-nums"
					aria-hidden="true"
					>${badge}</span
				>`
				: ""
		}
	</button>`;
}

/** Header button for the session's artifacts, with their count; hidden until there is one. */
function artifactsButton() {
	const count = chatPanel?.artifactsCount ?? 0;
	if (count === 0) return "";
	return headerButton(`Artifacts (${count})`, FileCode2, () => chatPanel?.openArtifacts(), count);
}

function openSettings() {
	void openApiKeysDialog();
}

function openSessions() {
	TabkyraSessionListDialog.open(
		(sessionId: string) => {
			loadSession(sessionId);
		},
		(deletedSessionId: string) => {
			// Only reload if the current session was deleted
			if (deletedSessionId === currentSessionId) {
				newSession();
			}
		},
		(renamedId: string, title: string) => {
			if (renamedId !== currentSessionId) return;
			currentTitle = title;
			const session = browserSession;
			const label = sessionLabel();
			queueBrowserSessionOp(() => session?.setLabel(label));
			renderApp();
		},
		currentSessionId,
	);
}

function startTitleEdit() {
	isEditingTitle = true;
	renderApp();
	requestAnimationFrame(() => {
		const input = document.body.querySelector<HTMLInputElement>("[data-title-input] input");
		if (input) {
			input.focus();
			input.select();
		}
	});
}

async function saveTitle(value: string) {
	const newTitle = value.trim();
	if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
		await storage.sessions.updateTitle(currentSessionId, newTitle);
		currentTitle = newTitle;
		const session = browserSession;
		const label = sessionLabel();
		queueBrowserSessionOp(() => session?.setLabel(label));
	}
	isEditingTitle = false;
	renderApp();
}

function titleArea() {
	if (!currentTitle) return html`<span class="text-sm font-semibold tracking-tight select-none">Polycarp</span>`;
	if (isEditingTitle)
		return html`<div class="flex-1 min-w-0" data-title-input>
			${Input({
				type: "text",
				value: currentTitle,
				className: "text-sm h-8 w-full",
				onKeyDown: async (e: KeyboardEvent) => {
					if (e.key === "Enter") await saveTitle((e.target as HTMLInputElement).value);
					else if (e.key === "Escape") {
						e.stopPropagation();
						isEditingTitle = false;
						renderApp();
					}
				},
			})}
		</div>`;
	return html`<button
		type="button"
		class="min-w-0 h-8 px-2 text-sm font-medium text-foreground hover:bg-secondary rounded-md truncate text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
		@click=${startTitleEdit}
		aria-label=${`Rename chat: ${currentTitle}`}
		title=${currentTitle}
	>
		${currentTitle}
	</button>`;
}

function moreMenuItems(): HeaderMenuItem[] {
	return [
		{ label: "Copy chat as Markdown", icon: Copy, run: () => void copyCurrentChat() },
		{ label: "Record a skill on this page", icon: CircleDot, run: () => void toggleRecording() },
		{ label: "Theme", icon: Palette, separator: true, run: () => void openApiKeysDialog({ tab: "Appearance" }) },
	];
}

const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header: brand or chat title, then what is used every chat; the rest is under More. -->
			<div class="flex items-center gap-1 border-b border-border shrink-0 h-12 px-2">
				<span class="flex items-center shrink-0 px-1 select-none" aria-hidden="true">${helmMark(18)}</span>
				<div class="flex items-center gap-1 flex-1 min-w-0">${titleArea()}</div>
				<div class="flex items-center gap-0.5 shrink-0 tk-tips-end">
					${
						isRecording
							? html`<button
								type="button"
								class="tk-header-pill tk-rec-pill"
								aria-label="Stop recording and save as a skill"
								data-tip="Stop recording and save as a skill"
								@click=${toggleRecording}
							>
								<span class="tk-rec-dot" aria-hidden="true"></span>Recording
							</button>`
							: ""
					}
					${artifactsButton()}
					${headerButton("Past chats", History, openSessions)}
					${headerButton("New chat", Plus, newSession)}
					<tk-header-menu .items=${moreMenuItems()} label="More"></tk-header-menu>
					${headerButton("Settings", Settings, openSettings)}
				</div>
			</div>

			${updateNotice()}
			${bridgeQuestions()}
			${planBadge(agent?.state.model?.provider)}

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, document.body);
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// The agent only hears about URL changes on its own current tab (a page redirecting
// or the user navigating a shared tab). The user's other tabs are never observed.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	if (
		changeInfo.url &&
		tab.url &&
		browserSession?.currentTabId === tabId &&
		agent?.state.isStreaming &&
		!isRestrictedUrl(tab.url) &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for", tab.url);
	}
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		// Escape in an external agent's question card is not a Stop for this panel's agent.
		const inBridgeQuestion = e.target instanceof Element && e.target.closest('[data-testid="bridge-questions"]');
		if (e.key === "Escape" && agent?.state.isStreaming && !inBridgeQuestion) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// The saved colors, before anything is drawn in them; the system setting is followed while the mode is "match system".
	await startAppearance();
	followSystem();
	// Adding or removing a key changes what the model button says.
	for (const event of ["provider-key-saved", "provider-key-removed"])
		document.addEventListener(event, () => void refreshProviderless());

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Reconcile CORS rules for any configured custom providers (dynamic DNR rules
	// don't ship in the static manifest, so make sure they exist after a reload).
	syncCustomProviderCorsRules().catch((err) => console.error("Failed to sync custom provider CORS rules:", err));

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// The tab this panel is bound to, from ?tabId= in the URL (background sets it per tab).
	const homeTabParam = new URLSearchParams(window.location.search).get("tabId");
	homeTabId = homeTabParam ? Number(homeTabParam) : undefined;

	// Initialize port communication system (lifecycle only; background tracks open panels)
	port.initialize(currentWindowId);

	pruneEmptyUnsavedSessions().catch(() => {});

	// Register cached provider model lists now; refresh stale ones in the background.
	refreshDiscoveredModels(storage).catch((err) => console.warn("Model discovery failed:", err));
	installFreeMode({
		settings: storage.settings,
		hasOpenRouterKey: async () => Boolean(await storage.providerKeys.get("openrouter")),
		currentModel: () => agent?.state.model,
		setModel: async (model) => {
			agent?.setModel(model);
			await storage.settings.set("lastUsedModel", model);
			chatPanel.agentInterface?.requestUpdate();
			renderApp();
		},
		leaveFreeMode: async (previous) => {
			if (previous) {
				agent?.setModel(previous);
				await storage.settings.set("lastUsedModel", previous);
				renderApp();
			} else await selectDefaultModelForAvailableProvider();
			chatPanel.agentInterface?.requestUpdate();
		},
	});
	// ChatGPT and Copilot plan models, when signed in (the native host knows; no token comes here).
	registerSubscriptionApis();
	refreshSubscriptionModels().catch((err) => console.warn("Subscription models unavailable:", err));

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// In-page scripts use the userScripts API when the browser exposes it and fall back
	// to an isolated content-script world otherwise, so no permission prompt is needed.

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Create ChatPanel. Artifacts open from the header button and from their tool cards, not a pill over the chat.
	chatPanel = new ChatPanel();
	chatPanel.showArtifactsPill = false;
	chatPanel.onArtifactsCountChange = () => renderApp();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Tokens from the removed subscription sign-ins only worked through borrowed clients.
	// Cleared before any chat is restored, so no path can still use them.
	const cleared = await purgeRemovedSignIns(storage.providerKeys).catch(() => []);
	if (cleared.length > 0) {
		Toast.error(`Removed subscription sign-in for ${cleared.join(", ")}. Add an API key in Settings.`);
	}

	// Which chat should this panel show?
	//  - ?session=<id>  : explicit (a history-list click)
	//  - ?new=true      : a fresh task on this tab (New chat)
	//  - otherwise      : the task already bound to this tab, if any
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	if (!sessionIdFromUrl && !isNewSession && homeTabId !== undefined && storage.sessions) {
		const boundId = await sessionIdForTab(homeTabId);
		// The tab's session id is the saved chat id once persisted; an unsaved one has no
		// storage entry, so only restore ids the sessions store actually knows.
		if (boundId && !boundId.startsWith("tab-") && !boundId.startsWith("temp-")) {
			sessionIdFromUrl = boundId;
			updateUrl(boundId);
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";

			await createAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: sessionData.model,
				thinkingLevel: sessionData.thinkingLevel,
				messages: sessionData.messages,
				tools: [],
			});

			renderApp();
			void watchBridgeQuestions(renderApp).catch(() => {});
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent();

	// Add welcome message for new sessions
	if (agent) {
		const welcomeMessage = createWelcomeMessage(starters);
		agent.appendMessage(welcomeMessage);
		// appendMessage emits no event, so the already-rendered chat would not show it.
		chatPanel.agentInterface?.requestUpdate();
	}

	renderApp();
	void watchUpdateStatus(renderApp).catch(() => {});
	// External agents' questions (ask_user over the bridge) show above the chat.
	void watchBridgeQuestions(renderApp).catch(() => {});

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		const choice: WelcomeChoice = await WelcomeSetupDialog.show();
		// "Set up provider" lands on the API keys list, not the top of the tab (Free mode and subscriptions sit above it).
		await openApiKeysDialog(
			choice === "connect" ? { tab: "Connect" } : { tab: "Providers", anchor: "api-keys-heading" },
		);
		await refreshDiscoveredModels(storage, { wait: true }).catch(() => {});
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
