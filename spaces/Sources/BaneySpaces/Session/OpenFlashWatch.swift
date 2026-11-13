import AppKit
import BaneySpacesCore
import ScreenCaptureKit

/// Runs `OpenFlashGuard.cover` around one `agent open` launch when it is set in defaults. It watches the window server
/// from before the launch, so a window drawn before the launch's completion handler runs is caught too: the owner name
/// is the app's and the pid wasn't running before. Trace lines carry ms since the launch, for the probe's numbers.
enum OpenFlashWatch {
    static var mode: OpenFlashGuard { .from(UserDefaults.standard.string(forKey: OpenFlashGuard.defaultsKey)) }

    /// Runs `launch` (on the main thread), guarded when the cover is set and the agent workspace isn't the one shown.
    static func around(app: String, before: Set<pid_t>, agentShown: Bool, launch: @escaping () -> Void) {
        guard mode == .cover, !agentShown else { return launch() }
        let screens = Windows.screens(), primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        // The screen as it was, taken before the launch so the new window isn't in it.
        capture { shots in
            DispatchQueue.main.async {
                Windows.hold(OpenFlashGuard.Hold(app: app, before: Set(before), now: Date()))
                let covers = Covers(shots: shots, primaryHeight: primaryHeight, screens: screens)
                watch(app: app, before: before, screens: screens, covers: covers)
                launch()
            }
        }
    }

    private static func watch(app: String, before: Set<pid_t>, screens: [CGRect], covers: Covers) {
        let t0 = ProcessInfo.processInfo.systemUptime
        let ms: () -> Int = { Int((ProcessInfo.processInfo.systemUptime - t0) * 1000) }
        let t = Thread {
            var covered = Set<UInt32>()
            while ProcessInfo.processInfo.systemUptime - t0 < OpenFlashGuard.watchFor {
                let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                var inSight: [UInt32: CGRect] = [:]
                for w in info where (w[kCGWindowOwnerName as String] as? String) == app {
                    guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, !before.contains(pid),
                          let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                          let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }),
                          OpenFlashGuard.needsGuard(layer: (w[kCGWindowLayer as String] as? Int) ?? 0, bounds: b, screens: screens) else { continue }
                    inSight[id] = b
                }
                for id in inSight.keys where !covered.contains(id) { Trace.log("flash guard cover: window \(id) of \(app) in sight at +\(ms())ms") }
                let gone = covered.filter { inSight[$0] == nil }
                if !inSight.isEmpty || !gone.isEmpty { DispatchQueue.main.async { covers.show(inSight, dropping: gone, at: ms) } }
                covered.subtract(gone); covered.formUnion(inSight.keys)
                Thread.sleep(forTimeInterval: OpenFlashGuard.interval)
            }
            DispatchQueue.main.async { covers.show([:], dropping: Set(covers.windows.keys), at: ms); Windows.hold(nil) }
        }
        t.name = "open-flash-guard"
        t.qualityOfService = .userInteractive
        t.start()
    }

    private static func capture(_ done: @escaping ([(frame: CGRect, image: CGImage)]) -> Void) {
        guard CGPreflightScreenCaptureAccess(), #available(macOS 14, *) else { return done([]) }
        Task {
            var shots: [(CGRect, CGImage)] = []
            if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) {
                for d in content.displays {
                    let cfg = SCStreamConfiguration()
                    cfg.width = Int(CGDisplayPixelsWide(d.displayID)); cfg.height = Int(CGDisplayPixelsHigh(d.displayID))
                    cfg.showsCursor = false
                    if let img = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg) {
                        shots.append((CGDisplayBounds(d.displayID), img))
                    }
                }
            }
            done(shots)
        }
    }

    /// The panels over each new window, painted from the shot of the display it is on. Non-activating, and they take the
    /// clicks, so a click meant for what Donovan sees neither lands in the agent's app nor brings Polycarp forward.
    final class Covers {
        let shots: [(frame: CGRect, image: CGImage)], primaryHeight: CGFloat, screens: [CGRect]
        var windows: [UInt32: NSPanel] = [:]
        init(shots: [(frame: CGRect, image: CGImage)], primaryHeight: CGFloat, screens: [CGRect]) {
            self.shots = shots; self.primaryHeight = primaryHeight; self.screens = screens
        }
        func show(_ inSight: [UInt32: CGRect], dropping gone: Set<UInt32>, at ms: () -> Int) {
            for id in gone { windows.removeValue(forKey: id)?.orderOut(nil); Trace.log("flash guard cover: down for window \(id) at +\(ms())ms") }
            for (id, bounds) in inSight {
                guard let frame = OpenFlashGuard.coverFrame(for: bounds, screens: screens),
                      let shot = shots.first(where: { $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) }) else { continue }
                let w = windows[id] ?? make()
                let scale = CGFloat(shot.image.width) / shot.frame.width
                let crop = frame.offsetBy(dx: -shot.frame.minX, dy: -shot.frame.minY)
                let px = CGRect(x: crop.minX * scale, y: crop.minY * scale, width: crop.width * scale, height: crop.height * scale)
                w.contentView?.layer?.contents = shot.image.cropping(to: px.integral)
                w.setFrame(OpenFlashGuard.appKit(frame, primaryHeight: primaryHeight), display: false)
                if windows[id] == nil {
                    w.orderFrontRegardless(); windows[id] = w
                    Trace.log("flash guard cover: up for window \(id) at +\(ms())ms")
                    // Covered: Spaces may ask the app now, and the claim parks the window.
                    Windows.hold(nil)
                }
            }
        }
        private func make() -> NSPanel {
            let w = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            w.level = .floating; w.isOpaque = true; w.hasShadow = false; w.becomesKeyOnlyIfNeeded = true
            w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
            w.isReleasedWhenClosed = false
            let v = NSView(); v.wantsLayer = true; w.contentView = v
            return w
        }
    }
}
