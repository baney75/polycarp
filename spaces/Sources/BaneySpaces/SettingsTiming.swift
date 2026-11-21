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
/// as the goal, and prints both. Open and switch are to a pane not built yet: the deck (`SettingsDeck`) builds none while
/// they are timed. `built` is a switch to a pane the deck already holds, and `step` the CPU time the deck took to build
/// that pane hidden, which is the most an input can wait while the deck fills. Last, `memory`: how much the process grew
/// with every pane built, against the window with one, and `first input`: the window opening on General plus the longest
/// step, the longest the first click after opening can wait.
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
        var builtCPU: [SettingsTab: [Double]] = [:], step: [SettingsTab: [Double]] = [:], stepWall: [Double] = []
        var grew: [Double] = []
        let tabs = SettingsTab.allCases
        let wasQuiet = SettingsDeck.quiet
        SettingsDeck.quiet = { false }   // the deck builds only when this run asks
        defer { SettingsDeck.quiet = wasQuiet }
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
            // Every pane is built now: a switch only shows one and hides another.
            for tab in tabs.dropFirst() + [tabs[0]] {
                builtCPU[tab, default: []].append(both { m.tab = tab; draw(host) }.cpu)
            }
            // `idle`: one second of the open window's own reads with nothing changed (`SetupModel.tick`, four a second).
            for tab in tabs {
                m.tab = tab; draw(host)
                idle[tab, default: []].append(ms { for _ in 0..<4 { m.tick(); draw(host) } })
            }
            w.contentView = nil
            // The deck filling a window opened on General, one hidden pane a step.
            let f = model(), (fw, fhost) = window(f)
            draw(fhost)
            let deck = findDeck(fhost), before = footprint()
            while let deck, !deck.complete {
                let t = both { deck.buildNext() }
                stepWall.append(t.wall)
            }
            if let deck { for (tab, ms) in deck.steps { step[tab, default: []].append(ms) } }
            draw(fhost)
            grew.append(Double(footprint() - before) / 1_048_576)
            fw.contentView = nil
        }
        func median(_ v: [Double]) -> Double { let s = v.sorted(); return s[s.count / 2] }
        for tab in tabs {
            print(String(format: "settings %-12@ open %7.1f ms  switch %7.1f ms  idle %7.1f ms/s  cpu open %6.1f ms  cpu switch %6.1f ms  cpu built %6.1f ms  step %6.1f ms",
                         tab.rawValue as NSString, median(open[tab] ?? [0]), median(change[tab] ?? [0]), median(idle[tab] ?? [0]),
                         median(openCPU[tab] ?? [0]), median(changeCPU[tab] ?? [0]), median(builtCPU[tab] ?? [0]), median(step[tab] ?? [0])))
        }
        // The first click can land as the deck starts its longest step.
        print(String(format: "settings memory %.1f MB  first input %.1f ms  (open General %.1f ms, longest step %.1f ms)",
                     median(grew), median(open[.general] ?? [0]) + (stepWall.max() ?? 0), median(open[.general] ?? [0]), stepWall.max() ?? 0))
        print(String(format: "settings first model %.1f ms  open reads %.1f ms", first, median(reads)))
        return 0
    }

    /// The deck in a window's view tree.
    private static func findDeck(_ view: NSView) -> SettingsDeck? {
        view as? SettingsDeck ?? view.subviews.lazy.compactMap(findDeck).first
    }

    /// The process's memory as Activity Monitor counts it (`phys_footprint`), in bytes.
    private static func footprint() -> Int64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let r = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return r == KERN_SUCCESS ? Int64(info.phys_footprint) : 0
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
