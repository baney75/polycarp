import AppKit
import BaneySpacesCore

/// `BANEYSPACES_RENDER_BORDER_LAG=<seconds> Polycarp --render <folder>` measures how late a window border is while its
/// window moves. A second copy of this binary (`BANEYSPACES_BORDER_TARGET=<seconds>`) opens one plain window off every
/// display, where no one sees it, moves it 4 pt on every display frame, as a drag would, and writes down when it sent
/// each move. This copy puts the real border (`WindowBorders`, the app's code) around it and writes down when it moved
/// the border for each place. Both times are on the same clock, so the lag is exact: no sampling sits between, and
/// both windows then take the same path through the window server to the screen. Prints the median, p99 and worst in ms
/// and in frames at 120 Hz. Exits 1 when the p99 is over one frame.
@MainActor
enum BorderLagProbe {
    static let frame120 = 1000.0 / 120

    static func run(seconds: Double, folder: URL) -> Int32 {
        let me = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let log = folder.appendingPathComponent("border-target-moves.txt")
        try? FileManager.default.removeItem(at: log)
        let child = Process()
        child.executableURL = me
        child.arguments = ["--render", folder.path]
        var env = ProcessInfo.processInfo.environment
        env["BANEYSPACES_BORDER_TARGET"] = String(seconds + 1)
        env["BANEYSPACES_BORDER_TARGET_LOG"] = log.path
        env["BANEYSPACES_RENDER_BORDER_LAG"] = nil
        child.environment = env
        let out = Pipe()
        child.standardOutput = out
        do { try child.run() } catch { print("border lag: could not start the target window: \(error)"); return 2 }
        // The target ends on its own a second after the border stops, so its render run is a clean one (the crash ledger).
        func waitForTarget() {
            let until = Date().addingTimeInterval(5)
            while child.isRunning && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
            if child.isRunning { child.terminate() }
        }
        // Its first line is its window's number.
        var line = Data()
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline, !line.contains(UInt8(ascii: "\n")) {
            let d = out.fileHandleForReading.availableData
            if d.isEmpty { break }
            line.append(d)
        }
        guard let text = String(data: line, encoding: .utf8), let id = text.split(separator: " ").last.flatMap({ UInt32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }) else {
            waitForTarget(); print("border lag: the target window never said its number"); return 2
        }
        // The window server lists it once the target's run loop has drawn it.
        let listed = Date().addingTimeInterval(2)
        while BorderList.frames([id])[id] == nil, Date() < listed { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        guard BorderList.frames([id])[id] != nil else { waitForTarget(); print("border lag: the target window \(id) never showed in the window list"); return 2 }

        var border: [BorderLag.Move] = []
        WindowBorders.shared.probeMoved = { t, at in border.append(.init(t: t, at: CGPoint(x: at.x.rounded(), y: at.y.rounded()))) }
        WindowBorders.shared.pin(id, style: WindowBorderStyle(Appearance.shared.look))
        let start = ProcessInfo.processInfo.systemUptime
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
        let end = ProcessInfo.processInfo.systemUptime
        WindowBorders.shared.unpin()
        WindowBorders.shared.probeMoved = nil
        waitForTarget()

        let window = ((try? String(contentsOf: log, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { l -> BorderLag.Move? in
            let f = l.split(separator: " ").compactMap { Double($0) }
            guard f.count == 3 else { return nil }
            return .init(t: f[0], at: CGPoint(x: f[1], y: f[2]))
        }.filter { $0.t >= start + 0.2 && $0.t <= end }   // from once the border has its first place
        let lags = BorderLag.lags(window: window, border: border, end: end).map { $0 * 1000 }.sorted()
        guard lags.count > 20 else { print("border lag: only \(lags.count) moves (\(window.count) window, \(border.count) border)"); return 2 }
        func at(_ q: Double) -> Double { lags[min(lags.count - 1, Int(Double(lags.count) * q))] }
        let p99 = at(0.99)
        let pass = p99 <= frame120
        print(String(format: "border lag: %d window moves, %d border moves over %.0f s; median %.2f ms, p90 %.2f ms, p99 %.2f ms, "
                     + "worst %.2f ms; p99 %.2f frames at 120 Hz: %@", lags.count, border.count, seconds, at(0.5), at(0.9), p99,
                     lags.last!, p99 / frame120, pass ? "pass" : "FAIL"))
        return pass ? 0 : 1
    }

    /// The target: one plain window off every display, moved 4 pt each display frame for `seconds`. Prints its number
    /// first, and writes when it sent each move and where to (window-server coordinates) to `BANEYSPACES_BORDER_TARGET_LOG`.
    static func target(seconds: Double) -> Int32 {
        NSApp.setActivationPolicy(.accessory)
        let size = CGSize(width: 400, height: 300)
        // Far left of every display: the window server keeps its frame, and nothing is drawn where anyone looks.
        let left = (NSScreen.screens.map(\.frame.minX).min() ?? 0) - 6000
        let w = NSWindow(contentRect: CGRect(x: left, y: 200, width: size.width, height: size.height), styleMask: [.borderless],
                         backing: .buffered, defer: false)
        w.backgroundColor = .windowBackgroundColor
        w.collectionBehavior = [.managed, .ignoresCycle]
        w.orderFrontRegardless()
        print("target \(w.windowNumber)")
        fflush(stdout)
        let mover = Mover(window: w, left: left, top: NSScreen.screens.first?.frame.maxY ?? 0)
        let end = Date().addingTimeInterval(seconds)
        if #available(macOS 14, *), let screen = NSScreen.main {
            screen.displayLink(target: mover, selector: #selector(Mover.step)).add(to: .main, forMode: .common)
        } else {
            RunLoop.main.add(Timer(timeInterval: 1.0 / 120, target: mover, selector: #selector(Mover.step), userInfo: nil, repeats: true), forMode: .common)
        }
        while Date() < end { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
        if let path = ProcessInfo.processInfo.environment["BANEYSPACES_BORDER_TARGET_LOG"] {
            let text = mover.moves.map { String(format: "%.6f %.0f %.0f", $0.t, $0.at.x, $0.at.y) }.joined(separator: "\n")
            try? text.write(toFile: path, atomically: true, encoding: .utf8)
        }
        return 0
    }

    private final class Mover: NSObject {
        let window: NSWindow
        let left: CGFloat
        let top: CGFloat
        var step4 = 0
        var moves: [BorderLag.Move] = []
        init(window: NSWindow, left: CGFloat, top: CGFloat) { self.window = window; self.left = left; self.top = top }
        @objc func step() {
            step4 = (step4 + 1) % 500
            let origin = CGPoint(x: left + CGFloat(step4 * 4), y: 200 + CGFloat(step4 % 50))
            window.setFrameOrigin(origin)
            // The window server's y runs down from the primary display's top.
            moves.append(.init(t: ProcessInfo.processInfo.systemUptime,
                               at: CGPoint(x: origin.x.rounded(), y: (top - origin.y - window.frame.height).rounded())))
        }
    }
}
