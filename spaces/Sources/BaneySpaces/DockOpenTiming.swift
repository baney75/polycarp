import AppKit
import BaneySpacesCore
import QuartzCore
import SwiftUI

extension DockOpenPhases {
    /// Runs `body` once, on the main run loop, right after the next Core Animation commit: the first frame of what
    /// was just changed has left the main thread.
    static func afterNextFrame(_ body: @escaping () -> Void) {
        // Core Animation commits at order 2000000 before the run loop waits; this runs after it.
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, 2_100_000) { _, _ in body() }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    }
}

/// `BANEYSPACES_RENDER_DOCK_OPEN=<rounds> Polycarp --render <folder>` times a Workspace Dock open the way
/// `WorkspaceDock.show(on:)` does it, with the dock's real panel, model and SwiftUI view in a window that is never
/// shown: 6 workspaces holding 25 apps (real icons from NSWorkspace), a 21-app Background tile, and this Mac's own
/// window server and running apps for the reads an open makes. Between opens the pointer rests on the edge for the
/// dwell, as it does before every open from the edge. A frame is the main thread's whole share: the
/// update, layout, display and the Core Animation commit. Prints the p50, p90 and worst open and each phase's p50
/// and p90, and exits 1 when the p90 is over `BANEYSPACES_DOCK_OPEN_BUDGET` ms (default `DockOpenPhases.budgetMs`).
/// `DockOpenSpeedTests` runs it.
@MainActor
enum DockOpenTiming {
    static func run(rounds: Int) -> Int32 {
        // It runs beside the installed app: nothing here may write to that app's trace.log.
        Trace.muted = true
        let budget = ProcessInfo.processInfo.environment["BANEYSPACES_DOCK_OPEN_BUDGET"].flatMap(Double.init) ?? DockOpenPhases.budgetMs
        let sample = Sample()
        guard sample.paths.count >= Sample.needed else {
            print("dock open: only \(sample.paths.count) apps found in /System/Applications, need \(Sample.needed)")
            return 2
        }
        let model = DockModel()
        model.edge = .bottom
        model.iconSource = { sample.icon($0) }
        let panel = WorkspaceDock.makePanel(model: model) {}
        guard let host = panel.contentView else { return 2 }
        let screen = CGSize(width: 1512, height: 982)

        func open() -> DockOpenPhases {
            let phases = DockOpenPhases()
            model.reset()
            model.forgetSide()
            model.shown = true
            model.maxLength = screen.width - 32
            phases.mark("reset")
            // `Spaces.refresh()`: the window server's list, which says whether a scan is due.
            _ = Windows.snapshot(apps: RunningApps.regular)
            phases.mark("refresh")
            model.loadTiles(entries: sample.entries, attention: [], current: 1, last: sample.last)
            phases.mark("tiles")
            // `Spaces.backgroundApps()`: this Mac's running apps, read as the Background tile reads them; the tile
            // shows the sample's 21.
            _ = RunningApps.hidden(among: RunningApps.regular)
            let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let showing = Set(info.compactMap { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value })
            let running = RunningApps.forBackground(tracked: []) { showing.contains($0) }
            _ = BackgroundApps.list(running: running, trackedWindows: [], selfPID: getpid())
            model.loadBackground(sample.background)
            phases.mark("background")
            // `Spaces.refreshHidden()`: which apps with windows are hidden.
            _ = RunningApps.hidden(among: RunningApps.regular)
            phases.mark("hidden")
            host.layoutSubtreeIfNeeded()
            phases.mark("layout")
            let size = host.fittingSize
            phases.mark("fit")
            panel.setFrame(NSRect(origin: .zero, size: size), display: false)
            phases.mark("order")
            // The first frame: what the rest of this run loop turn does, then the update, layout, display and commit.
            RunLoop.current.run(mode: .default, before: Date())
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            CATransaction.flush()
            phases.mark("draw")
            return phases
        }
        func hide() {
            model.reset()
            // The pointer comes back to the edge and rests there for the dwell before the dock comes, as
            // `WorkspaceDock.tick` sees it: whatever the last open left for later runs now, untimed.
            let dwell = Date().addingTimeInterval(DockEdge.bottom.dwell)
            while Date() < dwell {
                RunningApps.prepare()
                RunLoop.current.run(until: min(dwell, Date().addingTimeInterval(1.0 / 30)))
            }
        }

        // The panel is built once, on the first reveal, and stays: the first opens aren't the ones that count.
        for _ in 0..<3 { _ = open(); hide() }
        var opens: [DockOpenPhases] = []
        for _ in 0..<max(1, rounds) { opens.append(open()); hide() }

        let totals = opens.map(\.totalMs)
        func f(_ v: Double) -> String { String(format: "%.1f", v) }
        let p50 = DockOpenPhases.percentile(totals, 50), p90 = DockOpenPhases.percentile(totals, 90)
        print("dock open: \(opens.count) opens, \(sample.tileApps) apps on \(sample.entries.count) workspaces, \(sample.background.count) in the background: "
              + "p50 \(f(p50)) ms, p90 \(f(p90)) ms, worst \(f(totals.max() ?? 0)) ms (budget \(f(budget)) ms p90)")
        let names = opens.first?.phases.map(\.name) ?? []
        print("dock open phases (p50/p90 ms): " + names.map { name in
            let v = opens.map { $0.ms(name) }
            return "\(name) \(f(DockOpenPhases.percentile(v, 50)))/\(f(DockOpenPhases.percentile(v, 90)))"
        }.joined(separator: ", "))
        return p90 > budget ? 1 : 0
    }

    /// The sample dock: apps from /System/Applications, so every Mac (and CI) has them.
    final class Sample {
        static let needed = 46
        /// Apps per workspace: 25 in all.
        static let perWorkspace = [6, 5, 4, 4, 3, 3]
        let paths: [String]
        var entries: [Int: [Spaces.Entry]] = [:]
        var last: [Int: WindowID] = [:]
        var background: [BackgroundApps.Entry] = []
        var tileApps: Int { Self.perWorkspace.reduce(0, +) }
        /// Pids for sample apps start here, past any real one.
        static let firstPid: pid_t = 900_000

        init() {
            let fm = FileManager.default
            var found: [String] = []
            for dir in ["/System/Applications", "/System/Applications/Utilities"] {
                for name in ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).sorted() where name.hasSuffix(".app") {
                    found.append(dir + "/" + name)
                }
            }
            paths = found
            guard found.count >= Self.needed else { return }
            var app = 0, window: WindowID = 10_000
            for (i, count) in Self.perWorkspace.enumerated() {
                let n = i + 1
                var list: [Spaces.Entry] = []
                for _ in 0..<count {
                    let pid = Self.firstPid + pid_t(app)
                    let name = (found[app] as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
                    for w in 0..<(app % 3 + 1) {
                        window += 1
                        list.append(Spaces.Entry(id: window, pid: pid, app: name, title: "\(name) document \(w + 1)"))
                    }
                    app += 1
                }
                entries[n] = list
                last[n] = list.first?.id
            }
            background = (0..<21).map { b in
                let k = app + b
                let name = (found[k] as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
                return BackgroundApps.Entry(pid: Self.firstPid + pid_t(k), name: name, state: b % 3 == 0 ? .hidden : .noWindow)
            }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }

        /// What `NSRunningApplication.icon` gives a running app: the app's icon from NSWorkspace, a new image each time.
        func icon(_ pid: pid_t) -> NSImage? {
            let i = Int(pid - Self.firstPid)
            return paths.indices.contains(i) ? NSWorkspace.shared.icon(forFile: paths[i]) : nil
        }
    }
}
