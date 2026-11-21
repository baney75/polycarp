import AppKit
import BaneySpacesCore

/// Moves real windows to match the workspace model. Hidden windows wait at the bottom-right
/// corner of the screen, so every app keeps running and nothing is minimized or closed.
///
/// A window is hidden exactly when `saved` holds its frame. That record, not where the window
/// happens to sit, decides what to show, so a display change or an app nudging its own window
/// can't make BaneySpaces lose track of it.
final class Spaces {
    private(set) var model = Workspaces()
    private var saved: SavedFrames
    private var windows: [WindowID: Window] = [:]
    private(set) var switching = false
    /// Set with `switching` while a switch (or a key press held in order with switches) waits on a background scan
    /// before anything moves: a scan landing then is applied, since nothing it saw has moved yet.
    private var holding = false
    /// False after `suspend()`: nothing moves until `start()` runs again.
    private(set) var active = false
    /// Timing of the switch in progress, for timing.log.
    private var clock = SwitchClock()
    /// Work requested mid-switch runs in order once it finishes. Workspace switches collapse to
    /// the last one pressed, so ⌘2 ⌘3 ⌘4 in quick succession lands on 4 without stopping at 2 and 3.
    private var queued: [Queued] = []
    private enum Queued {
        case switchTo(n: Int, focus: Bool, announce: Bool)
        case action(() -> Void)
    }
    /// Bumped by every switch and by `suspend()`. A timer or callback from an earlier switch
    /// checks it and stands down, so late work never lands on top of newer work.
    private var generation = 0
    /// An app activation arrived mid-switch that BaneySpaces didn't cause: check once afterwards.
    private var followPending = false
    /// The app our own switch is bringing forward. Its activation is ours, not the person's.
    private var expectedFront: pid_t?
    private var settleUntil = Date.distantPast
    /// Window layer-0 numbers and app pids at the last full Accessibility scan.
    /// `unsure` holds apps that scan couldn't read; once one is willing to answer again, scan again.
    /// `offscreen` is the known windows of shown apps that weren't on screen: one joining them
    /// may have been closed (see `closedWindows`), so it's worth a scan.
    private var lastScan: (windows: Set<WindowID>, pids: Set<pid_t>, unsure: Set<pid_t>, offscreen: Set<WindowID>)?
    /// Each app window the window server listed at the last scan, with its app: the next scan asks only the apps whose
    /// windows changed (`ScanPlan`).
    private var lastScanWindows: [WindowID: pid_t]?
    /// Each app's last answer to a scan. An app a scan didn't ask keeps its answer; one with no window now has none.
    private var answers: [pid_t: Windows.Answer] = [:]
    /// Each window's title and minimized state from the last background read, for the dock, the overview and the
    /// launcher, which never ask an app on the main thread.
    private var details: [WindowID: WindowDetails] = [:]
    /// Scans asked for and the code waiting on them (`whenFresh`). One runs at a time, on `scanQueue`.
    private var scans = ScanRequests<() -> Void>()
    /// Numbers each scan as it starts. One that lands after a newer one was applied (`refreshNow`) only runs its waiters.
    private var scanSerial = 0
    private var appliedSerial = 0
    /// The scan running on `scanQueue` now, if any.
    private var scanning: ScanStart?
    /// Accessibility scans run here, never on the main thread (2026-11-21, `ScanPlan`).
    private static let scanQueue = DispatchQueue(label: "com.baney.polycarp.scan", qos: .userInitiated)
    /// Short Accessibility questions (which window has focus, has a new window appeared), asked off the main thread.
    static let axQueue = DispatchQueue(label: "com.baney.polycarp.ax", qos: .userInitiated, attributes: .concurrent)
    /// When titles were last read for the dock, and whether a read runs now (`refreshDetails`).
    private var detailsReadAt = Date.distantPast
    private var readingDetails = false
    /// When hidden apps were last asked for their windows (`refreshHidden`).
    private var hiddenAskedAt = Date.distantPast
    /// What the last scan listed that isn't a standard window, so a skipped refresh can tell a
    /// window the scan missed (see `ScanCheck`) from a sheet or panel; and the on-screen windows
    /// scans couldn't place, each with its next look.
    private var notWindows = Set<WindowID>()
    /// What the last scan listed that waits on you (`WaitingWindow`), and the workspaces the dock
    /// marks for it (`DockAttention`), kept current after each scan and each switch.
    private var asking: [WaitingWindow.Seen] = []
    private(set) var attention: [DockAttention.Mark] = []
    private var unplaced = UnplacedWindows()
    private var heal: DispatchWorkItem?
    /// Windows that ignored every request to leave macOS full screen. Asking again only stalls.
    private var refusedFullScreen = Set<WindowID>()
    private lazy var watcher = FocusWatcher { [weak self] pid in self?.focusMovedWithin(pid) }
    private let hud = SwitchHUD()
    /// Saved workspaces for windows not seen yet this launch. A hidden or busy app may not answer
    /// at startup; when its window shows up later it goes back where it was, and until then its
    /// entry stays in the saved layout instead of being forgotten.
    private var pendingLayout: [WindowID: SavedLayout.Entry] = [:]
    /// Windows dropped as closed (see `closedWindows`), with their workspace and parked frame. A
    /// tab behind another tab looks closed too. When its app lists it again out of sight (the
    /// tab in front of a parked window closed), it goes back to its workspace. One that comes back
    /// in sight was opened or picked here, and joins the workspace you're on; it had a workspace
    /// before, so new-window rules leave it alone (`placedBefore`).
    private var dormant: [WindowID: (pid: pid_t, workspace: Int, frame: CGRect?)] = [:]
    /// Every window that has had a workspace, until the window server says it's gone. One coming
    /// back after Accessibility dropped it is never treated as new: new-window rules could send
    /// it to another workspace and hide it.
    private var placedBefore = Set<WindowID>()
    /// Windows that had a workspace, or will once they answer: placed before, waiting in the saved
    /// layout at launch, or dormant. Each heals on the fast back-off (r5: a launch during an outage
    /// left saved-layout windows on the 60 s one).
    private var knownWindows: Set<WindowID> { placedBefore.union(pendingLayout.keys).union(dormant.keys) }
    /// Workspaces from most to least recently visited, for the ⌘Tab switcher.
    private(set) var recent: [Int] = [1]
    /// When each app last had the focus on each workspace, by process id: the dock's tiles and
    /// ⌘Tab's cards put the one used last first.
    private(set) var activations = AppActivations()
    /// Windows claimed for a workspace: the next window each
    /// process opens goes to that workspace, until the time runs out.
    private var claims: [pid_t: [Claim]] = [:]
    private struct Claim {
        let id = UUID()
        let workspace: Int
        let until: Date
        let title: String?
        /// Polycarp started this process for the claim, so its windows go even if the app brought itself forward.
        var newProcess = false
    }

    /// The agent workspace (see `AgentWorkspace`), or nil when it's off.
    static var agentWorkspace: Int? {
        get { AgentWorkspace.number(setting: UserDefaults.standard.integer(forKey: "agentWorkspace")) }
        set { UserDefaults.standard.set(newValue ?? 0, forKey: "agentWorkspace") }
    }
    private var screensWork: DispatchWorkItem?
    var onChange: (() -> Void)?

    static let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Polycarp")
    static let framesURL = folder.appendingPathComponent("frames.json")
    static let stateURL = folder.appendingPathComponent("state.json")
    static let layoutURL = folder.appendingPathComponent("layout.json")
    private static let writer = DispatchQueue(label: "com.baney.polycarp.persist", qos: .utility)

    init() {
        saved = SavedFrames.load(from: Spaces.framesURL)
    }

    /// Takes stock of every window. Windows a crash left hidden go back to their saved frame;
    /// any other window that is mostly off screen (another window manager's leftovers, an
    /// unplugged display) is centered.
    func start() {
        active = true
        for pid in saved.hiddenApps { NSRunningApplication(processIdentifier: pid)?.unhide() }
        refreshNow()
        let screens = Windows.screens()
        var unreached: [WindowID: CGRect] = [:]
        let server = Windows.serverWindows()
        for w in windows.values {
            // Only stranded windows move. Window numbers are reused after a logout, so a saved
            // frame must never move a window that is already in plain sight.
            guard let f = w.frame else {
                // A busy app keeps its parked window's record, so a later switch brings it back.
                // Only a window really sitting at the hiding spot: numbers are reused after a restart.
                if let s = saved.frames[w.id], let b = server[w.id]?.bounds, Geometry.isStranded(b, screens: screens) { unreached[w.id] = s }
                continue
            }
            guard !w.isMinimized, Geometry.isStranded(f, screens: screens) else { continue }
            w.setFrame(Geometry.restoreFrame(saved: saved.frames[w.id], size: f.size, screens: screens))
        }
        saved = SavedFrames()
        saved.frames = unreached
        noteDisplays()
        // Put every window back on the workspace it had before this launch (an update, a crash,
        // a restart), and return to the workspace you were on, on each display.
        if let layout = SavedLayout.load(from: Spaces.layoutURL) {
            model.restore(current: layout.current, home: layout.homes(livePids: windows.mapValues(\.pid)),
                          lastFocused: layout.lastFocused, displays: layout.displays ?? [:])
            // Window numbers are reused after a restart, so a waiting window must still belong
            // to the same app; otherwise its entry would unhide a stranger.
            let server = Windows.serverWindows()
            pendingLayout = Dictionary(uniqueKeysWithValues: layout.entries
                .filter { model.workspace(of: $0.window) == nil && server[$0.window]?.pid == $0.pid }.map { ($0.window, $0) })
        }
        persist()
        switchTo(model.current, takeFocus: false, announce: false)
        flattenFullScreen()
    }

    /// Puts every window back and stops managing them, for when macOS withdraws permission.
    /// `start()` picks up again.
    func suspend() {
        guard active else { return }
        restoreAll()
        active = false
        switching = false
        queued.removeAll()
        followPending = false
        generation += 1
        scans.reset()
        scanning = nil
        watcher.removeAll()
        emptyHolder.orderOut(nil)
    }

    /// Brings the window list up to date without waiting on any app. When the window server's list of app windows is
    /// what it was at the last scan and no app launched or quit, nothing needs asking. Otherwise windows the server
    /// says are gone leave now, and a background scan asks the apps whose windows changed (`ScanPlan`); its answer
    /// lands a moment later and calls `onChange`. Code that must act on the new list uses `whenFresh`.
    /// Until 2026-11-21 this asked every app on the main thread: a scan nearly always paid one app's 0.25 s timeout
    /// (p50 255 ms), and the dock, the launcher and each key press waited behind it.
    func refresh(full: Bool = false) { refresh(full: full, asking: [], then: nil) }

    /// Runs `body` on the main thread once the window list is at least as new as this call: at once when nothing
    /// changed, else when a background scan that started after this call lands. Mid-switch it waits for the switch.
    /// `asking` are apps to ask even if their windows look unchanged (a hidden app's window closing changes nothing
    /// the window server shows).
    func whenFresh(full: Bool = false, asking: Set<pid_t> = [], _ body: @escaping () -> Void) {
        if switching { return enqueue { [weak self] in self?.whenFresh(full: full, asking: asking, body) } }
        // A switch that started while the scan ran: wait for it, then look again, since windows moved meanwhile.
        refresh(full: full, asking: asking, then: { [weak self] in
            guard let self else { return }
            if self.switching { self.enqueue { [weak self] in self?.whenFresh(full: full, asking: asking, body) } } else { body() }
        })
    }

    private func refresh(full: Bool, asking: Set<pid_t>, then body: (() -> Void)?) {
        let pids = RunningApps.regular
        let snap = Windows.snapshot(apps: pids)
        clock.mark(.snap)
        let offKnown = offscreenKnown(snap.offscreen)
        let stray = ScanCheck.unplaced(onScreen: snap.onScreen, placed: Set(model.home.keys),
                                       notWindows: notWindows, unsure: lastScan?.unsure ?? [])
        let now = Date()
        if !full, asking.isEmpty, let last = lastScan, last.windows == snap.appWindows, last.pids == pids,
           last.offscreen == offKnown, !unplaced.due(stray, now: now) {
            prune(alive: snap.alive)
            unplaced.keep(stray)
            scheduleHeal()
            clock.scan = "skip"
            updateAttention()
            body?()
            return
        }
        clock.scan = lastScan.map { full ? "full" : last($0, snap.appWindows, pids, offKnown, asked: !asking.isEmpty) } ?? "first"
        // A window the window server no longer has is gone: no app needs asking for that.
        prune(alive: snap.alive)
        let due = Set(stray.filter { unplaced.due([$0], now: now) }.compactMap { snap.onScreen[$0] })
        // The scan running now started from this same window list: its answer is as new as this call needs.
        if let body, !full, asking.isEmpty, let running = scanning, running.snap.appWindows == snap.appWindows,
           running.pids == pids, Set(running.snap.offscreen.keys) == Set(snap.offscreen.keys), scans.join(body) {
            if !due.isEmpty { scans.request(full: false, pids: due) }
            return
        }
        scans.request(full: full, pids: asking.union(due), waiter: body)
        startScan()
    }

    /// What a scan starts from, read on the main thread from the window server (never an app): its list of windows,
    /// the regular apps, and the apps to ask.
    private struct ScanStart {
        let serial: Int
        let snap: (alive: Set<WindowID>, appWindows: Set<WindowID>, owners: Set<pid_t>, offscreen: [WindowID: pid_t], onScreen: [WindowID: pid_t])
        let pids: Set<pid_t>
        let owners: Set<pid_t>
        let ask: Set<pid_t>
    }

    private func scanStart(full: Bool, extra: Set<pid_t>) -> ScanStart {
        RunningApps.invalidate()
        let pidsNow = RunningApps.regular
        Windows.keepBench(pidsNow)
        let snap = Windows.snapshot(apps: pidsNow)
        // Only apps that own a window are asked. A running app with no windows is often frozen by
        // macOS and never answers, which would cost a full timeout on every scan.
        let owners = pidsNow.intersection(snap.owners)
        let complete = Set(answers.filter { $0.value.answered && !$0.value.partial }.keys)
        let ask = ScanPlan.appsToAsk(full: full, owners: owners, now: snap.offscreen.merging(snap.onScreen) { a, _ in a },
                                     before: lastScanWindows, offscreenNow: offscreenKnown(snap.offscreen),
                                     offscreenBefore: lastScan?.offscreen ?? [], complete: complete, extra: extra)
        scanSerial += 1
        return ScanStart(serial: scanSerial, snap: snap, pids: pidsNow, owners: owners, ask: ask)
    }

    /// Starts the next scan asked for, on `scanQueue`, unless one runs. Mid-switch only one the switch waits on starts:
    /// windows are on the move, so any other answer would be thrown away.
    private func startScan() {
        guard active, let (ticket, ask) = scans.start(onlyIfWaitedOn: switching) else { return }
        let plan = scanStart(full: ask.full, extra: ask.pids)
        scanning = plan
        let kind = clock.scan, mid = switching
        Spaces.scanQueue.async { [weak self] in
            let started = ProcessInfo.processInfo.systemUptime
            let fresh = Windows.all(asking: plan.ask)
            let missed = plan.ask.filter { fresh[$0]?.answered != true }.map { NSRunningApplication(processIdentifier: $0)?.localizedName ?? "pid \($0)" }
            if let line = ScanCheck.slowScanLine(seconds: ProcessInfo.processInfo.systemUptime - started, kind: kind,
                                                  switching: mid, missed: missed, onMain: false) { Trace.log(line) }
            DispatchQueue.main.async { self?.scanLanded(ticket: ticket, plan: plan, fresh: fresh) }
        }
    }

    /// A background scan's answer, on the main thread: applied, then the code that waited on it runs.
    private func scanLanded(ticket: Int, plan: ScanStart, fresh: [pid_t: Windows.Answer]) {
        let waiters = scans.landed(ticket)
        if scanning?.serial == plan.serial { scanning = nil }
        guard active else { return }
        // Mid-switch, windows are on the move and what this scan saw of them is already old: its apps are asked again
        // once the switch is done (`finish`). A scan the switch itself waits on started before anything moved.
        // Its waiters (`whenFresh`) see the switch and wait for it.
        if switching, !holding {
            scans.request(full: false, pids: plan.ask)
            for run in waiters { run() }
            return startScan()
        }
        let before = model, titles = details
        if plan.serial > appliedSerial { applyScan(plan, fresh: fresh) }
        for run in waiters { run() }
        startScan()
        // A window that came or went, or a title that changed, shows in the dock and the menu bar.
        if !switching, model != before || details != titles {
            persist()
            onChange?()
        }
    }

    /// Launch, quit and lost permission only: every app asked, with the main thread waiting. `start` places every
    /// window before the first switch, and `restoreAll` must reach every parked window before Polycarp lets go.
    private func refreshNow() {
        let plan = scanStart(full: true, extra: [])
        let started = ProcessInfo.processInfo.systemUptime
        let fresh = Windows.all(asking: plan.ask)
        let missed = plan.ask.filter { fresh[$0]?.answered != true }.map { NSRunningApplication(processIdentifier: $0)?.localizedName ?? "pid \($0)" }
        if let line = ScanCheck.slowScanLine(seconds: ProcessInfo.processInfo.systemUptime - started, kind: lastScan == nil ? "first" : "full",
                                              switching: switching, missed: missed, onMain: true) { Trace.log(line) }
        applyScan(plan, fresh: fresh)
    }

    /// Titles change with every tab and never show in the window server's list, so the dock and the overview read
    /// them again in the background when they open; a change reloads them. At most one read runs, and not more often
    /// than every half second.
    /// `pid` reads only that app's windows, unthrottled: the app in front, whose tab or window just changed.
    func refreshDetails(of pid: pid_t? = nil) {
        guard active else { return }
        if pid == nil {
            guard !readingDetails, Date().timeIntervalSince(detailsReadAt) > 0.5 else { return }
            readingDetails = true
            detailsReadAt = Date()
        }
        let list = windows.values.filter { pid == nil || $0.pid == pid }
        Spaces.axQueue.async { [weak self] in
            let read = Windows.details(of: list)
            DispatchQueue.main.async {
                guard let self else { return }
                if pid == nil { self.readingDetails = false }
                let merged = self.details.merging(read) { _, new in new }.filter { self.windows[$0.key] != nil }
                guard merged != self.details else { return }
                self.details = merged
                if !self.switching { self.onChange?() }
            }
        }
    }

    /// A hidden app's window closing changes nothing the window server shows, so no scan notices it: the dock asks
    /// hidden apps again, in the background, when it opens. At most every two seconds.
    func refreshHidden() {
        guard active, !switching, Date().timeIntervalSince(hiddenAskedAt) > 2 else { return }
        let hidden = RunningApps.hidden(among: Set(windows.values.map(\.pid)))
        guard !hidden.isEmpty else { return }
        hiddenAskedAt = Date()
        refresh(full: false, asking: hidden, then: nil)
    }

    /// One scan's answer, applied to the model. Main thread; it asks no app (frames come from the window server, titles
    /// and minimized state from the scan).
    private func applyScan(_ plan: ScanStart, fresh: [pid_t: Windows.Answer]) {
        appliedSerial = plan.serial
        let snap = plan.snap, pidsNow = plan.pids
        let firstScan = lastScan == nil
        // Each app asked has its new answer; the rest keep their last one. An app with no window now has none.
        for (pid, a) in fresh { answers[pid] = a }
        answers = answers.filter { plan.owners.contains($0.key) }
        for a in fresh.values { details.merge(a.details) { _, new in new } }
        let list = answers.values.flatMap(\.windows)
        let unsure = plan.owners.filter { answers[$0]?.answered != true }
        let listed = Set(answers.values.flatMap(\.listed))
        let server = Windows.serverWindows()
        func bounds(_ id: WindowID) -> CGRect? { server[id]?.bounds }
        func minimized(_ id: WindowID) -> Bool { details[id]?.minimized ?? false }
        notWindows = Set(answers.values.flatMap(\.notWindows))
        asking = answers.values.flatMap(\.asking)
        // A window the app closed but kept isn't one any more, though the window server says it's alive. Only an app
        // asked just now, that answered in full, can say a window it didn't list is closed.
        let answered = Set(fresh.filter { $0.value.answered && !$0.value.partial }.keys)
        let closed = closedWindows(listed: listed, answered: answered, offscreen: snap.offscreen)
        for id in closed {
            guard let ws = model.workspace(of: id), let pid = snap.offscreen[id] else { continue }
            dormant[id] = (pid, ws, saved.frames[id])
        }
        let alive = snap.alive.subtracting(closed)
        dormant = dormant.filter { snap.alive.contains($0.key) }
        // Accessibility lists only the windows on the macOS desktop being shown. A window it
        // missed keeps the handle from an earlier listing; that handle still moves the window.
        var next = windows.filter { alive.contains($0.key) }
        for w in list { next[w.id] = w }
        windows = next
        placedBefore.formIntersection(snap.alive)
        let displays = Windows.displays()
        // A display came or went before screensChanged's settled work ran: the model hears of it
        // now, so a window macOS moved off an unplugged display isn't taken for one you dragged.
        if !model.order.isEmpty, displays.map(\.key) != model.order { noteDisplays() }
        let frames = Dictionary(displays.map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
        var appeared: [WindowID: DisplayKey] = [:]
        if model.shown.count > 1 {
            for w in list where model.workspace(of: w.id) == nil {
                if let f = bounds(w.id), let d = Geometry.display(of: f, in: frames) { appeared[w.id] = d }
            }
        }
        let added = model.sync(seen: list.map(\.id), alive: alive, on: appeared)
        if model.shown.count > 1, !switching || holding {
            noteMovedAcrossDisplays(list, frames: frames, act: Date() > displaysSettleUntil, bounds: bounds, minimized: minimized)
        }
        prune(alive: alive)
        // A scan that skipped a busy app can't vouch for that app's windows. It's remembered, and
        // the next refresh scans again as soon as that app is willing to answer.
        lastScan = (snap.appWindows, pidsNow, unsure, offscreenKnown(snap.offscreen))
        lastScanWindows = snap.offscreen.merging(snap.onScreen) { a, _ in a }
        details = details.filter { windows[$0.key] != nil }
        watcher.sync(snap.owners)
        if !unsure.isEmpty || watcher.missing { scheduleRetry() }
        let screens = Windows.screens()
        // A window from the saved layout that only now answered goes back to its workspace.
        var returned = false
        var fromLayout = Set<WindowID>()
        for id in added {
            if let d = dormant.removeValue(forKey: id), windows[id]?.pid == d.pid,
               snap.offscreen[id] != nil || bounds(id).map({ Geometry.isStranded($0, screens: screens) }) == true {
                // A tab came back because the tab in front of it just closed: that one knows where
                // the window lives now (it may have been moved since) and holds its parked frame.
                let sibling = closed.compactMap { dormant[$0] }.first { $0.pid == d.pid }
                let home = sibling?.workspace ?? d.workspace
                model.assign(id, to: home, focus: false)
                if !model.isShown(home), let frame = sibling?.frame ?? d.frame { saved.frames[id] = frame }
                fromLayout.insert(id)
                returned = returned || !model.isShown(home)
                continue
            }
            guard let entry = pendingLayout.removeValue(forKey: id), windows[id]?.pid == entry.pid else { continue }
            model.assign(id, to: entry.workspace, focus: false)
            fromLayout.insert(id)
            returned = returned || !model.isShown(entry.workspace)
        }
        // At launch every window is new; the saved layout decides where they go. A window that sat
        // unplaced in plain sight while Accessibility was out isn't new either.
        let now = Date()
        if !firstScan {
            let fresh = added.filter { !fromLayout.contains($0) && unplaced.isNew($0, known: knownWindows, now: now) }
            returned = placeClaimed(fresh) || returned
            adoptBackgroundWindows(fresh)
        }
        if returned {
            let again: () -> Void = { [weak self] in
                guard let self, self.active, !self.switching else { return }
                self.switchTo(self.model.current, takeFocus: false, announce: false)
            }
            // Mid-switch (its own scan) the window goes out of sight once the switch is done.
            if switching { enqueue(again) } else { DispatchQueue.main.async(execute: again) }
        }
        // An app that autosaves its window position can reopen a window at the hiding spot.
        // One that belongs on another workspace isn't moved into sight here: it's recorded as
        // parked, to come back to the middle of the screen when you go there.
        for id in added {
            guard let w = windows[id], !minimized(id), let f = bounds(id), Geometry.isStranded(f, screens: screens) else { continue }
            let to = Geometry.restoreFrame(saved: nil, size: f.size, screens: screens)
            if model.workspace(of: id).map(model.isShown) == true { w.setFrame(to) } else if saved.frames[id] == nil { saved.frames[id] = to }
        }
        // A window recorded as parked on the workspace being shown, yet back in plain sight
        // (an app that applied our move late), is simply shown. Its old record would otherwise
        // send it back to a stale spot later.
        for id in saved.frames.keys where model.workspace(of: id).map(model.isShown) == true {
            if windows[id] != nil, let f = bounds(id), !Geometry.isStranded(f, screens: screens) { saved.frames[id] = nil }
        }
        unplaced.scanned(unplaced: ScanCheck.unplaced(onScreen: snap.onScreen, placed: Set(model.home.keys),
                                                      notWindows: notWindows, unsure: unsure),
                         known: knownWindows, now: now)
        placedBefore.formUnion(model.home.keys)
        scheduleHeal()
        updateAttention()
    }

    /// Works out which workspaces have a window waiting on you out of sight, and says in
    /// `trace.log` when a mark sets or clears. Nothing moves and you aren't taken anywhere.
    private func updateAttention() {
        let live = asking.filter { snapAlive(pid: $0.pid) }
        var parents: [Int32: Set<Int>] = [:], names: [Int32: String] = [:]
        for (id, ws) in model.home {
            guard let w = windows[id] else { continue }
            parents[w.pid, default: []].insert(ws)
            names[w.pid] = w.appName
        }
        let marks = DockAttention.marks(live, names: names, parents: parents,
                                        shown: Set(Workspaces.range.filter(model.isShown)), recent: recent)
        guard marks != attention else { return }
        for line in DockAttention.traceLines(from: attention, to: marks) { Trace.log(line) }
        attention = marks
        onChange?()
    }

    private func snapAlive(pid: Int32) -> Bool { NSRunningApplication(processIdentifier: pid).map { !$0.isTerminated } ?? false }

    /// A click on a marked tile: that workspace, with the waiting window in front of its app.
    func focusWaiting(_ mark: DockAttention.Mark) {
        guard active else { return }
        if switching { return enqueue { [weak self] in self?.focusWaiting(mark) } }
        Trace.log("dock attention picked: \(mark.app) on workspace \(mark.workspace)")
        if !model.isShown(mark.workspace) { switchTo(mark.workspace, announce: false) }
        let raise = { [weak self] in
            guard let self, self.active else { return }
            let ax = AXUIElementCreateApplication(mark.pid)
            AXUIElementSetMessagingTimeout(ax, 0.25)
            let list: [AXUIElement] = ax.value(kAXWindowsAttribute) ?? []
            if let el = list.first(where: { $0.windowID == mark.window }) { AXUIElementPerformAction(el, kAXRaiseAction as CFString) }
            NSRunningApplication(processIdentifier: mark.pid)?.activate()
        }
        if switching { enqueue(raise) } else { raise() }
    }

    /// A window that opens in a parked app (see `ParkedApps`) while that app stays in the
    /// background was opened by automation, not by you: it joins the app's other windows instead
    /// of landing on the workspace you're looking at. Decided a moment later, so a link you
    /// click (which brings the app forward) still opens the window where you are.
    private func adoptBackgroundWindows(_ added: [WindowID]) {
        let ids = ParkedApps.bundleIDs
        let agent = Self.agentWorkspace
        let candidates = added.filter { id in
            guard let w = windows[id] else { return false }
            if NSRunningApplication(processIdentifier: w.pid)?.bundleIdentifier.map(ids.contains) == true { return true }
            // An app that lives on the agent workspace, too.
            return agent != nil && windows.values.contains { $0.pid == w.pid && $0.id != id && model.workspace(of: $0.id) == agent }
        }
        guard !candidates.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.active else { return }
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            var moved = false
            for id in candidates {
                // A window of the app you're in is yours (you may have just pressed New Window in it).
                guard let w = self.windows[id], let here = self.model.workspace(of: id), self.model.isShown(here), w.pid != front else { continue }
                let others = self.windows.values.filter { $0.pid == w.pid && $0.id != id }.compactMap { self.model.workspace(of: $0.id) }
                if let to = AgentWorkspace.homeForNewWindow(appFront: false, appWorkspaces: Set(others), claimed: nil,
                                                            current: here, agent: agent) {
                    Trace.log("agent window \(id) of \(w.appName) joins workspace \(to)")
                    self.model.assign(id, to: to, focus: false)
                    moved = true
                    continue
                }
                guard !others.contains(here),
                      let home = self.recent.first(where: others.contains) ?? others.min() else { continue }
                self.model.assign(id, to: home, focus: false)
                moved = true
            }
            if moved { self.reapply() }
        }
    }

    /// The next window `pid` opens goes to workspace `n` instead of the one you're on, for a
    /// process Polycarp is about to start there. Unclaimed after `within` seconds, the claim lapses.
    /// `newProcess`: Polycarp just started this process, so every window it already has goes
    /// too (it may have opened one before its pid reached us). Never for an app you were
    /// already using: that would take your windows.
    /// `title`: only a window whose title contains it (the file an agent opened), so a window
    /// you open in the same app meanwhile stays yours.
    func claimNextWindow(of pid: pid_t, for n: Int, within: TimeInterval = 8, newProcess: Bool = false, title: String? = nil) {
        // Added now, so `cancelClaim` right after always finds it.
        let claim = Claim(workspace: n, until: Date().addingTimeInterval(within), title: title, newProcess: newProcess)
        claims[pid, default: []].append(claim)
        look(for: claim, of: pid, within: within, newProcess: newProcess)
    }

    /// Finds a claimed window that's already open, or opens with its title a moment late.
    private func look(for claim: Claim, of pid: pid_t, within: TimeInterval, newProcess: Bool) {
        // Mid-switch the window list is in flux: look once the switch is done.
        if switching { return enqueue { [weak self] in self?.look(for: claim, of: pid, within: within, newProcess: newProcess) } }
        guard has(claim, of: pid) else { return }
        let n = claim.workspace, title = claim.title
        // A window with the file's name, not in front, is the agent's. It may show its name only a
        // moment after it opens (Terminal titles a window once its script starts): keep looking
        // until then. Only a window that wasn't there before the claim, and only one: your own
        // window of the same file, or one whose title merely contains the name, stays yours.
        if let title, !title.isEmpty {
            // An app the agent just started has only the agent's windows (the claim comes once it's up).
            let launched = NSRunningApplication(processIdentifier: pid)?.launchDate.map { -$0.timeIntervalSinceNow < 10 } ?? false
            let before = newProcess || launched ? [] : Set(windows.values.filter { $0.pid == pid }.map(\.id))
            var found: WindowID?
            waitUntil(timeout: within, interval: 0.15, { [weak self] in
                guard let self, self.has(claim, of: pid) else { return true }
                // Mid-switch the window list is in flux, and a scan would hold up the switch.
                if self.switching { return false }
                self.refresh()
                let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
                found = self.windows.values.first {
                    $0.pid == pid && $0.pid != front && !before.contains($0.id)
                        && self.model.workspace(of: $0.id) != n && $0.title.localizedCaseInsensitiveContains(title)
                }?.id
                return found != nil
            }) { [weak self] in
                guard let self, let id = found, self.has(claim, of: pid) else { return }
                self.drop(claim, of: pid)
                Trace.log("claimed window \(id) for workspace \(n) by its title")
                self.move([id], to: n)
            }
        }
        guard newProcess else { return }
        refresh()
        let early = windows.values.filter { $0.pid == pid && model.workspace(of: $0.id) != n }.map(\.id)
        guard !early.isEmpty else { return }
        drop(claim, of: pid)
        Trace.log("claimed \(early.count) window(s) \(early.map(String.init).joined(separator: ",")) of pid \(pid) for workspace \(n): open before the claim")
        move(early, to: n)
    }

    /// A request that came to nothing: its claim goes, so it can't take your next window.
    func cancelClaim(of pid: pid_t) {
        guard let last = claims[pid]?.last(where: { $0.title == nil }) else { return }
        drop(last, of: pid)
    }

    private func has(_ c: Claim, of pid: pid_t) -> Bool { claims[pid]?.contains { $0.id == c.id } ?? false }

    private func drop(_ c: Claim, of pid: pid_t) {
        claims[pid]?.removeAll { $0.id == c.id }
        if claims[pid]?.isEmpty == true { claims[pid] = nil }
    }

    /// Claimed windows go straight to their workspace, before the next switch would show them.
    /// A window of the app you're in is yours (⌘N), unless Polycarp started that process for the claim. True when one went
    /// somewhere other than here.
    private func placeClaimed(_ added: [WindowID]) -> Bool {
        let now = Date()
        claims = claims.compactMapValues { l in
            let live = l.filter { $0.until > now }
            return live.isEmpty ? nil : live
        }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var away = false
        for id in added {
            guard let w = windows[id],
                  // A brand-new window may not have its title yet.
                  let c = claims[w.pid]?.first(where: { c in
                      (c.newProcess || w.pid != front)
                          && (c.title.map { t in title(of: id).isEmpty || title(of: id).localizedCaseInsensitiveContains(t) } ?? true)
                  }) else { continue }
            // A modal window (a standard window that blocks its app) waits on you: it stays with its
            // app's windows, never sent off alone by a claim (`WaitingWindow.claimTakes`). A process
            // the agent started is the agent's whole: its modal goes with the claim, not onto your
            // workspace (`WaitingWindow.claimKeeps`).
            // Read by the scan: a standard window it found modal is among `asking`.
            let modal = asking.contains { $0.id == id && $0.modal == true }
            guard WaitingWindow.claimKeeps(agentStartedProcess: c.newProcess, subrole: kAXStandardWindowSubrole as String, modal: modal) else {
                let parents = Set(windows.values.filter { $0.pid == w.pid && $0.id != id }.compactMap { model.workspace(of: $0.id) })
                switch WaitingWindow.place(asks: true, parents: parents, shown: Set(Workspaces.range.filter(model.isShown)), recent: recent) {
                case .withParent(let n), .needsAttention(let n):
                    model.assign(id, to: n, focus: false)
                    away = away || !model.isShown(n)
                    Trace.log("claim skipped window \(id) of \(w.appName): it waits on you, so it joins the app's workspace \(n)")
                case .ordinary:
                    Trace.log("claim skipped window \(id) of \(w.appName): it waits on you")
                }
                continue
            }
            drop(c, of: w.pid)
            model.assign(id, to: c.workspace, focus: false)
            Trace.log("claimed window \(id) of \(windows[id]?.appName ?? "?") for workspace \(c.workspace)")
            away = away || !model.isShown(c.workspace)
        }
        return away
    }

    /// Whether workspace `n` holds any window: `agent on N` refuses a workspace someone is using.
    func isOccupied(_ n: Int) -> Bool { !model.windows(on: n).isEmpty }

    /// Windows on the agent workspace, for the agent workspace API's `windows` (docs/agent-workspace-api.md).
    func agentWindows() -> [AgentAPI.Window] {
        guard let n = Self.agentWorkspace else { return [] }
        // A window of a process that has exited is gone, though the model keeps it until the next scan (#311).
        let rows = model.windows(on: n).compactMap { id in windows[id].map { AgentAPI.Window(id: id, pid: $0.pid, app: $0.appName, title: $0.title) } }
        return AgentStatusRows.live(rows, pid: { $0.pid })
    }

    /// Window `id` as the API's `move` sees it, or nil when Polycarp doesn't place it.
    func moveCandidate(_ id: WindowID) -> AgentAPI.Candidate? {
        guard let w = windows[id], let n = model.workspace(of: id) else { return nil }
        return AgentAPI.Candidate(workspace: n, pid: w.pid, started: Self.processStart(w.pid))
    }

    /// When a process started: its launch date, or the kernel's start time for one launchd started (no launch date).
    static func processStart(_ pid: pid_t) -> Date? {
        if let d = NSRunningApplication(processIdentifier: pid)?.launchDate { return d }
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let t = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000)
    }

    /// Why a full scan ran, for timing.log.
    private func last(_ l: (windows: Set<WindowID>, pids: Set<pid_t>, unsure: Set<pid_t>, offscreen: Set<WindowID>), _ w: Set<WindowID>, _ p: Set<pid_t>, _ off: Set<WindowID>, asked: Bool) -> String {
        ScanPlan.reason(pidsChanged: l.pids != p, added: w.subtracting(l.windows).count, removed: l.windows.subtracting(w).count,
                        offscreenChanged: l.offscreen != off, asked: asked)
    }

    /// Known windows (and saved-layout ones still waiting) that their app closed but keeps:
    /// Ghostty keeps every window it closes, and a tab behind another tab is one too. The window
    /// server still counts them, so without this they stayed on their workspace for good, and
    /// ⌘Tab, the docks and the launcher sent you there for a window that never came forward.
    /// A window is closed only when its app answered and didn't list it, it isn't on screen, and
    /// it's on no macOS desktop or on one being shown. A minimized window, and a hidden app's,
    /// is still listed; one on another desktop, or in full screen, is on a desktop not shown.
    private func closedWindows(listed: Set<WindowID>, answered: Set<pid_t>, offscreen: [WindowID: pid_t]) -> Set<WindowID> {
        Set(Set(model.home.keys).union(pendingLayout.keys).filter { id in
            guard !listed.contains(id), let pid = offscreen[id], answered.contains(pid) else { return false }
            return Windows.onNoOtherDesktop(id)
        })
    }

    /// The known windows that are off screen while their app is shown, the ones `closedWindows`
    /// looks at. A hidden app's windows don't count: they leave the screen on every switch.
    private func offscreenKnown(_ offscreen: [WindowID: pid_t]) -> Set<WindowID> {
        var shown: [pid_t: Bool] = [:]
        return Set(offscreen.filter { id, pid in
            guard model.workspace(of: id) != nil || pendingLayout[id] != nil else { return false }
            if shown[pid] == nil { shown[pid] = NSRunningApplication(processIdentifier: pid)?.isHidden == false }
            return shown[pid]!
        }.keys)
    }

    /// Re-reads apps that a scan couldn't, once they're willing to answer again, in the
    /// background between switches, so the wait never lands on a key press.
    private var retry: (work: DispatchWorkItem, due: Date)?
    private func scheduleRetry() {
        // When the first app that didn't answer may be asked again: within a second for one still starting. A timer
        // already set for later (a hung app's) gives way to the sooner one.
        let delay = Windows.retryDelay()
        let due = Date().addingTimeInterval(delay)
        if let r = retry, r.due <= due.addingTimeInterval(0.05) { return }
        retry?.work.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.retry = nil
            guard self.active else { return }
            self.watcher.retry()
            guard let unsure = self.lastScan?.unsure, unsure.contains(where: Windows.isResponsive) else {
                if self.lastScan?.unsure.isEmpty == false || self.watcher.missing { self.scheduleRetry() }
                return
            }
            if self.switching { return self.scheduleRetry() }
            // Only the apps that didn't answer are asked; the scan runs in the background and saves what it changes.
            self.refresh(full: false, asking: unsure.filter(Windows.isResponsive), then: nil)
        }
        retry = (work, due)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Looks again at unplaced windows when the first is due, without waiting for a switch or the
    /// dock to ask. Each scan moves the time, so the timer follows the latest one.
    private func scheduleHeal() {
        heal?.cancel()
        heal = nil
        guard let due = unplaced.nextDue else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active else { return }
            if self.switching { return self.scheduleHeal() }
            // The scan lands in the background, saves and reloads the dock if anything moved, and sets the next look.
            self.refresh()
            self.scheduleHeal()
        }
        heal = work
        // Never sooner than a second: a look that's overdue yet not taken mustn't spin the timer.
        DispatchQueue.main.asyncAfter(deadline: .now() + max(1, due.timeIntervalSinceNow + 0.1), execute: work)
    }

    private func prune(alive: Set<WindowID>) {
        // The app in front closing its window here (⌘W) hands focus to another app.
        if windows.contains(where: { !alive.contains($0.key) && $0.value.pid == frontPid && model.workspace(of: $0.key).map(model.isShown) == true }) {
            leftAt = Date()
        }
        windows = windows.filter { alive.contains($0.key) }
        model.sync(seen: [], alive: alive)
        saved.frames = saved.frames.filter { alive.contains($0.key) }
        saved.hiddenApps = saved.hiddenApps.filter { NSRunningApplication(processIdentifier: $0).map { !$0.isTerminated } ?? false }
        refusedFullScreen.formIntersection(alive)
        pendingLayout = pendingLayout.filter { alive.contains($0.key) }
    }

    /// `takeFocus: false` rearranges windows without touching focus, for moves made from the
    /// viewer while it holds the keyboard. `announce` flashes the workspace HUD, only when
    /// `showSwitchHUD` is on (off by default, `SwitchHUDPolicy`).
    func switchTo(_ n: Int, takeFocus moveFocus: Bool = true, announce: Bool = true) {
        guard active, Workspaces.range.contains(n) else { return }
        if switching {
            // Presses keep their order; only back-to-back switches collapse to the last one.
            if case .switchTo = queued.last { queued.removeLast() }
            queued.append(.switchTo(n: n, focus: moveFocus, announce: announce))
            return
        }
        // The HUD is drawn after the switch is under way, never in front of it, from the windows
        // the switch's own scan found.
        if SwitchHUDPolicy.shows(announce: announce, takeFocus: moveFocus, stored: SwitchHUD.stored) {
            DispatchQueue.main.async { [self] in
                var seen = Set<pid_t>()
                let icons = model.windows(on: n).compactMap { windows[$0]?.pid }.filter { seen.insert($0).inserted }
                    .prefix(5).compactMap { NSRunningApplication(processIdentifier: $0)?.icon }
                hud.show(n, occupied: Set(Workspaces.range.filter { !model.windows(on: $0).isEmpty }), icons: Array(icons),
                         display: model.shown.count > 1 ? model.display(showing: n) : nil)
            }
        }
        generation += 1
        clock = SwitchClock(target: n)
        // From here every other request queues behind this switch. It plans from the last scan when the window server
        // says nothing changed since; otherwise from a background scan of the apps whose windows changed, waited for
        // without holding the main thread (`whenFresh`).
        switching = true
        holding = true
        let gen = generation
        refresh(full: false, asking: [], then: { [self] in
            guard gen == generation, active else { return }
            holding = false
            plan(n, moveFocus: moveFocus)
        })
    }

    /// The switch, once the window list is fresh.
    private func plan(_ n: Int, moveFocus: Bool) {
        clock.mark(.scanned)
        // The window in front, from the window server's stacking order: asking its app could wait on it.
        let focused = Windows.front(in: windows) { [self] id in saved.frames[id] == nil }
        if let f = focused, model.workspace(of: f.id) == model.current { noteFocus(f.id) }
        let leaving = model.current
        clock.from = leaving
        let plan = model.switchTo(n)
        recent.removeAll { $0 == n }
        recent.insert(n, at: 0)
        // The menu bar number changes the moment the plan is made, not when the work is done.
        onChange?()

        // Full screen lives on a macOS desktop of its own, which BaneySpaces can't hide. Any window
        // left behind in full screen (a video, a presentation), focused or not, leaves full screen
        // first. One that refused before comes along instead of staying stranded on its desktop.
        let full = fullScreen(among: plan.hide)
        // Rearranging the workspace you're on (a move from the overview) is on purpose: no carrying.
        let carried = n == leaving ? [] : full.filter { refusedFullScreen.contains($0.id) }
        for w in carried { model.assign(w.id, to: n, focus: false) }
        let asking = full.filter { !refusedFullScreen.contains($0.id) }
        guard !asking.isEmpty else {
            return apply(carried.isEmpty ? plan : model.switchTo(n), moveFocus: moveFocus)
        }
        let gen = generation
        let known = Set(model.home.keys).union(pendingLayout.keys)
        // macOS puts each window back where it was before full screen.
        leaveFullScreen(asking, fill: false) { [self] refused in
            guard gen == generation, active else { return }
            clock.mark(.fullscreen)
            for w in refused { model.assign(w.id, to: n, focus: false) }
            // Back on the regular desktop, Accessibility can list windows it couldn't see from the
            // full-screen one. Those opened while you were on the workspace you just left. Every app is asked, in the
            // background; nothing moves until it lands.
            holding = true
            refresh(full: true, asking: [], then: { [self] in
                holding = false
                guard gen == generation, active else { return }
                for id in Set(model.home.keys).subtracting(known) { model.assign(id, to: leaving, focus: false) }
                apply(model.switchTo(n), moveFocus: moveFocus)
            })
        }
    }

    /// The windows among `ids` in macOS full screen. Only windows exactly the size of a screen are
    /// asked, so a switch with no full screen costs one window-server read. A window seen out
    /// of full screen is asked again next time, even if it once refused to leave.
    private func fullScreen(among ids: [WindowID]) -> [Window] {
        let sizes = Windows.fullScreenFrames()
        let server = Windows.serverWindows()
        func screenSized(_ b: CGRect) -> Bool {
            sizes.contains { abs($0.minX - b.minX) < 1 && abs($0.minY - b.minY) < 1 && abs($0.width - b.width) < 1 && abs($0.height - b.height) < 1 }
        }
        var found: [Window] = []
        for id in ids {
            // A hidden app's windows aren't on screen, and a hidden app can be slow to answer.
            guard let w = windows[id], NSRunningApplication(processIdentifier: w.pid)?.isHidden != true else { continue }
            guard let b = server[id]?.bounds, screenSized(b), w.isFullScreen else {
                if server[id]?.bounds.map(screenSized) == false { refusedFullScreen.remove(id) }
                continue
            }
            found.append(w)
        }
        return found
    }

    /// The green button or ⌃⌘F: the window fills the screen on its own workspace, or goes back where it was
    /// (`FullScreenFill`). No Space, no slide, nothing to wait for.
    func toggleFill(_ target: AXUIElement?) {
        guard active else { return }
        if switching { return enqueue { [weak self] in self?.toggleFill(target) } }
        refresh()
        // A window just opened may not be tracked yet, so the element the gesture found is used as it is.
        var w: Window?
        if let target, let id = target.windowID {
            var pid: pid_t = 0
            AXUIElementGetPid(target, &pid)
            w = windows[id] ?? Window(id: id, element: target, pid: pid, appName: NSRunningApplication(processIdentifier: pid)?.localizedName ?? "")
        } else {
            // The front window by the window server's order, not by asking the app.
            w = Windows.front(in: windows)
        }
        guard let w, let current = w.frame else { return NSSound.beep() }
        let fill = Windows.visibleArea(near: current)
        let next = FullScreenFill.target(current: current, fill: fill, record: filled[w.id])
        let filling = next == fill
        w.setFrame(next)
        // At its largest size already, short of the screen (character cells, a maximum): the fill changed nothing.
        let stuck = filling && filled[w.id] == nil && (w.frame.map { FullScreenFill.isFilling($0, current) } ?? false)
        if stuck { w.setFrame(FullScreenFill.smaller(fill)) }
        filled[w.id] = filling && !stuck ? FullScreenFill.Record(from: current, landed: w.frame ?? next) : nil
        saveFilled()
        // A green button on a window behind the front one: the click never reached it, so it comes forward here.
        AXUIElementPerformAction(w.element, kAXRaiseAction as CFString)
        NSRunningApplication(processIdentifier: w.pid)?.activate()
        Trace.log("fill window=\(w.id) \(filling ? "on" : "off")")
    }

    /// A window's title bar started moving: a window this filled goes back to its earlier size under the pointer.
    func unfillForDrag(_ id: WindowID, at pointer: CGPoint) {
        guard active, !switching, FullScreenGestures.isEnabled else { return }
        refresh()
        guard let w = windows[id], let current = w.frame else { return }
        switch FullScreenFill.dragStart(current: current, fill: Windows.visibleArea(near: current), record: filled[id], pointer: pointer) {
        case let .unfill(next):
            w.setFrame(next)
            filled[id] = nil
            saveFilled()
            Trace.log("fill window=\(id) off: dragged away from=\(current) to=\(next)")
        case .forget:
            filled[id] = nil
            saveFilled()
            Trace.log("fill window=\(id) record dropped: resized since it filled, frame=\(current)")
        case .leftToMacOS:
            Trace.log("fill window=\(id) drag left to macOS: full size, no record, frame=\(current)")
        case .ordinary:
            break
        }
    }

    /// Each display's whole frame and visible area in window-server coordinates, as `DragRelease` takes them.
    static func dragDisplays() -> [(frame: CGRect, visible: CGRect)] {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSScreen.screens.map { (frame: Geometry.toAX($0.frame, primaryHeight: primaryHeight),
                                       visible: Geometry.toAX($0.visibleFrame, primaryHeight: primaryHeight)) }
    }

    /// A drag of a window ended and it has held still: one the overview covered and that dropped nowhere goes back to its
    /// frame from before the overview, and one whose title bar is out of reach comes back far enough to grab. Anything
    /// else stays where the person put it. Only a window on the workspace you're on.
    func correctAfterDrag(_ id: WindowID, end: DragEnd) {
        guard active, !switching, let w = windows[id], model.workspace(of: id).map(model.isShown) == true,
              !w.isMinimized, let f = w.frame else { return }
        guard let fix = DragRelease.correction(for: f, after: end, displays: Self.dragDisplays()) else { return }
        let next = fix.frame
        if next.size == f.size { w.setOrigin(next.origin) } else { w.setFrame(next) }
        switch fix {
        case .backToBeforeOverview: Trace.log("drag end window=\(id) back to its frame before the overview: \(f) to \(next)")
        case .titleBarBackInReach: Trace.log("drag end window=\(id) title bar out of reach at \(f), moved to \(next.origin)")
        }
    }

    /// Windows this filled, so a second press puts each back. Kept across launches: an update or a restart must not leave
    /// a filled window with a green button that does nothing.
    private lazy var filled: [WindowID: FullScreenFill.Record] = Self.loadFilled()
    private static let filledURL = folder.appendingPathComponent("filled.json")

    private static func loadFilled() -> [WindowID: FullScreenFill.Record] {
        guard let data = try? Data(contentsOf: filledURL) else { return [:] }
        return (try? JSONDecoder().decode([WindowID: FullScreenFill.Record].self, from: data)) ?? [:]
    }

    private func saveFilled() {
        let alive = Set(windows.keys)
        let kept = filled.filter { alive.contains($0.key) }
        guard let data = try? JSONEncoder().encode(kept) else { return }
        Spaces.writer.async { try? data.write(to: Spaces.filledURL, options: .atomic) }
    }

    /// macOS full screen moves a window to a desktop of its own, where BaneySpaces can't hide or
    /// show it. Full screen you choose (a video, a presentation) stays until you switch
    /// workspaces; a window left in full screen from before BaneySpaces started comes back out
    /// at launch and fills the screen.
    func flattenFullScreen() {
        guard active else { return }
        if switching { return enqueue { [weak self] in self?.flattenFullScreen() } }
        whenFresh(full: true) { [self] in
            // Each window's full-screen flag is asked of its app off the main thread.
            let list = windows.values.filter { !refusedFullScreen.contains($0.id) }
            Spaces.axQueue.async { [weak self] in
                let fullScreen = list.filter(\.isFullScreen)
                DispatchQueue.main.async {
                    guard let self, self.active, !fullScreen.isEmpty else { return }
                    if self.switching { return self.enqueue { [weak self] in self?.flattenFullScreen() } }
                    self.flatten(fullScreen)
                }
            }
        }
    }

    private func flatten(_ fullScreen: [Window]) {
        switching = true
        generation += 1
        let gen = generation
        leaveFullScreen(fullScreen, fill: true) { [self] _ in
            guard gen == generation, active else { return }
            holding = true
            refresh(full: true, asking: [], then: { [self] in
                holding = false
                persist()
                finish()
            })
        }
    }

    /// Takes windows out of full screen, and with `fill` fills the screen with each. Calls back
    /// with the windows that refused, which are remembered so they aren't asked again.
    private func leaveFullScreen(_ fullScreen: [Window], fill: Bool, then: @escaping ([Window]) -> Void) {
        fullScreen.forEach { $0.exitFullScreen() }
        // Some apps (Chromium browsers among them) ignore the request. Their green button doesn't.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            fullScreen.filter(\.isFullScreen).forEach { $0.pressFullScreenButton() }
        }
        waitUntil(timeout: 4, interval: 0.05, { fullScreen.allSatisfy { !$0.isFullScreen } }) {
            // The exit animation keeps resizing the window for a moment after the flag flips.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [self] in
                var refused: [Window] = []
                for w in fullScreen {
                    if w.isFullScreen {
                        refused.append(w)
                        refusedFullScreen.insert(w.id)
                        NSSound.beep()
                    } else if fill, let f = w.frame {
                        w.setFrame(Windows.visibleArea(near: f))
                    }
                }
                then(refused)
            }
        }
    }

    /// Sends the focused window to workspace `n` and follows it there.
    func moveFocused(to n: Int) {
        guard active, Workspaces.range.contains(n) else { return }
        if switching { return enqueue { [weak self] in self?.moveFocused(to: n) } }
        // A window opened a moment ago is scanned first; the window in front comes from the window server.
        holdUntilFresh { [self] in
            guard let w = Windows.front(in: windows) else {
                NSLog("Polycarp: no window to move (focused app pid %d)", NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
                return NSSound.beep()
            }
            model.assign(w.id, to: n)
            switchTo(n)
        }
    }

    /// Runs `body` once the window list is fresh, holding every other request meanwhile (they queue as during a
    /// switch), so key presses keep their order though the scan runs in the background. Whatever queued runs after
    /// `body`, or after the switch it starts.
    private func holdUntilFresh(full: Bool = false, asking: Set<pid_t> = [], _ body: @escaping () -> Void) {
        switching = true
        holding = true
        let gen = generation
        refresh(full: full, asking: asking, then: { [weak self] in
            guard let self, gen == self.generation, self.active else { return }
            self.holding = false
            self.switching = false
            body()
            if !self.switching { self.finish() }
        })
    }

    /// Asks apps something through Accessibility off the main thread; `then` gets the answer on the main thread,
    /// unless Polycarp stopped or a switch started meanwhile (the answer is about a desktop that's gone): then `dropped`.
    private func ask<T>(_ question: @escaping () -> T, then: @escaping (T) -> Void, dropped: (() -> Void)? = nil) {
        let gen = generation
        Spaces.axQueue.async { [weak self] in
            let answer = question()
            DispatchQueue.main.async {
                guard let self, self.active else { return }
                guard gen == self.generation else { dropped?(); return }
                then(answer)
            }
        }
    }

    /// Clicking a Dock icon or using ⌘Tab can focus a window on another workspace. Go there,
    /// and land on the window that was picked. Activations BaneySpaces caused are ignored.
    func appActivated(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        guard active, pid != getpid() else { return }
        defer { frontPid = pid }
        Windows.markResponsive(pid)
        // Its title may have changed while it was in back (a tab switch): the switcher and the dock show the new one.
        refreshDetails(of: pid)
        // Asked for by `openWindowHere`: its window is on the way, here.
        if let o = opening, o.pid == pid, Date() < o.until { return }
        activatedAt = Date()
        if switching {
            if pid != expectedFront { followPending = true }
            return
        }
        if pid == expectedFront, Date() < settleUntil { return }
        followFocus()
    }

    /// The window each app last had in focus, to tell a window closing (⌘W) from the person
    /// picking another window of the same app.
    private var lastKey: [pid_t: WindowID] = [:]
    /// A window a switch tried and failed to raise, until when. Focus moving elsewhere in that
    /// app meanwhile is the app catching up, not a choice.
    private var intended: [pid_t: (id: WindowID, until: Date)] = [:]

    /// The app's window on this workspace that should take focus, if it has one: the one used
    /// last here, or any visible one.
    /// `minimized` defaults to asking each window; the focus paths pass what they asked off the main thread.
    private func windowHere(of pid: pid_t, minimized: ((WindowID) -> Bool)? = nil) -> Window? {
        let minimized = minimized ?? { [windows] id in windows[id]?.isMinimized ?? false }
        // This display's workspace first, then the other displays'.
        let order = [model.current] + model.shown.values.sorted().filter { $0 != model.current }
        for n in order {
            let here = model.windows(on: n).compactMap { windows[$0] }
                .filter { $0.pid == pid && !minimized($0.id) && saved.frames[$0.id] == nil }
            if let last = model.lastFocused[n], let w = here.first(where: { $0.id == last }) { return w }
            if let w = here.first { return w }
        }
        return nil
    }

    /// The window in focus on its workspace, and its app the one used there last.
    private func noteFocus(_ id: WindowID) {
        model.noteFocus(id)
        guard let pid = windows[id]?.pid, let n = model.workspace(of: id) else { return }
        activations.note("\(pid)", on: n, at: Date().timeIntervalSinceReferenceDate)
    }

    /// Stamps the activation, then tells the dock. The stamp comes first so the reload reads the new
    /// order: a same-app window change sends no `didActivateApplication` to reload it later. A
    /// display change already notifies; any other case notifies here.
    private func noteFocusAndReload(_ id: WindowID) {
        noteFocus(id)
        if !noteFocusedDisplay(of: id) { onChange?() }
    }

    /// An app that quit loses its place in the order: its process id may come back as another app.
    func appQuit(_ pid: pid_t) { activations.forget("\(pid)") }

    /// Focuses a window on this workspace, marking the activation as BaneySpaces' own.
    private func stay(on w: Window) {
        expectedFront = w.pid
        settleUntil = Date().addingTimeInterval(0.3)
        noteFocusAndReload(w.id)
        // Only a raise that landed makes this the window you were in.
        if w.focus() { lastKey[w.pid] = w.id }
    }

    /// An app came to the front (Dock click, ⌘Tab, a link opening it). If it has a window on this
    /// workspace, stay here and use that one: macOS tends to focus the app's most recent window,
    /// which may belong to another workspace. Only an app with nothing here takes you to its
    /// workspace.
    private func followFocus() {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid() else { return }
        // A newly activated app may have just become a regular app: re-read the app list, which
        // forces a scan only if it changed.
        RunningApps.invalidate()
        let pid = app.processIdentifier
        // Its focused window and standard windows are asked of the app off the main thread, once a window it opened a
        // moment ago is scanned.
        whenFresh { [self] in
            let mine = windows.values.filter { $0.pid == pid }
            ask({ Windows.look(at: pid, windows: mine) }) { [self] look in
                // A switch that started meanwhile looks again when it's done.
                if switching { followPending = true; return }
                guard let w = look.focused.flatMap({ windows[$0] }), let n = model.workspace(of: w.id) else { return }
                followed(w, on: n, pid: pid, look: look)
            } dropped: { [self] in
                // A switch overtook the look (one `applyScan` queued, say): follow once it's done, as `finish` does.
                followPending = true
                if !switching { followIfPending() }
            }
        }
    }

    /// The rest of `followFocus`, with the app's focused window `w` on workspace `n` and what the app said about its
    /// windows (`look`), asked off the main thread. Nothing here asks the app again.
    private func followed(_ w: Window, on n: Int, pid: pid_t, look: Windows.FocusLook) {
        let known = look.standard
        let minimized: (WindowID) -> Bool = { look.minimized[$0] ?? false }
        // An agent action on this very window (for its whole run and a moment after), or an app the agent
        // launched, caused this: it is not you picking the app. Your own windows of the same app are never
        // ignored: only the window the action works on.
        if model.isShown(n) && saved.frames[w.id] == nil {
            // The app in front just closed its last window here, quit or hid, and macOS handed
            // focus to an app on the other display: you're still on this one.
            if model.shown.count > 1, let d = model.display(showing: n), d != model.focusedDisplay,
               activatedAt.timeIntervalSince(max(leftAt, handedOffAt)) < 0.5 {
                Trace.log("followFocus stayed on this display: \(w.appName) came forward after the front app left")
                if let id = model.lastFocused[model.current], let t = windows[id], saved.frames[id] == nil, t.pid != pid {
                    stay(on: t)
                } else {
                    takeFocus()
                }
                return
            }
            lastKey[pid] = w.id
            noteFocusedDisplay(of: w.id)
            noteFocus(w.id)
            // An app BaneySpaces hid, opening a window here: macOS unhid all of it, so its windows
            // from other workspaces are in sight too. They go back out of view.
            if strayed(pid, minimized: minimized) { return switchTo(model.current, announce: false) }
            return persist()
        }
        // A window its own app had put away, shown again now: a screenshot tool's result, say. It comes here, and you stay.
        let away = ReappearedWindow.isAway(hasRecord: saved.frames[w.id] != nil,
                                           atHidingSpot: look.frame.map { Geometry.isStranded($0, screens: Windows.screens()) } ?? true,
                                           justSwitched: activatedAt.timeIntervalSince(max(leftAt, handedOffAt)) < 0.5)
        if ReappearedWindow.belongsHere(workspaceShown: model.isShown(n), onAgentWorkspace: n == Self.agentWorkspace,
                                        parked: away, appHiddenByUs: saved.hiddenApps.contains(pid),
                                        minimized: minimized(w.id), fullScreen: look.fullScreen,
                                        onScreen: !Windows.allOffscreen([w.id])) {
            Trace.log("followFocus stayed: \(w.appName) showed a window it had put away; it comes here")
            saved.frames[w.id] = nil
            model.assign(w.id, to: model.current, focus: true)
            lastKey[pid] = w.id
            noteFocus(w.id)
            return switchTo(model.current, announce: false)
        }
        if let here = windowHere(of: pid, minimized: minimized) { return stay(on: here) }
        // When the app in front closes its last window here, quits or hides (a switch hiding it
        // too), macOS hands focus to the next app in line on its own: often one BaneySpaces just
        // put away, parked or hidden. That isn't you picking it: stay here, and an app the
        // activation unhid goes back into hiding. Following it pulled you off the workspace you
        // had just gone to, Finder or Ghostty a moment after you arrived.
        let putAway = (saved.frames[w.id] != nil && parkedPids().contains(pid)) || saved.hiddenApps.contains(pid)
        // Timed from when the activation arrived: one that came mid-switch is only looked at once
        // the switch, parking included, is over.
        if putAway, activatedAt.timeIntervalSince(max(leftAt, handedOffAt)) < 0.5 {
            Trace.log("followFocus stayed: \(w.appName) came forward after the front app left")
            if let id = model.lastFocused[model.current], let t = windows[id], saved.frames[id] == nil, t.pid != pid {
                stay(on: t)
            } else {
                takeFocus()
            }
            if saved.hiddenApps.contains(pid) { hideOnceBehind(pid) }
            // Unless it came forward to open a window here after all (its New Window key, pressed
            // right after the switch): that window shows.
            waitOffMain(timeout: 0.5, interval: 0.02, { !Windows.standardIDs(of: pid).subtracting(known).isEmpty }) { [self] in
                guard active, !switching else { return }
                showNewWindow(of: pid, besides: known) { _ in }
            }
            return
        }
        // An app opening a new window (a global New Window key, a file opened in it) comes
        // forward before the window exists, still focused on its window elsewhere: Ghostty's
        // came 54 ms after it activated. Give the window that long to show up here before
        // following the app away.
        let gen = generation
        following += 1
        let ticket = following
        waitOffMain(timeout: Self.newWindowGrace, interval: 0.02, {
            !Windows.standardIDs(of: pid).subtracting(known).isEmpty
        }) { [self] in
            guard following == ticket, gen == generation, active, !switching,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
            showNewWindow(of: pid, besides: known) { [self] shown in
                guard !shown else { return Trace.log("followFocus stayed: \(w.appName) opened a window here") }
                guard following == ticket, active, !switching else { return }
                followAway(w, to: n, pid: pid)
            }
        }
    }

    /// `followFocus`'s last step: the app came forward with nothing of it here and opened no window here.
    private func followAway(_ w: Window, to n: Int, pid: pid_t) {
        // Something on the agent workspace came forward on its own (an agent's click fell
        // back to the foreground, an app took focus): you stay where you are, and so does your
        // typing, which must never go into a window out of sight.
        if !AgentWorkspace.mayFollow(to: n, current: model.current, agent: Self.agentWorkspace) {
            Trace.log("followFocus stayed: \(w.appName) is on the agent workspace")
            if let id = model.lastFocused[model.current], let t = windows[id], saved.frames[id] == nil, t.pid != pid {
                stay(on: t)
            } else {
                takeFocus()
            }
            return
        }
        Trace.log("followFocus \(w.appName) to \(n)")
        lastKey[pid] = w.id
        noteFocus(w.id)
        switchTo(n, announce: true)
    }

    /// Hides an app BaneySpaces put away that came forward on its own, once it's out of the front:
    /// hiding the app in front makes macOS pick yet another app. Not if it has a window here by
    /// then (one it opened).
    private func hideOnceBehind(_ pid: pid_t) {
        waitUntil(timeout: 0.3, interval: 0.01, { NSWorkspace.shared.frontmostApplication?.processIdentifier != pid }) { [self] in
            guard active, !model.visibleWindows.contains(where: { windows[$0]?.pid == pid }) else { return }
            // Still in front (focus didn't move here): the workspace is applied again instead,
            // which hides it the usual way.
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier != pid else {
                return switching ? () : switchTo(model.current, announce: false)
            }
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isHidden else { return }
            ownHides.insert(pid)
            ownHidesUntil = Date().addingTimeInterval(1)
            app.hide()
            saved.hiddenApps.insert(pid)
        }
    }

    /// How long an app that came forward gets to open a window here before BaneySpaces follows
    /// it to its workspace. Long enough for an app to make a window after activating, short
    /// enough that a Dock click on an app elsewhere still feels immediate.
    private static let newWindowGrace: TimeInterval = 0.2
    /// Counts followFocus calls; one waiting out `newWindowGrace` stands down for a newer one.
    private var following = 0

    /// The app has windows on other workspaces that aren't out of view: it was unhidden.
    private func strayed(_ pid: pid_t, minimized: (WindowID) -> Bool) -> Bool {
        guard NSRunningApplication(processIdentifier: pid)?.isHidden == false else { return false }
        return windows.values.contains { $0.pid == pid && model.workspace(of: $0.id).map { !model.isShown($0) } == true
            && saved.frames[$0.id] == nil && !minimized($0.id) }
    }

    /// When the app in front last closed a window here, quit or hid. An activation right after
    /// that is macOS picking the next app, not you.
    private var leftAt = Date.distantPast
    /// When a switch last handed focus away from the app in front (hid it, left a parked app,
    /// or went to an empty workspace). macOS then picks an app to put in front on its own.
    private var handedOffAt = Date.distantPast
    /// When the last app activation BaneySpaces didn't ask for arrived.
    private var activatedAt = Date.distantPast
    /// An app `openWindowHere` asked for a window, until when: its coming forward isn't followed.
    private var opening: (pid: pid_t, until: Date)?
    /// The app in front, as of the last activation.
    private var frontPid: pid_t?
    /// Apps BaneySpaces itself just hid; their hide notifications arrive late.
    private var ownHides: Set<pid_t> = []
    private var ownHidesUntil = Date.distantPast

    /// An app quit or hid (⌘Q, ⌘H). Only the app in front counts, and not BaneySpaces' own hiding.
    func appLeft(_ pid: pid_t) {
        guard pid == frontPid, !(ownHides.contains(pid) && Date() < ownHidesUntil) else { return }
        leftAt = Date()
    }

    /// The front app moved focus to another of its windows without an app switch. Two cases:
    /// the window you were in closed (⌘W), and the app picked its next window on its own; or you
    /// chose a window yourself (the Window menu, ⌘`). A closed window keeps you on this workspace,
    /// so typing never lands in a hidden window. A window you chose takes you to its workspace.
    private func focusMovedWithin(_ pid: pid_t) {
        guard active else { return }
        // Another window or tab in front has another title.
        refreshDetails(of: pid)
        guard !switching, Date() > settleUntil,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
        // Which window has focus, and which the app still lists, are asked off the main thread, once a window it opened
        // a moment ago is scanned.
        whenFresh { [self] in
            let mine = windows.values.filter { $0.pid == pid }
            ask({ Windows.look(at: pid, windows: mine) }) { [self] look in
                guard !switching, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
                movedWithin(pid, look: look)
            }
        }
    }

    /// The rest of `focusMovedWithin`, with what the app said (`look`). Nothing here asks the app again.
    private func movedWithin(_ pid: pid_t, look: Windows.FocusLook) {
        guard let w = look.focused.flatMap({ windows[$0] }), let n = model.workspace(of: w.id) else { return }
        let minimized: (WindowID) -> Bool = { look.minimized[$0] ?? false }
        if let i = intended[pid], Date() < i.until, i.id != w.id, model.workspace(of: i.id).map(model.isShown) == true,
           !model.isShown(n) || saved.frames[w.id] != nil, let target = windows[i.id] {
            return stay(on: target)
        }
        intended[pid] = nil
        let previous = lastKey[pid]
        lastKey[pid] = w.id
        guard !model.isShown(n) || saved.frames[w.id] != nil else {
            return noteFocusAndReload(w.id)
        }
        // A window minimized or closed (even one an app only hid) is one you left, not chose from.
        let chosen = previous.map { $0 != w.id && windows[$0].map { !minimized($0.id) } == true && look.listed?.contains($0) == true } ?? false
        if chosen {
            noteFocus(w.id)
            switchTo(n, announce: true)
        } else if let here = windowHere(of: pid, minimized: minimized) {
            stay(on: here)
        } else {
            switchTo(model.current, announce: false)
        }
    }

    /// The running apps on the parked list (see `ParkedApps`) that answer Accessibility. A busy
    /// app is hidden as before: parking needs it to answer, hiding doesn't.
    private func parkedPids() -> Set<pid_t> {
        let ids = ParkedApps.bundleIDs
        // Apps with a window on the agent workspace stay drivable from behind, like the list's.
        let agents = AgentWorkspace.parkedApps(owners: windows.mapValues(\.pid), home: model.home, agent: Self.agentWorkspace)
        guard !ids.isEmpty || !agents.isEmpty else { return [] }
        let unsure = lastScan?.unsure ?? []
        return Set(windows.values.map(\.pid)).filter { pid in
            Windows.isResponsive(pid) && !unsure.contains(pid) && !SlowMovers.contains(pid)
                && (agents.contains(pid) || NSRunningApplication(processIdentifier: pid)?.bundleIdentifier.map(ids.contains) == true)
        }
    }

    /// Each app with a window, by name and bundle identifier, for the parked-apps menu.
    func appsWithWindows() -> [(name: String, bundleID: String)] {
        var seen = Set<String>()
        return windows.values.sorted { $0.appName.localizedCompare($1.appName) == .orderedAscending }.compactMap { w in
            guard let id = NSRunningApplication(processIdentifier: w.pid)?.bundleIdentifier, seen.insert(id).inserted else { return nil }
            return (w.appName, id)
        }
    }

    /// Re-applies the workspace you're on, after the parked-apps list changed.
    func reapply() { switchTo(model.current, takeFocus: false, announce: false) }

    /// Every window onto workspace 1, all visible. The way out of any tangle.
    func gatherOnOne() {
        guard active else { return }
        if switching { return enqueue { [weak self] in self?.gatherOnOne() } }
        holdUntilFresh(full: true) { [weak self] in self?.gather() }
    }

    private func gather() {
        let screens = Windows.screens()
        for w in windows.values where saved.frames[w.id] == nil && !w.isMinimized {
            guard let f = w.frame, Geometry.isStranded(f, screens: screens) else { continue }
            w.setFrame(Geometry.restoreFrame(saved: nil, size: f.size, screens: screens))
        }
        for id in model.home.keys { model.assign(id, to: 1) }
        switchTo(1)
    }

    /// Puts every hidden window back on screen. Runs on quit, so BaneySpaces never strands a
    /// window. A window it can't reach right now keeps its saved frame for the next launch.
    func restoreAll() {
        // Quitting or losing permission: every parked window must be reached before Polycarp lets go.
        refreshNow()
        let screens = Windows.screens()
        for (id, frame) in saved.frames {
            guard let w = windows[id], restore(w, to: frame, screens: screens) else { continue }
            saved.frames[id] = nil
        }
        for pid in saved.hiddenApps { NSRunningApplication(processIdentifier: pid)?.unhide() }
        saved.hiddenApps = []
        persist()
    }

    /// The Mac woke. Apps that missed Accessibility while it slept were benched (up to 10 minutes) as if hung, so their
    /// windows went unplaced after wake: every app is asked again, the window list is read in full, and the workspace
    /// you're on is applied again, as for a display change.
    func didWake() {
        Windows.clearBench()
        RunningApps.invalidate()
        Trace.log("wake: every app asked again; workspace \(model.current) applied again")
        guard active else { return }
        if !switching { refresh(full: true) }
        screensChanged()
    }

    /// The display layout changed: put hidden windows at the new hiding spot. macOS sends a burst
    /// of these on wake and on plugging in a display, so act once, after it settles, and leave
    /// focus where it is (a dialog may hold it).
    func screensChanged() {
        screensWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active else { return }
            if self.switching { return self.enqueue { [weak self] in self?.screensChanged() } }
            // A display plugged in shows a workspace of its own; one unplugged stops showing its.
            self.noteDisplays()
            // macOS moved windows around for the change; any on a shown workspace that landed on
            // another display goes back to its workspace's display.
            self.returnToDisplays()
            self.switchTo(self.model.current, takeFocus: false, announce: false)
        }
        screensWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    /// One window as the viewer shows it.
    struct Entry: Identifiable {
        let id: WindowID
        let pid: pid_t
        let app: String
        let title: String
    }

    /// A window's title as the last background read found it (`details`); "" before the first.
    private func title(of id: WindowID) -> String { details[id]?.title ?? "" }

    /// The windows on workspace `n`, for the viewer, the dock and the switcher. Titles are the last background read's
    /// (`refreshDetails`): nothing here asks an app.
    func entries(on n: Int) -> [Entry] {
        model.windows(on: n).compactMap { id in
            windows[id].map { Entry(id: id, pid: $0.pid, app: $0.appName, title: title(of: id)) }
        }
    }

    /// Running apps with no window to see on any workspace (the agent's included): none at all, or
    /// only minimized ones (`BackgroundApps`). Call after `refresh()`.
    /// An app BaneySpaces hid has its windows on a workspace, so it isn't one. A window not scanned
    /// yet that a saved layout names counts as on its workspace, so a launch doesn't flash them all.
    func backgroundApps() -> [BackgroundApps.Entry] {
        var byPid: [pid_t: [Window]] = [:]
        for (id, w) in windows where model.workspace(of: id) != nil { byPid[w.pid, default: []].append(w) }
        var tracked: [BackgroundApps.TrackedWindow] = []
        let hiddenApps = RunningApps.hidden(among: Set(byPid.keys))
        for (pid, var list) in byPid {
            // A hidden app's window closing doesn't prompt a scan, so its record can outlive it and
            // keep a windowless app off the list. Ask the app, as `focusApp` does; one on another
            // macOS desktop is never listed from here, so it still counts.
            // The listing is the app's last scan answer (`refreshHidden` asks hidden apps again when the dock opens).
            if hiddenApps.contains(pid), let a = answers[pid], a.answered, !a.partial {
                list = list.filter { a.listed.contains($0.id) || !Windows.onNoOtherDesktop($0.id) }
            }
            // One window that isn't minimized settles it. Minimized state is the scan's (`details`): this runs on every
            // dock reload, on the main thread, and asks no app.
            for w in list {
                let minimized = details[w.id]?.minimized ?? false
                tracked.append(.init(pid: pid, isMinimized: minimized))
                if !minimized { break }
            }
        }
        for e in pendingLayout.values where model.workspace(of: e.window) == nil { tracked.append(.init(pid: e.pid, isMinimized: false)) }
        let trackedPids = Set(tracked.filter { !$0.isMinimized }.map(\.pid))
        // Dialogs and alerts aren't tracked windows, yet they are on screen: one look at the window
        // server for every app's normal-layer windows showing now.
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let showing = Set(info.compactMap { w -> pid_t? in
            // Invisible helper windows sit on the same layer; they show nothing.
            guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
                  let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }),
                  b.width > 40, b.height > 40 else { return nil }
            return (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        })
        // Windows on another macOS desktop (full screen) from the window server, which answers when
        // a busy app doesn't; a window the app closed but kept is on no desktop and doesn't count.
        // Read only once some app needs it: every window of every desktop is a big list.
        lazy var serverWindows: [pid_t: [WindowID]] = {
            var out: [pid_t: [WindowID]] = [:]
            for w in CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] {
                // The same filter as `showing`: invisible helper windows show nothing on any desktop.
                guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                      (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
                      let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                      let owner = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                      let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }),
                      b.width > 40, b.height > 40 else { continue }
                out[owner, default: []].append(id)
            }
            return out
        }()
        // Only a candidate (a regular app with no tracked window) is asked about windows on other macOS desktops
        // (full screen): an Accessibility call each, so not for apps already settled.
        let running = RunningApps.forBackground(tracked: trackedPids) { pid in
            showing.contains(pid)
                || (serverWindows[pid]?.contains { model.workspace(of: $0) == nil && !Windows.onNoOtherDesktop($0) } ?? false)
        }
        return BackgroundApps.list(running: running, trackedWindows: tracked, selfPID: getpid())
    }

    /// Brings a background app (`backgroundApps()`) to the workspace you're on: unhides it; its most
    /// recent minimized window is restored onto this workspace; with no window, it opens one here
    /// (`openWindowHere`, else a reopen like a Dock click), and that window joins this workspace.
    func showBackgroundApp(_ pid: pid_t) {
        guard active else { return focusApp(pid) }
        if switching { return enqueue { [weak self] in self?.showBackgroundApp(pid) } }
        refresh()
        // The list was drawn a moment ago: an app that has since opened a window on some workspace
        // is just gone to, so nothing on another workspace is unhidden here or opened twice.
        guard backgroundApps().contains(where: { $0.pid == pid }) else { return focusApp(pid, announce: false) }
        let app = NSRunningApplication(processIdentifier: pid)
        if app?.isHidden == true { app?.unhide() }
        // Shown by hand, so BaneySpaces' record of having hidden it is stale.
        if saved.hiddenApps.remove(pid) != nil { persist() }
        let minimized = windows.values.filter { $0.pid == pid && model.workspace(of: $0.id) != nil && $0.isMinimized }
        // The window used last on its workspace, else the newest (window numbers only grow).
        let lastUsed = Set(model.lastFocused.values)
        if let pick = minimized.filter({ lastUsed.contains($0.id) }).max(by: { $0.id < $1.id }) ?? minimized.max(by: { $0.id < $1.id }) {
            let n = model.current
            model.assign(pick.id, to: n)
            focus(pick.id, on: n, announce: false)
            return
        }
        // The unhide lands when the app gets to it. Asked before then, a busy app can answer that
        // it has no window while one is coming back, and a New Window would make it a twin.
        // A second pick before the first lands would open a second window.
        guard picking.insert(pid).inserted else { return }
        waitUntil(timeout: 1, interval: 0.02, { NSRunningApplication(processIdentifier: pid)?.isHidden != true }) { [weak self] in
            guard let self else { return }
            // Still hidden at the deadline: it can't be asked yet, so it is only reopened.
            let settled = NSRunningApplication(processIdentifier: pid)?.isHidden != true
            // Held a moment past the wait, so a busy app's window has time to appear before a second
            // pick could press New Window again; released on a timer, so a dropped queue can't lock it out.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.picking.remove(pid) }
            let finish = { [weak self] in
                guard let self, self.active else { return }
                self.showWindowless(pid, settled: settled)
            }
            if self.switching { return self.enqueue(finish) }
            finish()
        }
    }

    /// Apps with a Background pick waiting on their unhide.
    private var picking = Set<pid_t>()

    /// The end of `showBackgroundApp` for an app with no window on any workspace. A window it has that
    /// no workspace holds (hidden before it was scanned, or launched hidden) joins this one. Only an
    /// app that clearly says it has no window gets a new one from its New Window command; when it
    /// can't say (busy, not answering) or its window isn't scanned yet, it is reopened like a Dock
    /// click, which shows the window it has rather than making another.
    private func showWindowless(_ pid: pid_t, settled: Bool) {
        // What the app lists is asked off the main thread.
        Spaces.axQueue.async { [weak self] in
            let listed = Windows.listedIDs(of: pid)
            let standard = Windows.standardIDs(of: pid)
            DispatchQueue.main.async {
                guard let self, self.active else { return }
                let go: () -> Void = { [weak self] in self?.windowless(pid, settled: settled, listed: listed, standard: standard) }
                if self.switching { return self.enqueue(go) }
                go()
            }
        }
    }

    private func windowless(_ pid: pid_t, settled: Bool, listed: Set<WindowID>?, standard: Set<WindowID>) {
        if !standard.isEmpty {
            // The app is scanned (in the background) so its windows are known before one joins this workspace.
            return whenFresh(asking: [pid]) { [self] in
                let n = model.current
                // One on another macOS desktop (full screen) stays there; only this desktop's join.
                let here = standard.filter { Windows.onNoOtherDesktop($0) }
                let adopt = here.filter { windows[$0] != nil && model.workspace(of: $0) == nil }
                for id in adopt { model.assign(id, to: n) }
                if let pick = adopt.max() ?? here.filter({ model.workspace(of: $0) == n }).max() {
                    return focus(pick, on: n, announce: false)
                }
                reopen(pid)
            }
        }
        if settled, listed?.isEmpty == true { return openWindowHere(pid) { [weak self] in self?.reopen(pid) } }
        reopen(pid)
    }

    /// Opens the app again, like a Dock click, which shows the window it has rather than making another.
    private func reopen(_ pid: pid_t) {
        guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return focusApp(pid, announce: false) }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            guard let error else { return }
            DispatchQueue.main.async { Trace.log("dock background: reopening \(url.lastPathComponent) failed: \(error.localizedDescription)") }
        }
    }

    /// One window as the viewer shows it, with its workspace; nil for a window not on one.
    func entry(for id: WindowID) -> (Entry, Int)? {
        refresh()
        guard let w = windows[id], let n = model.workspace(of: id) else { return nil }
        return (Entry(id: id, pid: w.pid, app: w.appName, title: title(of: id)), n)
    }

    /// A window dragged to the top of the screen and let go over another workspace in the
    /// overview: it goes back to where the drag picked it up, then to workspace `n`, so it's
    /// waiting there where it was instead of pressed against the menu bar.
    /// `wanted` is asked again when the move runs, which may be after a switch in progress.
    func moveCarried(_ id: WindowID, to n: Int, from frame: CGRect, wanted: @escaping () -> Bool = { true }) {
        let inRange = Workspaces.range.contains(n)
        // `wanted` runs only once the first two hold.
        let want = active && inRange ? wanted() : nil
        guard want == true else {
            Trace.log("drop not wanted window=\(id) active=\(active) inRange=\(inRange) wanted=\(want.map { "\($0)" } ?? "unasked")")
            return
        }
        if switching { Trace.log("drop waits for a switch window=\(id)"); return enqueue { [weak self] in self?.moveCarried(id, to: n, from: frame, wanted: wanted) } }
        Trace.log("drop moves window=\(id) to=\(n)")
        // Already gone to `n` while the drop settled: the window is out of sight on the workspace
        // just left, so it goes back to its spot now, before the switch below shows it here.
        if model.isShown(n), let w = windows[id] { w.place(onDisplayOf(n, frame), currentSize: w.frame?.size ?? .zero) }
        // The window had the keyboard (it was just dragged) and the overview never took it, so
        // this workspace's next window takes it, or the empty-workspace holder when none is left.
        model.assign(id, to: n, focus: false)
        switchTo(model.current, announce: false)
        // Out of sight now, it goes back where the drag picked it up, never on screen here.
        let putBack: () -> Void = { [weak self] in self?.placeAway(id, at: frame) }
        if switching { enqueue(putBack) } else { putBack() }
    }

    /// A window on another workspace will come back at `frame`: a parked one's record says so,
    /// and one whose app is hidden moves there unseen.
    private func placeAway(_ id: WindowID, at frame: CGRect) {
        guard active, let n = model.workspace(of: id), !model.isShown(n) else { return }
        if saved.frames[id] != nil {
            saved.frames[id] = frame
            persist()
        } else if let w = windows[id], saved.hiddenApps.contains(w.pid) {
            // BaneySpaces' own record says it hid the app; the move waits until the window
            // server has the window off screen, so it's never seen.
            waitUntil(timeout: 0.5, interval: 0.02, { Windows.allOffscreen([id]) }) { [weak self] in
                guard let self, self.model.workspace(of: id) == n, Windows.allOffscreen([id]) else {
                    return Trace.log("topDrag putBack skipped window=\(id): still on screen")
                }
                w.place(frame, currentSize: w.frame?.size ?? .zero)
            }
        } else {
            Trace.log("topDrag putBack skipped window=\(id): neither parked nor hidden")
        }
    }

    /// Records the window in front, so closing the viewer (or any switch back here) returns to it.
    func rememberFocus() {
        refresh()
        // The window in front by the window server's stacking order: the overview opens without asking any app.
        if let f = Windows.front(in: windows, preferring: { [saved] id in saved.frames[id] == nil }), model.workspace(of: f.id) == model.current {
            noteFocus(f.id)
        }
        persist()
    }

    /// Goes to workspace `n` and lands on one particular window there.
    func focus(_ id: WindowID, on n: Int, announce: Bool = true) {
        guard active else { return }
        if switching { return enqueue { [weak self] in self?.focus(id, on: n, announce: announce) } }
        // Picking a minimized window in the viewer means wanting it back.
        if let w = windows[id], w.isMinimized { w.unminimize() }
        // Already here: raise it directly. A switch would first record the window in front (the
        // app you're leaving, since docks and switchers never take focus) and land back on it.
        if model.isShown(n), let w = windows[id] {
            // A window still parked off screen here (an earlier restore didn't land) comes back first.
            if let frame = saved.frames[id], restore(w, to: frame, screens: Windows.screens()) { saved.frames[id] = nil }
            stay(on: w)
            persist()
            return
        }
        noteFocus(id)
        switchTo(n, announce: announce)
    }

    /// Goes to an app wherever it is: the window of it used last, on whichever workspace that is,
    /// preferring the workspace you're on. An app with no windows is simply brought forward.
    /// The workspace an app was last in front on, from each workspace's last-focused window,
    /// most recently visited workspace first.
    func lastWorkspace(of pid: pid_t) -> Int? {
        (recent + Array(Workspaces.range)).first { n in model.lastFocused[n].flatMap { windows[$0]?.pid } == pid }
    }

    /// `on` limits it to one workspace, for an app icon clicked in a dock tile. `cycle` steps to
    /// the app's next window there when one of its windows on that workspace is already in front.
    func focusApp(_ pid: pid_t, on only: Int? = nil, cycle: Bool = false, announce: Bool = true) {
        guard active else { NSRunningApplication(processIdentifier: pid)?.activate(options: []); return }
        if switching { return enqueue { [weak self] in self?.focusApp(pid, on: only, cycle: cycle, announce: announce) } }
        // A hidden app's window closing doesn't prompt a scan (its windows are off screen anyway), so a hidden app is
        // asked which windows it has before one is picked: going to one it closed would bring nothing forward. Any
        // other app's closed window left the screen, which a scan notices. The scan runs in the background; other
        // requests wait their turn meanwhile.
        let hidden = NSRunningApplication(processIdentifier: pid)?.isHidden == true
        holdUntilFresh(asking: hidden ? [pid] : []) { [self] in pickApp(pid, on: only, cycle: cycle, announce: announce) }
    }

    private func pickApp(_ pid: pid_t, on only: Int?, cycle: Bool, announce: Bool) {
        let mine = windows.values.filter { $0.pid == pid && model.workspace(of: $0.id) != nil }
        let order = only.map { [$0] } ?? ([model.current] + recent.filter { $0 != model.current } + Array(Workspaces.range))
        for n in order {
            let here = mine.filter { model.workspace(of: $0.id) == n }
            guard !here.isEmpty else { continue }
            if cycle, n == model.current, let front = Windows.front(in: windows),
               here.contains(where: { $0.id == front.id }), here.count > 1,
               let next = WindowCycle.next(here.map(\.id).sorted(), after: front.id) {
                return focus(next, on: n, announce: announce)
            }
            let last = model.lastFocused[n].flatMap { id in here.first { $0.id == id } }
            let pick = last ?? here.first { !(details[$0.id]?.minimized ?? false) } ?? here[0]
            return focus(pick.id, on: n, announce: announce)
        }
        if let only { return switchTo(only, announce: announce) }
        NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    }

    /// Opens a new window of a running app here, with the app's own New Window command, and
    /// focuses it once it exists. The app stays hidden until then, and its windows on other
    /// workspaces stay where they are. `orElse` runs when the app has no New Window command; an app that makes no
    /// window in time is gone to instead. The app's menus are read, and the command pressed, off the main thread.
    func openWindowHere(_ pid: pid_t, orElse: @escaping () -> Void) {
        guard active else { return orElse() }
        // An app that comes forward for it isn't asking to be followed to its workspace. Set before the press, which
        // lands off the main thread, so an activation it causes can't arrive first.
        opening = (pid, Date().addingTimeInterval(1.5))
        Spaces.axQueue.async { [weak self] in
            let item = Windows.newWindowItem(pid)
            let known = Windows.standardIDs(of: pid)
            let pressed = item.map { AXUIElementPerformAction($0, kAXPressAction as CFString) == .success } ?? false
            DispatchQueue.main.async {
                guard let self, self.active else { return }
                guard pressed else {
                    if self.opening?.pid == pid { self.opening = nil }
                    return orElse()
                }
                self.waitOffMain(timeout: 1.5, interval: 0.02, { !Windows.standardIDs(of: pid).subtracting(known).isEmpty }) { [weak self] in
                    guard let self, self.active else { return }
                    if self.switching { return self.enqueue { [weak self] in self?.finishOpening(pid, besides: known) } }
                    self.finishOpening(pid, besides: known)
                }
            }
        }
    }

    private func finishOpening(_ pid: pid_t, besides known: Set<WindowID>) {
        opening = nil
        showNewWindow(of: pid, besides: known) { [weak self] shown in if !shown { self?.focusApp(pid) } }
    }

    /// Shows a window the app just opened, which joined the workspace you're on: the app's others
    /// are parked before it shows, and it takes focus. `done(false)` when there's no such window.
    private func showNewWindow(of pid: pid_t, besides known: Set<WindowID>, _ done: @escaping (Bool) -> Void) {
        // The app is asked even if the window server shows no change: it may already have counted the window before
        // Accessibility listed it, and a quick refresh would then never look again.
        whenFresh(asking: [pid]) { [self] in
            guard let new = windows.values.first(where: { $0.pid == pid && !known.contains($0.id) && model.workspace(of: $0.id).map(model.isShown) == true }) else {
                return done(false)
            }
            lastKey[pid] = new.id
            noteFocus(new.id)
            switchTo(model.current, announce: false)
            done(true)
        }
    }

    /// Sends one window to workspace `n` without going there.
    func move(_ id: WindowID, to n: Int) { move([id], to: n) }

    /// Sends windows to workspace `n` without going there, in one switch.
    func move(_ ids: [WindowID], to n: Int) {
        guard active, Workspaces.range.contains(n), !ids.isEmpty else { return }
        if switching { return enqueue { [weak self] in self?.move(ids, to: n) } }
        // The window last used there stays the one a visit lands on.
        for id in ids { model.assign(id, to: n, focus: false) }
        switchTo(model.current, takeFocus: false, announce: false)
    }

    /// The ⌘Tab switcher's list: the current workspace (even when empty), then others with
    /// windows, most recent first, then any remaining ones with windows in number order.
    /// Occupied counts the same entries the tile's caption counts, so no listed tile but the
    /// current one says "empty".
    func switcherOrder() -> [Int] {
        refresh()
        return WorkspaceSwitcherOrder.make(
            current: model.current,
            recent: recent,
            occupied: Set(Workspaces.range.filter { !entries(on: $0).isEmpty }),
            range: Array(Workspaces.range)
        )
    }

    /// App names on workspace `n`, for the menu.
    func apps(on n: Int) -> [String] {
        var seen = Set<String>()
        return model.windows(on: n).compactMap { windows[$0]?.appName }.filter { seen.insert($0).inserted }
    }

    private func apply(_ plan: SwitchPlan, moveFocus: Bool = true) {
        guard active else { return }
        let gen = generation
        // What follows changes each app's windows on its own schedule. Held, they reach the screen as one change.
        ScreenHold.begin()
        let screens = Windows.screens()
        // macOS reports the new front app a moment late. Right after a switch, the app that
        // switch brought forward is the one really in front.
        let oldFront = Date() < settleUntil ? expectedFront : NSWorkspace.shared.frontmostApplication?.processIdentifier
        // 1. Everything on this workspace comes back. That includes an app hidden with ⌘H:
        //    going to its workspace means wanting to see it.
        // A hidden app may not answer until it's shown, so a saved window that hasn't been seen yet
        // still brings its app back when you go to its workspace.
        // An app that also has known windows elsewhere stays hidden: it isn't answering, so those
        // windows couldn't be parked. The retry scan brings the waiting window home instead.
        let elsewhere = Set(windows.values.filter { model.workspace(of: $0.id).map(model.isShown) != true }.map(\.pid))
        let waiting = Set(pendingLayout.values.filter { model.isShown($0.workspace) }.map(\.pid)).subtracting(elsewhere)
        // A workspace that went to another display takes its windows there, unseen: parked ones by
        // their record, ones whose app is hidden moved while it still is. Every shown workspace's,
        // so one that came back with a display lands on it.
        if model.shown.count > 1 {
            for (d, n) in model.shown { carry(model.windows(on: n), to: d) }
        }
        let parkedApps = parkedPids()
        let how = Concealment(plan: plan, owner: windows.mapValues(\.pid), alsoShown: waiting, neverHidden: parkedApps)
        let home = plan.show.compactMap { id -> (Window, CGRect)? in
            guard let frame = saved.frames[id], let w = windows[id] else { return nil }
            return (w, frame)
        }
        // Parked windows go home first, unseen; only then do their apps show.
        bringHome(home, screens: screens, gen: gen) { [self] in
        // From scanned (or fullscreen, after leaving full screen and scanning again) to here:
        // planning the switch, carrying windows between displays and bringing parked windows home.
        clock.mark(.home)
        // An app with a window here parks its other windows now, before it shows (a hidden one
        // parks them unseen), so they never linger among this workspace's windows.
        parkAlongside(how, screens: screens)
        clock.mark(.alongside)
        // An app on the parked list that BaneySpaces hid comes back once its windows from other
        // workspaces are parked, later in this switch (see `park`).
        // Going to a workspace shows its apps, even one hidden with ⌘H. An app on the other
        // display's workspace comes back only if BaneySpaces hid it: one you hid stays hidden.
        let going = Set(model.windows(on: model.current).compactMap { windows[$0]?.pid }).union(waiting)
        for pid in how.showApps where going.contains(pid) || saved.hiddenApps.contains(pid) {
            if let app = NSRunningApplication(processIdentifier: pid), app.isHidden { app.unhide() }
            saved.hiddenApps.remove(pid)
        }
        // A hidden app that didn't answer couldn't move its windows home; now shown, it may.
        // Even one that animates its moves: a slide beats a window missing from its workspace.
        for (w, frame) in home where saved.frames[w.id] != nil {
            if restore(w, to: frame, screens: screens) { saved.frames[w.id] = nil }
        }
        clock.mark(.unhidden)
        // 2. Everything else leaves at once, except the app in front. Hiding a background app
        //    changes nothing about focus, so there's no reason to wait for it.
        let deferred: Set<pid_t> = moveFocus ? Set([oldFront].compactMap { $0 }).intersection(how.hideApps) : []
        // Our own hides are announced a moment later; they aren't an app you closed.
        ownHides = how.hideApps.union(Date() < ownHidesUntil ? ownHides : [])
        ownHidesUntil = Date().addingTimeInterval(1)
        let leavingParked: pid_t? = moveFocus ? oldFront.flatMap { parkedApps.contains($0) && !how.showApps.contains($0) ? $0 : nil } : nil
        conceal(how, apps: how.hideApps.subtracting(deferred), screens: screens)
        clock.mark(.concealed)
        // 3. Focus moves to this workspace. Only then does the old front app hide: hiding the app
        //    in front makes macOS activate another app on its own, which would look like the
        //    person picking it.
        let target = ([plan.focus].compactMap { $0 } + plan.show)
            .compactMap { windows[$0] }.first { !$0.isMinimized && saved.frames[$0.id] == nil }
        let frontPid = target?.pid ?? getpid()
        if moveFocus { expectedFront = frontPid }
        var raised = false
        if moveFocus {
            if let target {
                emptyHolder.orderOut(nil)
                raised = target.focus()
                if raised { lastKey[target.pid] = target.id; intended[target.pid] = nil } else {
                    // The app may come forward on its own a moment later, focusing whatever window
                    // it used last. Until the raise lands, that isn't the person choosing it.
                    intended[target.pid] = (target.id, Date().addingTimeInterval(2))
                }
            } else {
                takeFocus()
            }
        }
        clock.mark(.shown)
        let done = { [self] in
            guard gen == generation, active else { return ScreenHold.end() }
            clock.mark(.focused)
            // An app busy coming back from hiding can miss the raise. Try again once it has had
            // a moment, unless another switch came first.
            if moveFocus, !raised, let target {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [self] in
                    guard gen == generation, active, target.focus() else { return }
                    lastKey[target.pid] = target.id
                    intended[target.pid] = nil
                }
            }
            conceal(how, apps: deferred, screens: screens)
            // Hiding the app in front makes macOS activate the next one in line, often a parked
            // app whose window sits in the corner. That's this switch, not you picking it.
            if !deferred.isEmpty { leftAt = Date() }
            // A parked app isn't hidden, so nothing forces it out of the front. If it's still
            // there, its key window is out of sight: typing must not go into it.
            if let p = leavingParked, Windows.focusedPid() == p {
                if let target, target.focus() { lastKey[target.pid] = target.id } else { takeFocus() }
            }
            if moveFocus, target == nil, Windows.focusedPid() != getpid() {
                // Finder is the last resort, unless it was just hidden: activating a hidden app
                // brings back its windows from other workspaces.
                takeFocus(finderFallback: !how.hideApps.contains(Self.finderPid ?? -1))
            }
            if moveFocus, !deferred.isEmpty || leavingParked != nil || target == nil { handedOffAt = Date() }
            clock.mark(.done)
            ScreenHold.end()
            // Only a switch that really brought an app forward vouches for the next one's idea of
            // which app is in front.
            if moveFocus, Windows.focusedPid() == frontPid { settleUntil = Date().addingTimeInterval(0.3) }
            // Windows from other workspaces leave last, behind the ones now in front.
            park(how, parkedApps: parkedApps, screens: screens, gen: gen) { [self] in
                clock.mark(.parked)
                clock.log(to: Spaces.folder.appendingPathComponent("timing.log"))
                persist()
                finish()
            }
        }
        // Nothing left that depends on focus: finish now, without waiting a timer tick.
        // Nothing left that depends on focus: finish now. An empty workspace still waits for
        // BaneySpaces to be in front, or the Finder fallback would fire on stale information.
        let waitForFocus = !deferred.isEmpty || (moveFocus && target == nil) || leavingParked != nil
        if !waitForFocus || Windows.focusedPid() == frontPid { return done() }
        waitUntil(timeout: 0.5, interval: 0.01, { Windows.focusedPid() == frontPid }, then: done)
        }
    }

    private func enqueue(_ action: @escaping () -> Void) { queued.append(.action(action)) }

    /// Ends a switch and runs what queued up during it, in order, then one check of an
    /// activation BaneySpaces didn't cause.
    private func finish() {
        switching = false
        holding = false
        updateAttention()
        onChange?()
        // A scan asked for during the switch runs now that nothing is moving.
        startScan()
        while !switching, !queued.isEmpty {
            switch queued.removeFirst() {
            case let .switchTo(n, focus, announce): switchTo(n, takeFocus: focus, announce: announce)
            case let .action(run): run()
            }
        }
        followIfPending()
    }

    /// One check of an activation BaneySpaces didn't cause, once no switch runs.
    private func followIfPending() {
        guard !switching, followPending else { return }
        followPending = false
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != expectedFront { followFocus() }
    }

    private func conceal(_ how: Concealment, apps: Set<pid_t>, screens: [CGRect]) {
        // Apps with nothing here are hidden whole, as ⌘H does.
        for pid in apps {
            guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
            // hide() can report failure and still hide the app, so record every request.
            app.hide()
            saved.hiddenApps.insert(pid)
        }
        // A hidden app's parked windows can go home once it's off screen; nobody sees them move.
        let home = saved.frames.compactMap { id, frame in windows[id].flatMap { apps.contains($0.pid) ? ($0, frame) : nil } }
        guard !home.isEmpty else { return }
        waitUntil(timeout: 0.3, interval: 0.01, { Windows.allOffscreen(Set(home.map(\.0.id))) }) { [self] in
            for (w, frame) in home where saved.frames[w.id] == frame && saved.hiddenApps.contains(w.pid) {
                if restore(w, to: frame, screens: screens) { saved.frames[w.id] = nil }
            }
        }
    }

    /// Parks the windows of other workspaces that stay unhidden: their app has a window here, or
    /// it's kept usable by automation. Some apps (Chromium browsers like Helium) animate every
    /// move, so a window slides away only behind windows that hide its whole path. An app with
    /// nothing here hides for the moment its windows move instead; one with a window here moves
    /// in place.
    private func park(_ how: Concealment, parkedApps: Set<pid_t>, screens: [CGRect], gen: Int, then: @escaping () -> Void) {
        let spot = Geometry.hidingSpot(screens: screens)
        // Apps with a window here parked theirs already (`parkAlongside`).
        // On a native full-screen Space the window server lists only that Space, so "not listed" says nothing about a window.
        let inSight: Set<WindowID>? = DockSpaces.current().unsafe ? nil : Windows.onScreenIDs()
        let todo = how.park.compactMap { windows[$0] }.filter { !how.showApps.contains($0.pid) }.filter { w in
            // Hidden by its own app (a tool's reused window): nothing to park, and a record would say Polycarp put it away.
            saved.frames[w.id] != nil || saved.hiddenApps.contains(w.pid) || (inSight?.contains(w.id) ?? true)
                || (NSRunningApplication(processIdentifier: w.pid)?.isHidden ?? false)
        }.filter { w in
            !w.isMinimized && (saved.frames[w.id] == nil || w.frame.map { !Geometry.isStranded($0, screens: screens) } == true)
        }.filter { w in
            // Visible until now: remember where it stood. No readable frame, no parking.
            if saved.frames[w.id] == nil { saved.frames[w.id] = w.frame }
            return saved.frames[w.id] != nil
        }
        // A parked-list app BaneySpaces hid earlier (it was busy, or a park failed) parks while
        // still hidden, and shows once that worked, even with nothing left to park.
        let hiddenByUs = parkedApps.filter { pid in
            !how.showApps.contains(pid) && saved.hiddenApps.contains(pid) && NSRunningApplication(processIdentifier: pid)?.isHidden == true
                && !UnhideUndoesMoves.contains(pid)
        }
        guard !todo.isEmpty || !hiddenByUs.isEmpty else { return then() }
        let moving = Set(todo.map(\.id))
        let server = Windows.serverWindows()
        func path(_ w: Window) -> CGRect {
            (server[w.id]?.bounds ?? saved.frames[w.id] ?? .null).union(CGRect(origin: spot, size: CGSize(width: 1, height: 1)))
        }
        // Windows of apps hiding right now still read as on screen for a moment; they don't cover.
        let exposed = todo.filter { w in
            guard !UnhideUndoesMoves.contains(w.pid) else { return false }
            return hiddenByUs.contains(w.pid) || !Windows.isCovered(w.id, ignoring: moving, apps: how.hideApps, path: path(w))
        }
        let exposedIDs = Set(exposed.map(\.id))
        for w in todo where !exposedIDs.contains(w.id) { w.setOrigin(spot) }
        whileHidden(exposed, move: { exposed.forEach { $0.setOrigin(spot) } }) { [self] justHid in
            guard gen == generation, active else { return }
            let hid = justHid.union(hiddenByUs)
            settle(moving, screens: screens) { [self] in
                guard gen == generation, active else { return }
                // An app kept unhidden for automation can ignore the move, or stop answering.
                // Read it back: one whose window didn't park is hidden after all, rather than
                // left in sight on the wrong workspace.
                let bounds = Windows.serverWindows()
                var unparked = Set<pid_t>()
                for w in todo {
                    guard let b = bounds[w.id]?.bounds, !Geometry.isStranded(b, screens: screens) else { continue }
                    unparked.insert(w.pid)
                    // A window that never left stays home with no record. One that moved part
                    // way keeps its record, so it comes back where it stood.
                    if let f = saved.frames[w.id], abs(f.minX - b.minX) < 2, abs(f.minY - b.minY) < 2 { saved.frames[w.id] = nil }
                }
                for pid in unparked {
                    NSRunningApplication(processIdentifier: pid)?.hide()
                    saved.hiddenApps.insert(pid)
                }
                let reshown = hid.subtracting(unparked)
                for pid in reshown {
                    NSRunningApplication(processIdentifier: pid)?.unhide()
                    saved.hiddenApps.remove(pid)
                }
                then()
                recheckParked(todo.filter { reshown.contains($0.pid) }, spot: spot, screens: screens, gen: gen)
            }
        }
    }

    /// The read-back above is from before the unhide, and unhiding can undo the move: T3 Code's window jumped back 20 ms later and
    /// sat in sight on the wrong workspace. So look again once it's had time. One that came back is moved in plain sight, and
    /// remembered so it never goes through this again. One that still won't stay is hidden after all.
    private func recheckParked(_ moved: [Window], spot: CGPoint, screens: [CGRect], gen: Int) {
        guard !moved.isEmpty else { return }
        func back(_ list: [Window]) -> [Window] {
            let bounds = Windows.serverWindows()
            return list.filter { w in
                guard let b = bounds[w.id]?.bounds else { return false }
                return ParkRecheck.cameBack(b, screens: screens, wantedAway: model.workspace(of: w.id).map { !model.isShown($0) } == true)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + ParkRecheck.afterUnhide) { [self] in
            guard gen == generation, active else { return }
            let returned = back(moved)
            guard !returned.isEmpty else { return }
            for pid in Set(returned.map(\.pid)) { UnhideUndoesMoves.remember(pid) }
            Trace.log("parked: \(Set(returned.map(\.appName)).sorted().joined(separator: ", ")) came back when unhidden; moving in plain sight")
            returned.forEach { $0.setOrigin(spot) }
            DispatchQueue.main.asyncAfter(deadline: .now() + ParkRecheck.afterPlainMove) { [self] in
                guard gen == generation, active else { return }
                let stubborn = Set(back(returned).map(\.pid))
                guard !stubborn.isEmpty else { return }
                Trace.log("parked: still in sight after a plain move; hiding")
                ownHides.formUnion(stubborn)
                ownHidesUntil = Date().addingTimeInterval(1)
                for pid in stubborn {
                    NSRunningApplication(processIdentifier: pid)?.hide()
                    saved.hiddenApps.insert(pid)
                }
                persist()
            }
        }
    }

    /// Parks, in place and at once, the other windows of apps that have a window here. Hiding
    /// such an app would hide the window you came for, so these move where they are.
    private func parkAlongside(_ how: Concealment, screens: [CGRect]) {
        let spot = Geometry.hidingSpot(screens: screens)
        for id in how.park {
            guard let w = windows[id], how.showApps.contains(w.pid), !w.isMinimized,
                  saved.frames[id] == nil || w.frame.map({ !Geometry.isStranded($0, screens: screens) }) == true else { continue }
            if saved.frames[id] == nil {
                // Visible until now: remember where it stood. No readable frame, no parking.
                guard let f = w.frame else { continue }
                saved.frames[id] = f
            }
            w.setOrigin(spot)
        }
    }

    /// Brings parked windows back to where they stood, unseen. A window whose whole path is
    /// behind other windows moves in place, and so does one whose app has windows in sight
    /// (hiding it would make those blink). Any other moves while its app is hidden for a
    /// moment. Either way the move finishes before anything in front of it goes away.
    private func bringHome(_ moves: [(Window, CGRect)], screens: [CGRect], gen: Int, then: @escaping () -> Void) {
        // A window whose app doesn't answer can't move now; it isn't waited for.
        let targets = moves.compactMap { w, frame -> (Window, CGRect)? in
            w.frame.map { (w, Geometry.restoreFrame(saved: frame, size: $0.size, screens: screens)) }
        }
        guard !targets.isEmpty else { return then() }
        let moving = Set(targets.map(\.0.id))
        let server = Windows.serverWindows()
        let inSight = Windows.pidsInSight(screens: screens)
        let exposed = targets.filter { w, to in
            if NSRunningApplication(processIdentifier: w.pid)?.isHidden == true { return true }
            return !inSight.contains(w.pid) && !Windows.isCovered(w.id, ignoring: moving, apps: [], path: (server[w.id]?.bounds ?? .null).union(to))
        }
        let exposedIDs = Set(exposed.map(\.0.id))
        func place(_ list: [(Window, CGRect)]) {
            for (w, to) in list { w.place(to, currentSize: w.frame?.size ?? to.size) }
        }
        place(targets.filter { !exposedIDs.contains($0.0.id) })
        whileHidden(exposed.map(\.0), move: { place(exposed) }) { [self] hid in
            guard gen == generation, active else { return }
            let goal = Dictionary(uniqueKeysWithValues: targets.map { ($0.0.id, $0.1.origin) })
            settle(moving, targets: goal, screens: screens) { [self] in
                guard gen == generation, active else { return }
                // A busy app can drop the move: the window only counts as shown once it's on
                // screen. Otherwise it stays parked in the record and the next switch tries again.
                let bounds = Windows.serverWindows()
                for (w, _) in targets where bounds[w.id]?.bounds.map({ !Geometry.isStranded($0, screens: screens) }) == true {
                    saved.frames[w.id] = nil
                }
                for pid in hid {
                    NSRunningApplication(processIdentifier: pid)?.unhide()
                    saved.hiddenApps.remove(pid)
                }
                then()
            }
        }
    }

    /// Hides the apps of `windows` that are showing, runs `move` once the window server has
    /// them off screen, and hands back the apps it hid for the caller to show again. They're
    /// recorded as hidden meanwhile, so a quit or crash mid-switch still brings them back.
    private func whileHidden(_ windows: [Window], move: @escaping () -> Void, then: @escaping (Set<pid_t>) -> Void) {
        guard !windows.isEmpty else { return then([]) }
        let apps = Set(windows.map(\.pid)).compactMap { NSRunningApplication(processIdentifier: $0) }.filter { !$0.isHidden }
        let hid = Set(apps.map(\.processIdentifier))
        ownHides.formUnion(hid)
        ownHidesUntil = Date().addingTimeInterval(1)
        saved.hiddenApps.formUnion(hid)
        if !hid.isEmpty { persist() }
        apps.forEach { $0.hide() }
        let ids = Set(windows.map(\.id))
        waitUntil(timeout: 0.3, interval: 0.01, { Windows.allOffscreen(ids) }) {
            move()
            then(hid)
        }
    }

    /// Waits until each window has stopped where it was sent: exactly at its target when one is
    /// given, otherwise anywhere parked, still for 50 ms. Some apps animate a move over several
    /// frames; an app whose window was still changing position after 0.12 s is remembered in
    /// `SlowMovers` and hidden instead of parked from then on. Gives up after 0.4 s.
    private func settle(_ ids: Set<WindowID>, targets: [WindowID: CGPoint] = [:], screens: [CGRect], then: @escaping () -> Void) {
        guard !ids.isEmpty else { return then() }
        var last: [WindowID: CGRect] = [:]
        var stillSince: [WindowID: Date] = [:]
        var slow: Set<WindowID> = []
        let start = Date()
        waitUntil(timeout: 0.4, interval: 0.01, {
            let now = Windows.serverWindows().compactMapValues(\.bounds).filter { ids.contains($0.key) }
            let t = Date()
            // Only position counts: an app snapping its size to a grid isn't animating a move.
            for (id, b) in now where last[id]?.origin != b.origin {
                // A position between two others, late: the app is animating.
                if last[id] != nil, t.timeIntervalSince(start) > 0.12 { slow.insert(id) }
                stillSince[id] = t
            }
            last = now
            return ids.allSatisfy { id in
                guard let b = now[id] else { return true }
                if let to = targets[id], abs(b.minX - to.x) < 1, abs(b.minY - to.y) < 1 { return true }
                let still = t.timeIntervalSince(stillSince[id] ?? start) >= 0.05
                return still && (targets[id] == nil ? Geometry.isStranded(b, screens: screens) : !Geometry.isStranded(b, screens: screens))
            }
        }, then: { [self] in
            for pid in Set(slow.compactMap { windows[$0]?.pid }) {
                guard let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier, !SlowMovers.bundleIDs.contains(id) else { continue }
                SlowMovers.bundleIDs.insert(id)
                Trace.log("slow mover: \(id) animates its moves; hiding it instead of parking")
            }
            then()
        })
    }

    /// Brings a parked window back and reads it back. A busy app can drop the move, so the
    /// window only counts as shown once it is actually on screen; otherwise it stays parked in
    /// the record and the next switch tries again.
    private func restore(_ w: Window, to frame: CGRect, screens: [CGRect]) -> Bool {
        guard let f = w.frame else { return false }
        w.place(Geometry.restoreFrame(saved: frame, size: f.size, screens: screens), currentSize: f.size)
        guard let now = w.frame else { return false }
        return !Geometry.isStranded(now, screens: screens)
    }

    /// Called when BaneySpaces stops being the active app: the holder's job is over.
    func dropEmptyHolder() { emptyHolder.orderOut(nil) }

    private lazy var emptyHolder: NSPanel = {
        let p = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.alphaValue = 0.01
        p.ignoresMouseEvents = true
        p.hasShadow = false
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        return p
    }()

    private static var finderPid: pid_t? {
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first?.processIdentifier
    }

    /// Nothing on this workspace can take focus, so BaneySpaces takes it and typing goes nowhere.
    /// If macOS won't hand it over, Finder gets it, as on an empty Mac desktop.
    private func takeFocus(finderFallback: Bool = false) {
        Windows.makeFrontmost(getpid())
        NSApp.activate(ignoringOtherApps: true)
        // An app with no window loses focus to whatever macOS picks next, which would pull the
        // person off the empty workspace. A clear, click-through window keeps focus here.
        emptyHolder.orderFrontRegardless()
        emptyHolder.makeKey()
        guard finderFallback, Windows.focusedPid() != getpid(), let finder = Self.finderPid else { return }
        Windows.makeFrontmost(finder)
    }

    // MARK: Displays

    /// Tells the model which displays are connected now. After a change, windows macOS moves
    /// for it aren't taken for ones you dragged, for `displaysSettle`.
    private func noteDisplays() {
        let keys = Windows.displays().map(\.key)
        let before = (model.order, model.shown)
        model.reserved = Self.agentWorkspace.map { [$0] } ?? []
        model.displays(keys)
        guard model.order != before.0 || model.shown != before.1 else { return }
        displaysSettleUntil = Date().addingTimeInterval(Self.displaysSettle)
        Trace.log("displays \(model.shown.sorted { $0.value < $1.value }.map { "\($0.key.prefix(8))=\($0.value)" })")
    }

    /// The display under the pointer is the one you're on: a click there (on a window, the
    /// desktop, the Workspace Dock or the overview) makes it the one ⌘1–⌘9 change. Going by the
    /// window in front alone, the dock on the iPad switched the laptop (Donovan, 2026-10-28).
    func usePointerDisplay() {
        useDisplay(of: NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
    }

    /// The display a BaneySpaces panel sits on (the Workspace Dock) is the one its actions change.
    func useDisplay(of screen: NSScreen?) { use(display: screen.flatMap(Windows.key(of:))) }

    /// Makes display `key` the one ⌘1–⌘9 change. During a switch it waits its turn in the queue,
    /// ahead of whatever the same press asks for next, so a dock tile pressed mid-switch still
    /// switches the dock's display.
    func use(display key: DisplayKey?) {
        guard active, model.shown.count > 1, let key, model.shown[key] != nil else { return }
        if switching { return enqueue { [weak self] in self?.use(display: key) } }
        guard key != model.focusedDisplay else { return }
        model.focus(display: key)
        Trace.log("display in use: \(key.prefix(8)) showing \(model.current)")
        onChange?()
        persist()
    }

    /// The workspace a screen shows (the current one with a single display).
    func workspace(onScreen s: NSScreen?) -> Int {
        s.flatMap(Windows.key(of:)).flatMap { model.shown[$0] } ?? model.current
    }

    /// How long after displays change that windows moving between them are macOS's doing.
    private static let displaysSettle: TimeInterval = 3
    private var displaysSettleUntil = Date.distantPast

    /// Windows on a shown workspace that sit on another display (macOS put them there when a
    /// display came or went) go to their workspace's display.
    private func returnToDisplays() {
        guard model.shown.count > 1 else { return }
        let displays = Windows.displays()
        let frames = Dictionary(displays.map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
        for w in windows.values where saved.frames[w.id] == nil && !w.isMinimized {
            guard let n = model.workspace(of: w.id), let d = model.display(showing: n), let f = w.frame,
                  let at = Geometry.display(of: f, in: frames), at != d,
                  let from = displays.first(where: { $0.key == at }), let to = displays.first(where: { $0.key == d }) else { continue }
            w.place(Geometry.carry(f, from: from.visible, to: to.visible), currentSize: f.size)
            Trace.log("window \(w.id) of \(w.appName) back to the display showing \(n)")
        }
    }

    /// The window with focus is on display `d`'s workspace: that display is the one ⌘N changes.
    /// Returns whether the focused display changed (and `onChange` fired).
    @discardableResult
    private func noteFocusedDisplay(of id: WindowID) -> Bool {
        guard model.shown.count > 1, let n = model.workspace(of: id), n != Self.agentWorkspace,
              let d = model.display(showing: n), d != model.focusedDisplay else { return false }
        model.focus(display: d)
        onChange?()
        return true
    }

    /// Windows you dragged onto another display join the workspace that display shows. Parked
    /// windows (off every display) and minimized ones are left alone.
    ///
    /// Only movement seen counts as a drag: a window last seen on its workspace's display that's
    /// now on another. One that turns up on the wrong display without being seen leave its own (a
    /// carry that didn't land while its app was hidden) goes back to its display instead of
    /// changing workspace. With `act` false (right after displays changed) it only takes note.
    /// `bounds` and `minimized` come from the window server and the scan, so nothing here asks an app until a window
    /// really has to move back.
    private func noteMovedAcrossDisplays(_ list: [Window], frames: [DisplayKey: CGRect], act: Bool,
                                         bounds: (WindowID) -> CGRect?, minimized: (WindowID) -> Bool) {
        seenOn = seenOn.filter { windows[$0.key] != nil }
        var moved = false
        let displays = Windows.displays()
        for w in list where saved.frames[w.id] == nil && !minimized(w.id) {
            guard let n = model.workspace(of: w.id), model.isShown(n), let f = bounds(w.id),
                  let d = Geometry.display(of: f, in: frames), let mine = model.display(showing: n) else { continue }
            let before = seenOn[w.id]
            seenOn[w.id] = d
            guard act, d != mine else { continue }
            if before == mine {
                if model.moved(w.id, to: d) {
                    Trace.log("window \(w.id) of \(w.appName) moved to the display showing \(model.shown[d] ?? 0)")
                    moved = true
                }
            } else if let from = displays.first(where: { $0.key == d }), let to = displays.first(where: { $0.key == mine }) {
                w.place(Geometry.carry(f, from: from.visible, to: to.visible), currentSize: f.size)
                seenOn[w.id] = mine
                Trace.log("window \(w.id) of \(w.appName) back to the display showing \(n) (it wasn't dragged there)")
            }
        }
        if moved { persist() }
    }
    /// The display each window in sight was on at the last look.
    private var seenOn: [WindowID: DisplayKey] = [:]

    /// `frame` on the display showing workspace `n`: carried there if it's on another one.
    private func onDisplayOf(_ n: Int, _ frame: CGRect) -> CGRect {
        let displays = Windows.displays()
        let frames = Dictionary(displays.map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
        guard let d = model.display(showing: n), let to = displays.first(where: { $0.key == d }),
              let fromKey = Geometry.display(of: frame, in: frames), fromKey != d,
              let from = displays.first(where: { $0.key == fromKey }) else { return frame }
        return Geometry.carry(frame, from: from.visible, to: to.visible)
    }

    /// Moves `ids` that sit on another display onto display `d`, never in sight: a parked
    /// window's record changes, and a window whose app BaneySpaces hid moves while hidden.
    /// Anything else is on screen already and stays put.
    private func carry(_ ids: [WindowID], to d: DisplayKey) {
        let displays = Windows.displays()
        let frames = Dictionary(displays.map { ($0.key, $0.frame) }, uniquingKeysWith: { a, _ in a })
        guard let to = displays.first(where: { $0.key == d }) else { return }
        func across(_ f: CGRect) -> CGRect? {
            guard let k = Geometry.display(of: f, in: frames), k != d, let from = displays.first(where: { $0.key == k }) else { return nil }
            return Geometry.carry(f, from: from.visible, to: to.visible)
        }
        for id in ids {
            if let f = saved.frames[id] {
                if let moved = across(f) { saved.frames[id] = moved }
            } else if let w = windows[id], let f = w.frame, NSRunningApplication(processIdentifier: w.pid)?.isHidden == true,
                      let moved = across(f) {
                w.place(moved, currentSize: f.size)
            }
        }
    }

    /// Saves the parked-window record and state.json. The snapshot is taken here; the disk
    /// writes happen off the main thread so they never delay a switch.
    private func persist() {
        let frames = saved
        // state.json is for scripts and checks: the current workspace and where each window lives.
        let state: [String: Any] = [
            "current": model.current,
            // The workspace on each display, by display UUID (one entry with one display).
            "displays": model.shown,
            // The agent workspace (0 when off).
            "agentWorkspace": Self.agentWorkspace ?? 0,
            "parked": saved.frames.keys.sorted(),
            "hiddenApps": saved.hiddenApps.sorted(),
            // Apps the last scan couldn't read, and windows from the saved layout still waiting
            // for theirs: why a window might be missing.
            "unsure": (lastScan?.unsure ?? []).sorted().map { ["pid": $0, "answering": Windows.isResponsive($0)] as [String: Any] },
            "waiting": pendingLayout.keys.sorted(),
            "lastFocused": Dictionary(uniqueKeysWithValues: model.lastFocused.map { (String($0.key), $0.value) }),
            "workspaces": Dictionary(uniqueKeysWithValues: Workspaces.range.map { n in
                (String(n), model.windows(on: n).map { ["id": $0, "app": windows[$0]?.appName ?? ""] as [String: Any] })
            }),
        ]
        let known = model.home.compactMap { id, ws in windows[id].map { SavedLayout.Entry(window: id, pid: $0.pid, workspace: ws) } }
        let layout = SavedLayout(current: model.current,
                                 entries: known + pendingLayout.values.filter { model.workspace(of: $0.window) == nil },
                                 lastFocused: model.lastFocused, displays: model.shown)
        Spaces.writer.async {
            frames.save(to: Spaces.framesURL)
            layout.save(to: Spaces.layoutURL)
            if let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: Spaces.stateURL, options: .atomic)
            }
        }
    }

    /// Blocks until queued disk writes are done, for quitting.
    func flushWrites() { Spaces.writer.sync {} }

    /// `waitUntil` for a question that asks an app: each look runs off the main thread, one at a time, and `then` runs
    /// on the main thread once it says yes or time is up.
    private func waitOffMain(timeout: TimeInterval, interval: TimeInterval, _ done: @escaping () -> Bool, then: @escaping () -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func look() {
            DispatchQueue.main.asyncAfter(deadline: .now() + interval) {
                Spaces.axQueue.async {
                    let yes = done()
                    DispatchQueue.main.async { if yes || Date() > deadline { then() } else { look() } }
                }
            }
        }
        look()
    }

    private func waitUntil(timeout: TimeInterval, interval: TimeInterval, _ done: @escaping () -> Bool, then: @escaping () -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { timer in
            guard done() || Date() > deadline else { return }
            timer.invalidate()
            then()
        }
    }
}

final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// How long one switch takes, phase by phase. Appended to timing.log so speed changes are
/// measured on real use, not guessed.
struct SwitchClock {
    enum Phase: String { case snap, scanned, fullscreen, home, alongside, unhidden, concealed, shown, focused, done, parked }
    var target = 0
    /// The workspace being left: a switch to the one you're on (`bench.sh`) moves nothing.
    var from = 0
    var scan = "full"
    private let start = CFAbsoluteTimeGetCurrent()
    private var marks: [(Phase, Double)] = []

    init(target: Int = 0) { self.target = target }

    mutating func mark(_ p: Phase) { marks.append((p, (CFAbsoluteTimeGetCurrent() - start) * 1000)) }

    func log(to url: URL) {
        let parts = marks.map { "\($0.0.rawValue)=\(Int($0.1.rounded()))" }.joined(separator: " ")
        TimingLog.append("\(Int(Date().timeIntervalSince1970)) ws=\(target) from=\(from) scan=\(scan) \(parts)", to: url)
    }
}

/// The last 500 lines of timing.log.
enum TimingLog {
    private static let lock = NSLock()

    static func append(_ line: String, to url: URL) {
        lock.lock(); defer { lock.unlock() }
        var lines = ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        lines.append(line)
        try? (lines.suffix(500).joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
    }
}

/// How long something took to appear, from the moment it was asked for until AppKit has drawn it and returned to the run
/// loop. In timing.log as `open launcher=12`, so speed is measured on real use, not guessed.
struct OpenClock {
    private let what: String
    private let start = CFAbsoluteTimeGetCurrent()

    init(_ what: String) { self.what = what }

    /// Call when it's on screen. The file write happens off the main thread, so this adds nothing to the next open.
    func shown() {
        DispatchQueue.main.async { [what, start] in
            let ms = Int(((CFAbsoluteTimeGetCurrent() - start) * 1000).rounded())
            let url = Spaces.folder.appendingPathComponent("timing.log")
            DispatchQueue.global(qos: .utility).async {
                TimingLog.append("\(Int(Date().timeIntervalSince1970)) open \(what)=\(ms)", to: url)
            }
        }
    }
}

