// Does three gestures Donovan reported, for real, with throwaway apps, and reads where focus and windows landed.
// Each guards a regression ledger row that had no automatic guard (gaps G4, G5, G6):
//   swift scripts/focus-probe.swift hold-tab [--runs 100]
//     Three apps on three empty workspaces, used in turn. ⌘Tab, tap Tab to the third app, hold Tab a second (its
//     window bar opens), let go of ⌘. The app in front must be the one highlighted, every run.
//   swift scripts/focus-probe.swift empty-workspace [--runs 50]
//     From a workspace with an app in front (every other run closing one of its windows as it leaves), switch to an
//     empty one. 2 s later state.json must still say the empty one is current.
//   swift scripts/focus-probe.swift reopen-here [--runs 20]
//     An app open on one workspace is opened again (`open -a`, its window 60 ms after it comes forward) from an
//     empty one; every other run it was quit first. Its new window must be listed on the empty workspace, and you there.
// The apps are scripts/probe-window-app.swift built into a temp folder as ProbeA.app, ProbeB.app and ProbeC.app; they
// are quit and removed at the end, and you are put back on the workspace you were on. It switches workspaces on the
// screen and hold-tab presses keys, so it runs only when Donovan has been idle 10 minutes (HIDIdleTime >= 600 s) and
// stops the moment any input that isn't its own arrives. Needs Polycarp installed and running; hold-tab also needs
// Accessibility for the terminal (to post keys) and Polycarp's ⌘Tab in apps mode.
// Exit 0 pass, 1 fail, 3 untested live (with the reason).
import AppKit
import Carbon.HIToolbox

let args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first, ["hold-tab", "empty-workspace", "reopen-here"].contains(mode) else {
    print("usage: swift scripts/focus-probe.swift hold-tab|empty-workspace|reopen-here [--runs N]")
    exit(2)
}
let runs = args.firstIndex(of: "--runs").flatMap { args.indices.contains($0 + 1) ? Int(args[$0 + 1]) : nil }
    ?? ["hold-tab": 100, "empty-workspace": 50, "reopen-here": 20][mode]!
let support = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Polycarp")
let temp = FileManager.default.temporaryDirectory.appendingPathComponent("focus-probe-\(getpid())")
var started: [String: pid_t] = [:]
var home: Int?

func say(_ s: String) { print(s); fflush(stdout) }
func cleanup() {
    for (n, _) in started { tell(n, "quit") }
    Thread.sleep(forTimeInterval: 0.5)
    for (_, pid) in started where kill(pid, 0) == 0 { kill(pid, SIGTERM) }
    try? FileManager.default.removeItem(at: temp)
    if let home { go(home) }
}
func finish(_ code: Int32, _ s: String) -> Never { cleanup(); say(s); exit(code) }
func untested(_ why: String) -> Never { finish(3, "untested live: \(why)") }

// MARK: idle, and input that isn't ours

func idleSeconds() -> Double {
    let p = Process(), out = Pipe()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/ioreg")
    p.arguments = ["-c", "IOHIDSystem"]
    p.standardOutput = out
    try? p.run()
    let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    p.waitUntilExit()
    guard let r = text.range(of: #""HIDIdleTime" = \d+"#, options: .regularExpression),
          let ns = Double(text[r].split(separator: "=").last!.trimmingCharacters(in: .whitespaces)) else { return 0 }
    return ns / 1e9
}
// hold-tab's own key events reset the idle time, so it watches for events from any other source instead.
var foreignEvents = 0
func watchForeignInput() -> Bool {
    let mask: CGEventMask = [CGEventType.keyDown, .leftMouseDown, .mouseMoved, .scrollWheel].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
                                      callback: { _, _, event, _ in
        if event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()) { foreignEvents += 1 }
        return Unmanaged.passUnretained(event)
    }, userInfo: nil) else { return false }
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
}
var lastIdle = 0.0
func wait(_ s: Double) {
    let end = Date().addingTimeInterval(s)
    while Date() < end { RunLoop.main.run(until: min(end, Date().addingTimeInterval(0.02))) }
    if mode == "hold-tab" {
        if foreignEvents > 0 { untested("input from you arrived mid-run; stopped") }
    } else {
        let now = idleSeconds()
        if now < lastIdle - 1 { untested("input from you arrived mid-run; stopped") }
        lastIdle = now
    }
}

// MARK: Polycarp's state

struct State { let current: Int; let agent: Int; let workspaces: [Int: [Int]] }
func state() -> State {
    let data = (try? Data(contentsOf: support.appendingPathComponent("state.json"))) ?? Data()
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    var ws: [Int: [Int]] = [:]
    for (k, v) in json["workspaces"] as? [String: [[String: Any]]] ?? [:] {
        if let n = Int(k) { ws[n] = v.compactMap { ($0["id"] as? NSNumber)?.intValue } }
    }
    return State(current: json["current"] as? Int ?? 0, agent: json["agentWorkspace"] as? Int ?? 9, workspaces: ws)
}
func go(_ n: Int) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-g", "polycarp://switch/\(n)"]
    try? p.run()
    p.waitUntilExit()
}
func traceSize() -> UInt64 {
    ((try? FileManager.default.attributesOfItem(atPath: support.appendingPathComponent("trace.log").path))?[.size] as? UInt64) ?? 0
}
/// trace.log lines written since `offset` (it rotates at 200 KB; a rotation mid-run reads as nothing new).
func trace(since offset: UInt64) -> [String] {
    guard let h = FileHandle(forReadingAtPath: support.appendingPathComponent("trace.log").path) else { return [] }
    defer { try? h.close() }
    guard (try? h.seekToEnd()).map({ $0 >= offset }) == true else { return [] }
    try? h.seek(toOffset: offset)
    return String(data: h.readDataToEndOfFile(), encoding: .utf8)?.split(separator: "\n").map(String.init) ?? []
}

// MARK: the throwaway apps

func build(_ names: [String]) {
    let bin = temp.appendingPathComponent("probe-window-app")
    try? FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("probe-window-app.swift")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    p.arguments = ["swiftc", "-O", src.path, "-o", bin.path]
    try? p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { untested("couldn't build scripts/probe-window-app.swift") }
    for n in names {
        let macos = temp.appendingPathComponent("\(n).app/Contents/MacOS")
        try? FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
        try? FileManager.default.copyItem(at: bin, to: macos.appendingPathComponent(n))
        let plist: [String: Any] = ["CFBundleExecutable": n, "CFBundleIdentifier": "com.baney.probe-window-app.\(n)",
                                    "CFBundleName": n, "CFBundlePackageType": "APPL", "NSPrincipalClass": "NSApplication"]
        (plist as NSDictionary).write(to: temp.appendingPathComponent("\(n).app/Contents/Info.plist"), atomically: true)
    }
}
/// Opens the app: launches it, or, running, opens it again (a new window 60 ms after it comes forward).
func openApp(_ n: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-a", temp.appendingPathComponent("\(n).app").path]
    try? p.run()
    p.waitUntilExit()
}
func windows(of n: String) -> (pid: pid_t, ids: [Int])? {
    guard let data = try? Data(contentsOf: temp.appendingPathComponent("\(n).json")),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pid = json["pid"] as? Int else { return nil }
    return (pid_t(pid), json["windows"] as? [Int] ?? [])
}
func tell(_ n: String, _ what: String) {
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.baney.probe-window-app"), object: n,
                                                                 userInfo: ["do": what], deliverImmediately: true)
}
/// Launches the app on workspace `on` and waits until Polycarp lists its window there.
func launch(_ n: String, on ws: Int) {
    go(ws)
    wait(0.6)
    try? FileManager.default.removeItem(at: temp.appendingPathComponent("\(n).json"))
    openApp(n)
    for _ in 0..<50 {
        wait(0.1)
        if let w = windows(of: n), let id = w.ids.first, state().workspaces[ws]?.contains(id) == true { started[n] = w.pid; return }
    }
    if let w = windows(of: n) { started[n] = w.pid }
    untested("\(n)'s window never showed up on workspace \(ws) in state.json")
}
func front() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

// MARK: preconditions

let idle = idleSeconds()
if idle < 600 { untested("you were active \(Int(idle)) s ago; the probe needs 10 idle minutes (HIDIdleTime >= 600)") }
lastIdle = idle
let running = NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.lastPathComponent == "Polycarp.app" && !$0.isTerminated }
if !running { untested("Polycarp isn't running") }
let start = state()
home = start.current
let empty = (1...9).filter { $0 != start.agent && $0 != start.current && (start.workspaces[$0] ?? []).isEmpty }
let need = mode == "hold-tab" ? 3 : 2
if empty.count < need { untested("needs \(need) empty workspaces besides the agent's; found \(empty)") }
if mode == "hold-tab" {
    if !AXIsProcessTrusted() { untested("this terminal isn't allowed Accessibility, which posting keys needs") }
    if !watchForeignInput() { untested("couldn't watch for your input (no event tap); keys won't be posted blind") }
}
build(["ProbeA", "ProbeB", "ProbeC"].prefix(need).map { $0 })

// MARK: the gestures

var failures: [String] = []

switch mode {
case "hold-tab":
    let (a, b, c) = (empty[0], empty[1], empty[2])
    launch("ProbeA", on: a)
    tell("ProbeA", "open") // two windows, so holding Tab opens its window bar
    wait(0.5)
    launch("ProbeB", on: b)
    launch("ProbeC", on: c)
    let src = CGEventSource(stateID: .hidSystemState)
    func key(_ code: Int, down: Bool, cmd: Bool, repeat: Bool = false) {
        let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: down)!
        e.flags = cmd ? .maskCommand : []
        if `repeat` { e.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        e.post(tap: .cghidEventTap)
    }
    for run in 1...runs {
        // Used in turn, so ⌘Tab lists C, B, A first; the third is A.
        for ws in [a, b, c] { go(ws); wait(0.5) }
        guard let pidA = started["ProbeA"], front() == started["ProbeC"] else {
            failures.append("run \(run): ProbeC wasn't in front on \(c) before the gesture"); continue
        }
        let mark = traceSize()
        key(kVK_Command, down: true, cmd: true)
        key(kVK_Tab, down: true, cmd: true); wait(0.08); key(kVK_Tab, down: false, cmd: true); wait(0.2)
        if run == 1, !trace(since: mark).contains(where: { $0.contains("cmdTab show apps=") }) {
            key(kVK_Command, down: false, cmd: false)
            untested("Polycarp's ⌘Tab isn't on in apps mode (no `cmdTab show apps=` in trace.log)")
        }
        key(kVK_Tab, down: true, cmd: true); wait(0.08); key(kVK_Tab, down: false, cmd: true); wait(0.2)
        key(kVK_Tab, down: true, cmd: true)
        wait(0.3)
        for _ in 0..<21 { key(kVK_Tab, down: true, cmd: true, repeat: true); wait(0.033) }
        key(kVK_Command, down: false, cmd: false)
        key(kVK_Tab, down: false, cmd: false)
        wait(1.2)
        let lines = trace(since: mark)
        let landed = front()
        if landed != pidA || state().current != a {
            failures.append("run \(run): front pid \(landed.map(String.init) ?? "none"), current \(state().current); wanted ProbeA (\(pidA)) on \(a). "
                            + "trace: " + lines.filter { $0.contains("cmdTab") }.joined(separator: " | "))
        } else if !lines.contains(where: { $0.contains("cmdTab hold") }) {
            failures.append("run \(run): no `cmdTab hold` line: the hold never registered, so this run tested nothing")
        }
        if run % 10 == 0 { say("hold-tab: \(run) runs, \(failures.count) failed") }
    }
case "empty-workspace":
    let (a, b) = (empty[0], empty[1])
    launch("ProbeA", on: a)
    for run in 1...runs {
        go(a); wait(0.6)
        let closing = run % 2 == 0
        if closing { tell("ProbeA", "open"); wait(0.4) }
        guard front() == started["ProbeA"] else { failures.append("run \(run): ProbeA wasn't in front on \(a)"); continue }
        let mark = traceSize()
        if closing { tell("ProbeA", "close") }
        go(b)
        wait(2)
        let now = state().current
        if now != b {
            failures.append("run \(run)\(closing ? " (a window closing)" : ""): current \(now) 2 s after switching to empty \(b). trace: "
                            + trace(since: mark).filter { $0.contains("followFocus") }.joined(separator: " | "))
        }
        if run % 10 == 0 { say("empty-workspace: \(run) runs, \(failures.count) failed") }
    }
case "reopen-here":
    let (a, b) = (empty[0], empty[1])
    launch("ProbeA", on: a)
    for run in 1...runs {
        let quitFirst = run % 2 == 0
        go(a); wait(0.6)
        if quitFirst {
            tell("ProbeA", "quit"); wait(1)
            try? FileManager.default.removeItem(at: temp.appendingPathComponent("ProbeA.json"))
        }
        let before = Set(windows(of: "ProbeA")?.ids ?? [])
        go(b); wait(0.8)
        let mark = traceSize()
        openApp("ProbeA")
        wait(1.5)
        guard let w = windows(of: "ProbeA"), let new = w.ids.first(where: { !before.contains($0) }) else {
            failures.append("run \(run): ProbeA opened no new window"); continue
        }
        started["ProbeA"] = w.pid
        let s = state()
        let on = s.workspaces.first { $0.value.contains(new) }?.key
        if on != b || s.current != b {
            failures.append("run \(run)\(quitFirst ? " (quit first)" : ""): new window on \(on.map(String.init) ?? "none"), current \(s.current); "
                            + "wanted both \(b). trace: " + trace(since: mark).filter { $0.contains("followFocus") }.joined(separator: " | "))
        }
        tell("ProbeA", "close") // b is empty again for the next run
        wait(0.4)
        if run % 5 == 0 { say("reopen-here: \(run) runs, \(failures.count) failed") }
    }
default: break
}

for f in failures.prefix(20) { say("FAIL \(f)") }
finish(failures.isEmpty ? 0 : 1, "focus-probe \(mode): \(failures.isEmpty ? "pass" : "FAIL"), \(runs - failures.count) of \(runs) runs right")
