import AppKit
import ApplicationServices
import BaneySpacesCore

/// Tiling in the app. It looks when something changed (a scan landed, a switch ended, a display, the settings), lets
/// `TilingEngine` decide, writes the frames off the main thread and reports where they landed. While no workspace in
/// sight tiles it reads nothing, and it never writes while a switch, a drag or a press of the mouse is under way.
final class Tiling {
    unowned let spaces: Spaces
    var engine = TilingEngine()
    /// What is shown of tiling changed (`TilingState`).
    var onChange: () -> Void = {}

    /// Apps are being asked, or frames written: a look asked for meanwhile comes after.
    private var busy = false
    private var again = false
    private var soon: DispatchWorkItem?
    private var soonDue = 0.0
    private var answers: [WindowID: TilingAnswer] = [:]
    /// Windows whose app didn't answer, when to ask again.
    private var silent: [WindowID: Date] = [:]
    private var bundles: [pid_t: String] = [:]
    /// Windows drawn a moment after they were scanned, and how often they were waited for.
    private var waits: [WindowID: Int] = [:]
    private var watching = false
    var loaded = false
    var titleKey = Data()
    var facts: [WindowID: TilingFacts] = [:]
    var saving: DispatchWorkItem?
    var savedLast: Data?

    init(spaces: Spaces) { self.spaces = spaces }

    /// Takes surfaces.json. Nothing is read or moved when it turns nothing on or off.
    func settingsChanged() {
        guard readSettings() else { return }
        onChange()
        look()
    }

    /// The layout or its state changed: what is kept, and what the bar shows.
    func changed() {
        saveSoon()
        onChange()
    }

    @discardableResult
    private func readSettings() -> Bool {
        let next = TilingOptions(SurfacesStore.shared.current.tiling, agentWorkspace: Spaces.agentWorkspace)
        guard next != engine.options else { return false }
        engine.apply(next)
        return true
    }

    /// A window got the focus: the next one opened goes beside it.
    func focused(_ id: WindowID) {
        if engine.wanted(on: spaces.shownWorkspaces) { engine.focused(id) }
    }

    /// A look a moment from now, the earliest asked for.
    func lookSoon(_ seconds: TimeInterval) {
        let due = CFAbsoluteTimeGetCurrent() + seconds
        guard TilingSoon.replaces(pending: soon == nil ? nil : soonDue, asked: due) else { return }
        soon?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.soon = nil
            self?.look()
        }
        (soon, soonDue) = (work, due)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// Brings the workspaces in sight in line with their windows. Called whenever any of that may have changed.
    func look() {
        guard engine.wanted(on: spaces.shownWorkspaces) else { return }
        guard !busy else { again = true; return }
        // Mid-drag the window is the person's; the release looks again, and this in case it doesn't.
        guard NSEvent.pressedMouseButtons & 1 == 0 else { return lookSoon(0.1) }
        if engine.options.agentWorkspace != Spaces.agentWorkspace { readSettings() }
        watch()
        load()
        guard let view = spaces.tilingView(bar: Self.reach) else { return }
        var facts = view.facts
        for i in facts.indices {
            facts[i].answer = answers[facts[i].id]
            facts[i].bundle = bundle(of: facts[i].pid)
        }
        let now = Date()
        let ask = TilingRead.toAsk(facts, shown: Set(view.shown.keys), options: engine.options)
            .filter { silent[$0.id].map { $0 < now } ?? true && Windows.isResponsive($0.pid) }
        guard ask.isEmpty else { return question(ask, view.windows) }
        let clock = OpenClock("tile")
        claim(facts)
        let moves = engine.plan(TilingRead.shot(facts, shown: view.shown, focused: view.focused))
        waitForLate(facts, Set(view.shown.keys))
        forget(facts)
        saveSoon()
        onChange()
        let (later, go) = (moves.filter { silent[$0.id].map { $0 > now } ?? false }, moves.filter { silent[$0.id].map { $0 <= now } ?? true })
        for m in later { engine.touched(m.id) }
        if !go.isEmpty { write(go, view.windows, clock) }
    }

    /// Off: nothing is watched. On: an app shown, hidden or taken to another desktop changes what is in sight.
    private func watch() {
        guard !watching else { return }
        watching = true
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification,
                     NSWorkspace.activeSpaceDidChangeNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.lookSoon(0.15) }
        }
        // Polycarp's bar takes another height, comes or goes.
        for name in [SurfacesStore.didChange, StyleSheetStore.didChange, NSWindow.didResizeNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                if (note.object as? NSWindow).map(Self.isBar) ?? true { self?.lookSoon(0.05) }
            }
        }
    }

    private static func isBar(_ w: NSWindow) -> Bool {
        w.level.rawValue == Int(CGWindowLevelForKey(.normalWindow)) + BarLayout.levelBelowWindows
    }

    /// How far Polycarp's bar reaches into a display, from its top. It is read off the bar's own windows, which alone
    /// are at their level, so a bar of any shape is kept clear of.
    private static func reach(into display: DisplayKey) -> CGFloat {
        guard let screen = NSScreen.screens.first(where: { Windows.key(of: $0) == display }) else { return 0 }
        return TilingRead.reach(of: NSApp.windows.filter { $0.isVisible && isBar($0) }.map(\.frame), into: screen.frame)
    }

    private func bundle(of pid: pid_t) -> String {
        if let b = bundles[pid] { return b }
        let b = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
        bundles[pid] = b
        return b
    }

    private func forget(_ facts: [TilingFacts]) {
        self.facts = Dictionary(facts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let ids = Set(facts.map(\.id)), pids = Set(facts.map(\.pid))
        answers = answers.filter { ids.contains($0.key) }
        silent = silent.filter { ids.contains($0.key) }
        waits = waits.filter { ids.contains($0.key) }
        bundles = bundles.filter { pids.contains($0.key) }
    }

    /// A window just opened may not be drawn yet, and no event says when it is.
    private func waitForLate(_ facts: [TilingFacts], _ shown: Set<Int>) {
        let late = TilingRead.late(facts, shown: shown, known: { waits[$0, default: 0] >= 4 })
        guard !late.isEmpty else { return }
        for id in late { waits[id, default: 0] += 1 }
        lookSoon(0.1)
    }

    // MARK: Asking and writing, off the main thread

    private func question(_ list: [TilingFacts], _ windows: [WindowID: Window]) {
        busy = true
        let ask = list.compactMap { f in windows[f.id].map { (f, $0) } }
        Spaces.axQueue.async { [weak self] in
            let read = Lanes.map(ask, by: \.0.pid) { f, w in (f.id, w.tilingAnswer(screenSized: f.screenSized)) }
            DispatchQueue.main.async {
                guard let self else { return }
                for (id, answer) in read {
                    self.answers[id] = answer ?? self.answers[id]
                    self.silent[id] = answer == nil ? Date().addingTimeInterval(5) : nil
                }
                self.ready()
                if read.contains(where: { $0.1 == nil }) { self.lookSoon(5.1) }
                self.look()
            }
        }
    }

    /// Asks for every frame, the apps side by side and each app's windows in turn; which were asked for whole.
    static func place(_ list: [(TilingMove, Window)], while allowed: @escaping @Sendable () -> Bool) -> [(WindowID, Bool)] {
        Lanes.map(list, by: \.0.pid) { m, w in (m.id, w.place(m.to, currentSize: m.from.size, while: allowed)) }
    }

    /// The left button is down, read on any thread.
    private static var pressed: Bool { CGEventSource.buttonState(.combinedSessionState, button: .left) }

    private func write(_ moves: [TilingMove], _ windows: [WindowID: Window], _ clock: OpenClock) {
        busy = true
        let list = moves.compactMap { m in windows[m.id].map { (m, $0) } }
        let gate = Window.gate
        let pass = gate.pass
        Spaces.axQueue.async { [weak self] in
            let wrote = Tiling.place(list, while: { gate.open(pass) && !Tiling.pressed })
            DispatchQueue.main.async {
                guard let self else { return }
                clock.shown()
                // One a switch or a press got in front of was never asked; one whose app didn't answer is asked later.
                for (id, whole) in wrote where !whole {
                    self.engine.touched(id)
                    if gate.open(pass), !Tiling.pressed { self.silent[id] = Date().addingTimeInterval(2) } else { self.again = true }
                }
                if wrote.contains(where: { !$0.1 }) { self.lookSoon(2.1) }
                self.settle(Set(wrote.filter(\.1).map(\.0)), Dictionary(uniqueKeysWithValues: moves.map { ($0.id, $0.to) }), pass)
            }
        }
    }

    /// Waits until the windows hold still, then tells the engine where they are. One on its tile at once is done; one
    /// that isn't is given a quarter of a second, since some apps lay out late.
    private func settle(_ ids: Set<WindowID>, _ targets: [WindowID: CGRect], _ pass: Int, last: [WindowID: CGRect] = [:], still: Int = 0, looks: Int = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + (looks == 0 ? 0.03 : 0.06)) { [weak self] in
            guard let self else { return }
            // A switch or a drag owns the windows now: what is seen here isn't their app's answer.
            guard Window.gate.open(pass) else { self.ready(); return self.look() }
            let now = WindowMoves.bounds(of: ids)
            let there = now.allSatisfy { id, f in targets[id].map { TilingEngine.near(f, $0) } ?? true }
            let held = now == last ? still + 1 : 0
            guard there || held >= 3 || looks >= 10 else {
                return self.settle(ids, targets, pass, last: now, still: held, looks: looks + 1)
            }
            let again = self.ready()
            if self.engine.landed(now) || again { self.look() }
        }
    }

    /// The apps are done with; whether a look was asked for meanwhile.
    @discardableResult
    private func ready() -> Bool {
        defer { again = false }
        busy = false
        return again
    }
}

extension Window {
    /// Asks the app, off the main thread, whether this window can take a tile. Nil when it doesn't answer.
    func tilingAnswer(screenSized: Bool) -> TilingAnswer? {
        guard Windows.isResponsive(pid) else { return nil }
        var settable = DarwinBoolean(false)
        guard element.checked(AXUIElementIsAttributeSettable(element, kAXSizeAttribute as CFString, &settable), call: "size settable") else { return nil }
        return TilingAnswer(resizable: settable.boolValue, fullScreen: screenSized && isFullScreen, screenSized: screenSized)
    }
}
