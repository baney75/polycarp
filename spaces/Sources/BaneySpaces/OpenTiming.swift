import AppKit
import QuartzCore
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_OPEN_TIMING=<rounds> Polycarp --render <folder>` times what the launcher and the ⌘Tab switcher
/// draw: a cold open (a new view, laid out, displayed and committed) and one step of the selection in an open one, in
/// windows that are never shown. With `BANEYSPACES_RENDER_STYLE=<style.css>` it times the same with that sheet in force.
/// It prints the median and p90 of each, and the median of the instructions it took (which a busy Mac does not change), for a before and after of a drawing change.
@MainActor
enum OpenTiming {
    static func run(rounds: Int) -> Int32 {
        let icon = NSWorkspace.shared.icon(forFile: "/System/Applications/Utilities/Terminal.app")
        let launcher = LauncherModel(actions: LauncherActions())
        launcher.prepare(scope: .root)
        launcher.query = "a"
        let switcher = SwitcherModel()
        switcher.mode = .apps
        // Typed out: a slower compiler gave up inferring the closure.
        switcher.apps = (1...12).map { (n: Int) -> SwitcherModel.AppTile in
            let workspace: Int = (n - 1) % 9 + 1, windows: Int = n % 3 + 1
            return SwitcherModel.AppTile(pid: pid_t(n), name: "App \(n)", icon: icon, workspace: workspace, windows: windows, isSplit: n % 4 == 0)
        }
        // One unmeasured round of each warms the fonts and the icons.
        for _ in 0..<2 {
            _ = closing(open(LauncherView(model: launcher), NSSize(width: 700, height: 512)))
            _ = closing(open(SwitcherView(model: switcher), NSSize(width: 960, height: 280)))
        }
        var times: [(String, [Cost])] = []
        times.append(("launcher open", (0..<rounds).map { _ in closing(open(LauncherView(model: launcher), NSSize(width: 700, height: 512))) }))
        times.append(("switcher open", (0..<rounds).map { _ in closing(open(SwitcherView(model: switcher), NSSize(width: 960, height: 280))) }))
        let l = open(LauncherView(model: launcher), NSSize(width: 700, height: 512)).window
        let count = max(launcher.items.count, 1)
        times.append(("launcher step", (0..<rounds).map { r in step(l) { launcher.selected = (r + 1) % min(count, 6) } }))
        let s = open(SwitcherView(model: switcher), NSSize(width: 960, height: 280)).window
        times.append(("switcher step", (0..<rounds).map { r in step(s) { switcher.selected = (r + 1) % 12 } }))
        for (name, costs) in times {
            let sorted = costs.map(\.ms).sorted()
            let work = costs.map(\.work).sorted()
            print(String(format: "%@: median %.2f ms, p90 %.2f ms, %.2f M instructions, n %d", name,
                         sorted[sorted.count / 2], sorted[sorted.count * 9 / 10], work[work.count / 2], sorted.count))
        }
        return 0
    }

    private struct Cost {
        var ms = CACurrentMediaTime() * 1000
        /// Millions of instructions this process has retired.
        var work: Double = {
            var info = rusage_info_v4()
            let failed = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0) }
            }
            return failed == 0 ? Double(info.ri_instructions) / 1_000_000 : 0
        }()

        static func since(_ start: Cost) -> Cost {
            let now = Cost()
            return Cost(ms: now.ms - start.ms, work: now.work - start.work)
        }
    }

    private static func draw(_ w: NSWindow) {
        w.contentView?.layoutSubtreeIfNeeded()
        w.displayIfNeeded()
        CATransaction.flush()
    }

    private static func open(_ view: some View, _ size: NSSize) -> (cost: Cost, window: NSWindow) {
        let start = Cost()
        let w = RenderWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: view.environment(\.controlActiveState, .key))
        draw(w)
        return (.since(start), w)
    }

    /// Lets the window's view go, so it doesn't redraw with the next one (both watch the same model).
    private static func closing(_ opened: (cost: Cost, window: NSWindow)) -> Cost {
        opened.window.contentView = nil
        return opened.cost
    }

    private static func step(_ w: NSWindow, _ change: () -> Void) -> Cost {
        let start = Cost()
        change()
        // `objectWillChange` reaches the hosting view in this turn's update.
        RunLoop.current.run(until: Date())
        draw(w)
        return .since(start)
    }
}
