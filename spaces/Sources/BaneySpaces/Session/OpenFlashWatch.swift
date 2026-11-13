import AppKit
import BaneySpacesCore
import ScreenCaptureKit

/// Runs `OpenFlashGuard.cover` around one `agent open` launch when it is set in defaults. The watch starts when the
/// launch hands back its process and covers only that process's windows (`OpenFlashGuard.Plan`). Trace lines carry ms
/// since the watch began, for the probe's numbers.
enum OpenFlashWatch {
    static var mode: OpenFlashGuard { .from(UserDefaults.standard.string(forKey: OpenFlashGuard.defaultsKey)) }
    /// The launches being watched, on the main thread, so a workspace switch can take their covers down.
    private static var live: [ObjectIdentifier: Launch] = [:]

    /// Runs `launch`, which must call `started` (on any thread) with what its completion handler got, before the claim.
    static func around(app: String, before: Set<pid_t>, agentShown: @escaping () -> Bool,
                       launch: @escaping (_ started: @escaping (NSRunningApplication?) -> Void) -> Void) {
        guard mode == .cover, !agentShown() else { return launch { _ in } }
        let screens = Windows.screens(), primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        // The screen as it was, taken before the launch so the new window isn't in it.
        capture(screens) { shots in
            DispatchQueue.main.async {
                guard let shots else {
                    Trace.log("flash guard cover: no shot of every display (Screen Recording off, or a capture failed); \(app) opens unguarded")
                    return launch { _ in }
                }
                let l = Launch(app: app, screens: screens, shots: shots, primaryHeight: primaryHeight, agentShown: agentShown)
                launch { got in DispatchQueue.main.async { l.started(got, before: before) } }
            }
        }
    }

    /// The agent workspace may be shown now: every launch drops its covers if so.
    static func environmentChanged() { for l in live.values { l.redraw() } }

    final class Launch {
        struct Key: Hashable { let id: UInt32, screen: Int }
        let app: String, screens: [CGRect], shots: [CGImage], primaryHeight: CGFloat, agentShown: () -> Bool
        private var pid: pid_t = 0
        private var want: [UInt32: CGRect] = [:]
        private var panels: [Key: (panel: NSPanel, frame: CGRect)] = [:]
        private var t0 = ProcessInfo.processInfo.systemUptime

        init(app: String, screens: [CGRect], shots: [CGImage], primaryHeight: CGFloat, agentShown: @escaping () -> Bool) {
            self.app = app; self.screens = screens; self.shots = shots; self.primaryHeight = primaryHeight; self.agentShown = agentShown
        }

        private func ms() -> Int { Int((ProcessInfo.processInfo.systemUptime - t0) * 1000) }

        /// On the main thread, before the claim runs: hold Spaces' asks to the new process and watch its windows.
        func started(_ got: NSRunningApplication?, before: Set<pid_t>) {
            guard let got, !got.isTerminated, !before.contains(got.processIdentifier) else {
                return Trace.log("flash guard cover: the launch of \(app) gave no new process; nothing to cover")
            }
            pid = got.processIdentifier
            t0 = ProcessInfo.processInfo.systemUptime
            Windows.hold(pid)
            OpenFlashWatch.live[ObjectIdentifier(self)] = self
            watch()
        }

        private func watch() {
            let pid = self.pid, t0 = self.t0
            var plan = OpenFlashGuard.Plan(pid: pid, screens: screens)
            let t = Thread { [self] in
                var released = false
                while true {
                    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                    let mine = info.compactMap { w -> OpenFlashGuard.Sighting? in
                        guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                              let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                              let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { return nil }
                        return .init(pid: pid, id: id, layer: (w[kCGWindowLayer as String] as? Int) ?? 0, bounds: b)
                    }
                    let alive = kill(pid, 0) == 0 || errno == EPERM
                    let step = plan.tick(now: ProcessInfo.processInfo.systemUptime - t0, windows: mine, alive: alive)
                    for id in step.expired { Trace.log("flash guard cover: down for window \(id) of \(app) after \(OpenFlashGuard.coverLife) s, not parked yet") }
                    let release = step.release && !released
                    released = released || step.release
                    if step.changed || release || step.end {
                        DispatchQueue.main.async { self.apply(step.covers, release: release, end: step.end) }
                    }
                    if step.end { break }
                    Thread.sleep(forTimeInterval: OpenFlashGuard.interval)
                }
            }
            t.name = "open-flash-guard"
            t.qualityOfService = .userInteractive
            t.start()
        }

        /// On the main thread: the covers wanted, never while the agent workspace is shown. A panel is re-cropped only
        /// when its window moved. The hold ends after the covers are up.
        func apply(_ covers: [UInt32: CGRect], release: Bool, end: Bool) {
            want = end ? [:] : covers
            redraw()
            if release || end || agentShown() { Windows.release(pid) }
            if end { OpenFlashWatch.live[ObjectIdentifier(self)] = nil }
        }

        func redraw() {
            var keep = Set<Key>()
            if !agentShown() {
                for (id, bounds) in want {
                    for part in OpenFlashGuard.coverParts(for: bounds, screens: screens) {
                        let key = Key(id: id, screen: part.screen)
                        keep.insert(key)
                        if let p = panels[key], p.frame == part.frame { continue }
                        let p = panels[key]?.panel ?? make()
                        paint(p, part.frame, screen: part.screen)
                        if panels[key] == nil { p.orderFrontRegardless(); Trace.log("flash guard cover: up for window \(id) of \(app) at +\(ms())ms") }
                        panels[key] = (p, part.frame)
                    }
                }
            }
            for (key, p) in panels where !keep.contains(key) {
                p.panel.orderOut(nil); panels[key] = nil
                Trace.log("flash guard cover: down for window \(key.id) of \(app) at +\(ms())ms")
            }
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
        /// nor brings Polycarp forward.
        private func make() -> NSPanel {
            let w = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            w.level = .floating; w.isOpaque = true; w.hasShadow = false; w.becomesKeyOnlyIfNeeded = true
            w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
            w.isReleasedWhenClosed = false
            let v = NSView(); v.wantsLayer = true; w.contentView = v
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
