import AppKit
import Darwin

/// `Polycarp --bench-panels <folder>`: opens the app's own dock again and again and times each open the way
/// `OpenClock` does, from the ask until the main thread is back from the run loop turn that showed it. Four
/// runs of 12 opens: cold (the panel built anew, as after the dock is switched on) and warm, each alone and
/// beside hw.ncpu CPU-bound shells at nice 15 under `taskpolicy -b`, which is how builds run on the owner's Mac.
/// Each run goes to <folder>/<run>/timing.log as `open dock=` lines; scripts/panel-bench.sh judges every run
/// with scripts/speed-report.sh against spec/speed.json.
///
/// It runs only where CI=true: it puts panels on screen, and must never do that on someone's own session.
///
/// A shared runner has few windows and no app that is slow to answer, so its window list reads back at once.
/// A busy Mac's doesn't: `Windows.all` gives each app 0.25 s before it counts it unsure, and trace.log on the
/// owner's Mac shows scans of 141 to 273 ms on main beside slow opens ("slow scan: 256 ms on main, windows+0-1;
/// missed: Music"). The bench stands one such app in: every read of the window list for the dock waits 0.25 s more.
enum PanelBench {
    static let busyApp: TimeInterval = 0.25
    static let opens = 12

    static func run(dock: WorkspaceDock, spaces: Spaces, folder: URL) -> Never {
        guard ProcessInfo.processInfo.environment["CI"] == "true" else {
            FileHandle.standardError.write(Data("bench-panels: runs only where CI=true; it puts panels on screen\n".utf8))
            exit(2)
        }
        let trusted = AXIsProcessTrusted()
        if trusted { spaces.start() }
        dock.model.rescan = { s in
            s.refresh()
            Thread.sleep(forTimeInterval: busyApp)
        }
        dock.start()
        print("bench-panels: accessibility \(trusted ? "trusted" : "not trusted"), \(cpus()) CPUs,"
              + " a busy app adds \(Int(busyApp * 1000)) ms to each read of the window list")
        for spinning in [false, true] {
            let spinners = spinning ? spin() : []
            settle(1)
            for cold in [true, false] {
                let name = "dock-\(cold ? "cold" : "warm")-\(spinning ? "spinning" : "alone")"
                var ms: [Int] = [], phases: [String] = []
                for _ in 0..<opens {
                    if cold {
                        dock.dropPanelForBench()
                        settle(0.3)
                    }
                    ms.append(open(dock))
                    if let p = dock.lastOpen { phases.append("\(Int(p.load))+\(Int(p.layout))") }
                    dock.pin(false)
                    settle(0.4)
                }
                write(ms, to: folder.appendingPathComponent(name))
                print("\(name): open ms \(ms.map(String.init).joined(separator: " ")); load+layout ms \(phases.joined(separator: " "))")
            }
            spinners.forEach { $0.terminate() }
        }
        dock.stop(restoreSystemDock: true)
        exit(0)
    }

    /// One open, timed as `OpenClock` times it. The show queued OpenClock's block first; this one runs after it.
    private static func open(_ dock: WorkspaceDock) -> Int {
        let start = CFAbsoluteTimeGetCurrent()
        dock.pin(true)
        var ms: Int?
        DispatchQueue.main.async { ms = Int(((CFAbsoluteTimeGetCurrent() - start) * 1000).rounded()) }
        while ms == nil { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        // The slide-in ends, and whatever the open left for after it runs, before the next one.
        settle(0.6)
        return ms!
    }

    private static func settle(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private static func write(_ ms: [Int], to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let now = Int(Date().timeIntervalSince1970)
        let lines = ms.map { "\(now) open dock=\($0)\n" }.joined()
        try? lines.write(to: dir.appendingPathComponent("timing.log"), atomically: true, encoding: .utf8)
    }

    private static func cpus() -> Int {
        var n: Int32 = 0
        var size = MemoryLayout<Int32>.size
        sysctlbyname("hw.ncpu", &n, &size, nil, 0)
        return max(1, Int(n))
    }

    /// hw.ncpu shells that never stop, at nice 15 with background policy, as builds run on the owner's Mac.
    private static func spin() -> [Process] {
        (0..<cpus()).compactMap { _ in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/taskpolicy")
            p.arguments = ["-b", "/usr/bin/nice", "-n", "15", "/bin/sh", "-c", "while :; do :; done"]
            return (try? p.run()) != nil ? p : nil
        }
    }
}
