import AppKit
import QuartzCore
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_SETTINGS_TIMING=<rounds> Polycarp --render <folder>` times the settings window offscreen (never
/// shown) and prints one line a pane: `open`, a new window's content built, laid out and drawn with that pane up; and
/// `switch`, the same window going to that pane from the one before; `idle`, a second of the open window's own reads
/// with nothing changed. Medians over the rounds, in ms. Then the reads opening the window sets off: the model's first
/// build, and `show`, the window taking the keyboard and the app coming forward.
///
/// `cpu` is the same open and switch as the main thread's own CPU time. On a busy Mac the wall clock also counts the time
/// the thread waited for a core; `scripts/settings-speed.sh` holds `cpu` to its recorded times, with one 60 Hz frame (16 ms)
/// as the goal, and prints both.
@MainActor
enum SettingsTiming {
    /// The reads opening the window sets off (`SetupWindowController.show` and its two observers).
    static let openReads: (SetupModel) -> Void = { m in m.readShown(opening: true); m.readShown(); m.readShown() }

    static func run(rounds: Int) -> Int32 {
        let first = ms { _ = SetupModel() }
        func model() -> SetupModel {
            let m = SetupModel()
            m.trusted = true; m.started = true; m.modifier = .command; m.conflicts = []; m.desktops = 1
            return m
        }
        // What the main thread pays before the window server can show the pane: the update, layout, display and the
        // Core Animation commit. The pixels are drawn by the window server, not here (a CPU `cacheDisplay` costs more
        // than the pane and is no part of the live window).
        func draw(_ host: NSView) {
            RunLoop.current.run(mode: .default, before: Date())
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            CATransaction.flush()
        }
        func window(_ m: SetupModel) -> (NSWindow, NSView) {
            let host = NSHostingView(rootView: SetupView(model: m, close: {}))
            let w = RenderWindow(contentRect: NSRect(origin: .zero, size: SettingsSidebar.windowSize), styleMask: [.borderless],
                                 backing: .buffered, defer: false)
            w.contentView = host
            host.frame = NSRect(origin: .zero, size: SettingsSidebar.windowSize)
            return (w, host)
        }
        // BANEYSPACES_RENDER_SETTINGS_LOOP=<pane> switches between Automation and that pane for 8 s, for `sample`.
        if let name = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_SETTINGS_LOOP"], let tab = SettingsTab(rawValue: name) {
            let m = model(), (_, host) = window(m), end = Date().addingTimeInterval(8)
            while Date() < end { m.tab = tab; draw(host); m.tab = .automation; draw(host) }
            return 0
        }
        var reads: [Double] = []
        for _ in 0..<max(1, rounds) { let m = model(); reads.append(ms { openReads(m) }) }
        var open: [SettingsTab: [Double]] = [:], change: [SettingsTab: [Double]] = [:], idle: [SettingsTab: [Double]] = [:]
        var openCPU: [SettingsTab: [Double]] = [:], changeCPU: [SettingsTab: [Double]] = [:]
        let tabs = SettingsTab.allCases
        for _ in 0..<max(1, rounds) {
            for tab in tabs {
                let m = model(); m.tab = tab
                var keep: (NSWindow, NSView)?
                let t = both { keep = window(m); draw(keep!.1) }
                open[tab, default: []].append(t.wall); openCPU[tab, default: []].append(t.cpu)
                keep?.0.contentView = nil
            }
            let m = model(), (w, host) = window(m)
            draw(host)
            for tab in tabs.dropFirst() + [tabs[0]] {
                let t = both { m.tab = tab; draw(host) }
                change[tab, default: []].append(t.wall); changeCPU[tab, default: []].append(t.cpu)
            }
            // `idle`: one second of the open window's own reads with nothing changed (`SetupModel.tick`, four a second).
            for tab in tabs {
                m.tab = tab; draw(host)
                idle[tab, default: []].append(ms { for _ in 0..<4 { m.tick(); draw(host) } })
            }
            w.contentView = nil
        }
        func median(_ v: [Double]) -> Double { let s = v.sorted(); return s[s.count / 2] }
        for tab in tabs {
            print(String(format: "settings %-12@ open %7.1f ms  switch %7.1f ms  idle %7.1f ms/s  cpu open %6.1f ms  cpu switch %6.1f ms",
                         tab.rawValue as NSString, median(open[tab] ?? [0]), median(change[tab] ?? [0]), median(idle[tab] ?? [0]),
                         median(openCPU[tab] ?? [0]), median(changeCPU[tab] ?? [0])))
        }
        print(String(format: "settings first model %.1f ms  open reads %.1f ms", first, median(reads)))
        return 0
    }

    /// Wall clock and this thread's CPU time for `f`, in ms.
    private static func both(_ f: () -> Void) -> (wall: Double, cpu: Double) {
        let c = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID), a = DispatchTime.now().uptimeNanoseconds
        f()
        let wall = Double(DispatchTime.now().uptimeNanoseconds - a) / 1e6
        return (wall, Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - c) / 1e6)
    }

    private static func ms(_ f: () -> Void) -> Double {
        let a = DispatchTime.now().uptimeNanoseconds; f(); return Double(DispatchTime.now().uptimeNanoseconds - a) / 1e6
    }
}
