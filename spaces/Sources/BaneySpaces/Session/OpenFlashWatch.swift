import AppKit
import BaneySpacesCore
import ScreenCaptureKit

/// Runs `OpenFlashGuard.cover` around one `agent open` launch when it is set in defaults. The watch starts when the
/// launch hands back its process and covers only that process's windows (`OpenFlashGuard.Plan`). Each queued cover
/// carries a `Ticket` and is raised only while it still holds. Trace lines carry ms since the watch began.
enum OpenFlashWatch {
    /// The app's own domain is `UserDefaults.standard` (`OpenFlashGuard.current`).
    static var mode: OpenFlashGuard { OpenFlashGuard.current() }
    /// The launches capturing or watching, on the main thread. One at a time holds the slot (`OpenFlashGuard.slotBusy`).
    private static var live: [UInt64: Launch] = [:]
    private static var launches: UInt64 = 0
    /// Bumped on every workspace switch (and macOS Space change): a cover from before it is never raised.
    private(set) static var workspaces: UInt64 = 0
    private static var lastShowing: OpenFlashGuard.Showing?
    private static var observing = false

    /// Runs `launch`, which must call `started` (on any thread) with what its completion handler got, before the claim.
    /// `showing` is what is on screen (read on main), `agent` the agent's workspace. Called on any thread: `agent open`
    /// comes from the hands engine's and the session socket's queues, so with the cover on everything after the flag
    /// runs on main (review of PR 213, first-F1). With it off the launch runs where it was called, as before.
    static func around(app: String, before: Set<pid_t>, showing: @escaping () -> OpenFlashGuard.Showing, agent: Int,
                       launch: @escaping (_ started: @escaping (NSRunningApplication?) -> Void) -> Void) {
        guard mode == .cover else { return launch { _ in } }
        OpenFlashGuard.onMain { guarded(app: app, before: before, showing: showing, agent: agent, launch: launch) }
    }

    private static func guarded(app: String, before: Set<pid_t>, showing: @escaping () -> OpenFlashGuard.Showing, agent: Int,
                                launch: @escaping (_ started: @escaping (NSRunningApplication?) -> Void) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !showing().contains(agent) else { return launch { _ in } }
        observe(showing())
        waitTurn(since: ProcessInfo.processInfo.systemUptime) { guarded in
            guard guarded else {
                Trace.log("flash guard cover: another guarded open still running after \(OpenFlashGuard.waitForTurn) s; \(app) opens unguarded")
                return launch { _ in }
            }
            guard !showing().contains(agent) else { return launch { _ in } }
            launches += 1
            let screens = Windows.screens(), primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            let l = Launch(gen: launches, workspaces: workspaces, app: app, screens: screens, primaryHeight: primaryHeight)
            live[l.gen] = l
            // The screen as it was, taken before the launch so the new window isn't in it, within `captureLimit`.
            l.shotAt = ProcessInfo.processInfo.systemUptime
            var fired = false
            let go: ([CGImage]?, String) -> Void = { shots, why in
                guard !fired else { return }
                fired = true
                guard let shots, l.workspaces == workspaces else {
                    live[l.gen] = nil
                    Trace.log("flash guard cover: \(shots == nil ? why : "a workspace switch during the capture"); \(app) opens unguarded")
                    return launch { _ in }
                }
                l.shots = shots
                launch { got in DispatchQueue.main.async { l.started(got, before: before) } }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + OpenFlashGuard.captureLimit) { go(nil, "no shot within \(Int(OpenFlashGuard.captureLimit * 1000)) ms") }
            capture(screens) { shots in DispatchQueue.main.async { go(shots, "no shot of every display (Screen Recording off, or a capture failed)") } }
        }
    }

    /// One guarded open at a time: waits for the one before it to finish, up to `waitForTurn`.
    private static func waitTurn(since: Double, _ body: @escaping (Bool) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        switch OpenFlashGuard.turn(busy: OpenFlashGuard.slotBusy(live.values.map(\.step)), waited: ProcessInfo.processInfo.systemUptime - since) {
        case .go: body(true)
        case .unguarded: body(false)
        case .wait: DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { waitTurn(since: since, body) }
        }
    }

    private static func observe(_ showing: OpenFlashGuard.Showing) {
        guard !observing else { return }
        observing = true
        lastShowing = showing
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
            switched()
        }
    }

    /// Spaces changed something (`spaces.onChange`): a switch, between any workspaces, ends every launch's covers. The
    /// whole map is compared, so two displays trading workspaces count (review of PR 213, sol-F2, second-F8).
    static func environmentChanged(showing: OpenFlashGuard.Showing) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard showing != lastShowing else { return }
        lastShowing = showing
        switched()
    }

    private static func switched() {
        workspaces &+= 1
        for l in live.values { l.finish(why: "a workspace switch") }
    }

    final class Launch {
        struct Key: Hashable { let id: UInt32, screen: Int }
        let gen: UInt64, workspaces: UInt64, app: String, screens: [CGRect], primaryHeight: CGFloat
        var shots: [CGImage] = [], shotAt = 0.0
        /// The last step main took (nil until the first): whether this launch holds the slot.
        private(set) var step: OpenFlashGuard.Plan.Step?
        private var up = false
        private var pid: pid_t = 0, incarnation: UInt64 = 0
        private var want: [UInt32: CGRect] = [:]
        private var panels: [Key: (panel: NSPanel, frame: CGRect)] = [:]
        private var t0 = ProcessInfo.processInfo.systemUptime
        /// The newest step from the watch thread, taken by one main-thread drain: a stale cover never runs after a
        /// later cleanup.
        private let lock = NSLock()
        private var mailbox: OpenFlashGuard.Plan.Step?
        private var cancelled = false

        init(gen: UInt64, workspaces: UInt64, app: String, screens: [CGRect], primaryHeight: CGFloat) {
            self.gen = gen; self.workspaces = workspaces; self.app = app; self.screens = screens; self.primaryHeight = primaryHeight
        }

        private func ms() -> Int { Int((ProcessInfo.processInfo.systemUptime - t0) * 1000) }
        private var ticket: OpenFlashGuard.Ticket { .init(launch: gen, workspaces: workspaces, incarnation: incarnation) }

        /// On the main thread, before the claim runs: hold Spaces' asks to the new process and watch its windows.
        func started(_ got: NSRunningApplication?, before: Set<pid_t>) {
            dispatchPrecondition(condition: .onQueue(.main))
            guard OpenFlashWatch.live[gen] === self else { return }
            guard let got, !got.isTerminated, !before.contains(got.processIdentifier),
                  let inc = Self.start(got.processIdentifier) else {
                return finish(why: "the launch gave no new process")
            }
            pid = got.processIdentifier
            incarnation = inc
            t0 = ProcessInfo.processInfo.systemUptime
            Windows.hold(pid)
            watch()
        }

        /// The kernel's start time of `pid`, nil once it has exited: a reused pid has another.
        static func start(_ pid: pid_t) -> UInt64? {
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
            return info.pbi_start_tvsec &* 1_000_000 &+ info.pbi_start_tvusec
        }

        private func watch() {
            let pid = self.pid, t0 = self.t0
            var plan = OpenFlashGuard.Plan(pid: pid, incarnation: incarnation, screens: screens)
            let t = Thread { [self] in
                while true {
                    lock.lock(); let stop = cancelled; lock.unlock()
                    if stop { break }
                    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                    let mine = info.compactMap { w -> OpenFlashGuard.Sighting? in
                        let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
                        guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                              let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                              let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { return nil }
                        return .init(pid: pid, id: id, layer: (w[kCGWindowLayer as String] as? Int) ?? 0, alpha: alpha, bounds: b)
                    }
                    let step = plan.tick(now: ProcessInfo.processInfo.systemUptime - t0, windows: mine, incarnation: Self.start(pid))
                    for id in step.expired { Trace.log("flash guard cover: down for window \(id) of \(app) after \(OpenFlashGuard.coverLife) s, not parked yet") }
                    if step.changed || step.end { post(step) }
                    if step.end { break }
                    Thread.sleep(forTimeInterval: step.idle ? OpenFlashGuard.idleInterval : OpenFlashGuard.interval)
                }
            }
            t.name = "open-flash-guard"
            t.qualityOfService = .userInteractive
            t.start()
        }

        /// Keeps only the newest step (an end in an older one is kept too) and wakes the main thread once. An older
        /// step's covers are dropped with it: nothing in a step ends the hold, only a cover main painted (sol-F1).
        private func post(_ step: OpenFlashGuard.Plan.Step) {
            lock.lock()
            var s = step
            s.end = step.end || (mailbox?.end ?? false)
            let wake = mailbox == nil
            mailbox = s
            lock.unlock()
            if wake { DispatchQueue.main.async { self.drain() } }
        }

        private func drain() {
            dispatchPrecondition(condition: .onQueue(.main))
            lock.lock(); let step = mailbox; mailbox = nil; lock.unlock()
            guard let step else { return }
            let ok = ticket.holds(live: Set(OpenFlashWatch.live.keys), workspaces: OpenFlashWatch.workspaces, incarnation: Self.start(pid))
            guard ok, !step.end else { return finish(why: ok ? "parked or done" : "its moment passed (switch, exit or a reused pid)") }
            self.step = step
            // A shot older than `shotLife` paints nothing: the window opens unguarded, and with no cover left to raise
            // the watch is over (review of PR 225, second-S1).
            let age = ProcessInfo.processInfo.systemUptime - shotAt
            if !OpenFlashGuard.shotFresh(age: age), !step.covers.isEmpty || step.idle {
                return finish(why: step.covers.isEmpty ? "the shot is too old for another cover"
                              : "unguarded: stale shot (\(Int(age * 1000)) ms old) for window \(step.covers.keys.sorted())")
            }
            want = step.covers
            if redraw() { CATransaction.flush() }
            // On the next turn, so a new cover is committed and drawn before Spaces may ask the app (a 0.25 s block):
            // asks are let through only while a cover main painted is up (sol-F1, first-F2).
            if up != !panels.isEmpty { up = !panels.isEmpty; let pid = self.pid, up = self.up; DispatchQueue.main.async { Windows.covered(pid, up) } }
        }

        /// Ends this launch: no more covers, the hold released (after the panels are gone), the watch stopped.
        func finish(why: String) {
            dispatchPrecondition(condition: .onQueue(.main))
            lock.lock(); cancelled = true; mailbox = nil; lock.unlock()
            guard OpenFlashWatch.live[gen] === self else { return }
            OpenFlashWatch.live[gen] = nil
            want = [:]
            _ = redraw()
            if pid != 0 { let pid = self.pid; DispatchQueue.main.async { Windows.release(pid) } }
            Trace.log("flash guard cover: \(app) watch over at +\(ms())ms: \(why)")
        }

        /// The covers in `want`, one panel per screen part, re-cropped only when the window moved. True when a panel went up.
        private func redraw() -> Bool {
            var keep = Set<Key>(), raised = false
            for (id, bounds) in want {
                for part in OpenFlashGuard.coverParts(for: bounds, screens: screens) {
                    let key = Key(id: id, screen: part.screen)
                    keep.insert(key)
                    if let p = panels[key], p.frame == part.frame { continue }
                    let p = panels[key]?.panel ?? make()
                    paint(p, part.frame, screen: part.screen)
                    if panels[key] == nil { p.orderFrontRegardless(); raised = true; Trace.log("flash guard cover: up for window \(id) of \(app) at +\(ms())ms") }
                    panels[key] = (p, part.frame)
                }
            }
            for (key, p) in panels where !keep.contains(key) {
                p.panel.orderOut(nil); panels[key] = nil
                Trace.log("flash guard cover: down for window \(key.id) of \(app) at +\(ms())ms")
            }
            return raised
        }

        /// Paints a panel from its own screen's shot, at the shot's backing scale.
        private func paint(_ p: NSPanel, _ frame: CGRect, screen i: Int) {
            let shot = shots[i], s = screens[i]
            let scale = CGFloat(shot.width) / s.width
            let crop = frame.offsetBy(dx: -s.minX, dy: -s.minY)
            let px = CGRect(x: crop.minX * scale, y: crop.minY * scale, width: crop.width * scale, height: crop.height * scale)
            p.contentView?.layer?.contentsScale = scale
            p.contentView?.layer?.contents = shot.cropping(to: px.integral)
            p.setFrame(OpenFlashGuard.appKit(frame, primaryHeight: primaryHeight), display: false)
        }

        /// Non-activating, and it takes the clicks, so a click meant for what Donovan sees neither lands in the agent's app
        /// nor brings Polycarp forward. Layer-hosting: the layer is ours, so AppKit never redraws over the shot.
        private func make() -> NSPanel {
            let w = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            w.level = NSWindow.Level(rawValue: OpenFlashGuard.coverLevel)
            w.isOpaque = true; w.hasShadow = false; w.becomesKeyOnlyIfNeeded = true
            w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
            w.isReleasedWhenClosed = false
            let v = NSView(), layer = CALayer()
            layer.contentsGravity = .resize
            v.layer = layer
            v.wantsLayer = true
            w.contentView = v
            return w
        }
    }

    /// One shot per screen, in `screens`' order, at each display's backing pixels; nil without Screen Recording or when
    /// any display has no shot.
    private static func capture(_ screens: [CGRect], _ done: @escaping ([CGImage]?) -> Void) {
        guard CGPreflightScreenCaptureAccess(), #available(macOS 14, *) else { return done(nil) }
        Task {
            var shots: [(frame: CGRect, image: CGImage)] = []
            if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) {
                for d in content.displays {
                    let cfg = SCStreamConfiguration()
                    let mode = CGDisplayCopyDisplayMode(d.displayID)
                    cfg.width = mode?.pixelWidth ?? Int(CGDisplayPixelsWide(d.displayID))
                    cfg.height = mode?.pixelHeight ?? Int(CGDisplayPixelsHigh(d.displayID))
                    cfg.showsCursor = false
                    if let img = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg) {
                        shots.append((CGDisplayBounds(d.displayID), img))
                    }
                }
            }
            // The same rect from AppKit and from CoreGraphics, to within a point.
            let ordered = screens.compactMap { s in shots.first { $0.frame.insetBy(dx: -1, dy: -1).contains(s) && s.insetBy(dx: -1, dy: -1).contains($0.frame) }?.image }
            done(ordered.count == screens.count && !screens.isEmpty ? ordered : nil)
        }
    }
}
