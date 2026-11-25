import AppKit
import BaneySpacesCore
import Contacts
import SwiftUI

/// `BANEYSPACES_RENDER_LAUNCHER_TIMING=<rounds> Polycarp --render <folder>` times a launcher open on this Mac's own running
/// apps and windows, the panel built and opened before: `open` is what `OpenClock` logs, from the open being asked for
/// until the main thread is free again, and the lines under it are its steps, then the reads an open depends on, each on
/// its own. p50 and p90 over the rounds, in ms. The panel is clear, takes no click and never the keyboard. Run it with
/// `CFFIXED_USER_HOME` and `POLYCARP_CONFIG_DIR` set to a temporary folder, so it touches none of the installed app's files.
@MainActor
enum LauncherTiming {
    static func run(rounds: Int) -> Int32 {
        Trace.muted = true
        NSApp.setActivationPolicy(.accessory)
        let apps = ["Safari", "Calendar", "Mail", "Notes", "Music"].map { "/System/Applications/\($0).app" }
        UserDefaults.standard.register(defaults: ["launcherRecents": apps])
        let spaces = Spaces()
        // This Mac's windows, spread over the nine workspaces as a model would hold them. No app is asked.
        let owners = Windows.snapshot(apps: RunningApps.regular).onScreen.values.sorted()
        let model = LauncherModel(actions: actions(spaces) { n in owners.enumerated().filter { $0.offset % 9 == n - 1 }.map(\.element) })
        let size = NSSize(width: 700, height: 512)
        let panel = LauncherPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
                                  backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.alphaValue = 0
        panel.ignoresMouseEvents = true
        panel.contentView = NSHostingView(rootView: LauncherView(model: model).environment(\.colorScheme, .dark))
        spin(2)

        var steps: [(String, [Double])] = []
        func note(_ name: String, _ ms: Double) {
            if let i = steps.firstIndex(where: { $0.0 == name }) { steps[i].1.append(ms) } else { steps.append((name, [ms])) }
        }
        for round in 0...rounds {
            let started = now()
            model.prepare(scope: .root)
            let prepared = now()
            panel.setFrame(NSRect(origin: .zero, size: size), display: false)
            panel.contentView?.layoutSubtreeIfNeeded()
            let laidOut = now()
            panel.orderFrontRegardless()
            panel.displayIfNeeded()
            let shown = now()
            var free: Double?
            DispatchQueue.main.async { free = now() }
            while free == nil { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2)) }
            // The first round warms what a launch warms.
            if round > 0 {
                note("open", free! - started)
                note("  prepare", prepared - started)
                note("  layout", laidOut - prepared)
                note("  order front and draw", shown - laidOut)
                note("  until the main thread is free", free! - shown)
            }
            spin(0.7)
            panel.orderOut(nil)
            spin(0.7)
            let parts: [(String, () -> Void)] = [
                ("Contacts access", { _ = CNContactStore.authorizationStatus(for: .contacts) }),
                ("every running app's bundle path", { for a in NSWorkspace.shared.runningApplications { _ = a.bundleURL?.path } }),
                ("Spaces.refresh", { spaces.refresh() }),
                ("bangs.json", { _ = Launcher.loadBangs() }),
                ("rooms", { RoomsProvider.shared.refresh() }),
                ("the app in front", { _ = NSWorkspace.shared.frontmostApplication?.bundleIdentifier }),
            ]
            for (name, part) in parts {
                let at = now()
                part()
                if round > 0 { note("part: " + name, now() - at) }
                spin(0.05)
            }
        }
        print("launcher open, n=\(rounds), \(NSWorkspace.shared.runningApplications.count) running apps, \(owners.count) windows on screen")
        for (name, ms) in steps { print(TimingStats.line(name, ms)) }
        return 0
    }

    /// The launcher's reads as `AppDelegate` wires them, with the model's windows given.
    private static func actions(_ spaces: Spaces, _ pids: @escaping (Int) -> [pid_t]) -> LauncherActions {
        var a = LauncherActions()
        a.willShow = { _ = NSWorkspace.shared.frontmostApplication?.bundleIdentifier }
        a.workspacesByApp = { RunningApps.workspacesByPath(pids) }
        a.lookAgain = { done in
            RunningApps.prepare {
                spaces.refresh()
                done()
            }
        }
        a.restingApps = { done in
            RunningApps.prepare {
                RunningApps.prepare {
                    let running = RunningApps.forBackground(tracked: Set((1...9).flatMap(pids))) { _ in false }
                    done(BackgroundApps.list(running: running, trackedWindows: [], selfPID: getpid()))
                }
            }
        }
        a.sessionItems = { q in
            guard q.isEmpty else { return [] }
            return (1...3).map { i in
                LauncherItem(id: "session:\(i)", section: "Needs You", title: "Session \(i)", subtitle: "Terminal",
                             icon: .file("/System/Applications/Utilities/Terminal.app"), badge: "Done", run: {})
            }
        }
        return a
    }

    private static func spin(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
    private static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }
}
