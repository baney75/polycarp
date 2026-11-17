// Fails if an app that answers Accessibility late, or never, slows a switch or puts a window on the wrong workspace
// (organizers study, item 6). It starts two test apps of its own, each with one small window: one answers every ask 2 s
// late, one never answers (`scan-bench --be-app slow|hung`). Then:
//   1. The slow app's window must be on a workspace within 7 s of a scan asking it: 2 s for it to answer, 5 s to place.
//   2. 20 switches between the workspace you're on and <empty n>, with state.json read back after each: no window may
//      change workspace, and each switch (timing.log done=) must finish under 150 ms.
// It switches your screen, so it runs only when the Mac has been idle 10 minutes; otherwise it prints "untested live"
// and exits 3. It leaves you on the workspace you started on and quits both test apps. Build the test apps first:
//   swift build -c release --product scan-bench
//   swift scripts/slow-app-probe.swift 6
import AppKit

func fail(_ s: String) -> Never { print("FAIL: \(s)"); exit(1) }
func say(_ s: String) { print(s); fflush(stdout) }

guard let empty = CommandLine.arguments.dropFirst().first.flatMap(Int.init), (1...9).contains(empty) else {
    FileHandle.standardError.write(Data("usage: swift scripts/slow-app-probe.swift <empty workspace 1-9>\n".utf8))
    exit(2)
}

/// Seconds since the last key or pointer event.
func idle() -> Double {
    let p = Process(), out = Pipe()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/ioreg")
    p.arguments = ["-c", "IOHIDSystem", "-d", "4"]
    p.standardOutput = out
    try? p.run()
    let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    guard let line = text.split(separator: "\n").first(where: { $0.contains("\"HIDIdleTime\"") }),
          let ns = line.split(separator: "=").last.flatMap({ Double($0.trimmingCharacters(in: .whitespaces)) }) else { return 0 }
    return ns / 1e9
}
let quiet = idle()
guard quiet >= 600 else {
    say("untested live: the Mac has been idle \(Int(quiet)) s, under 10 minutes; nothing was switched")
    exit(3)
}

let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Polycarp")
guard NSWorkspace.shared.runningApplications.contains(where: { $0.executableURL?.path.hasSuffix("Polycarp.app/Contents/MacOS/Polycarp") == true }) else {
    fail("Polycarp isn't running")
}
let bench = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent(".build/release/scan-bench")
guard FileManager.default.isExecutableFile(atPath: bench.path) else {
    fail("no \(bench.path): swift build -c release --product scan-bench")
}

struct State { let current: Int; let home: [UInt32: Int] }
func state() -> State {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("state.json")),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ws = json["workspaces"] as? [String: [[String: Any]]] else { fail("can't read state.json") }
    var home: [UInt32: Int] = [:]
    for (n, rows) in ws { for r in rows { if let id = (r["id"] as? NSNumber)?.uint32Value, let n = Int(n) { home[id] = n } } }
    return State(current: (json["current"] as? Int) ?? 0, home: home)
}
func open(_ url: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-g", url]
    try? p.run()
    p.waitUntilExit()
}
func now() -> Double { ProcessInfo.processInfo.systemUptime }
func loadAverage() -> String {
    var l = [Double](repeating: 0, count: 3)
    return getloadavg(&l, 3) == 3 ? String(format: "%.2f %.2f %.2f", l[0], l[1], l[2]) : "?"
}

let start = state()
let home = start.current
guard home != empty else { fail("you're on workspace \(empty); name an empty one you aren't on") }
guard !start.home.values.contains(empty) else { fail("workspace \(empty) isn't empty") }

var apps: [Process] = []
func launch(_ kind: String) -> UInt32 {
    let p = Process(), out = Pipe()
    p.executableURL = bench
    p.arguments = ["--be-app", kind]
    p.standardOutput = out
    do { try p.run() } catch { fail("can't start the \(kind) test app: \(error)") }
    apps.append(p)
    let line = String(decoding: out.fileHandleForReading.availableData, as: UTF8.self)
    guard let id = line.split(separator: " ").last.flatMap({ UInt32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }) else {
        fail("the \(kind) test app didn't say its window: \(line)")
    }
    return id
}
var failures: [String] = []
func finish() -> Never {
    for p in apps { p.terminate() }
    open("polycarp://switch/\(home)")
    if failures.isEmpty { say("slow-app-probe: pass"); exit(0) }
    for f in failures { print("FAIL: \(f)") }
    exit(1)
}

let epoch = Int(Date().timeIntervalSince1970)
let hungWindow = launch("hung")
let slowWindow = launch("slow")
say("test apps up: slow window \(slowWindow), hung window \(hungWindow); load \(loadAverage())")

// 1. A scan asks the slow app now (a switch to where you are); it answers within 2 s and must be placed by 5 s after.
let asked = now()
open("polycarp://switch/\(home)")
var placed: Double?
while now() - asked < 7.05 {
    if state().home[slowWindow] != nil { placed = now() - asked; break }
    Thread.sleep(forTimeInterval: 0.1)
}
if let placed { say(String(format: "slow app's window placed %.1f s after the scan asked it", placed)) }
else { failures.append("the slow app's window \(slowWindow) wasn't on any workspace 7 s after a scan asked it") }

// 2. 20 switches; every window keeps the workspace it had.
var known = state().home
for i in 0..<20 {
    open("polycarp://switch/\(i % 2 == 0 ? empty : home)")
    Thread.sleep(forTimeInterval: 0.8)
    let s = state()
    for (id, n) in s.home {
        if let was = known[id], was != n { failures.append("switch \(i + 1): window \(id) moved from workspace \(was) to \(n)") }
        else if known[id] == nil { known[id] = n }
    }
}
let slow = state().home[slowWindow]
say("after 20 switches: slow window on \(slow.map(String.init) ?? "no workspace"), hung window on \(state().home[hungWindow].map(String.init) ?? "no workspace")")

// Each switch's own time, from timing.log (the line's first field is epoch seconds).
let lines = (try? String(contentsOf: dir.appendingPathComponent("timing.log"), encoding: .utf8))?.split(separator: "\n") ?? []
var done: [Int] = []
for line in lines {
    let f = line.split(separator: " ")
    guard let t = f.first.flatMap({ Int($0) }), t >= epoch else { continue }
    var kv: [String: String] = [:]
    for p in f.dropFirst() { let kvp = p.split(separator: "=", maxSplits: 1); if kvp.count == 2, kv[String(kvp[0])] == nil { kv[String(kvp[0])] = String(kvp[1]) } }
    guard let d = kv["done"].flatMap(Int.init), let ws = kv["ws"], let from = kv["from"], ws != from else { continue }
    done.append(d)
}
if done.count < 20 { failures.append("timing.log has \(done.count) switches from this run, not 20") }
let slowest = done.max() ?? 0
let median = done.isEmpty ? 0 : done.sorted()[done.count / 2]
say("switches: \(done.count), median \(median) ms, slowest \(slowest) ms (budget 150); load \(loadAverage())")
if slowest >= 150 { failures.append("a switch took \(slowest) ms") }
finish()
