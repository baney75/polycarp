// Does three gestures Donovan reported, for real, with throwaway apps, and reads where focus and windows landed.
// Each guards a regression ledger row that had no automatic guard (gaps G4, G5, G6):
//   swift scripts/focus-probe.swift hold-tab [--runs 100]
//     Three apps on three empty workspaces, used in turn. ⌘Tab, tap Tab to the third app, hold Tab a second (its
//     window bar opens), let go of ⌘. The app in front must be the one highlighted, every run.
//   swift scripts/focus-probe.swift empty-workspace [--runs 50]
//     From a workspace with an app in front (every other run closing one of its windows as it leaves), switch to an
//     empty one. 2 s later state.json must still say the empty one is current.
//   swift scripts/focus-probe.swift reopen-here [--runs 20]
//     An app with its window on one workspace is opened again (`open -a`, its window 60 ms after it comes forward) from
//     an empty one; every other run it was quit first. Its new window must be listed on the empty workspace, and you there.
// The apps are scripts/probe-window-app.swift built into a temp folder as ProbeA.app, ProbeB.app and ProbeC.app; they
// are quit and removed at the end, and you are put back on the workspace you were on. It switches workspaces on the
// screen and hold-tab presses keys, so it runs only when Donovan has been idle 10 minutes (HIDIdleTime >= 600 s), with
// the screen unlocked, and stops the moment any input that isn't its own arrives. On every way out (a pass, a FAIL,
// untested, Ctrl-C or a kill other than -9) it lets go of any key it holds before it quits its apps. Needs Polycarp
// installed and running; hold-tab also needs Accessibility for the terminal (to post keys) and ⌘Tab in apps mode.
// Exit 0 pass, 1 fail, 2 usage, 3 untested live (with the reason): a precondition it couldn't set up is never a FAIL.
//   swift scripts/focus-probe.swift <mode> --self-test <scenario> runs the same code against a fake Mac (no key,
//   window or workspace of the real one is touched); FocusProbeSafetyTests drives it.
import AppKit
import Carbon.HIToolbox

let args = Array(CommandLine.arguments.dropFirst())
let usage = "usage: swift scripts/focus-probe.swift hold-tab|empty-workspace|reopen-here [--runs N] (N >= 1)"
guard let mode = args.first, ["hold-tab", "empty-workspace", "reopen-here"].contains(mode) else { print(usage); exit(2) }
let runs: Int
if let i = args.firstIndex(of: "--runs") {
    guard args.indices.contains(i + 1), let n = Int(args[i + 1]), n >= 1 else { print(usage); exit(2) }
    runs = n
} else {
    runs = ["hold-tab": 100, "empty-workspace": 50, "reopen-here": 20][mode]!
}
let support = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Polycarp")
let temp = FileManager.default.temporaryDirectory.appendingPathComponent("focus-probe-\(getpid())")
let probeBundle = "com.baney.probe-window-app."

// MARK: the world: every read of the Mac and every effect on it goes through here

struct TraceMark { let file: UInt64; let offset: UInt64 }
struct World {
    var idleSeconds: () -> Double
    /// False when the screen is locked or the session isn't on the console (loginwindow is in front then).
    var sessionUsable: () -> Bool
    var polycarpRunning: () -> Bool
    var canPostKeys: () -> Bool
    var watchInput: () -> Bool
    var readState: () -> Data?
    var go: (Int) -> Void
    var build: ([String]) -> Bool
    var openApp: (String) -> Void
    var tell: (String, String) -> Void
    var windows: (String) -> (pid: pid_t, ids: [Int])?
    var front: () -> pid_t?
    var post: (_ key: Int, _ down: Bool, _ cmd: Bool, _ repeat: Bool) -> Void
    /// The bundle id of a live process, nil once it is gone.
    var bundleID: (pid_t) -> String?
    var terminate: (pid_t) -> Void
    var traceMark: () -> TraceMark
    /// trace.log lines written since the mark, or nil when it rotated in between (the lines are lost).
    var traceSince: (TraceMark) -> [String]?
    var pause: (Double) -> Void
    var done: () -> Void
}

var foreignEvents = 0

// MARK: the real Mac

func realWorld() -> World {
    func run(_ path: String, _ arguments: [String]) -> (status: Int32, out: String) {
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = arguments
        p.standardOutput = out
        try? p.run()
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return (p.terminationStatus, text)
    }
    let trace = support.appendingPathComponent("trace.log").path
    func traceFile() -> (file: UInt64, size: UInt64) {
        let a = try? FileManager.default.attributesOfItem(atPath: trace)
        return ((a?[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0, (a?[.size] as? NSNumber)?.uint64Value ?? 0)
    }
    let src = CGEventSource(stateID: .hidSystemState)
    return World(
        idleSeconds: {
            let text = run("/usr/sbin/ioreg", ["-c", "IOHIDSystem"]).out
            guard let r = text.range(of: #""HIDIdleTime" = \d+"#, options: .regularExpression),
                  let ns = Double(text[r].split(separator: "=").last!.trimmingCharacters(in: .whitespaces)) else { return 0 }
            return ns / 1e9
        },
        sessionUsable: {
            guard let s = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
            return (s["kCGSSessionOnConsoleKey"] as? Bool) == true && (s["CGSSessionScreenIsLocked"] as? Bool) != true
        },
        polycarpRunning: { NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.lastPathComponent == "Polycarp.app" && !$0.isTerminated } },
        canPostKeys: { AXIsProcessTrusted() },
        watchInput: {
            let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                        .leftMouseDragged, .rightMouseDragged, .mouseMoved, .scrollWheel]
            let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
            guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
                                              callback: { _, _, event, _ in
                if event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()) { foreignEvents += 1 }
                return Unmanaged.passUnretained(event)
            }, userInfo: nil) else { return false }
            CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            return true
        },
        readState: { try? Data(contentsOf: support.appendingPathComponent("state.json")) },
        go: { _ = run("/usr/bin/open", ["-g", "polycarp://switch/\($0)"]) },
        build: { names in
            let bin = temp.appendingPathComponent("probe-window-app")
            try? FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
            let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("probe-window-app.swift")
            guard run("/usr/bin/xcrun", ["swiftc", "-O", source.path, "-o", bin.path]).status == 0 else { return false }
            for n in names {
                let macos = temp.appendingPathComponent("\(n).app/Contents/MacOS")
                try? FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
                try? FileManager.default.copyItem(at: bin, to: macos.appendingPathComponent(n))
                let plist: [String: Any] = ["CFBundleExecutable": n, "CFBundleIdentifier": probeBundle + n,
                                            "CFBundleName": n, "CFBundlePackageType": "APPL", "NSPrincipalClass": "NSApplication"]
                (plist as NSDictionary).write(to: temp.appendingPathComponent("\(n).app/Contents/Info.plist"), atomically: true)
            }
            return true
        },
        openApp: { _ = run("/usr/bin/open", ["-a", temp.appendingPathComponent("\($0).app").path]) },
        tell: { n, what in
            DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.baney.probe-window-app"), object: n,
                                                                         userInfo: ["do": what], deliverImmediately: true)
        },
        windows: { n in
            guard let data = try? Data(contentsOf: temp.appendingPathComponent("\(n).json")),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let pid = json["pid"] as? Int else { return nil }
            return (pid_t(pid), json["windows"] as? [Int] ?? [])
        },
        front: { NSWorkspace.shared.frontmostApplication?.processIdentifier },
        post: { code, down, cmd, isRepeat in
            let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: down)!
            e.flags = cmd ? .maskCommand : []
            if isRepeat { e.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
            e.post(tap: .cghidEventTap)
        },
        bundleID: { pid in NSRunningApplication(processIdentifier: pid).flatMap { $0.isTerminated ? nil : $0.bundleIdentifier } },
        terminate: { kill($0, SIGTERM) },
        traceMark: { let t = traceFile(); return TraceMark(file: t.file, offset: t.size) },
        traceSince: { mark in
            let now = traceFile()
            guard now.file == mark.file, now.size >= mark.offset, let h = FileHandle(forReadingAtPath: trace) else { return nil }
            defer { try? h.close() }
            try? h.seek(toOffset: mark.offset)
            return String(data: h.readDataToEndOfFile(), encoding: .utf8)?.split(separator: "\n").map(String.init) ?? []
        },
        pause: { s in
            let end = Date().addingTimeInterval(s)
            while Date() < end {
                // With no event tap the run loop has nothing to run and returns at once: sleep instead of spinning.
                if !RunLoop.main.run(mode: .default, before: min(end, Date().addingTimeInterval(0.02))) { Thread.sleep(forTimeInterval: 0.01) }
            }
        },
        done: {}
    )
}

// MARK: the fake Mac, for --self-test

/// A Mac with Polycarp that behaves (unless the scenario says otherwise) and records what the probe did to it.
/// Scenarios: pass, lands-wrong, foreign-input, signal, locked-at-start, locks-mid-run, front-elsewhere,
/// reused-pid, no-state, bad-state, rotation.
func fakeWorld(_ scenario: String) -> World {
    final class Mac {
        var current = 1, front: pid_t? = 501, nextPid: pid_t = 9001, nextWindow = 100, pauses = 0
        var apps: [String: (pid: pid_t, windows: [(id: Int, ws: Int)])] = [:]
        var down: Set<Int> = [], switcher = false, held = false, trace: [String] = [], file: UInt64 = 1
        var quitWithKeysDown = false, reopensWithoutWindowHome = 0, terminated: [String] = [], reused: [pid_t: String] = [:]
        var homes: [String: Int] = [:], rotated = false
        func open(_ n: String) {
            if apps[n] == nil { apps[n] = (nextPid, []); nextPid += 1; if homes[n] == nil { homes[n] = current } }
            nextWindow += 1
            apps[n]!.windows.append((nextWindow, current))
            front = apps[n]!.pid
        }
    }
    let mac = Mac()
    func stateJSON() -> Data {
        var ws: [String: [[String: Any]]] = [:]
        for n in 1...9 { ws[String(n)] = [] }
        ws["1"] = [["app": "Ghostty", "id": 1]] // his own window, on the workspace he is on
        for (n, app) in mac.apps { for w in app.windows { ws[String(w.ws), default: []].append(["app": n, "id": w.id]) } }
        return try! JSONSerialization.data(withJSONObject: ["current": mac.current, "agentWorkspace": 9, "workspaces": ws])
    }
    return World(
        idleSeconds: { 900 },
        sessionUsable: { scenario == "locked-at-start" ? false : scenario == "locks-mid-run" ? mac.pauses < 40 : true },
        polycarpRunning: { true },
        canPostKeys: { true },
        watchInput: { true },
        readState: {
            if scenario == "no-state" { return nil }
            if scenario == "bad-state" { return #"{"current": 1, "workspaces": [1, 2]}"#.data(using: .utf8) }
            return stateJSON()
        },
        go: { n in
            mac.current = n
            mac.front = mac.apps.values.first { $0.windows.contains { $0.ws == n } }?.pid
        },
        build: { _ in true },
        openApp: { n in
            if let app = mac.apps[n], mac.current != mac.homes[n] {
                if !app.windows.contains(where: { $0.ws == mac.homes[n] }) { mac.reopensWithoutWindowHome += 1 }
            }
            mac.open(n)
        },
        tell: { n, what in
            guard mac.apps[n] != nil else { return }
            switch what {
            case "open": mac.open(n)
            case "close": mac.apps[n]!.windows.removeLast()
            case "quit":
                if !mac.down.isEmpty { mac.quitWithKeysDown = true }
                if mac.current == mac.homes[n], !mac.apps[n]!.windows.contains(where: { $0.ws == mac.homes[n] }) {
                    mac.reopensWithoutWindowHome += 1
                }
                if scenario == "reused-pid" && n == "ProbeA" { return } // hung: only a SIGTERM ends it
                if scenario == "reused-pid" && n == "ProbeB" { mac.reused[mac.apps[n]!.pid] = "com.example.notes" }
                mac.apps[n] = nil
            default: break
            }
        },
        windows: { n in mac.apps[n].map { (pid: $0.pid, ids: $0.windows.map(\.id)) } },
        front: { scenario == "front-elsewhere" ? 501 : mac.front }, // 501: an app of his stays in front
        post: { code, down, cmd, isRepeat in
            if down { mac.down.insert(code) } else { mac.down.remove(code) }
            if code == kVK_Command && down {
                if scenario == "foreign-input" { foreignEvents += 1 }
                if scenario == "signal" { kill(getpid(), SIGTERM) } // as a kill from outside sends it
            }
            if code == kVK_Tab && down && cmd && !isRepeat && !mac.switcher { mac.switcher = true; mac.trace.append("cmdTab show apps=3") }
            if isRepeat && !mac.held { mac.held = true; mac.trace.append("cmdTab hold") }
            if code == kVK_Command && !down && mac.switcher {
                mac.switcher = false; mac.held = false
                let land = scenario == "lands-wrong" ? "ProbeB" : "ProbeA"
                mac.front = mac.apps[land]?.pid
                mac.current = mac.apps[land]?.windows.first?.ws ?? mac.current
            }
        },
        bundleID: { pid in mac.reused[pid] ?? mac.apps.first { $0.value.pid == pid }.map { probeBundle + $0.key } },
        terminate: { pid in mac.terminated.append(mac.reused[pid] ?? mac.apps.first { $0.value.pid == pid }.map { probeBundle + $0.key } ?? "gone") },
        traceMark: { TraceMark(file: mac.file, offset: UInt64(mac.trace.count)) },
        traceSince: { mark in
            if scenario == "rotation" && !mac.rotated && mark.offset > 0 { mac.rotated = true; mac.file += 1; mac.trace = [] }
            guard mark.file == mac.file, mac.trace.count >= Int(mark.offset) else { return nil }
            return Array(mac.trace[Int(mark.offset)...])
        },
        pause: { s in
            mac.pauses += 1
            Thread.sleep(forTimeInterval: scenario == "signal" ? min(s, 0.05) : 0.0005)
        },
        done: {
            say("fake: keys down at exit: \(mac.down.isEmpty ? "none" : mac.down.sorted().map(String.init).joined(separator: ","))")
            say("fake: an app quit while a key was down: \(mac.quitWithKeysDown ? "yes" : "no")")
            say("fake: terminated: \(mac.terminated.isEmpty ? "none" : mac.terminated.joined(separator: ","))")
            say("fake: reopens or quits without a window on the app's own workspace: \(mac.reopensWithoutWindowHome)")
            say("fake: probe apps left running: \(mac.apps.count)")
        }
    )
}

let world = args.firstIndex(of: "--self-test").map { i in fakeWorld(args.indices.contains(i + 1) ? args[i + 1] : "pass") } ?? realWorld()

var started: [String: pid_t] = [:]
var home: Int?
var held: Set<Int> = []
var finishing = false

func say(_ s: String) { print(s); fflush(stdout) }
func key(_ code: Int, down: Bool, cmd: Bool, repeat: Bool = false) {
    world.post(code, down, cmd, `repeat`)
    if down { held.insert(code) } else { held.remove(code) }
}
func cleanup() {
    // Keys first: a ⌘ left down turns his next q or w into Quit or Close.
    if held.contains(kVK_Tab) { key(kVK_Tab, down: false, cmd: held.contains(kVK_Command)) }
    if held.contains(kVK_Command) { key(kVK_Command, down: false, cmd: false) }
    for (n, _) in started { world.tell(n, "quit") }
    world.pause(0.5)
    // Only a probe app: a pid that quit can be reused by any process of his.
    for (_, pid) in started where world.bundleID(pid)?.hasPrefix(probeBundle) == true { world.terminate(pid) }
    try? FileManager.default.removeItem(at: temp)
    if let home { world.go(home) }
}
func finish(_ code: Int32, _ s: String) -> Never {
    if !finishing { finishing = true; cleanup(); say(s); world.done() }
    exit(code)
}
func untested(_ why: String) -> Never { finish(3, "untested live: \(why)") }
// Ctrl-C, a kill or a closed terminal ends the probe through untested(), so it lets go of its keys first (not -9).
// The handlers run on their own queue and only note the signal: the main thread may be mid-gesture.
var stopSignal: Int32 = 0
let signalQueue = DispatchQueue(label: "focus-probe.signals")
var signals: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler { stopSignal = sig }
    source.resume()
    signals.append(source)
}

var lastIdle = 0.0
func wait(_ s: Double) {
    world.pause(s)
    if stopSignal != 0 { untested("stopped by signal \(stopSignal)") }
    if !world.sessionUsable() { untested("the screen is locked or the session isn't on the console") }
    if mode == "hold-tab" {
        if foreignEvents > 0 { untested("input from you arrived mid-run; stopped") }
    } else {
        let now = world.idleSeconds()
        if now < lastIdle - 1 { untested("input from you arrived mid-run; stopped") }
        lastIdle = now
    }
}

// MARK: Polycarp's state

struct State { let current: Int; let agent: Int; let workspaces: [Int: [Int]] }
func readState() -> State? {
    guard let data = world.readState(), let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let current = json["current"] as? Int, let raw = json["workspaces"] as? [String: Any] else { return nil }
    var ws: [Int: [Int]] = [:]
    for (k, v) in raw {
        guard let n = Int(k), let list = v as? [[String: Any]] else { return nil }
        ws[n] = list.compactMap { ($0["id"] as? NSNumber)?.intValue }
    }
    return State(current: current, agent: json["agentWorkspace"] as? Int ?? 9, workspaces: ws)
}
/// Never a guess: with no readable state the probe can't tell your workspaces from empty ones.
func state() -> State {
    for _ in 0..<3 {
        if let s = readState() { return s }
        world.pause(0.05) // caught mid-rewrite
    }
    untested("can't read state.json (missing, unreadable, or no current and workspaces)")
}

// MARK: the throwaway apps

/// Launches the app on workspace `on` and waits until Polycarp lists its window there.
func launch(_ n: String, on ws: Int) {
    world.go(ws)
    wait(0.6)
    try? FileManager.default.removeItem(at: temp.appendingPathComponent("\(n).json"))
    world.openApp(n)
    for _ in 0..<50 {
        wait(0.1)
        if let w = world.windows(n) { started[n] = w.pid }
        if let w = world.windows(n), let id = w.ids.first, state().workspaces[ws]?.contains(id) == true { return }
    }
    untested("\(n)'s window never showed up on workspace \(ws) in state.json")
}
func hasWindow(_ n: String, on ws: Int) -> Bool {
    guard let pid = started[n], world.bundleID(pid) != nil, let w = world.windows(n) else { return false }
    let listed = state().workspaces[ws] ?? []
    return w.ids.contains { listed.contains($0) }
}

// MARK: preconditions

if !world.sessionUsable() { untested("the screen is locked or the session isn't on the console") }
let idle = world.idleSeconds()
if idle < 600 { untested("you were active \(Int(idle)) s ago; the probe needs 10 idle minutes (HIDIdleTime >= 600)") }
lastIdle = idle
if !world.polycarpRunning() { untested("Polycarp isn't running") }
let start = state()
home = start.current
let empty = (1...9).filter { $0 != start.agent && $0 != start.current && (start.workspaces[$0] ?? []).isEmpty }
let need = mode == "hold-tab" ? 3 : 2
if empty.count < need { untested("needs \(need) empty workspaces besides the agent's; found \(empty)") }
if mode == "hold-tab" {
    if !world.canPostKeys() { untested("this terminal isn't allowed Accessibility, which posting keys needs") }
    if !world.watchInput() { untested("couldn't watch for your input (no event tap); keys won't be posted blind") }
}
if !world.build(["ProbeA", "ProbeB", "ProbeC"].prefix(need).map { $0 }) { untested("couldn't build scripts/probe-window-app.swift") }

// MARK: the gestures

enum Outcome { case right, wrong(String), redo }
var failures: [String] = []
let (a, b) = (empty[0], empty[1])

func holdTab(_ run: Int, c: Int) -> Outcome {
    // Used in turn, so ⌘Tab lists C, B, A first; the third is A.
    for ws in [a, b, c] { world.go(ws); wait(0.5) }
    guard let pidA = started["ProbeA"], let pidC = started["ProbeC"], world.front() == pidC else {
        untested("ProbeC wasn't in front on \(c) before run \(run)'s gesture")
    }
    let mark = world.traceMark()
    key(kVK_Command, down: true, cmd: true)
    key(kVK_Tab, down: true, cmd: true); wait(0.08); key(kVK_Tab, down: false, cmd: true); wait(0.2)
    if run == 1, world.traceSince(mark)?.contains(where: { $0.contains("cmdTab show apps=") }) == false {
        untested("Polycarp's ⌘Tab isn't on in apps mode (no `cmdTab show apps=` in trace.log)")
    }
    key(kVK_Tab, down: true, cmd: true); wait(0.08); key(kVK_Tab, down: false, cmd: true); wait(0.2)
    key(kVK_Tab, down: true, cmd: true)
    wait(0.3)
    for _ in 0..<21 { key(kVK_Tab, down: true, cmd: true, repeat: true); wait(0.033) }
    key(kVK_Command, down: false, cmd: false)
    key(kVK_Tab, down: false, cmd: false)
    wait(1.2)
    guard let lines = world.traceSince(mark) else { return .redo }
    let landed = world.front(), now = state().current
    if landed != pidA || now != a {
        return .wrong("front pid \(landed.map(String.init) ?? "none"), current \(now); wanted ProbeA (\(pidA)) on \(a). "
                      + "trace: " + lines.filter { $0.contains("cmdTab") }.joined(separator: " | "))
    }
    if !lines.contains(where: { $0.contains("cmdTab hold") }) { return .wrong("no `cmdTab hold` line: the hold never registered") }
    return .right
}

func emptyWorkspace(_ run: Int) -> Outcome {
    world.go(a); wait(0.6)
    let closing = run % 2 == 0
    if closing { world.tell("ProbeA", "open"); wait(0.4) }
    guard world.front() == started["ProbeA"] else { untested("ProbeA wasn't in front on \(a) before run \(run)") }
    let mark = world.traceMark()
    if closing { world.tell("ProbeA", "close") }
    world.go(b)
    wait(2)
    let now = state().current
    guard let lines = world.traceSince(mark) else { return .redo }
    if now != b {
        return .wrong("\(closing ? "(a window closing) " : "")current \(now) 2 s after switching to empty \(b). trace: "
                      + lines.filter { $0.contains("followFocus") }.joined(separator: " | "))
    }
    return .right
}

func reopenHere(_ run: Int) -> Outcome {
    // Every run starts from ProbeA with a window on a: a quit-first run leaves it with none, and the close below
    // takes the window it opened on b.
    if !hasWindow("ProbeA", on: a) {
        if started["ProbeA"].flatMap(world.bundleID) == nil { started["ProbeA"] = nil; launch("ProbeA", on: a) }
        else { world.go(a); wait(0.6); world.tell("ProbeA", "open"); wait(0.8) }
        if !hasWindow("ProbeA", on: a) { untested("couldn't put ProbeA's window on \(a) before run \(run)") }
    }
    let quitFirst = run % 2 == 0
    world.go(a); wait(0.6)
    if quitFirst {
        world.tell("ProbeA", "quit"); wait(1)
        started["ProbeA"] = nil
        try? FileManager.default.removeItem(at: temp.appendingPathComponent("ProbeA.json"))
    }
    let before = Set(world.windows("ProbeA")?.ids ?? [])
    world.go(b); wait(0.8)
    let mark = world.traceMark()
    world.openApp("ProbeA")
    wait(1.5)
    guard let w = world.windows("ProbeA"), let new = w.ids.first(where: { !before.contains($0) }) else {
        return .wrong("ProbeA opened no new window")
    }
    started["ProbeA"] = w.pid
    let s = state()
    world.tell("ProbeA", "close") // b is empty again for the next run
    wait(0.4)
    guard let lines = world.traceSince(mark) else { return .redo }
    let on = s.workspaces.first { $0.value.contains(new) }?.key
    if on != b || s.current != b {
        return .wrong("\(quitFirst ? "(quit first) " : "")new window on \(on.map(String.init) ?? "none"), current \(s.current); "
                      + "wanted both \(b). trace: " + lines.filter { $0.contains("followFocus") }.joined(separator: " | "))
    }
    return .right
}

switch mode {
case "hold-tab":
    launch("ProbeA", on: a)
    world.tell("ProbeA", "open") // two windows, so holding Tab opens its window bar
    wait(0.5)
    launch("ProbeB", on: b)
    launch("ProbeC", on: empty[2])
case "empty-workspace": launch("ProbeA", on: a)
default: launch("ProbeA", on: a)
}
var run = 1, redos = 0
while run <= runs {
    let outcome = mode == "hold-tab" ? holdTab(run, c: empty[2]) : mode == "empty-workspace" ? emptyWorkspace(run) : reopenHere(run)
    switch outcome {
    case .redo:
        // trace.log rotated (200 KB) mid-run: its lines are gone, so the run proves nothing either way.
        redos += 1
        if redos > 3 { untested("trace.log rotated during \(redos) runs") }
        say("\(mode): run \(run): trace.log rotated, run again")
        continue
    case .wrong(let why): failures.append("run \(run): \(why)")
    case .right: break
    }
    if run % 10 == 0 { say("\(mode): \(run) runs, \(failures.count) failed") }
    run += 1
}

for f in failures.prefix(20) { say("FAIL \(f)") }
finish(failures.isEmpty ? 0 : 1, "focus-probe \(mode): \(failures.isEmpty ? "pass" : "FAIL"), \(runs - failures.count) of \(runs) runs right")
