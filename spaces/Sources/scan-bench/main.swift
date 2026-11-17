// What a window scan costs the main thread, on the apps running on this Mac now.
//
//   swift run -c release scan-bench                 20 scans, 0.5 s apart
//   swift run -c release scan-bench --rounds 50     more scans
//   swift run -c release scan-bench --hung          also asks a hung app: a windowless helper this bench starts, whose
//                                                   main thread never returns, so every ask of it runs out its deadline
//
// Each scan makes the same reads Polycarp's does (`AXScan`: each app's window list, then each window's subrole and
// modal flag) of every regular app that owns a window, from this process's main thread, and prints its `scan` line
// (`ScanCheck.Cost`): main= is how long the main thread waited, bg= the slowest app's read. It only reads: it moves,
// hides and focuses nothing, starts nothing but its own helper, and writes nothing to Polycarp's logs. The helper has no
// window and no Dock icon; it quits with the bench, or on its own once the bench is gone.
//
// Needs Accessibility for the app that runs it (the terminal). The load average is printed with the results: a busy
// Mac answers slower.
import AppKit
import BaneySpacesAX
import BaneySpacesCore

let args = CommandLine.arguments

if args.contains("--be-hung") {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let parent = getppid()
    Thread.detachNewThread {
        while getppid() == parent { Thread.sleep(forTimeInterval: 0.5) }
        exit(0)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        print("ready"); fflush(stdout)
        while true { Thread.sleep(forTimeInterval: 60) }
    }
    app.run()
}

func value(_ flag: String) -> String? { args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
let rounds = Int(value("--rounds") ?? "") ?? 20
let gap = Double(value("--gap") ?? "") ?? 0.5

guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(Data("scan-bench: this terminal has no Accessibility permission; nothing was measured\n".utf8))
    exit(2)
}

func loadAverage() -> String {
    var l = [Double](repeating: 0, count: 3)
    return getloadavg(&l, 3) == 3 ? String(format: "%.2f %.2f %.2f", l[0], l[1], l[2]) : "?"
}

var helper: Process?
if args.contains("--hung") {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    p.arguments = ["--be-hung"]
    let out = Pipe()
    p.standardOutput = out
    try p.run()
    _ = out.fileHandleForReading.availableData // "ready": its main thread is blocked from here on
    helper = p
}
defer { helper?.terminate() }

/// Regular apps that own an ordinary window, as Polycarp asks them (`Windows.all`).
func owners() -> [Int32] {
    let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    var owning = Set<Int32>()
    for w in info where (w[kCGWindowLayer as String] as? Int) == 0 {
        if let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value { owning.insert(pid) }
    }
    return NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && !$0.isTerminated && owning.contains($0.processIdentifier) }
        .map(\.processIdentifier)
}

print("scan-bench: \(rounds) scans, load \(loadAverage())\(helper.map { ", with a hung app (pid \($0.processIdentifier))" } ?? "")")
var mains: [Double] = []
for _ in 0..<rounds {
    var pids = owners()
    if let h = helper { pids.append(h.processIdentifier) }
    let start = ProcessInfo.processInfo.systemUptime
    let reads = AXScan.all(pids)
    let main = ProcessInfo.processInfo.systemUptime - start
    let cost = ScanCheck.Cost(main: main, background: reads.map(\.seconds).max() ?? 0, apps: pids.count,
                              timedOut: reads.filter(\.timedOut).count)
    print(cost.line(kind: "bench", switching: false))
    mains.append(main * 1000)
    Thread.sleep(forTimeInterval: gap)
}
let sorted = mains.sorted()
func pct(_ p: Double) -> Double { sorted[max(0, Int((Double(sorted.count) * p).rounded(.up)) - 1)] }
print(String(format: "main thread per scan: median %.1f ms, p90 %.1f ms, max %.1f ms over %d scans; load %@",
             pct(0.5), pct(0.9), sorted.last ?? 0, sorted.count, loadAverage()))
