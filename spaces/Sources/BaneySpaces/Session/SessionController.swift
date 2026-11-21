import AppKit
import BaneySpacesCore
import Carbon.HIToolbox
import SwiftUI

/// What the agent workspace needs from BaneySpaces. The app delegate fills it in.
struct AgentHost {
    var workspace: () -> Int? = { nil }
    var setWorkspace: (Int?) -> Void = { _ in }
    var current: () -> Int = { 1 }
    var move: (UInt32, Int) -> Void = { _, _ in }
    /// The windows on the agent workspace (`Spaces.agentWindows`).
    var windows: () -> [AgentAPI.Window] = { [] }
    /// Whether Polycarp places a window (it is on some workspace).
    var window: (UInt32) -> AgentAPI.Candidate? = { _ in nil }
    /// Whether a workspace holds any window.
    var occupied: (Int) -> Bool = { _ in false }
}

/// The session engine: the engine behind every terminal split, browser tab and coding agent BaneySpaces
/// knows about. It feeds the launcher's rows, the Workspace Dock's agent badges and the
/// `baneyspaces` command, reads agent state from hooks, and toasts when an agent finishes while
/// you're elsewhere. BaneySpaces' app delegate owns it and starts it once Accessibility is allowed.
final class SessionController {
    /// Legacy keys from the removed sidebar (2026-10-30), cleared on every start.
    static let legacySidebarKeys = ["deckPinned", "deckLayout", "deckEdgeOpens", "deckEnabled"]
    let engine = Engine()
    let server = Server()
    let phones = PhoneWatcher()
    let remote = RemoteServer()
    private var remoteRetry: Timer?

    static var remoteEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "remoteEnabled") }
        set { UserDefaults.standard.set(newValue, forKey: "remoteEnabled") }
    }
    lazy var toast = ToastPanel()
    /// ⌘⇧U, held only while a terminal is in front.
    let terminalKeys = ScopedHotkeys(signature: "BSTM")
    /// Set by the app delegate: opens the launcher, where the launcher's session rows are searched. ⌃⌘K calls it.
    var onSearch: () -> Void = {}
    /// The rows changed, so an open launcher can show them.
    var onItemsChange: () -> Void = {}
    private var lastItems: [Item] = []
    /// A new Claude session's pane is on its way.
    private var claudeOpening = false
    private var tileGate = TileGate()
    var trustTimer: Timer?
    private(set) var started = false

    var agentHost = AgentHost()
    /// Answers `polycarp-spaces update status|check|now` with the app's updater (the app delegate sets it).
    var updateHandler: ((String) -> Wire.Reply)?

    /// Set by the app delegate: the menu bar badge shows how many agents finished unseen.
    var onUnseenChange: (Int) -> Void = { _ in }
    /// `baneyspaces get` and `set` (the theme, the palette, the dock switch): the app reads and applies them.
    /// Until the app wires them (it does at launch, before the socket listens) a write is refused, never dropped.
    var readSetting: (SettingKey) -> String? = { _ in nil }
    var writeSetting: (SettingKey, String) -> Bool = { _, _ in false }
    /// Which rows are working, asking or stopped changed, so the Workspace Dock's badges can follow.
    var onWorkingChange: () -> Void = {}
    private var lastWorking: [String: String] = [:]

    /// Agents working, asking, stopped on an error or finished unseen, for the Workspace Dock: each with its window, so the
    /// dock can badge the app it runs in and go straight to it.
    /// Finished ones come in the order ⌘⇧U visits them, so a tile's badge goes to the same one.
    func dockAgents() -> [DockAgent] {
        let unseen = engine.attention.unseen
        let agents = engine.items.compactMap { item -> DockAgent? in
            guard let state = DockAgent.State.of(activity: item.activity, unseen: unseen.contains(item.id), notice: item.notice) else { return nil }
            let name = item.agent.isEmpty ? item.appName : item.agent.prefix(1).uppercased() + item.agent.dropFirst()
            return DockAgent(id: item.id, window: item.windowNumber, workspace: item.workspace, state: state, name: name,
                             task: Activity.label(of: item.title))
        }
        let rank = { (a: DockAgent) in unseen.firstIndex(of: a.id) ?? unseen.count }
        return agents.sorted { rank($0) < rank($1) }
    }

    /// Goes to an agent's own row: its tab or split selected, and a finished one marked seen.
    /// False when the session engine no longer has it.
    func focusAgent(_ id: String) -> Bool {
        guard started, let item = engine.item(id) else { return false }
        focus(item)
        return true
    }

    /// Agents that finished unseen and still have a row to go to; the menu bar badge counts these,
    /// so it never counts one the menu's list can't show (a session that closed before you looked).
    var unseenCount: Int { finishedRows().count }

    private var keysAdded = false

    func start(workspaceOf: @escaping (UInt32) -> Int?, currentWorkspace: @escaping () -> Int) {
        guard !started else { return }
        started = true
        engine.workspaceOf = workspaceOf
        engine.currentWorkspace = currentWorkspace
        engine.onUpdate = { [weak self] in self?.engineUpdated() }
        engine.extraItems = { [weak self] in self?.phones.phones.map(\.item) ?? [] }
        phones.onChange = { [weak self] in self?.engine.merge() }
        engine.start()
        phones.start()
        server.handle = { [weak self] in self?.handle($0) ?? Wire.Reply(ok: false) }
        server.start()
        remote.handle = { [weak self] in self?.handle($0) ?? Wire.Reply(ok: false) }
        if Self.remoteEnabled { startRemote() }
        for key in Self.legacySidebarKeys { UserDefaults.standard.removeObject(forKey: key) }

        let cmdShift = cmdKey | shiftKey
        if !keysAdded {
            keysAdded = true
            terminalKeys.add(keyCode: kVK_ANSI_U, modifiers: cmdShift) { [weak self] in self?.jumpToFinished() }
        }

        toast.onPick = { [weak self] id in if let i = self?.engine.item(id) { self?.focus(i) } }
        if !AX.isTrusted { watchForTrust() }
        appChanged()
    }

    /// Everything off: keys released, panels gone, no reads, no socket. Windows stay where they are.
    func stop() {
        guard started else { return }
        started = false
        terminalKeys.deactivate()
        toast.orderOut(nil)
        trustTimer?.invalidate()
        engine.stop()
        phones.stop()
        server.stop()
        remote.stop()
        remoteRetry?.invalidate()
        lastUnseen = []
        onUnseenChange(0)
    }

    // MARK: engine

    var lastState = ""
    var lastUnseen: [String] = []
    func engineUpdated() {
        guard started else { return }
        let unseen = engine.attention.unseen
        // Newly finished while you're in some other app: say so, once, in a corner.
        let fresh = unseen.filter { !lastUnseen.contains($0) }
        if let id = fresh.first, let item = engine.item(id), wrappedFront == nil || !(item.focused) {
            toast.show(item, more: fresh.count - 1, on: Self.activeScreen())
        }
        if unseen != lastUnseen { onUnseenChange(unseen.count) }
        let working = Dictionary(engine.items.filter { $0.activity == .working || !$0.notice.isEmpty }
            .map { ($0.id, $0.activity == .working ? "" : $0.notice) }) { a, _ in a }
        if working != lastWorking { lastWorking = working; onWorkingChange() }
        lastUnseen = unseen
        if engine.items != lastItems { lastItems = engine.items; onItemsChange() }
        writeState()
    }

    /// What the session engine believes, for checks, agents and bug reports:
    /// ~/Library/Application Support/BaneySpaces/session.json.
    func writeState() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        struct State: Encodable {
            let trusted: Bool
            let unseen: [String]
            let reads: [String: String]
            let items: [Item]
        }
        let s = State(trusted: AX.isTrusted, unseen: engine.attention.unseen, reads: engine.statusInfo, items: engine.items)
        guard let data = try? enc.encode(s), let text = String(data: data, encoding: .utf8), text != lastState else { return }
        lastState = text
        try? FileManager.default.createDirectory(at: Wire.supportDir, withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: Wire.ownStatePath), options: .atomic)
    }

    func watchForTrust() {
        trustTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] t in
            guard AX.isTrusted else { return }
            t.invalidate()
            self?.engine.retryWatching()
        }
    }

    // MARK: showing and hiding

    var wrappedFront: AppSpec? {
        guard let b = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else { return nil }
        return engine.specs.first { $0.bundleID == b }
    }

    /// The app delegate calls this when the front app changes.
    func appChanged() {
        guard started else { return }
        let front = wrappedFront
        if front?.role == .terminal { terminalKeys.activate() } else { terminalKeys.deactivate() }
    }

    // MARK: actions

    /// Goes to a row picked in the launcher, a toast, ⌘⇧U or a dock badge. A phone opens as its app.
    /// A row whose window BaneySpaces has on a workspace goes there through `focusWindow` (the same
    /// path as a dock icon click), and the engine only selects the tab or split inside it. Activating
    /// the app from here instead reached Spaces as an activation it didn't ask for, of an app it had
    /// hidden on another workspace, so it re-applied the workspace you were on: the app flashed up
    /// and you were put back (Donovan, 2026-11-20, T3 Code's "?" and the tile's finished count).
    func focus(_ item: Item) {
        if item.kind == .device {
            engine.seen(item.id)
            if let p = phones.phone(item.id) { phones.open(p) }
            return
        }
        if item.windowNumber != 0, let n = engine.workspaceOf(item.windowNumber), focusWindow(item.windowNumber, n) {
            return engine.focus(item, bringForward: false)
        }
        engine.focus(item)
    }

    /// Goes to window `id` on workspace `n` through BaneySpaces, so the switch and the activation are its own.
    /// False when it can't (not wired, or BaneySpaces is off): the engine brings the app forward itself.
    var focusWindow: (UInt32, Int) -> Bool = { _, _ in false }

    func jumpToFinished() {
        guard let id = engine.attention.unseen.first, let item = engine.item(id) else { NSSound.beep(); return }
        focus(item)
    }

    /// The launcher's "New Claude session": another session tiled into
    /// `claude-desk`'s Claude window, through a script compiled here (`Scripts.claudeDesk`).
    /// Running `claude-desk` itself cost a bash and an `osascript` launch plus a 90 to 150 ms
    /// compile on every press. It stays the fallback when the script never reached Ghostty, and a
    /// plain terminal running `claude` without it. `done` runs once the pane is up or handed off.
    func newClaude(in folder: String? = nil, then done: @escaping () -> Void = {}) {
        // Not while a timed-out tile may still be landing its pane: a second press could open a second.
        guard !claudeOpening, !tileGate.blocks(now: Date().timeIntervalSinceReferenceDate) else { return }
        let desk = NSHomeDirectory() + "/.local/bin/claude-desk"
        guard FileManager.default.isExecutableFile(atPath: desk) else {
            let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            engine.newTerminal(in: folder ?? Item.workingFolder(engine.items, front: front), command: "claude")
            return done()
        }
        claudeOpening = true
        let finish = { [weak self] in self?.claudeOpening = false; done() }
        guard Automation.allowed(Catalog.known[0].bundleID) else { return runClaudeDesk(desk, then: finish) }
        let script = claudeScript
        script.queue.async { [weak self] in
            let prior = ClaudeDesk.read()
            let token = UUID().uuidString
            let r = script.run("claudeTile", [ClaudeDesk.workDir, ClaudeDesk.paneCommand, prior.joined(separator: "\n"), token])
            var landing: TimeInterval?
            if let out = r.out {
                ClaudeDesk.write(ClaudeDesk.parse(out))
            } else if r.error == ClaudeDesk.timedOut {
                // The script stopped at the Apple event that timed out. Only if that was the one that
                // opens the pane can one still land; otherwise nothing opened and nothing is owed.
                // `frontTab` queues behind it in Ghostty, so its answer means the pane exists. It
                // reads the tab `claudeTile` worked in, so the next press splits it.
                if ClaudeDesk.paneMayLand(progress: script.run("tileProgress").out ?? "", token: token) {
                    if let tab = script.run("frontTab", [prior.joined(separator: "\n")]).out {
                        ClaudeDesk.write(ClaudeDesk.recovered(prior: prior, front: ClaudeDesk.parse(tab)))
                    } else {
                        // From when `frontTab` gave up, not when the tile did: its timeout shows the
                        // pane's event was still unanswered then.
                        landing = Date().timeIntervalSinceReferenceDate
                    }
                }
            }
            DispatchQueue.main.async {
                // No answer from `frontTab` either: presses wait out `TileGate.limit` from then.
                if let landing { self?.tileGate.timedOut(at: landing) } else { self?.tileGate.settled() }
                // Only a script that never reached Ghostty is tried again through claude-desk; one
                // that failed or timed out partway may already have opened the pane.
                if Self.neverReached.contains(r.error) { self?.runClaudeDesk(desk, then: finish) } else { finish() }
            }
        }
    }

    private lazy var claudeScript = Scripts.claudeDesk()

    /// Errors that mean Ghostty saw nothing: the script didn't compile, Automation isn't allowed,
    /// Ghostty isn't running or its connection was gone.
    static let neverReached: Set<Int> = [OSA.didNotCompile, -1743, -600, -609]

    private func runClaudeDesk(_ path: String, then done: @escaping () -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.terminationHandler = { _ in DispatchQueue.main.async(execute: done) }
        do { try p.run() } catch { done() }
    }

    static func cliPath() -> String { Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/bin/\(Product.commandName)").path }

    static func hooksInstalled() -> Bool {
        guard let d = FileManager.default.contents(atPath: NSHomeDirectory() + "/.claude/settings.json"),
              let s = String(data: d, encoding: .utf8) else { return true }
        return HookSettings.mentioned(in: s)
    }

    func installHooks() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: Self.cliPath())
        p.arguments = ["hooks", "install"]
        try? p.run()
        p.waitUntilExit()
    }

    /// Rows for BaneySpaces' launcher (⌘Space, ⌃⌘K), so one search finds apps, splits, tabs and agents.
    func launcherItems(_ q: String) -> [LauncherItem] {
        guard started else { return [] }
        let unseen = engine.attention.unseen
        let rows = q.isEmpty
            ? unseen.compactMap { engine.item($0) }
            : SessionRank.rank(q, engine.items) { [$0.label, "\($0.appName) \($0.label)", $0.detail] }
        return rows.map { item in
            let done = unseen.contains(item.id)
            var sub = [item.appName]
            if !item.notice.isEmpty { sub.append(item.notice) } else if !item.detail.isEmpty { sub.append(item.detail) }
            return LauncherItem(id: "session:" + item.id, section: done ? "Needs You" : "Terminals, Tabs and Agents",
                                title: item.label, subtitle: sub.joined(separator: " · "), icon: .file(Self.appPath(item.bundleID)),
                                badge: done ? "Done" : item.activity == .working ? "Working" : "",
                                workspaces: item.workspace > 0 ? [item.workspace] : [],
                                run: { [weak self] in self?.focus(item) })
        }
    }

    /// The screen showing the front app's focused window, else the main one: where the toast appears.
    static func activeScreen() -> NSScreen {
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
           let w: AXUIElement = AX.app(pid, timeout: 0.1).value(kAXFocusedWindowAttribute), let f = w.frame {
            let center = CGPoint(x: f.midX, y: f.midY)
            if let s = NSScreen.screens.first(where: { AX.flip($0.frame).contains(center) }) { return s }
        }
        return NSScreen.main ?? NSScreen.screens[0]
    }

    private static var appPaths: [String: String] = [:]
    static func appPath(_ bundleID: String) -> String {
        if let p = appPaths[bundleID] { return p }
        let p = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)?.path ?? ""
        appPaths[bundleID] = p
        return p
    }

    // MARK: socket

    /// `doctor`'s line for a Polycarp theme: in force (it draws instead of appearance.theme and appearance.palette) or none.
    static func polycarpThemeStatus() -> String {
        guard let p = Appearance.shared.polycarp else { return "none (appearance.theme and appearance.palette draw)" }
        return "in force: \(p.title) (\(p.name), mode \(p.mode.rawValue)); it overrides appearance.theme and appearance.palette, which are kept"
    }

    func handle(_ r: Wire.Request) -> Wire.Reply {
        // Looks and the dock switch need no Accessibility, so they answer before the session engine has started.
        if r.op == .setting { return setting(r) }
        // Updating needs no Accessibility either. A remote caller never gets here (`Remote.allows`), and the
        // check below keeps it so if that ever changes: another machine does not get to restart this app.
        if r.op == .update {
            guard r.caller?.hasPrefix("remote ") != true else { return .init(ok: false, error: "updates are started on each machine itself") }
            return updateHandler?(r.text ?? "status") ?? .init(ok: false, error: "the updater isn't ready")
        }
        // The player needs no Accessibility either; another machine never gets here (`Remote.allows`).
        if r.op == .play { return play(r) }
        guard started else { return .init(ok: false, error: "Polycarp hasn't finished starting (it needs Accessibility)") }
        switch r.op {
        case .ping:
            var info = engine.statusInfo
            info["accessibility"] = AXIsProcessTrusted() ? "allowed" : "not allowed"
            info["version"] = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
            info["polycarp_theme"] = Self.polycarpThemeStatus()
            return .init(ok: true, info: info)
        case .list:
            return .init(ok: true, items: engine.items)
        case .setting:
            return setting(r)
        case .event:
            guard let e = r.event else { return .init(ok: false, error: "no event") }
            engine.apply(e)
            return .init(ok: true)
        case .notify:
            guard let e = r.event else { return .init(ok: false, error: "no event") }
            guard let item = engine.notify(e) else { return .init(ok: false, error: "couldn't tell which row this terminal is") }
            return .init(ok: true, info: ["id": item.id, "label": item.label])
        case .focus:
            guard let q = r.target, let item = engine.find(q) else { return .init(ok: false, error: "nothing matches") }
            focus(item)
            return .init(ok: true, info: ["id": item.id, "label": item.label])
        case .open:
            guard let s = r.target, let url = URL(string: s), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else {
                return .init(ok: false, error: "only http and https URLs")
            }
            NSWorkspace.shared.open(url)
            return .init(ok: true)
        case .send:
            guard let q = r.target, let item = engine.find(q) else { return .init(ok: false, error: "nothing matches") }
            guard engine.send(item, r.text ?? "") else { return .init(ok: false, error: "\(item.label) isn't a Ghostty terminal") }
            return .init(ok: true, info: ["id": item.id, "label": item.label])
        // A caller on another machine gets only `agent status` (`Remote.allows`).
        case .agent: return agent(r.text ?? "status", r.args ?? [])
        case .update:
            // Answered above, before the Accessibility check.
            return .init(ok: false, error: "the updater isn't ready")
        case .play:
            return play(r)
        case .remote:
            switch r.text ?? "status" {
            case "on":
                Self.remoteEnabled = true
                startRemote()
            case "off":
                Self.remoteEnabled = false
                remoteRetry?.invalidate()
                remote.stop()
            case "token":
                return .init(ok: true, info: ["token": RemoteServer.token()])
            default: break
            }
            var info = ["remote": Self.remoteEnabled ? "on" : "off"]
            if let a = remote.address { info["listening"] = "\(a):\(Remote.port)" }
            else if Self.remoteEnabled { info["listening"] = "waiting for Tailscale" }
            return .init(ok: true, info: info)
        }
    }

    /// `polycarp-spaces play <path>`: the command checked the path; this only hands it to the player, which reads the
    /// disk off the main thread.
    private func play(_ r: Wire.Request) -> Wire.Reply {
        guard r.caller?.hasPrefix("remote ") != true else { return .init(ok: false, error: "the player opens files on this machine only") }
        guard let path = r.target, path.hasPrefix("/"), let kind = PlayerMedia.kind(of: path) else {
            return .init(ok: false, error: "the player opens \(PlayerMedia.extensionList) files, by absolute path")
        }
        Player.open(URL(fileURLWithPath: path))
        return .init(ok: true, info: ["kind": kind.rawValue, "path": path])
    }

    private var notReady: Wire.Reply { .init(ok: false, error: "Polycarp isn't ready for settings yet; try again in a moment") }

    private func setting(_ r: Wire.Request) -> Wire.Reply {
        switch SettingKey.ask(target: r.target, text: r.text) {
        case .refused(let why): return .init(ok: false, error: why)
        case .list:
            let all = SettingKey.allCases.compactMap { k in readSetting(k).map { (k.rawValue, $0) } }
            return all.count == SettingKey.allCases.count ? .init(ok: true, info: Dictionary(uniqueKeysWithValues: all)) : notReady
        case .get(let key):
            guard let v = readSetting(key) else { return notReady }
            return .init(ok: true, info: [key.rawValue: v])
        case .set(let key, let value):
            guard writeSetting(key, value), let v = readSetting(key) else { return notReady }
            // Agents may change how this Mac looks, so each change says who made it.
            Trace.log("setting \(key.rawValue)=\(v) by \(r.caller ?? "unnamed caller")")
            var info = [key.rawValue: v]
            if let note = key.polycarpNote(inForce: Appearance.shared.polycarp != nil) { info["note"] = note }
            return .init(ok: true, info: info)
        }
    }

    /// Listens for your other machines. Every 30 seconds it checks the tailnet address: it starts
    /// once Tailscale is up, and moves when the address changes.
    private func startRemote() {
        _ = RemoteServer.token()
        _ = remote.start()
        remoteRetry?.invalidate()
        remoteRetry = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] t in
            guard let self, Self.remoteEnabled, self.started else { return t.invalidate() }
            if self.remote.address != RemoteServer.tailnetAddress() { self.remote.stop() }
            _ = self.remote.start()
        }
    }

    // MARK: agent workspace

    /// `polycarp-spaces agent …`: the agent workspace (on, off, status) and its API's two operations, `windows` and `move`
    /// (docs/agent-workspace-api.md). Computer use (reading and driving apps) is Tychicus's, not Polycarp's.
    func agent(_ sub: String, _ args: [String]) -> Wire.Reply {
        let h = agentHost
        switch sub {
        case "on":
            let n = args.first.flatMap(Int.init) ?? h.workspace() ?? 9
            guard Workspaces.range.contains(n) else { return .init(ok: false, error: "pick a workspace from 1 to 9") }
            // A workspace with windows on it is someone's: the agent workspace starts empty.
            if n != h.workspace(), h.occupied(n) {
                return .init(ok: false, error: "workspace \(n) has windows on it; pick an empty workspace: polycarp-spaces agent on <N>")
            }
            h.setWorkspace(n)
            return agentStatus()
        case "off":
            h.setWorkspace(nil)
            return .init(ok: true, info: ["workspace": "off"])
        case "status":
            return agentStatus()
        case "windows":
            return AgentAPI.windows(agentWorkspace: h.workspace(), h.windows())
        case "move":
            switch AgentAPI.move(args: args, agentWorkspace: h.workspace(), window: h.window) {
            case .refused(let reply): return reply
            case .move(let id, let n):
                h.move(id, n)
                return AgentAPI.moved(id, to: n)
            }
        default:
            return AgentAPI.refusal(.badRequest, "usage: polycarp-spaces agent status|on [N]|off|windows|move <window number>")
        }
    }

    func agentStatus() -> Wire.Reply {
        guard let n = agentHost.workspace() else { return .init(ok: true, info: ["workspace": "off"]) }
        var info = ["workspace": "\(n)", "current": "\(agentHost.current())"]
        for (i, w) in agentHost.windows().enumerated() { info["window.\(i)"] = "\(w.id)\t\(w.app)\t\(w.title)" }
        return .init(ok: true, items: engine.items.filter { $0.workspace == n }, info: info)
    }

    // MARK: finished agents

    /// Agents that finished while you were away, for Settings > Dock.
    func finishedRows() -> [(id: String, label: String)] {
        engine.attention.unseen.compactMap { engine.item($0) }.map { ($0.id, $0.label) }
    }

    /// Goes to the agent a "Finished While You Were Away" row names, and marks it seen.
    func focusFinished(_ id: String) {
        guard let row = engine.item(id) else { return }
        focus(row)
    }

    /// The menu bar menu's row for agents that finished while you were away: a submenu, one item
    /// for each. The app adds it only while there is one.
    func finishedMenuItem(title: String) -> NSMenuItem {
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (id, label) in finishedRows() {
            let i = NSMenuItem(title: label, action: #selector(SessionMenuTarget.focusRow(_:)), keyEquivalent: "")
            i.representedObject = id
            i.target = menuTarget
            sub.addItem(i)
        }
        parent.submenu = sub
        return parent
    }

    private lazy var menuTarget = SessionMenuTarget(owner: self)
}

/// Menu items need an Objective-C target; this one forwards to the session engine.
final class SessionMenuTarget: NSObject {
    weak var owner: SessionController?
    init(owner: SessionController) { self.owner = owner }
    @objc func focusRow(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String else { return }
        owner?.focusFinished(id)
    }
}

/// A small notice in the top-right corner when an agent finishes or needs you while you're looking
/// elsewhere. It never takes focus; a click goes there, and it fades on its own.
final class ToastPanel: NSPanel {
    var onPick: (String) -> Void = { _ in }
    private var hideTimer: Timer?
    private var itemID = ""
    private let text = NSHostingView(rootView: ToastView(title: "", detail: "", bundleID: ""))

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 320, height: 64), styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        level = .floating
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        title = "Polycarp Agent Notice"
        setAccessibilityIdentifier("session.toast")
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        contentView = Self.chrome(text, radius: 12)
    }

    override var canBecomeKey: Bool { false }

    /// A blurred rounded card hosting `content`.
    private static func chrome(_ content: NSView, radius: CGFloat) -> NSView {
        let root = NSView()
        let blur = NSVisualEffectView()
        blur.material = .sidebar
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = radius
        blur.layer?.masksToBounds = true
        for (child, parent) in [(blur, root), (content, blur)] {
            child.translatesAutoresizingMaskIntoConstraints = false
            parent.addSubview(child)
            NSLayoutConstraint.activate([
                child.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
                child.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
                child.topAnchor.constraint(equalTo: parent.topAnchor),
                child.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
            ])
        }
        return root
    }

    func show(_ item: Item, more: Int, on screen: NSScreen) {
        itemID = item.id
        let what = item.notice.isEmpty ? "finished" : item.notice
        let who = item.agent.isEmpty ? item.appName : item.agent.capitalized
        text.rootView = ToastView(title: "\(who): \(what)", detail: item.label + (more > 0 ? "  +\(more) more" : ""), bundleID: item.bundleID)
        let v = screen.visibleFrame
        setFrame(NSRect(x: v.maxX - 332, y: v.maxY - 76, width: 320, height: 64), display: true)
        alphaValue = 1
        orderFrontRegardless()
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in self?.fade() }
    }

    override func mouseDown(with event: NSEvent) {
        hideTimer?.invalidate()
        orderOut(nil)
        onPick(itemID)
    }

    private func fade() {
        NSAnimationContext.runAnimationGroup({ $0.duration = Chrome.duration(0.25, .panelOut); animator().alphaValue = 0 }, completionHandler: { [weak self] in self?.orderOut(nil) })
    }
}

struct ToastView: View {
    let title: String
    let detail: String
    let bundleID: String
    var body: some View {
        HStack(spacing: 10) {
            if !bundleID.isEmpty { Image(nsImage: Icons.app(bundleID)).resizable().frame(width: 28, height: 28) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Text("⌃⌘U").font(.system(size: 10, weight: .medium)).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

enum Icons {
    private static var cache: [String: NSImage] = [:]
    static func app(_ bundleID: String) -> NSImage {
        if let i = cache[bundleID] { return i }
        let img: NSImage
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            img = NSWorkspace.shared.icon(forFile: url.path)
        } else {
            img = NSImage(systemSymbolName: "app", accessibilityDescription: nil) ?? NSImage()
        }
        img.size = NSSize(width: 32, height: 32)
        cache[bundleID] = img
        return img
    }
}
