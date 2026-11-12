// Fails if `agent open` leaves a window off the agent workspace, misses its window, takes the keyboard, or if `close`
// answers something the window list doesn't show. 11-12: Calculator and Font Book waited 7.1 s, answered
// `window_identified: false`, and stayed drawn on Donovan's workspace; `close` answered `closed: false` for windows
// already gone. Opens each app <rounds> times (default 3) through `polycarp-spaces agent`, and for each open checks:
//   identified: `open` returned a window id;
//   stray: no window of the new process is drawn (window server, on screen) on any workspace but the agent one;
//   focus: the app in front never changed while it opened (sampled every 50 ms);
//   close: `close`'s `closed` matches whether the window server still lists the window.
// Apps already running are skipped (an open of a running app asks that copy, which isn't this probe's). It quits only
// the copies it started: new pids, started after the probe, run with -ApplePersistenceIgnoreState.
// Agent workspace only: it types, clicks and moves nothing. Run it with the build under test installed and running.
//   swift scripts/agent-open-probe.swift [rounds] [App ...]
import AppKit

let defaults = ["Calculator", "Font Book", "Chess", "Dictionary", "Grapher", "Activity Monitor", "Console",
                "Digital Color Meter", "System Information", "TextEdit"]
var args = Array(CommandLine.arguments.dropFirst())
let rounds = args.first.flatMap(Int.init) ?? 3
if Int(args.first ?? "") != nil { args.removeFirst() }
let apps = args.isEmpty ? defaults : args
let cli = (ProcessInfo.processInfo.environment["POLYCARP_SPACES"] ?? "\(NSHomeDirectory())/.local/bin/polycarp-spaces")
let session = "agent-open-probe-\(getpid())"
let support = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Polycarp")
let handoff = support.appendingPathComponent("hands/handoff")
let probeStart = Date()

func agent(_ words: [String]) -> [String: Any] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cli)
    p.arguments = ["agent"] + words
    var env = ProcessInfo.processInfo.environment
    env["BANEYSPACES_SESSION"] = session
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return ["ok": false, "error": ["code": "cli_missing"]] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let last = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
    return (try? JSONSerialization.jsonObject(with: Data(last.utf8))) as? [String: Any] ?? ["ok": false, "raw": last]
}

func pids(_ name: String) -> Set<pid_t> {
    Set(NSWorkspace.shared.runningApplications.filter { $0.localizedName == name }.map(\.processIdentifier))
}

/// Layer-0 windows the window server draws, by id, with their owner.
func drawn() -> [UInt32: pid_t] {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    var out: [UInt32: pid_t] = [:]
    for w in info where (w[kCGWindowLayer as String] as? Int) == 0 {
        if let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value, let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value { out[id] = pid }
    }
    return out
}

func alive(_ id: UInt32) -> Bool {
    let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    return info.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id && ($0[kCGWindowLayer as String] as? Int) == 0 }
}

/// Window id -> workspace, from state.json.
func homes() -> (homes: [UInt32: Int], agent: Int?) {
    guard let data = try? Data(contentsOf: support.appendingPathComponent("state.json")),
          let s = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return ([:], nil) }
    var out: [UInt32: Int] = [:]
    for (ws, list) in (s["workspaces"] as? [String: Any]) ?? [:] {
        for w in (list as? [[String: Any]]) ?? [] { if let id = (w["id"] as? NSNumber)?.uint32Value, let n = Int(ws) { out[id] = n } }
    }
    return (out, (s["agentWorkspace"] as? NSNumber)?.intValue ?? 9)
}

func started(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), let t = app.launchDate, t >= probeStart.addingTimeInterval(-1) else { return false }
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/ps"); p.arguments = ["-o", "command=", "-p", "\(pid)"]
    let out = Pipe(); p.standardOutput = out
    guard (try? p.run()) != nil else { return false }
    let cmd = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    return cmd.contains("-ApplePersistenceIgnoreState")
}

func quit(_ pid: pid_t) {
    guard started(pid), let app = NSRunningApplication(processIdentifier: pid) else { return }
    app.terminate()
    let end = Date().addingTimeInterval(3)
    while !app.isTerminated, Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
    if !app.isTerminated { app.forceTerminate() }
}

try? FileManager.default.createDirectory(at: handoff, withIntermediateDirectories: true)
let note = handoff.appendingPathComponent("agent-open-probe-\(getpid()).txt")
try? "agent-open-probe\n".write(to: note, atomically: true, encoding: .utf8)
defer { try? FileManager.default.removeItem(at: note) }

var opens = 0, identified = 0, strays = 0, focusChanges = 0, closes = 0, closeMismatches = 0
var failures: [String] = []
setbuf(stdout, nil)
for app in apps {
    if !pids(app).isEmpty { print("skip \(app): already running"); continue }
    for round in 1...rounds {
        let before = pids(app)
        let front0 = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var frontChanged = false
        var reply: [String: Any] = [:]
        let done = DispatchSemaphore(value: 0)
        let t0 = Date()
        DispatchQueue.global().async {
            reply = agent(["open", app] + (app == "TextEdit" ? [note.path] : []))
            done.signal()
        }
        while done.wait(timeout: .now()) == .timedOut {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            if NSWorkspace.shared.frontmostApplication?.processIdentifier != front0 { frontChanged = true }
        }
        let secs = String(format: "%.2f", Date().timeIntervalSince(t0))
        opens += 1
        let data = reply["data"] as? [String: Any] ?? [:]
        let wid = (data["window"] as? NSNumber)?.uint32Value
        if wid != nil { identified += 1 } else { failures.append("\(app) #\(round): no window (\(reply["error"] ?? data["note"] ?? "?"))") }
        // Let a late window land, then look for any of the new process's drawn windows off the agent workspace.
        for _ in 0..<30 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            if NSWorkspace.shared.frontmostApplication?.processIdentifier != front0 { frontChanged = true }
        }
        let fresh = pids(app).subtracting(before)
        let (home, agentN) = homes()
        let off = drawn().filter { fresh.contains($0.value) && home[$0.key] != agentN }.map(\.key).sorted()
        if !off.isEmpty { strays += 1; failures.append("\(app) #\(round): window(s) \(off) drawn off the agent workspace") }
        if frontChanged { focusChanges += 1; failures.append("\(app) #\(round): the app in front changed") }
        var closeNote = "-"
        if let wid {
            let c = agent(["close", "--window", "\(wid)"])
            let closed = (c["data"] as? [String: Any])?["closed"] as? Bool
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            let present = alive(wid)
            closes += 1
            closeNote = "closed=\(closed.map(String.init) ?? "nil") present=\(present)"
            if closed == nil || closed! == present { closeMismatches += 1; failures.append("\(app) #\(round): close said \(closed.map(String.init) ?? "no answer"), window \(present ? "still" : "not") listed") }
        }
        print("\(app) #\(round): \(secs)s window=\(wid.map(String.init) ?? "none") stray=\(off.count) front_changed=\(frontChanged) \(closeNote)")
        for pid in fresh { quit(pid) }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
}
print("opens \(opens), identified \(identified), stray \(strays), focus changes \(focusChanges), close answers wrong \(closeMismatches) of \(closes)")
if failures.isEmpty && opens > 0 { print("agent-open-probe: pass"); exit(0) }
for f in failures { print("FAIL \(f)") }
print(opens == 0 ? "agent-open-probe: nothing ran (every app was already running)" : "agent-open-probe: fail")
exit(1)
