import { startBridge, trace } from "./bridge/native.js";
import { startPanelPageTools } from "./bridge/panel-calls.js";
import { installCdpListeners, persistCdpMemory } from "./browser/cdp.js";
import { startDialogGuard } from "./browser/dialog-guard.js";
import { setGuardLogger, startForegroundGuard } from "./browser/foreground-guard.js";
import { startGroupGestures } from "./browser/group-gestures.js";
import { BrowserSession, cleanupOrphanGroups } from "./browser/session.js";
import { startVeil } from "./browser/veil.js";
import { startCommunityWorker } from "./community/worker.js";
import { startConnectRelay } from "./connect/relay.js";
import { startSiteEdits } from "./site-edits/apply.js";
import { startSubscriptionRelay } from "./subscriptions/relay.js";
import { runningFromStore } from "./update/store-install.js";
import { setPanelsOpening, startUpdateWorker } from "./update/worker.js";

// Debugger events reach a worker only if its listeners exist when it starts (detaches, page crashes).
installCdpListeners();
// Screenshot scales and open dialogs outlive a worker restart (the side panel's page tools rely on them).
void persistCdpMemory();

// Keep popups opened by agent-driven background tabs from stealing the user's focus.
startForegroundGuard();
setGuardLogger(trace);
startGroupGestures(trace);
// The glow and pill over a page an agent is working in (Settings > Agents turns it off).
startVeil(trace);
// A dialog on an agent's tab is cancelled only when it would freeze a tab of the person's on that site (D46).
startDialogGuard(trace);

// Groups from before an extension reload have no owning session any more; give the tabs back.
cleanupOrphanGroups().catch(() => undefined);

// Prerendered / instant pages commit into a new tab id; keep the owning session pointed at it.
chrome.webNavigation.onTabReplaced.addListener(({ replacedTabId, tabId }) => {
	BrowserSession.replaceTab(replacedTabId, tabId).catch(() => undefined);
});

// External harnesses (omp, pi, Claude Code, Codex) drive the browser through the
// native-messaging bridge. Connects when the CLI has installed the host manifest.
startBridge();
startSubscriptionRelay();
// The side panel's page tools (read_page, act, ...) run here, on the same handlers as the bridge.
startPanelPageTools();
startConnectRelay();

// "Update now", the reload after an update (only when no agent runs), automatic updates. A copy
// from the Web Store is updated by Chrome instead.
if (!runningFromStore()) startUpdateWorker();

// Community skills: the side panel's on, off and sync buttons go to the native host.
startCommunityWorker();

// Site edits: what hides, blocks or runs on each site, and ad blocking (Settings > Site edits).
startSiteEdits();

// ============================================================================
// ONE SIDE PANEL PER WINDOW
// ============================================================================
// The panel is one document per window: `sidepanel.html` with no tab binding, enabled globally.
// It stays open while the user moves between tabs, shows their conversation, and works on the
// tab in front. Nothing here sets tab-specific options or disables the panel, because either
// closes it, and Chrome tears the document (and any agent run inside it) down when it closes.
// The manifest declares no default panel and no panel behavior, so the toolbar icon reaches
// `action.onClicked` and this file is the only path that opens it.

const PANEL_PATH = "sidepanel.html";
const PANEL_TRACE_KEY = "sidepanel_trace";
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";

/** How long a click counts as "opening" if the panel never connects (tests shorten it). */
const OPENING_MS = (globalThis as { __TABKYRA_OPENING_MS?: number }).__TABKYRA_OPENING_MS ?? 5_000;
/** Windows whose panel was just asked to open, until it connects or the window passes. */
const opening = new Map<number, ReturnType<typeof setTimeout>>();
// The update worker waits for these before it reloads Polycarp (src/update/worker.ts).
setPanelsOpening(() => opening.size);

function markOpening(windowId: number): void {
	clearOpening(windowId);
	opening.set(
		windowId,
		setTimeout(() => opening.delete(windowId), OPENING_MS),
	);
}

function clearOpening(windowId: number): void {
	const timer = opening.get(windowId);
	if (timer === undefined) return;
	clearTimeout(timer);
	opening.delete(windowId);
}

let panelTrace: string[] = [];
let traceFlush: ReturnType<typeof setTimeout> | undefined;
function panelLog(line: string): void {
	panelTrace.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
	if (panelTrace.length > 120) panelTrace = panelTrace.slice(-120);
	if (!traceFlush) {
		traceFlush = setTimeout(() => {
			traceFlush = undefined;
			chrome.storage.session.set({ [PANEL_TRACE_KEY]: panelTrace }).catch(() => undefined);
		}, 150);
	}
}
chrome.storage.session.get(PANEL_TRACE_KEY).then((d) => {
	const saved = d[PANEL_TRACE_KEY] as string[] | undefined;
	if (saved?.length) panelTrace = [...saved, ...panelTrace].slice(-120);
	panelLog("worker started");
});

function recordPanelError(where: string, err: unknown): void {
	const message = `${where}: ${err instanceof Error ? err.message : String(err)}`;
	console.warn("[Background]", message);
	panelLog(`ERROR ${message}`);
	chrome.storage.session
		.set({ sidepanel_last_error: `${new Date().toISOString()} ${message}` })
		.catch(() => undefined);
}

/** Make the window-wide panel the one every tab shows. Global options only, never per tab. */
function setGlobalPanelOptions(): void {
	chrome.sidePanel.setOptions({ path: PANEL_PATH, enabled: true }).catch((err) => recordPanelError("setOptions", err));
}
setGlobalPanelOptions();
chrome.runtime.onInstalled.addListener(setGlobalPanelOptions);

/**
 * Open the window's panel, in the click's user-gesture tick (Chrome requires open() there), so
 * nothing is awaited first. The global options are set once at start, not here: setting them
 * again on a click while a run goes on in an open panel could reload it and end the run.
 */
function openPanel(windowId: number, source: string): void {
	markOpening(windowId);
	chrome.sidePanel.open({ windowId }).catch((err) => {
		clearOpening(windowId);
		recordPanelError(`open(${source})`, err);
	});
	panelLog(`open window=${windowId} (${source})`);
}

// Toolbar icon: open this window's panel.
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	if (tab?.windowId !== undefined) openPanel(tab.windowId, "action");
});

// Listen for messages from userScripts (overlay in page).
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, _sender, sendResponse) => {
		if (message.type === "abort-repl") {
			chrome.runtime.sendMessage(message);
			sendResponse({ success: true });
			return true;
		}
	});
}

// Track which windows currently have an open panel document (for the keyboard toggle).
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;
	const windowId = Number(match[1]);
	panelLog(`panel connected window=${windowId}`);
	clearOpening(windowId);
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const open = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		open.add(windowId);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(open) });
	});
	port.onDisconnect.addListener(() => {
		panelLog(`panel disconnected window=${windowId}`);
		chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
			const open = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
			open.delete(windowId);
			chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(open) });
		});
	});
});

// Keyboard shortcut: same as the toolbar icon (Chrome offers no per-window close API).
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command !== "toggle-sidepanel") return;
	if (sender?.windowId !== undefined) openPanel(sender.windowId, "command");
});
