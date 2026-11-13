import AppKit
import BaneySpacesCore

/// What the hands need from the rest of the app. Everything here runs on the main thread.
struct HandsHost {
    var agentWorkspace: () -> Int? = { nil }
    /// Every window BaneySpaces places, with its workspace, from its model (cheap: no scan).
    var windows: () -> [HandsWindow] = { [] }
    /// The same after a scan (at most twice a second): a window that opened a moment ago is in it.
    var freshWindows: () -> [HandsWindow] = { [] }
    /// One window, straight from the model, for the check right before an engine call.
    var live: (UInt32) -> HandsWindow? = { _ in nil }
    var titles: ([UInt32]) -> [UInt32: String] = { _ in [:] }
    /// What a window shows: its document (AXDocument), and whether it is an Open or Save panel.
    var inspect: (UInt32) -> (document: String?, panel: Bool) = { _ in (nil, false) }
    /// The processes BaneySpaces started for an agent.
    var agentOwned: () -> Set<Int32> = { [] }
    /// Asks Donovan, in a sheet, whether to lend an app; true only for a real click on "Lend".
    var askToLend: (_ app: String, _ minutes: Int, _ takeBack: Bool) -> Bool = { _, _, _ in false }
    /// Where the agent cursor last acted in a window, for `agent shot --cursor`.
    var cursorMark: (UInt32) -> CursorMark? = { _ in nil }
    /// The session engine's `agent open <app> [files…]`.
    var open: ([String]) -> Wire.Reply = { _ in .init(ok: false, error: "not ready") }
    /// `workspaces`: one row per workspace (number, shown, current, window count).
    var workspaceRows: () -> [WorkspaceRow] = { [] }
    /// The usable area of the screen the agent workspace shows on, in screen coordinates with the origin at the top left.
    var agentArea: () -> CGRect = { .zero }
    /// `arrange`: frames for agent workspace windows, applied without showing them; how each one was applied.
    var arrange: ([UInt32: CGRect]) -> [UInt32: String] = { _ in [:] }
    /// Sends a window to a workspace without going there (`Spaces.move`).
    var move: (UInt32, Int) -> Void = { _, _ in }
    /// Presses a window's close button from behind; false when it has none.
    var close: (UInt32) -> Bool = { _ in false }
    /// A full scan now, every app asked again (`Spaces.refresh(full:)`): a window an app still starting couldn't show
    /// a moment ago is placed.
    var rescan: () -> Void = {}
}

/// Runs one agent command: checks scope, calls the engine, returns evidence. Lives in the app process,
/// which holds Accessibility; the CLI and the MCP server only send here.
final class HandsRouter {
    var host = HandsHost()
    private let lends = HandsLends.shared
    private let cap: (AgentAccessMode) -> AgentAccessMode
    /// The access this router works under: the Mac's setting, through its cap. Every decision below reads this one, so a
    /// router for connectors can never act on Full Access (`HandsRouterAccessTests` holds the code to it).
    var access: AgentAccessMode { cap(AgentAccess.shared.current) }

    /// A router for connectors (another machine): the managing verbs (`WorkspaceVerbs.manage`) are never open to it.
    let remote: Bool

    init(cap: @escaping (AgentAccessMode) -> AgentAccessMode = { $0 }, remote: Bool = false) { self.cap = cap; self.remote = remote }

    /// Which child windows appeared after which session's action (`ChildAttribution`), and what each session opened.
    var attribution = ChildAttribution()
    var sessionWindows = SessionWindows()
    let childLock = NSLock()
    /// The pids a child-window watch runs for: one watch per pid, which every action extends (`noteAction`).
    var childWatchers = Set<Int32>()
    /// One `open` per app at a time, so two sessions never race to claim the same new window. Under `childLock`.
    var openGates: [String: NSLock] = [:]

    /// What a snapshot's refs belong to. A ref is good only for this snapshot's window and process.
    /// `pasteboard`: the snapshot's cut, copy and paste refs, from its refmap, held as long as its refs resolve (198 r2 first-F1).
    private struct Snap { var window: UInt32; var pid: Int32; var app: String; var at: Date; var identity: [String: RefIdentity]; var pasteboard: [String: String] = [:] }
    /// Windows that must never be used: they showed a document from outside the handoff folder.
    private static var refused: Set<UInt32> = []
    private static let refusedLock = NSLock()
    private var snaps: [String: Snap] = [:]
    private let lock = NSLock()
    /// Each session's reads as rows: what `since: "latest"` compares with, and what a bare row number means.
    private var rowsMemory = SnapshotRowsMemory()
    private let rowsLock = NSLock()
    private func withRows<T>(_ f: (inout SnapshotRowsMemory) -> T) -> T { rowsLock.lock(); defer { rowsLock.unlock() }; return f(&rowsMemory) }

    /// Files an agent may hand to an app live here.
    static var handoffFolder: URL { HandsEngine.home.appendingPathComponent("handoff", isDirectory: true) }

    // MARK: wire

    /// The session socket's entry: `text` holds a HandsRequest as JSON, the reply carries the envelope.
    func handleWire(_ r: Wire.Request) -> Wire.Reply {
        let env: HandsEnvelope
        if let data = r.text?.data(using: .utf8), let req = try? JSONDecoder().decode(HandsRequest.self, from: data) {
            // A bare row number is resolved once, here: `handle` gets the full ref and the next call's window comes from it,
            // also for a call refused before it acts (187 r1 first-F3, 192 r1 first-F6).
            var resolved = req
            if let r = req.string("ref"), SnapshotRows.browserRefError(r) == nil, let n = SnapshotRows.bareNumber(r), case .success(let full) = bareRef(n, req) { resolved.args["ref"] = .string(full) }
            env = HandsNextCall.fill(handle(resolved), window: windowOf(resolved))
        } else {
            env = .failure(HandsError(.badArguments, "the request wasn't an agent command", suggestion: "Use `polycarp-spaces agent <command>`.", retry: .never))
        }
        return Wire.Reply(ok: true, info: ["envelope": env.line])
    }

    func handle(_ req: HandsRequest) -> HandsEnvelope {
        lends.expire()
        if HandsTools.userOnly.contains(req.verb) { return .failure(HandsParse.askedForLend(req.string("app"))) }
        if let e = AgentAccessGate.refusal(verb: req.verb, mode: access) { return .failure(e) }
        if remote, let e = WorkspaceVerbs.connectorRefusal(verb: req.verb) { return .failure(e) }
        var req = req
        if let r = req.string("ref"), let e = SnapshotRows.browserRefError(r) { return .failure(e) }
        if let r = req.string("ref"), let n = SnapshotRows.bareNumber(r) {
            switch bareRef(n, req) {
            case .success(let full): req.args["ref"] = .string(full)
            case .failure(let e): return .failure(e)
            }
        }
        if req.verb != "windows", req.verb != "workspaces", req.verb != "open", let problem = HandsEngine.shared.permissionProblem() { return .failure(problem) }
        switch req.verb {
        case "windows": return windows(session: req.session ?? "")
        case "workspaces": return workspaces(req)
        case "arrange": return arrange(req)
        case "move": return move(req)
        case "close": return close(req)
        case "snapshot": return snapshot(req)
        case "find": return find(req)
        case "get": return get(req)
        case "click":
            switch ContextMenu.refClick(button: req.string("button"), item: req.string("item")) {
            case .failure(let e): return .failure(e)
            case .success(.right(let item)): return contextClick(req, item: item)
            case .success(.press): return act(req, .click, "click")
            }
        case "type": return act(req, .typeText, "type", text: req.string("text"), pasted: req.bool("paste"))
        case "set-value": return act(req, .setValue, "set-value", text: req.string("value"))
        case "press": return press(req)
        case "click-at": return clickAt(req)
        case "drag": return drag(req)
        case "scroll": return scroll(req)
        case "select": return act(req, .select, "select", text: req.string("option"))
        case "toggle": return act(req, .toggle, "toggle")
        case "menu": return menu(req)
        case "shot": return shot(req)
        case "open": return open(req)
        default: return .failure(HandsError(.badArguments, "unknown agent command \(req.verb)", suggestion: "Commands: " + HandsTools.all.map(\.verb).joined(separator: ", ")))
        }
    }

    // MARK: scope

    func onMain<T>(_ f: () -> T) -> T { Thread.isMainThread ? f() : DispatchQueue.main.sync(execute: f) }

    func listWindows(fresh: Bool = false) -> (windows: [HandsWindow], agent: Int?) {
        onMain { (fresh ? host.freshWindows() : host.windows(), host.agentWorkspace()) }
    }

    func decide(_ w: HandsWindow, _ agent: Int?, session: String = "") -> ScopeDecision {
        // A window BaneySpaces doesn't place: usable only as a child of a window the agent may use (`ChildWindowRule`).
        if w.workspace == nil { return childDecision(w.id, pid: w.pid, agent: agent, session: session)?.decision.scope ?? ScopeGuard.check(w, agentWorkspace: agent, lends: lends.current(), now: Date(), mode: access, selfPid: getpid()) }
        let mode = access
        Self.refusedLock.lock(); let bad = Self.refused.contains(w.id); Self.refusedLock.unlock()
        // Under Full Access Donovan's documents are open to agents, so a window refused for showing one is usable again.
        if bad, mode != .full { return .denied(HandsError(.needsSandbox, "window \(w.id) showed a document of Donovan's", suggestion: "Open your own file from the handoff folder.", retry: .never)) }
        let book = lends.current()
        // Whether Donovan is using the app is not scope: reads never look at it, and actions wait for it (`awaitUse`).
        let base = ScopeGuard.check(w, agentWorkspace: agent, lends: book, now: Date(), mode: mode, selfPid: getpid())
        // A window an agent moved onto the agent workspace keeps the scope that let it move: none once that ends.
        let d = HandsMovedIn.shared.decide(w, base: base, lends: book, now: Date(), mode: mode)
        if case .denied = d { return d }
        // What Full Access let onto the agent workspace goes out with it. A window of that process Donovan lends later still counts as lent.
        if d == .onAgentWorkspace, mode != .full, AgentAccess.shared.grantedUnderFull(w.pid) {
            if book.isLent(w, now: Date()) { return .lent }
            return .denied(HandsError(.needsSandbox, "\(w.app) was opened for agents under Full Access, and agent access is \(mode.title) now",
                                      suggestion: "Ask Donovan to set Full Access again (Settings > Agents), or work in an app `polycarp-spaces agent open` starts in \(mode.title).", retry: .never))
        }
        return d
    }

    /// The scope check an engine call runs on its queue at the moment it executes, plus, for a call on a ref,
    /// the check that the ref still means what the snapshot said (the engine's saved refs are a file the
    /// agent could edit).
    func check(_ w: HandsWindow, ref: String? = nil, session: String = "") -> HandsEngine.Check {
        { [self] in gate(w, session: session) ?? ref.flatMap { refProblem($0) } }
    }

    /// The same for a call that changes something: Read Only, set after the request was let in, stops it here too, and so
    /// does Donovan coming back to the app after the wait found it free (the in-use rule, read again at this moment).
    /// `also`: a verb's own rule, read at the same moment (a menu command's key-window rule).
    func actingCheck(_ w: HandsWindow, ref: String? = nil, verb: String, delivery: InUseDelivery, session: String = "", also: HandsEngine.Check? = nil) -> HandsEngine.Check {
        let scope = check(w, ref: ref, session: session)
        return { [self] in AgentAccessGate.actingRefusal(mode: access) ?? scope() ?? inUseProblem(w, verb: verb, delivery: delivery) ?? also?() }
    }

    // MARK: in use

    /// How Donovan's use of the app stands for this action, from facts read now. The app's focused and main windows are
    /// read from accessibility only when they can change the answer.
    func inUseVerdict(_ w: HandsWindow, agent: Int?, verb: String, delivery: InUseDelivery) -> (state: InUseState, verdict: InUseRule.Verdict) {
        let state = UserActivity.shared.state(w.pid)
        guard state.busy else { return (state, .proceed) }
        let onAgentWorkspace = agent != nil && w.workspace == agent
        var windows: (focused: Bool?, main: Bool?) = (nil, nil)
        if onAgentWorkspace, InUseRule.semantic.contains(verb), delivery == .headlessAX { windows = BackgroundAX.isFocusedOrMain(w.id, pid: w.pid) }
        return (state, InUseRule.decide(verb: verb, state: state, onAgentWorkspace: onAgentWorkspace,
                                        isFocusedWindow: windows.focused, isMainWindow: windows.main, delivery: delivery))
    }

    /// The in-use check at the moment of delivery: nil to go ahead.
    private func inUseProblem(_ w: HandsWindow, verb: String, delivery: InUseDelivery) -> HandsError? {
        let (placed, agent) = onMain { (host.live(w.id), host.agentWorkspace()) }
        let (state, verdict) = inUseVerdict(placed ?? w, agent: agent, verb: verb, delivery: delivery)
        return verdict == .wait ? InUseWait.refusal(app: w.app, state: state, waited: nil) : nil
    }

    /// Before an action is dispatched: while Donovan is using the app, wait on this thread (never the main one, and never
    /// on the process queue, so other callers and other apps go on) until it is free or `wait` seconds pass. Every look
    /// checks Read Only and the whole scope decision again, so a narrowing during the wait refuses at once.
    func awaitUse(_ w: HandsWindow, verb: String, delivery: InUseDelivery, wait: Int?, session: String = "") -> HandsError? {
        let bound = Thread.isMainThread ? 0 : InUseRule.bound(wait)
        let outcome = InUseWait.run(bound: bound, now: Date.init, sleep: { Thread.sleep(forTimeInterval: $0) }) { [self] in
            let (placed, agent) = onMain { (host.live(w.id), host.agentWorkspace()) }
            guard let live = placed ?? (w.workspace == nil ? childWindow(w.id) : nil) else { return .refused(HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Run `polycarp-spaces agent windows` and take a new snapshot.", retry: .afterSnapshot)) }
            guard live.pid == w.pid else { return .refused(HandsError(.staleRef, "window \(w.id) belongs to a different process now", suggestion: "Take a new snapshot.", retry: .afterSnapshot)) }
            let (state, verdict) = inUseVerdict(live, agent: agent, verb: verb, delivery: delivery)
            return InUseWait.step(mode: access, scope: decide(live, agent, session: session), state: state, verdict: verdict)
        }
        switch outcome {
        case .ready(let waited):
            if waited >= InUseRule.poll { Trace.log("hands: \(verb) on \(w.app) waited \(Int(waited.rounded())) s for it to be free") }
            return nil
        case .refused(let e): return e
        case .timedOut(let state, let waited): return InUseWait.refusal(app: w.app, state: state, waited: waited)
        }
    }

    /// The one place `move`, `arrange` and `close` change something: on the main thread, the acting mode, and every target's
    /// live window, scope, inspection and in-use condition are read again, and `perform` runs in that same pass only when all of them
    /// pass (`MutationGate`). `perform` gets the agent workspace as read in that pass.
    func mutateOnMain<T>(_ ws: [HandsWindow], verb: String, session: String, perform: (_ agent: Int?) -> Result<T, HandsError>) -> Result<T, HandsError> {
        onMain {
            let agent = host.agentWorkspace()
            let targets = ws.map { w -> MutationTarget in
                let live = host.live(w.id)
                let scope = live.map { decide($0, agent, session: session) } ?? .denied(HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Run `polycarp-spaces agent windows`.", retry: .afterSnapshot))
                let inUse = live.flatMap { l -> HandsError? in
                    let (state, verdict) = inUseVerdict(l, agent: agent, verb: verb, delivery: .posted)
                    return verdict == .wait ? InUseWait.refusal(app: w.app, state: state, waited: nil) : nil
                }
                // The pre-check's inspection, read again on the live window in this pass, once per target (sol-F1).
                let inspection = live.flatMap { l in scope.allowed ? sheetProblem(l, agent: agent, session: session) ?? inspectProblem(l) : nil }
                return MutationTarget(window: w, live: live, scope: scope, inUse: inUse, inspection: inspection)
            }
            return MutationGate.run(mode: access, targets: targets) { perform(agent) }
        }
    }

    private func refmapURL(_ sid: String) -> URL { HandsEngine.stateRoot.appendingPathComponent("snapshots/\(sid)/refmap.json") }

    private func refProblem(_ ref: String) -> HandsError? {
        guard let colon = ref.firstIndex(of: ":") else { return nil }
        let sid = String(ref[ref.index(after: ref.startIndex)..<colon])
        lock.lock(); let snap = snaps[sid]; lock.unlock()
        guard let snap, let data = try? Data(contentsOf: refmapURL(sid)),
              RefmapIdentity.intact(sealed: snap.identity, current: data, ref: ref) else {
            return HandsError(.staleRef, "the saved refs for \(ref) no longer match the snapshot", suggestion: "Take a new snapshot.", retry: .afterSnapshot)
        }
        return nil
    }

    /// The check right before an engine call: the window is still the same process's, and still in scope.
    /// A move to one of Donovan's workspaces or a revoked lend between resolving and dispatching stops the call.
    func gate(_ w: HandsWindow, session: String = "") -> HandsError? {
        let (placed, agent) = onMain { (host.live(w.id), host.agentWorkspace()) }
        guard let now = placed ?? (w.workspace == nil ? childWindow(w.id) : nil) else { return HandsError(.windowNotFound, "window \(w.id) is gone", suggestion: "Run `polycarp-spaces agent windows` and take a new snapshot.", retry: .afterSnapshot) }
        guard now.pid == w.pid else { return HandsError(.staleRef, "window \(w.id) belongs to a different process now", suggestion: "Take a new snapshot.", retry: .afterSnapshot) }
        if case .denied(let e) = decide(now, agent, session: session) { return e }
        // A child's own panel check is part of its decision (`ChildWindowRule` rule 3).
        return now.workspace == nil ? nil : sheetProblem(now, agent: agent, session: session) ?? inspectProblem(now)
    }

    /// No window is used while it is or holds an Open or Save panel, which would browse his files, in any mode. Windows of a process
    /// BaneySpaces started for an agent are also used only while they show no document from outside the handoff folder (a restored
    /// one, or one opened through a panel). Checked on every use, so a late window is covered too.
    func inspectProblem(_ w: HandsWindow) -> HandsError? {
        let (owned, seen) = onMain { (host.agentOwned(), host.inspect(w.id)) }
        let agentOwned = owned.contains(w.pid)
        switch WindowInspection.decide(full: access == .full, agentOwned: agentOwned, panel: seen.panel, document: seen.document, handoff: Self.handoffFolder) {
        case .usable:
            return nil
        case .panel:
            // Remembered only for an agent's own process: one of Donovan's windows with a sheet up is usable again once the sheet closes.
            if agentOwned, access != .full { remember(w.id) }
            return PanelDetector.refusal(window: w.id, app: w.app)
        case .outsideDocument:
            remember(w.id)
            return HandsError(.needsSandbox, "window \(w.id) of \(w.app) shows a document from outside the handoff folder",
                              suggestion: "Agents work only on files from the handoff folder. Open the file with `polycarp-spaces agent open <app> <file in the handoff folder>`.", retry: .never)
        }
    }

    private func remember(_ id: UInt32) {
        Self.refusedLock.lock(); Self.refused.insert(id); Self.refusedLock.unlock()
    }

    func targetJSON(_ w: HandsWindow, _ scope: ScopeDecision) -> JSONValue {
        .object(["pid": .int(Int(w.pid)), "window": .int(Int(w.id)), "app": .string(w.app), "scope": .string(scope.reason)])
    }

    /// Gives each pending `open` (one that replied before its window appeared) its own launch's window, once it is there.
    func resolvePendingOpens(all: [HandsWindow], agent: Int?) {
        let now = Date()
        childLocked {
            syncLaunchPids()
            for app in Set(sessionWindows.requests.filter(\.pending).map(\.app)) {
                sessionWindows.resolvePending(app: app, windows: all.filter { matches($0, app) && $0.workspace == agent }, now: now)
            }
        }
    }

    /// The pids separate launches reported, into their requests. Under `childLock`.
    private func syncLaunchPids() {
        for r in sessionWindows.requests where r.separate && r.pid == nil {
            if let pid = AgentLaunches.shared.pid(r.id) { sessionWindows.launched(r.id, pid: pid) }
        }
    }

    private func windows(session: String) -> HandsEnvelope {
        let (all, agent) = listWindows(fresh: true)
        resolvePendingOpens(all: all, agent: agent)
        let mode = access
        let usable = all.map { ($0, decide($0, agent, session: session)) }.filter { $0.1.allowed }.map { (window: $0.0, scope: $0.1) }
            // Under Full Access every window is listed without reading each one (that would ask every app on the Mac);
            // a panel is still refused when the window is used.
            .filter { mode == .full || inspectProblem($0.window) == nil }
            .sorted { $0.window.id < $1.window.id }
        let titles = onMain { host.titles(usable.map(\.window.id)) }
        // The dialogs, alerts, sheets and palettes of the apps the agent may use, each decided by `ChildWindowRule`.
        let kids = children(ofPids: Set(usable.map(\.window.pid)), all: all, agent: agent, session: session)
        let waitingOn = Dictionary(grouping: kids.rows.filter { $0.facts.waiting }, by: \.facts.pid).mapValues { $0.map { JSONValue.int(Int($0.facts.id)) } }
        return .success(.object([
            "agent_workspace": agent.map(JSONValue.int) ?? .null,
            "access": .string(mode.rawValue),
            "windows": .array(usable.map { u in
                var w = u.window
                w.title = titles[w.id] ?? ""
                // A window of an app Donovan is using is listed like any other, marked so the agent knows an action waits.
                var e = HandsWindowList.entry(w, scope: u.scope, inUse: UserActivity.shared.state(w.pid))
                if case .object(var o) = e {
                    o["kind"] = "window"
                    if kids.sheetsOn.contains(w.id) { o["sheet"] = .bool(true); o["sheet_note"] = "a sheet is up on this window: its elements are in this window's snapshot, marked sheet" }
                    if let ids = waitingOn[w.pid] { o["waiting_on"] = .array(ids) }
                    e = .object(o)
                }
                return e
            } + kids.rows.map { ChildWindowList.entry($0.facts, decision: $0.decision, inUse: UserActivity.shared.state($0.facts.pid)) }),
        ]))
    }

    private func matches(_ w: HandsWindow, _ name: String) -> Bool {
        w.app.caseInsensitiveCompare(name) == .orderedSame || w.bundle.caseInsensitiveCompare(name) == .orderedSame
    }

    /// The window a snapshot or find names, and that the scope guard allows.
    func target(_ req: HandsRequest) -> Result<(HandsWindow, ScopeDecision, String?), HandsError> {
        var (all, agent) = listWindows()
        if let id = req.int("window") {
            if !all.contains(where: { Int($0.id) == id }) { (all, agent) = listWindows(fresh: true) }
            guard let w = all.first(where: { Int($0.id) == id }) ?? UInt32(exactly: id).flatMap({ childWindow($0) }) else {
                return .failure(HandsError(.windowNotFound, "no window \(id) that Polycarp tracks", suggestion: "Run `polycarp-spaces agent windows` for the ids you can use.", retry: .safe))
            }
            let d = decide(w, agent, session: req.session ?? "")
            if case .denied(let e) = d { return .failure(e) }
            return .success((w, d, nil))
        }
        let name = req.string("app") ?? ""
        var ofApp = all.filter { matches($0, name) }
        if ofApp.isEmpty { (all, agent) = listWindows(fresh: true); ofApp = all.filter { matches($0, name) } }
        guard !ofApp.isEmpty else {
            let running = NSWorkspace.shared.runningApplications.contains { $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame || $0.bundleIdentifier == name }
            return .failure(HandsError(running ? .windowNotFound : .appNotFound,
                                       running ? "\(name) has no window Polycarp tracks" : "\(name) isn't running",
                                       suggestion: running ? "Open one with `polycarp-spaces agent open \(name)`." : "Start it on the agent workspace with `polycarp-spaces agent open \(name)`.", retry: .safe))
        }
        let decided = ofApp.map { ($0, decide($0, agent)) }
        let allowed = decided.filter { $0.1.allowed }
        guard !allowed.isEmpty else {
            if case .denied(let e) = decided[0].1 { return .failure(e) }
            return .failure(HandsError(.outsideAgentWorkspace, "\(name) isn't on the agent workspace", suggestion: "Open it with `polycarp-spaces agent open \(name)`.", retry: .never))
        }
        let pids = Set(allowed.map(\.0.pid))
        guard pids.count == 1 else {
            return .failure(HandsError(.ambiguous, "\(name) has windows in \(pids.count) processes: " + allowed.map { "\($0.0.id) (pid \($0.0.pid))" }.joined(separator: ", "),
                                       suggestion: "Pass --window with one of those ids.", retry: .afterSnapshot))
        }
        let pick = allowed.max { $0.0.id < $1.0.id }!
        let note = allowed.count > 1 ? "newest of \(allowed.count) windows; pass window to choose" : nil
        return .success((pick.0, pick.1, note))
    }

    // MARK: reading

    /// Records the snapshot and what each of its refs points at, read from the engine's file now, while it is
    /// fresh. False when the file can't be read or a ref points anywhere but this window and process.
    private func remember(_ data: JSONValue, _ w: HandsWindow) -> Bool {
        guard let id = data["snapshot_id"]?.string, let file = try? Data(contentsOf: refmapURL(id)),
              let table = RefmapIdentity.table(from: file), RefmapIdentity.allTarget(table, window: w.id, pid: w.pid) else { return false }
        lock.lock(); defer { lock.unlock() }
        snaps[id] = Snap(window: w.id, pid: w.pid, app: w.app, at: Date(), identity: table, pasteboard: SessionClipboard.pasteboardRefs(refmap: file))
        if snaps.count > 256, let oldest = snaps.min(by: { $0.value.at < $1.value.at })?.key { snaps[oldest] = nil }
        return true
    }

    /// `register: false` for the snapshots taken as evidence: the agent never sees their refs, so they must not push its refs out.
    func read(_ w: HandsWindow, interactive: Bool, compact: Bool, depth: UInt8 = 10, register: Bool = true, session: String = "") -> Result<JSONValue, HandsError> {
        switch HandsEngine.shared.snapshot(window: w, interactive: interactive, compact: compact, depth: depth, evidence: !register, check: check(w, session: session)) {
        case .failed(let e): return .failure(e)
        case .ok(let data):
            // The engine must have read the window we asked for, never its neighbor.
            if let got = data["window"]?["id"]?.string, got != "w-\(w.id)" {
                return .failure(HandsError(.windowNotFound, "the engine read \(got), not window \(w.id)", suggestion: "Run `polycarp-spaces agent windows` and try again.", retry: .safe))
            }
            if register, !remember(data, w) {
                return .failure(HandsError(.engineError, "the snapshot's saved refs couldn't be checked", suggestion: "Take a new snapshot.", retry: .safe))
            }
            return .success(data)
        }
    }

    /// `snapshot` with screenshot: true: the read, then a capture of the same window under the same gate as `shot`. A
    /// capture that fails leaves the read as it is, with `screenshot_error`.
    private func snapshot(_ req: HandsRequest) -> HandsEnvelope {
        guard req.bool("screenshot") else {
            if req.string("zoom") != nil { return .failure(HandsError(.badArguments, "zoom goes with screenshot: true", suggestion: #"Example: {"window":4211,"screenshot":true,"zoom":"0,0,400,300"}"#, retry: .safe, nextCall: .null)) }
            return readSnapshot(req)
        }
        let zoom: ShotImage.Region?
        switch ShotImage.region(req.string("zoom"), snapshot: true) {
        case .failure(let e): return .failure(e)
        case .success(let z): zoom = z
        }
        let env = readSnapshot(req)
        guard env.ok, let o = env.data?.object, let id = o["window"]?.int ?? o["target"]?["window"]?.int else { return env }
        let session = req.session ?? ""
        return .success(.object(ShotImage.attach(to: o, zoom: zoom,
            target: { target(HandsRequest(verb: "shot", args: ["window": .int(id)], session: req.session)).map { $0.0 } },
            gate: { gate($0, session: session) },
            points: { Self.windowPoints($0.id) },
            capture: { w in
                let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
                defer { AgentActivity.shared.end(token) }
                return WindowShot.capture(window: w.id, named: nil, check: check(w, session: session))
                    .map { ShotImage.Captured(path: $0.path, width: $0.width, height: $0.height, points: $0.points) }
            })))
    }

    private func readSnapshot(_ req: HandsRequest) -> HandsEnvelope {
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope, note)):
            switch read(w, interactive: req.bool("interactive"), compact: req.bool("compact"), depth: UInt8(clamping: req.int("depth") ?? 10), session: req.session ?? "") {
            case .failure(let e): return .failure(e)
            case .success(let data):
                var o = data.object ?? [:]
                o["target"] = targetJSON(w, scope)
                if let note { o["note"] = .string(note) }
                var notes = note.map { [$0] } ?? []
                // A sheet on this window: its elements are part of the tree, marked, so the agent can answer it.
                if let tree = o["tree"] {
                    let (marked, sheets) = SheetMark.mark(tree)
                    if sheets > 0 {
                        o["tree"] = marked
                        o["sheets"] = .int(sheets)
                        o["sheet_note"] = "a sheet is up on this window and blocks it: its elements are marked sheet and in_sheet"
                        notes.append("a sheet is up on this window and blocks it; its rows are marked sheet")
                    }
                }
                if o["complete"]?.bool == false { notes.append("the read stopped before the end of the tree; pass a larger depth for the rest") }
                let sid = o["snapshot_id"]?.string ?? ""
                let rows = SnapshotRows.rows(of: o["tree"] ?? .null)
                let session = req.session ?? ""
                let view = "\(req.bool("interactive"))|\(req.bool("compact"))|\(req.int("depth") ?? 10)"
                let since = req.snapshotFormat == "rows" && req.string("since") == "latest"
                let previous = withRows { m -> SnapshotRowsMemory.Read? in
                    let p = m.previous(session: session, window: w.id, view: view)
                    let k = SnapshotRowsMemory.kind(since: since && p != nil, query: req.string("query"), rows: rows.count, max: req.int("max_elements"))
                    m.remember(session: session, window: w.id, view: view, snapshot: sid, rows: rows, now: Date(), listed: k.listed, baseline: k.baseline)
                    return p
                }
                guard req.snapshotFormat == "rows" else { return .success(.object(o)) }
                let text: String
                if since, let previous {
                    text = SnapshotRows.renderSince(SnapshotRows.changes(from: previous.rows, to: rows), new: rows, snapshot: sid, previous: previous.snapshot,
                                                    window: w.id, notes: notes, query: req.string("query"))
                } else {
                    if req.string("since") != nil { notes.append("no earlier read of this window in this session, so this is all of it") }
                    text = SnapshotRows.render(rows, snapshot: sid, window: w.id, title: o["window"]?["title"]?.string ?? "", app: w.app,
                                               refs: o["ref_count"]?.int ?? rows.compactMap(\.number).count, notes: notes,
                                               query: req.string("query"), max: req.int("max_elements"), also: Self.viewArguments(req))
                }
                return .success(.object(["format": "rows", "text": .string(text), "snapshot_id": .string(sid), "window": .int(Int(w.id)),
                                         "ref_count": o["ref_count"] ?? .null, "complete": o["complete"] ?? .null,
                                         "target": targetJSON(w, scope)]))
            }
        }
    }

    private func find(_ req: HandsRequest) -> HandsEnvelope {
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, _, _)):
            switch read(w, interactive: false, compact: true, session: req.session ?? "") {
            case .failure(let e): return .failure(e)
            case .success(let data):
                let role = req.string("role")?.lowercased(), name = req.string("name")?.lowercased()
                let text = req.string("text")?.lowercased(), value = req.string("value")?.lowercased()
                let limit = req.int("limit") ?? 20
                var found: [JSONValue] = []
                func walk(_ n: JSONValue) {
                    guard case .object(let o) = n, found.count < limit else { return }
                    let r = (o["role"]?.string ?? "").lowercased(), nm = (o["name"]?.string ?? o["title"]?.string ?? "").lowercased()
                    let v = (o["value"]?.string ?? "").lowercased(), d = (o["description"]?.string ?? "").lowercased()
                    let hit = (role.map { r == $0 } ?? true) && (name.map { nm.contains($0) } ?? true)
                        && (value.map { v.contains($0) } ?? true) && (text.map { nm.contains($0) || v.contains($0) || d.contains($0) } ?? true)
                    if hit, o["ref_id"] != nil || o["ref"] != nil { found.append(.object(o.filter { $0.key != "children" })) }
                    for c in o["children"]?.array ?? [] { walk(c) }
                }
                if let tree = data["tree"] { walk(tree) }
                if let sid = data["snapshot_id"]?.string {
                    let rows = SnapshotRows.rows(of: data["tree"] ?? .null)
                    withRows { $0.remember(session: req.session ?? "", window: w.id, view: "find", snapshot: sid, rows: rows, now: Date(), listed: false) }
                }
                return .success(.object(["snapshot_id": data["snapshot_id"] ?? .null, "window": .int(Int(w.id)), "count": .int(found.count), "matches": .array(found)]))
            }
        }
    }

    /// The read's view arguments as JSON members, for a call that must read the same view.
    static func viewArguments(_ req: HandsRequest) -> String {
        ["interactive", "compact"].compactMap { k in req.args[k] == nil ? nil : ",\"\(k)\":\(req.bool(k))" }.joined()
            + (req.int("depth").map { ",\"depth\":\($0)" } ?? "")
    }

    // MARK: refs

    /// The full ref a bare row number stands for in this session, or why it can't stand for one, with the call to make instead.
    private func bareRef(_ n: Int, _ req: HandsRequest) -> Result<String, HandsError> {
        switch withRows({ $0.resolve(bare: n, session: req.session ?? "", now: Date()) }) {
        case .ref(let full): return .success(full)
        case .refused(let code, let message, let latest): return .failure(SnapshotRowsMemory.error(code, message, latest: latest))
        }
    }

    /// A ref is good for the snapshot that printed it: that snapshot's window, in that process. Any other
    /// window, a window that changed process, or one that left the agent's scope fails here.
    func resolve(_ ref: String?, session: String = "") -> Result<(HandsWindow, ScopeDecision), HandsError> {
        guard let ref, ref.hasPrefix("@s"), let colon = ref.firstIndex(of: ":") else {
            return .failure(HandsError(.badArguments, "\(ref ?? "") isn't a ref", suggestion: "Refs look like @s8f3k2p9:e5 and come from `polycarp-spaces agent snapshot`.", retry: .safe))
        }
        let sid = String(ref[ref.index(after: ref.startIndex)..<colon])
        lock.lock(); let snap = snaps[sid]; snaps[sid]?.at = Date(); lock.unlock()
        guard let snap else {
            return .failure(HandsError(.unknownRef, "Polycarp didn't print \(ref)", suggestion: "Take a snapshot of the window and use the refs it prints.", retry: .afterSnapshot))
        }
        let (all, agent) = listWindows()
        guard let w = all.first(where: { $0.id == snap.window }) ?? childWindow(snap.window) else {
            return .failure(HandsError(.staleRef, "window \(snap.window) is gone", suggestion: "Run `polycarp-spaces agent windows` and take a new snapshot.", retry: .afterSnapshot))
        }
        guard w.pid == snap.pid else {
            return .failure(HandsError(.staleRef, "window \(snap.window) now belongs to a different process than the snapshot's", suggestion: "Take a new snapshot.", retry: .afterSnapshot))
        }
        let d = decide(w, agent, session: session)
        if case .denied(let e) = d { return .failure(e) }
        return .success((w, d))
    }

    private func get(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        switch resolve(req.string("ref"), session: session) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope)):
            let ref = req.string("ref")!
            switch HandsEngine.shared.get(window: w, ref: ref, property: req.string("property") ?? "value", check: check(w, ref: ref, session: session)) {
            case .failed(let e): return .failure(e)
            case .ok(let d):
                var o = d.object ?? [:]
                o["target"] = targetJSON(w, scope)
                // copy: true holds the value on the agent clipboard, never on the general pasteboard.
                if req.bool("copy") {
                    switch SessionClipboard.copyable(o["value"]) {
                    case .failure(let e): return .failure(e)
                    case .success(let text):
                        if let e = SessionClipboardBox.shared.copy(text, session: session) { return .failure(e) }
                        o["copied"] = .int(text.count)
                    }
                }
                return .success(.object(o))
            }
        }
    }

    // MARK: acting

    private func scroll(_ req: HandsRequest) -> HandsEnvelope {
        let dirs = ["up": 0, "down": 1, "left": 2, "right": 3]
        guard let d = dirs[(req.string("direction") ?? "").lowercased()] else {
            return .failure(HandsError(.badArguments, "direction must be up, down, left or right", suggestion: "usage: polycarp-spaces agent scroll <ref> down", retry: .safe))
        }
        return act(req, .scroll, "scroll", direction: Int32(d), amount: UInt32(clamping: req.int("amount") ?? 3))
    }

    func valueOf(_ w: HandsWindow, _ ref: String, session: String = "") -> String? {
        if case .ok(let v) = HandsEngine.shared.get(window: w, ref: ref, property: "value", check: check(w, ref: ref, session: session)) { return v["value"]?.string ?? "" }
        return nil
    }

    /// `pasted`: the text is what the session copied, read once the ref resolved and the app is free (198 r1 second-N1).
    private func act(_ req: HandsRequest, _ kind: HandsEngine.Kind, _ name: String, text: String? = nil, pasted: Bool = false, direction: Int32 = 1, amount: UInt32 = 3) -> HandsEnvelope {
        guard let ref = req.string("ref") else { return .failure(HandsError(.badArguments, "ref is missing", suggestion: "usage: polycarp-spaces agent \(name) <ref>", retry: .safe)) }
        let session = req.session ?? ""
        if kind == .click || kind == .select, let item = pasteboardItem(ref, option: kind == .select ? text : nil, session: session) {
            return .failure(SessionClipboard.pasteboardRefusal("\(item)"))
        }
        switch resolve(ref, session: session) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope)):
            // Before the mark: an activation while it waits is Donovan's, never taken for the agent's.
            // Every verb here goes through the engine's strict Headless accessibility path (`HandsEngine.act`).
            if let e = awaitUse(w, verb: name, delivery: .headlessAX, wait: req.int("wait"), session: session) { return .failure(e) }
            // A select or click that opens a pop-up menu: only with the window on screen under the agent workspace.
            if kind == .select || kind == .click, let e = popupRefusal(w, ref: ref, verb: name, session: session) { return .failure(e) }
            var text = text
            if pasted {
                switch SessionClipboard.typed(text: text, paste: true, from: { SessionClipboardBox.shared.paste(session: session) }) {
                case .failure(let e): return .failure(e)
                case .success(let t): text = t
                }
            }
            // The mark covers the whole action, queue wait and engine call included, and a short tail after it.
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            let writes = kind == .typeText || kind == .setValue
            let beforeValue: String? = writes ? valueOf(w, ref, session: session) : nil
            // Tree before the action, to show what it changed.
            var before: JSONValue?
            // A row click reads the selection itself; the full read before is for the plain path only (first-F7).
            let plan = kind == .click ? rowPlan(ref, session: session) : nil
            if !writes, kind != .toggle, plan == nil, case .success(let d) = read(w, interactive: false, compact: true, register: false, session: session) { before = d["tree"] }
            // Scope again, at the moment of dispatch: the window may have moved since resolving.
            // Every action reports its target before dispatch. When the agent cursor will draw it (it is on, and Donovan is
            // looking at this window) the target's frame is measured on the process queue and follows as `frameMeasured`:
            // this thread never waits for it, and a frame that is not there in 50 ms leaves the cursor where it was.
            let wantsFrame = HandsEvents.wantsFrame(scope: scope.reason, workspace: w.workspace)
            let actionID = wantsFrame ? HandsEvents.newActionID() : 0
            let scrollDirection = kind == .scroll ? ["up", "down", "left", "right"][max(0, min(3, Int(direction)))] : nil
            HandsEvents.willAct(HandsActionEvent(kind: name, ref: ref, window: w.id, pid: w.pid, app: w.app, point: nil, frame: nil,
                                                 session: req.session ?? "", scope: scope.reason, workspace: w.workspace, direction: scrollDirection,
                                                 id: actionID, frameComing: wantsFrame))
            if wantsFrame {
                HandsEngine.shared.measureBounds(window: w, ref: ref, within: HandsEngine.Budget.bounds, check: check(w, ref: ref, session: session)) {
                    HandsEvents.frameMeasured(actionID: actionID, frame: $0)
                }
            }
            // The child windows the app has now: one that appears after this is the action's (`ChildAttribution`).
            let childrenBefore = noteAction(session: session, pid: w.pid)
            if let plan {
                return clickRow(w, scope: scope, ref: ref, plan: plan, session: session, childrenBefore: childrenBefore)
            }
            // The scope and ref checks run again on the process queue, at the moment the call executes.
            let reply = HandsEngine.shared.act(window: w, ref: ref, kind: kind, text: text, direction: direction, amount: amount, check: actingCheck(w, ref: ref, verb: name, delivery: .headlessAX, session: session))
            switch reply {
            case .failed(let e): return .failure(e)
            case .ok(let engine):
                var evidence: JSONValue
                var verified = engine["disposition"]?["delivery"]?.string == "delivered_verified"
                if writes {
                    if let after = valueOf(w, ref, session: session) {
                        let before = beforeValue ?? ""
                        let expected = text ?? ""
                        let result: (ok: Bool, changed: Bool) = kind == .typeText
                            ? (ValueCheck.typed(before: before, after: after, text: expected), after != before)
                            : { let s = ValueCheck.set(before: before, after: after, expected: expected); return (s.verified, s.changed) }()
                        let (ok, changed) = (result.ok, result.changed)
                        verified = ok
                        evidence = .object(["kind": "value_readback", "value": .string(String(after.prefix(500))), "matches": .bool(ok), "changed": .bool(changed),
                                            "before_length": .int(before.count), "after_length": .int(after.count)])
                    } else { verified = false; evidence = .object(["kind": "value_readback", "error": "the value couldn't be read back"]) }
                } else if kind == .toggle {
                    if case .ok(let v) = HandsEngine.shared.get(window: w, ref: ref, property: "value", check: check(w, ref: ref, session: session)) {
                        var o: [String: JSONValue] = ["kind": "state_readback", "value": v["value"] ?? .null]
                        if case .ok(let s) = HandsEngine.shared.get(window: w, ref: ref, property: "states", check: check(w, ref: ref, session: session)) { o["states"] = s["value"] ?? .null }
                        evidence = .object(o)
                    } else { evidence = .object(["kind": "state_readback", "error": "the state couldn't be read back"]) }
                } else if let before, case .success(let d) = read(w, interactive: false, compact: true, register: false, session: session), let after = d["tree"] {
                    let diff = AXDiff.between(before, after)
                    verified = verified || diff.changed
                    evidence = diff.json()
                } else { evidence = .object(["kind": "ax_diff", "error": "the window couldn't be read after the action"]) }
                var result: [String: JSONValue] = [
                    "action": .string(name), "ref": .string(ref), "verified": .bool(verified), "evidence": evidence,
                    "engine": engine, "target": targetJSON(w, scope),
                ]
                // Not verified: the one read to make before anything else.
                if !verified { result["next_call"] = HandsNextCall.after(.unverified, window: Int(w.id)) }
                // A dialog or sheet the action raised: said here, so the agent need not poll.
                if let opened = openedChildren(pid: w.pid, before: childrenBefore, session: session) { result["opened"] = opened }
                return .success(.object(result))
            }
        }
    }

    /// A window's size in points from the window server's list, which needs no Screen Recording and captures nothing.
    static func windowPoints(_ id: UInt32) -> CGSize? {
        let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]] ?? []
        return (info.first?[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }?.size
    }

    /// The window a request is about, for its error's next call: the window it names, or the one its ref's snapshot read.
    /// A bare row number counts through what `handle` resolved it to (review r1 first-F2); one it refused names no window.
    private func windowOf(_ req: HandsRequest) -> Int? {
        RefWindow.of(window: req.int("window"), ref: req.string("ref"), bare: { _ in nil },
                     snapshotWindow: { sid in lock.lock(); defer { lock.unlock() }; return snaps[sid].map { Int($0.window) } })
    }

    /// The cut, copy or paste item a click on `ref` (or a select of `option` under it) would press. A click is checked
    /// against the snapshot's own refmap, held while the ref resolves, so it is refused however many reads came after
    /// (198 r2 first-F1); a select's option against the read's rows, and by the engine once the popup is open (0003).
    private func pasteboardItem(_ ref: String, option: String?, session: String) -> String? {
        guard ref.hasPrefix("@"), let colon = ref.firstIndex(of: ":"), let n = SnapshotRows.refNumber(ref) else { return nil }
        let sid = String(ref[ref.index(after: ref.startIndex)..<colon])
        if option == nil, let key = RefmapIdentity.key(forRef: ref) {
            lock.lock(); let held = snaps[sid]?.pasteboard[key]; lock.unlock()
            if let held { return held }
        }
        guard let read = withRows({ $0.read(snapshot: sid, session: session) }) else { return nil }
        return SessionClipboard.pasteboardItem(rows: read.rows, number: n, option: option)
    }

    /// Why a select or click on `ref` may not run: it opens a pop-up menu, and the window isn't on screen under the agent
    /// workspace (`ContextMenu.popupGate`). The role is read live; nothing is sent when it refuses.
    private func popupRefusal(_ w: HandsWindow, ref: String, verb: String, session: String) -> HandsError? {
        var role: String?
        if case .ok(let v) = HandsEngine.shared.get(window: w, ref: ref, property: "role", check: check(w, ref: ref, session: session)) { role = v["value"]?.string }
        return ContextMenu.popupGate(verb: verb, role: role, agentShown: agentShown(), window: BackgroundAX.serverWindow(w.id)?.frame, displays: ContextMenuAX.displays())
    }

    /// The selection write a click on `ref` falls back to, when the ref is an item in an outline, table or list.
    private func rowPlan(_ ref: String, session: String) -> ClickFallback.Plan? {
        guard ref.hasPrefix("@"), let colon = ref.firstIndex(of: ":"), let n = SnapshotRows.refNumber(ref) else { return nil }
        let sid = String(ref[ref.index(after: ref.startIndex)..<colon])
        guard let read = withRows({ $0.read(snapshot: sid, session: session) }) else { return nil }
        // The readbacks read in this read's view, so the row keys they compare match (second-F5).
        return ClickFallback.plan(rows: read.rows, snapshot: sid, number: n).map { var p = $0; p.view = read.view; return p }
    }

    private func shot(_ req: HandsRequest) -> HandsEnvelope {
        switch target(req) {
        case .failure(let e): return .failure(e)
        case .success(let (w, scope, _)):
            if let e = gate(w, session: req.session ?? "") { return .failure(e) }
            let zoom: ShotImage.Region?
            switch ShotImage.region(req.string("zoom")) {
            case .failure(let e): return .failure(e)
            case .success(let z): zoom = z
            }
            // The zoom is judged on the window's size first: a refused one captures nothing and writes no file.
            switch ShotImage.beforeCapture(zoom: zoom, points: zoom == nil ? nil : Self.windowPoints(w.id), capture: {
                let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
                defer { AgentActivity.shared.end(token) }
                return WindowShot.capture(window: w.id, named: req.string("out"), cursor: req.bool("cursor") ? host.cursorMark(w.id) : nil, check: check(w, session: req.session ?? ""))
            }) {
            case .failure(let e): return .failure(e)
            case .success(let r):
                return .success(.object([
                    "path": .string(r.path), "width": .int(r.width), "height": .int(r.height), "cursor": .bool(r.cursorDrawn),
                    "points": ShotImage.pointsJSON(r.points),
                    // A capture with the cursor drawn in is an edited picture: it says so and keeps the hash of the raw capture.
                    "evidence": r.cursorDrawn
                        ? .object(["kind": "capture_hash_composited", "sha256": .string(r.sha256), "raw_sha256": r.rawSha256.map(JSONValue.string) ?? .null])
                        : .object(["kind": "capture_hash", "sha256": .string(r.sha256)]),
                    "target": targetJSON(w, scope),
                ]))
            }
        }
    }

    // MARK: apps

    private func open(_ req: HandsRequest) -> HandsEnvelope {
        guard let app = req.string("app") else { return .failure(HandsError(.badArguments, "app is missing", suggestion: "usage: polycarp-spaces agent open <app>", retry: .safe)) }
        guard let url = SessionController.appURL(app) else {
            return .failure(HandsError(.appNotFound, "no app called \(app)", suggestion: "Use the app's name as in /Applications, or its bundle id.", retry: .safe))
        }
        let bundle = Bundle(url: url)?.bundleIdentifier ?? ""
        let display = url.deletingPathExtension().lastPathComponent
        let session = req.session ?? ""
        let targets = req.args["targets"]?.array?.compactMap(\.string) ?? []
        // new_window: false reuses a window this session opened in the app, when no files are given; nothing starts.
        if req.args["new_window"]?.bool == false, targets.isEmpty, AgentAccessGate.actingRefusal(mode: access) == nil {
            let (all, agent) = listWindows(fresh: true)
            resolvePendingOpens(all: all, agent: agent)
            let mine = childLocked { sessionWindows.windows(of: session) }
            if let w = all.filter({ mine[$0.id] == $0.pid && matches($0, bundle.isEmpty ? display : bundle) && $0.workspace == agent && decide($0, agent).allowed }).max(by: { $0.id < $1.id }) {
                return .success(.object(["window": .int(Int(w.id)), "pid": .int(Int(w.pid)), "app": .string(w.app), "workspace": agent.map(JSONValue.int) ?? .null,
                                         "reused": .bool(true), "focus": .object(["changed": .bool(false), "returned": .bool(false)])]))
            }
        }
        try? FileManager.default.createDirectory(at: Self.handoffFolder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let files: [String]
        switch AgentOpenGate.check(app: display, bundle: bundle, targets: targets, handoff: Self.handoffFolder, appURL: url,
                                     probeFolder: ProbeAppTrust.folder, probeTrusted: bundle == AgentAppPolicy.canvasProbeBundle && ProbeAppTrust.trusted(url),
                                     mode: access) {
        case .failure(let e): return .failure(e)
        case .success(let f): files = f
        }
        // Full Access, an app off the list that is already running: its running copy is asked for a new window, so the
        // session's `open` refuses it while Donovan is using it. Wait here, off the main thread, until it is free.
        if access == .full, !AgentAppPolicy.needsSeparateInstance(bundle: bundle),
           let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundle }) {
            let pid = running.processIdentifier
            let bound = Thread.isMainThread ? 0 : InUseRule.bound(req.int("wait"))
            let outcome = InUseWait.run(bound: bound, now: Date.init, sleep: { Thread.sleep(forTimeInterval: $0) }) { [self] in
                if let e = AgentAccessGate.actingRefusal(mode: access) { return .refused(e) }
                // Narrowed from Full Access: the session's gate decides, and no running copy is claimed then.
                guard access == .full else { return .ready }
                let state = UserActivity.shared.state(pid)
                return state.busy ? .busy(state) : .ready
            }
            switch outcome {
            case .ready: break
            case .refused(let e): return .failure(e)
            case .timedOut(let state, let waited): return .failure(InUseWait.refusal(app: display, state: state, waited: waited))
            }
        }
        // One open of this app at a time: a second request waits here until the first has claimed its window.
        let key = (bundle.isEmpty ? display : bundle).lowercased()
        let gate = childLocked { () -> NSLock in
            if let g = openGates[key] { return g }
            let g = NSLock(); openGates[key] = g; return g
        }
        if Thread.isMainThread {
            // The main thread never waits on another open (that one needs the main thread to finish).
            guard gate.try() else {
                return .failure(HandsError(.inUse, "another agent is opening \(display) right now", suggestion: "Retry in a moment.", retry: .safe))
            }
        } else {
            gate.lock()
        }
        defer { gate.unlock() }
        let pidsBefore = Set(NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle }.map(\.processIdentifier))
        let known = Set(listWindows(fresh: true).windows.map(\.id))
        // What is in front, and how often Polycarp has given the keyboard back, before the launch: the result says whether
        // macOS brought the app forward and whether it was undone.
        let (frontBefore, returnsBefore) = onMain { (NSWorkspace.shared.frontmostApplication?.processIdentifier, AgentLaunchFocus.shared.returns) }
        // This request's own launch: the session's `open` hands the token to the launch's completion, which reports its pid.
        let token = AgentLaunches.shared.newToken()
        let requestStart = Date()
        let reply = onMain { () -> Wire.Reply in
            AgentLaunches.shared.current = token
            defer { AgentLaunches.shared.current = nil }
            return host.open([app] + files)
        }
        guard reply.ok else {
            let msg = reply.error ?? "couldn't open it"
            if msg.contains("agent workspace is off") { return .failure(HandsError(.agentWorkspaceOff, msg, suggestion: "Ask Donovan to run `polycarp-spaces agent on`.", retry: .never)) }
            if reply.info?["code"] == HandsErrorCode.inUse.rawValue {
                return .failure(HandsError(.inUse, msg, suggestion: reply.info?["suggestion"] ?? InUseWait.suggestion(app: display, waited: nil), retry: .safe))
            }
            if msg.hasPrefix("no app called") { return .failure(HandsError(.appNotFound, msg, suggestion: "Use the app's name as in /Applications, or its bundle id.", retry: .safe)) }
            return .failure(HandsError(.actionFailed, msg, suggestion: "Try a different app.", retry: .never))
        }
        // Its window arrives a moment later; wait for it so the caller gets the id. It must belong to a new
        // process: an app that ran the launch inside Donovan's copy is not an agent's window.
        let separate = AgentAppPolicy.needsSeparateInstance(bundle: bundle)
        // A reply with a pid asked an app already running (one process for everyone); one without started a new process.
        let runningPid = reply.info?["pid"].flatMap { Int32($0) }
        // Nothing was asked to make a window: no claim, nothing looked for, and its reply says so (sol-F2).
        guard SessionWindows.asksForWindow(reply.info) else {
            var data: [String: JSONValue] = (reply.info ?? [:]).mapValues(JSONValue.string)
            data["window_identified"] = .bool(false)
            return .success(.object(data))
        }
        let start = childLocked {
            sessionWindows.beginOpen(id: token, session: session, app: key, separate: runningPid == nil, pid: runningPid, known: known, at: Date())
        }
        var window: HandsWindow?
        // Inside the 8 s claim on its window (`claimNextWindow`), so a window seen here was placed by that claim. At most
        // `wait` seconds (7 when it says more or nothing); 0 looks once.
        let wait = InUseRule.bound(req.int("wait"))
        let deadline = Date().addingTimeInterval(min(wait, OpenMiss.claimWait))
        func lookOnce() -> HandsWindow? {
            let (all, agent) = listWindows(fresh: true)
            let candidates = all.filter { matches($0, reply.info?["app"] ?? display) && $0.workspace == agent && (!separate || !pidsBefore.contains($0.pid)) }
            // Provenance: `close` closes only windows this session's `open` made. Claimed under the lock, only a window of this
            // request's own launch, never one another session owns, and nothing while another open of the same running app overlaps.
            return childLocked { () -> HandsWindow? in
                syncLaunchPids()
                return sessionWindows.claim(token, windows: candidates, now: Date())
            }
        }
        var looked = false
        while start != .overlap, window == nil, !looked || Date() < deadline {
            looked = true
            window = lookOnce()
            if window == nil { Thread.sleep(forTimeInterval: 0.15) }
        }
        // The launch's own process, when it started one: the only one a miss below may quit.
        let launched = runningPid == nil ? AgentLaunches.shared.pid(token) : nil
        var missLater = false
        if window == nil, start != .overlap, let pid = launched {
            switch OpenMiss.check(wait: wait, mainThread: Thread.isMainThread, elapsed: Date().timeIntervalSince(requestStart)) {
            case .now:
                let miss = missCheck(pid: pid, display: display, token: token, requestStart: requestStart, look: lookOnce)
                if let e = miss.error { return .failure(e) }
                window = miss.window
            case .after(let delay):
                // A short wait, or the main thread, answers now; the check still runs once the claim has passed (163 second-F5).
                missLater = true
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) { [self] in
                    _ = missCheck(pid: pid, display: display, token: token, requestStart: requestStart, look: lookOnce)
                }
            }
        }
        let waited = String(format: "%.1f", Date().timeIntervalSince(requestStart))
        if let window { Trace.log("agent open \(display): window \(window.id) of pid \(window.pid) in \(waited)s") }
        else { Trace.log("agent open \(display): no window identified in \(waited)s (launched pid \(launched.map(String.init) ?? runningPid.map(String.init) ?? "unknown"))") }
        var data: [String: JSONValue] = (reply.info ?? [:]).mapValues(JSONValue.string)
        let (frontAfter, returnsAfter) = onMain { (NSWorkspace.shared.frontmostApplication?.processIdentifier, AgentLaunchFocus.shared.returns) }
        data["focus"] = .object(["changed": .bool(frontAfter != frontBefore), "returned": .bool(returnsAfter > returnsBefore)])
        if frontAfter != frontBefore { data["focus_note"] = "the app in front changed while it opened; Polycarp did not switch workspaces, and gives the keyboard back when an agent's launch takes it" }
        if let window {
            data["window"] = .int(Int(window.id)); data["pid"] = .int(Int(window.pid))
            data["reused"] = .bool(false)
            if start == .noSession {
                data["owned"] = .bool(false)
                data["note"] = "this open had no session, so the window is reported but owned by nobody: `close` won't close it"
            }
        } else if separate, !pidsBefore.isEmpty, noNewProcess(bundle: bundle, before: pidsBefore) {
            childLocked { sessionWindows.cancelOpen(token) }
            return .failure(HandsError(.needsSandbox, "\(display) didn't start a separate copy, so nothing of it is the agent's",
                                       suggestion: "Close nothing; ask Donovan to quit \(display), or work in the sandbox.", retry: .never))
        } else {
            data["window_identified"] = .bool(false)
            // Its window may still come: when its own launch's window appears within 30 s it is this session's. An open that
            // overlapped another open of the same running app gets none.
            childLocked { sessionWindows.endOpen(token) }
            data["note"] = .string(OpenNote.text(start, app: display)
                + (missLater ? ". If no window of it is on the agent workspace \(Int(OpenMiss.claimWait)) s after the open, Polycarp quits that copy" : ""))
        }
        return .success(.object(data))
    }

    /// The miss check (`OpenMiss`): the launch's own copy with no window on the agent workspace once the claim has passed
    /// gets one more full look, and is quit when that finds none, so no window of it is left on Donovan's screen, drawn
    /// now or later. Answers the window that look found, or the error `open` returns for a quit copy.
    private func missCheck(pid: pid_t, display: String, token: Int, requestStart: Date, look: () -> HandsWindow?) -> (window: HandsWindow?, error: HandsError?) {
        // One more full look: an app still starting answers Accessibility late, and its window then joins the agent
        // workspace (`Spaces.adoptBackgroundWindows` takes an agent-started process's windows a moment after). Its bench is
        // cleared first, or the rescan would skip the very app it is for (review 157 F1).
        Windows.markResponsive(pid)
        onMain { host.rescan() }
        var window: HandsWindow?
        let until = Date().addingTimeInterval(1)
        repeat {
            Thread.sleep(forTimeInterval: 0.15)
            window = look()
        } while window == nil && Date() < until
        if let window { return (window, nil) }
        let (all, agent) = listWindows()
        let held = Set(all.filter { $0.pid == pid && $0.workspace != nil && $0.workspace == agent }.map(\.id))
        let elsewhere = Self.listedWindows(of: pid).subtracting(held)
        let owned = onMain { host.agentOwned() }
        let waited = String(format: "%.1f", Date().timeIntervalSince(requestStart))
        switch OpenMiss.decide(launched: pid, agentStarted: owned, startedAt: AgentOwned.startTime(pid),
                               requestStart: requestStart.timeIntervalSince1970, held: held.count) {
        case .quit(let p):
            childLocked { sessionWindows.cancelOpen(token) }
            Self.quit(p)
            Trace.log("agent open \(display): quit its copy (pid \(p)), no window on the agent workspace in \(waited)s; window(s) elsewhere: \(elsewhere.isEmpty ? "none" : elsewhere.sorted().map(String.init).joined(separator: ","))")
            return (nil, HandsError(.actionFailed, "\(display) opened no window Polycarp could put on the agent workspace, so that copy was quit",
                                    suggestion: "Run `open` again.", retry: .safe))
        case .leave:
            Trace.log("agent open \(display): pid \(pid) has no window on the agent workspace; not this request's copy, left alone")
        case .placed, .wait: break
        }
        return (nil, nil)
    }

    /// The ordinary windows of `pid` the window server lists that a person could see (layer 0, not clear, over 50 x 50:
    /// `OpenMiss.visible`), drawn or not: a hidden app's and parked ones included. For the miss check's trace line.
    static func listedWindows(of pid: pid_t) -> Set<UInt32> {
        let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        return Set(info.compactMap { w -> UInt32? in
            guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid, (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }),
                  OpenMiss.visible(alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1, bounds: b) else { return nil }
            return (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value
        })
    }

    /// Whether the window server still lists window `id` at all (parked and hidden ones included): `close`'s read-back.
    static func serverLists(_ id: UInt32) -> Bool {
        let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        return info.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
    }

    /// Quits a copy an agent's own launch started (`OpenMiss.quit`): asked first, forced if it hasn't gone in 2 s.
    static func quit(_ pid: pid_t) {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return }
        app.terminate()
        let end = Date().addingTimeInterval(2)
        while !app.isTerminated, Date() < end { Thread.sleep(forTimeInterval: 0.1) }
        if !app.isTerminated { app.forceTerminate() }
    }

    /// Whether every running copy of the app was already running before the launch.
    private func noNewProcess(bundle: String, before: Set<pid_t>) -> Bool {
        let now = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle }.map(\.processIdentifier)
        return now.allSatisfy { before.contains($0) }
    }

    // MARK: lending (Donovan's, never an agent's: see HandsTools.userOnly and SocketPolicy)

    /// `agent lend <app|pid>` from the command line: not a grant. It checks the request, then asks Donovan in a
    /// sheet; only a real click on "Lend" in the app lends (`LendConsent`). Called on the main thread.
    func askToLend(target: String, duration: String?, session: String) -> HandsEnvelope {
        guard !target.isEmpty else { return .failure(HandsError(.badArguments, "say which app", suggestion: "usage: polycarp-spaces agent lend <app|pid> [--for 30m]", retry: .safe)) }
        let regular = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        let found: [NSRunningApplication]
        if let pid = Int32(target) { found = regular.filter { $0.processIdentifier == pid } }
        else { found = regular.filter { $0.localizedName?.caseInsensitiveCompare(target) == .orderedSame || $0.bundleIdentifier?.caseInsensitiveCompare(target) == .orderedSame } }
        guard !found.isEmpty else { return .failure(HandsError(.appNotFound, "\(target) isn't running", suggestion: "Open it first.", retry: .safe)) }
        guard found.count == 1, let app = found.first else {
            return .failure(HandsError(.ambiguous, "\(target) is running \(found.count) times: pids " + found.map { String($0.processIdentifier) }.joined(separator: ", "),
                                       suggestion: "Lend by pid: `polycarp-spaces agent lend <pid>`.", retry: .safe))
        }
        let name = app.localizedName ?? "app"
        if lends.isLent(pid: app.processIdentifier) {
            // Already lent: the sheet offers to take it back.
            guard host.askToLend(name, 0, true) else { return .failure(HandsError(.permissionDenied, "not confirmed", suggestion: "Nothing changed.", retry: .never)) }
            lends.giveBack(name)
            return .success(.object(["returned": .array([.string(name)])]))
        }
        guard let seconds = LendBook.duration(duration) else {
            return .failure(HandsError(.badArguments, "couldn't read the time \(duration ?? "")", suggestion: "Use 10m, 2h or 90s.", retry: .safe))
        }
        // Whether Donovan is using the app doesn't stop the request: the sheet is his decision. After a lend, actions on it
        // wait while he uses it (`awaitUse`).
        let ids = host.freshWindows().filter { $0.pid == app.processIdentifier }.map(\.id)
        guard !ids.isEmpty else {
            return .failure(HandsError(.windowNotFound, "\(name) has no window Polycarp tracks", suggestion: "Open a window in it first.", retry: .safe))
        }
        guard host.askToLend(name, Int(seconds / 60), false) else {
            return .failure(HandsError(.permissionDenied, "Donovan didn't lend \(name)", suggestion: "Nothing was lent. Work on the agent workspace with `polycarp-spaces agent open`.", retry: .never))
        }
        let entry = lends.lend(app: name, bundle: app.bundleIdentifier ?? "", pid: app.processIdentifier, windows: ids, session: session, for: seconds)
        let ending = session.isEmpty ? "" : " or session \(session) ends"
        let note = "agents may use these windows until the time runs out" + ending + "; reads work at any time, and an action waits while you are using the app"
        return .success(.object(["lent": .string(name), "pid": .int(Int(app.processIdentifier)), "windows": .array(ids.map { .int(Int($0)) }),
                                 "until": .int(Int((entry?.until ?? Date()).timeIntervalSince1970)),
                                 "note": .string(note)]))
    }
}
