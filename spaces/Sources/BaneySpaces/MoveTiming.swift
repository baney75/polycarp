import AppKit
import BaneySpacesCore

/// `BANEYSPACES_RENDER_MOVE_TIMING=<rounds> Polycarp --render <folder>` times a switch's window reads and moves
/// (`WindowMoves`) on windows of its own: it starts `BANEYSPACES_RENDER_MOVE_APPS` helper copies of itself (4) with
/// `BANEYSPACES_RENDER_MOVE_WINDOWS` windows each (2), each answering Accessibility `BANEYSPACES_RENDER_MOVE_DELAY` ms late
/// (0), brings them home from the hiding spot and parks them again, and stops the helpers. Their windows are nearly clear,
/// take no click and sit below the normal level, so nothing shows and Polycarp manages none of them. AppKit keeps their title
/// bars on screen, so they park a bar's height above the hiding spot; `BANEYSPACES_RENDER_MOVE_FREE=1` makes windows that
/// go exactly there, as borderless ones do. `live reads` times the
/// same reads on this Mac's real windows; it moves none of those. Exits 1 when a helper window isn't where it was sent.
@MainActor
enum MoveTiming {
    static func run(rounds: Int) -> Int32 {
        Trace.muted = true
        let env = ProcessInfo.processInfo.environment
        func number(_ key: String, _ standard: Int) -> Int { env[key].flatMap(Int.init) ?? standard }
        let apps = number("BANEYSPACES_RENDER_MOVE_APPS", 4), each = number("BANEYSPACES_RENDER_MOVE_WINDOWS", 2)
        let delay = number("BANEYSPACES_RENDER_MOVE_DELAY", 0)
        let helpers = Helpers()
        defer { helpers.stop() }
        guard let windows = helpers.start(apps: apps, each: each, delay: delay) else { return 2 }
        let screens = Windows.screens(), spot = Geometry.hidingSpot(screens: screens)
        let home = Dictionary(uniqueKeysWithValues: windows.enumerated().map { i, w in
            (w.id, CGRect(x: 100 + 40 * Double(i), y: 120 + 30 * Double(i), width: 400, height: 300))
        })
        let ids = Set(windows.map(\.id))
        var homeMs: [Double] = [], homeMoves: [Double] = [], parkMs: [Double] = [], parkMoves: [Double] = []
        var lost = 0
        func wait(_ goal: Settling.Goal) {
            var done = false
            WindowMoves.settle(ids, goal: goal, screens: screens) { _ in
                done = true
                CFRunLoopStop(CFRunLoopGetMain())
            }
            while !done { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(1)) }
        }
        /// How many windows aren't where they were sent: home exactly, or out of sight.
        func astray(parked: Bool) -> Int {
            let server = Windows.serverWindows()
            return windows.filter { w in
                guard let b = server[w.id]?.bounds, let to = home[w.id]?.origin else { return true }
                return parked ? !Geometry.isStranded(b, screens: screens) : abs(b.minX - to.x) >= 1 || abs(b.minY - to.y) >= 1
            }.count
        }
        for round in 0...rounds {
            var at = now()
            // What `Spaces.park` and `bringHome` read of the window server, where they read it.
            _ = Windows.onScreenIDs()
            let states = WindowMoves.states(of: windows)
            _ = WindowMoves.bounds(of: ids)
            for w in windows { _ = Windows.isCovered(w.id, ignoring: ids, apps: [], path: home[w.id] ?? .zero) }
            WindowMoves.move(windows.filter { states[$0.id]?.frame != nil }, to: spot)
            let moved = now() - at
            wait(.parked(at: spot))
            _ = WindowMoves.bounds(of: ids)
            let parked = now() - at
            lost += astray(parked: true)
            spin(0.05)
            at = now()
            let targets = WindowMoves.targets(windows.map { ($0, home[$0.id] ?? .zero) }, screens: screens)
            _ = WindowMoves.bounds(of: ids)
            _ = Windows.pidsInSight(screens: screens)
            for w in windows { _ = Windows.isCovered(w.id, ignoring: ids, apps: [], path: home[w.id] ?? .zero) }
            WindowMoves.place(targets)
            let placed = now() - at
            wait(.home(Dictionary(uniqueKeysWithValues: targets.map { ($0.window.id, $0.to.origin) })))
            _ = WindowMoves.bounds(of: ids)
            let back = now() - at
            lost += astray(parked: false)
            spin(0.05)
            // The first round moves windows that were never parked.
            if round > 0 { parkMs.append(parked); parkMoves.append(moved); homeMs.append(back); homeMoves.append(placed) }
        }
        print("window moves, n=\(rounds), \(apps) helper apps with \(each) windows each, answering \(delay) ms late")
        print(TimingStats.line("bring home: until the moves are asked for", homeMoves))
        print(TimingStats.line("bring home: whole", homeMs))
        print(TimingStats.line("park: until the moves are asked for", parkMoves))
        print(TimingStats.line("park: whole", parkMs))
        // The apps in use, read only.
        let real = RunningApps.regular.flatMap(list)
        var reads: [Double] = []
        for _ in 0..<rounds {
            let at = now()
            _ = WindowMoves.states(of: real)
            reads.append(now() - at)
            spin(0.05)
        }
        print(TimingStats.line("live reads: \(real.count) windows of \(Set(real.map(\.pid)).count) apps", reads))
        if lost > 0 { print("move timing: \(lost) windows weren't where they were sent") }
        return lost == 0 ? 0 : 1
    }

    /// The copies of the app whose windows are moved.
    final class Helpers {
        private var running: [(process: Process, stop: Pipe)] = []

        func stop() { for h in running { h.stop.fileHandleForWriting.closeFile(); h.process.waitUntilExit() } }

        /// Their windows, or nil with the reason printed.
        @MainActor func start(apps: Int, each: Int, delay: Int) -> [Window]? {
            guard AXIsProcessTrusted() else { print("move timing: no Accessibility permission here"); return nil }
            var windows: [Window] = []
            for _ in 0..<apps {
                let p = Process(), stop = Pipe(), said = Pipe()
                p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
                p.arguments = ["--render", NSTemporaryDirectory()]
                p.environment = ProcessInfo.processInfo.environment.merging(["BANEYSPACES_RENDER_MOVE_HELPER": "\(each) \(delay)"]) { $1 }
                p.standardInput = stop
                p.standardOutput = said
                do { try p.run() } catch { print("move timing: \(error)"); return nil }
                running.append((p, stop))
                _ = said.fileHandleForReading.availableData
                windows += list(p.processIdentifier)
            }
            guard windows.count == apps * each else { print("move timing: \(windows.count) of \(apps * each) helper windows"); return nil }
            return windows
        }
    }

    /// A helper: its windows, until its standard input closes.
    static func help(_ asked: String) -> Int32 {
        let numbers = asked.split(separator: " ").compactMap { Int($0) }
        guard numbers.count == 2 else { return 64 }
        NSApp.setActivationPolicy(.accessory)
        LateWindow.delay = UInt32(numbers[1]) * 1000
        LateWindow.free = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_MOVE_FREE"] == "1"
        let windows = (0..<numbers[0]).map { i in
            let w = LateWindow(contentRect: NSRect(x: 100 + 40 * i, y: 200, width: 400, height: 272),
                               styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.title = "Polycarp move timing \(i)"
            w.alphaValue = 0.01
            w.hasShadow = false
            w.ignoresMouseEvents = true
            w.level = NSWindow.Level(rawValue: -1)
            w.orderBack(nil)
            return w
        }
        FileHandle.standardInput.readabilityHandler = {
            guard $0.availableData.isEmpty else { return }
            CrashLoop.renderEnded()
            exit(0)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { FileHandle.standardOutput.write(Data("ready\n".utf8)) }
        withExtendedLifetime(windows) { NSApp.run() }
        return 0
    }

    /// An app's windows as a scan would list them. A read that fails here is not held against the app.
    fileprivate static func list(_ pid: pid_t) -> [Window] {
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.25)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &raw) == .success else { return [] }
        return (raw as? [AXUIElement] ?? []).compactMap { el in
            AXUIElementSetMessagingTimeout(el, 0.25)
            return el.windowID.map { Window(id: $0, element: el, pid: pid, appName: "helper") }
        }
    }

    static func spin(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
    static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }
}

/// A window whose app is slow to answer: each Accessibility read or move of it takes `delay` µs on the app's main thread.
private final class LateWindow: NSWindow {
    static var delay: UInt32 = 0
    static var free = false
    override func constrainFrameRect(_ r: NSRect, to s: NSScreen?) -> NSRect { Self.free ? r : super.constrainFrameRect(r, to: s) }
    override func accessibilityFrame() -> NSRect { usleep(Self.delay); return super.accessibilityFrame() }
    override func setAccessibilityFrame(_ r: NSRect) { usleep(Self.delay); super.setAccessibilityFrame(r) }
    override func isAccessibilityMinimized() -> Bool { usleep(Self.delay); return super.isAccessibilityMinimized() }
    override func setFrameOrigin(_ p: NSPoint) { usleep(Self.delay); super.setFrameOrigin(p) }
}
