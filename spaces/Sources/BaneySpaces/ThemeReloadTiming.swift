import AppKit
import QuartzCore
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_THEME_RELOAD=<rounds> Polycarp --render <folder>` times a theme change end to end: from the moment
/// `polycarp theme set <name>` is started (the real command, with `POLYCARP_CONFIG_DIR` set to a fresh temp folder) to
/// the first frame of the ⌘Tab workspace switcher drawn in the new theme. The watcher is built and applied as `AppDelegate`
/// does (deliver on its queue, then `usePolycarp` on main); the switcher is the live `SwitcherView`, in a window that is
/// never shown.
/// A frame is the main thread's whole share: the update, layout, display and the Core Animation commit. One line a round,
/// then the median, p90 and worst. Exits 1 when any round takes 200 ms or more. `POLYCARP_CLI` names the command;
/// otherwise the first `polycarp` on PATH.
@MainActor
enum ThemeReloadTiming {
    static let budgetMs = 200.0

    static func run(rounds: Int) -> Int32 {
        guard let cli = command() else { print("theme reload: no polycarp command on PATH (set POLYCARP_CLI)"); return 2 }
        let config = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-reload-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: config) }
        func set(_ name: String) -> Process? {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: cli)
            p.arguments = ["theme", "set", name]
            var env = ProcessInfo.processInfo.environment
            env["POLYCARP_CONFIG_DIR"] = config.path
            p.environment = env
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            return (try? p.run()) != nil ? p : nil
        }
        // A real install already has its folder: the first set makes it, untimed.
        let names = ["evening", "parchment"]
        set(names[1])?.waitUntilExit()

        let watcher = PolycarpThemeWatcher(path: config.appendingPathComponent("current/theme.json").path) { theme in
            DispatchQueue.main.async { Appearance.shared.usePolycarp(theme) }
        }
        if case .theme(let t) = watcher.start(firstLookWithin: 0.5) { Appearance.shared.usePolycarp(t) }
        defer { watcher.stop() }

        let switcher = SwitcherModel()
        let icon = NSWorkspace.shared.icon(forFile: "/System/Applications/Utilities/Terminal.app")
        switcher.tiles = (1...4).map { n in .init(n: n, icons: [icon], count: 1, isCurrent: n == 1) }
        switcher.selected = 1
        let host = NSHostingView(rootView: SwitcherView(model: switcher))
        let size = CGSize(width: 820, height: 140)
        let window = RenderWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.frame = NSRect(origin: .zero, size: size)
        func draw() {
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            CATransaction.flush()
        }
        func pixels() -> Data? {
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
            host.cacheDisplay(in: host.bounds, to: rep)
            return rep.tiffRepresentation
        }
        draw()
        var last = pixels()

        var total: [Double] = [], toLand: [Double] = []
        var failed = false
        for i in 0..<max(1, rounds) {
            let name = names[i % 2]
            let t0 = DispatchTime.now().uptimeNanoseconds
            guard let p = set(name) else { print("theme reload: could not start \(cli)"); return 2 }
            let deadline = Date().addingTimeInterval(3)
            while Appearance.shared.polycarp?.name != name, Date() < deadline {
                RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.001))
            }
            let landed = DispatchTime.now().uptimeNanoseconds
            guard Appearance.shared.polycarp?.name == name else {
                print("theme reload: round \(i + 1) never landed (\(name))"); failed = true; p.waitUntilExit(); continue
            }
            draw()
            let framed = DispatchTime.now().uptimeNanoseconds
            p.waitUntilExit()
            // Untimed: the switcher really looks different from the round before.
            let now = pixels()
            let changed = now != nil && now != last
            last = now
            let ms = Double(framed - t0) / 1e6
            total.append(ms)
            toLand.append(Double(landed - t0) / 1e6)
            if !changed { failed = true }
            print(String(format: "theme reload %2d %-10@ %6.1f ms to the first switcher frame (landed %6.1f ms)%@", i + 1, name as NSString,
                         ms, toLand.last!, changed ? "" : "  FAIL: the switcher did not change"))
            if ms >= budgetMs { failed = true }
        }
        guard !total.isEmpty else { return 1 }
        let s = total.sorted()
        func at(_ q: Double) -> Double { s[min(s.count - 1, Int(Double(s.count) * q))] }
        print(String(format: "theme reload: %d sets, median %.1f ms, p90 %.1f ms, worst %.1f ms (budget %.0f ms): %@", s.count,
                     at(0.5), at(0.9), s.last!, budgetMs, failed ? "FAIL" : "pass"))
        return failed ? 1 : 0
    }

    private static func command() -> String? {
        let env = ProcessInfo.processInfo.environment
        if let c = env["POLYCARP_CLI"], FileManager.default.isExecutableFile(atPath: c) { return c }
        for dir in (env["PATH"] ?? "").split(separator: ":") {
            let c = "\(dir)/polycarp"
            if FileManager.default.isExecutableFile(atPath: c) { return c }
        }
        return nil
    }
}
