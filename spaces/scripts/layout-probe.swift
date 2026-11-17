// Fails if a named layout doesn't bring windows back after their app relaunches: a window off its saved frame by more
// than 2 px, a window missing, or a restore over 300 ms. Agent workspace only: it opens two TextEdit documents there,
// places them, saves a layout of that workspace, quits TextEdit, opens them again (new window numbers), moves them,
// restores and compares the parked records in frames.json with the saved ones. It quits only the copy it started, and
// skips when TextEdit already runs. Each open draws for about a second before it is parked, so it needs 10 idle
// minutes (else "untested live", exit 3; --force on an unused Mac). Needs the build under test installed.
// Run: swift scripts/layout-probe.swift [--force]   Prints "layout-probe: pass" (exit 0) or the failures (exit 1).
import AppKit
import CoreGraphics
import Foundation

let force = CommandLine.arguments.contains("--force")
let idleSeconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
if !force && idleSeconds < 600 {
    print("untested live: you were active \(Int(idleSeconds)) s ago; the probe needs 10 idle minutes (or --force on an unused Mac)")
    exit(3)
}
setbuf(stdout, nil)
let cli = ProcessInfo.processInfo.environment["POLYCARP_SPACES"] ?? "\(NSHomeDirectory())/.local/bin/polycarp-spaces"
let support = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Polycarp")
let handoff = support.appendingPathComponent("hands/handoff")
let probeStart = Date()
let name = "layout-probe-\(getpid())"

/// Runs the cli and returns its exit status and last stdout line.
func run(_ words: [String]) -> (status: Int32, line: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cli)
    p.arguments = words
    var env = ProcessInfo.processInfo.environment
    // Agent commands run as this probe's session; layout commands as Donovan, since an agent may not restore one.
    env["BANEYSPACES_SESSION"] = words.first == "layout" ? nil : name
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    do { try p.run() } catch { return (127, "cli missing at \(cli)") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? "")
}

func json(_ line: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] ?? [:] }

func state() -> [String: Any] {
    guard let data = try? Data(contentsOf: support.appendingPathComponent("state.json")) else { return [:] }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

let agentWorkspace = (state()["agentWorkspace"] as? NSNumber)?.intValue ?? 9

func agentShown() -> Bool { ((state()["displays"] as? [String: Any]) ?? [:]).values.contains { ($0 as? NSNumber)?.intValue == agentWorkspace } }

/// Parked records by window number. `[UInt32: CGRect]` encodes as [id, [[x, y], [w, h]], id, ...].
func records() -> [UInt32: CGRect] {
    guard let data = try? Data(contentsOf: support.appendingPathComponent("frames.json")),
          let s = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let flat = s["frames"] as? [Any] else { return [:] }
    var out: [UInt32: CGRect] = [:]
    for i in stride(from: 0, to: flat.count - 1, by: 2) {
        guard let id = (flat[i] as? NSNumber)?.uint32Value, let r = flat[i + 1] as? [[Double]], r.count == 2, r[0].count == 2, r[1].count == 2 else { continue }
        out[id] = CGRect(x: r[0][0], y: r[0][1], width: r[1][0], height: r[1][1])
    }
    return out
}

func textEditPids() -> Set<pid_t> {
    Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").map(\.processIdentifier))
}

func startedHere(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), let t = app.launchDate, t >= probeStart.addingTimeInterval(-1) else { return false }
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/ps"); p.arguments = ["-o", "command=", "-p", "\(pid)"]
    let out = Pipe(); p.standardOutput = out
    guard (try? p.run()) != nil else { return false }
    let cmd = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    return cmd.contains("-ApplePersistenceIgnoreState")
}

func quitOurs() {
    for pid in textEditPids() where startedHere(pid) {
        guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
        app.terminate()
        let end = Date().addingTimeInterval(3)
        while !app.isTerminated, Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        if !app.isTerminated { app.forceTerminate() }
    }
}

func pause(_ s: Double) { RunLoop.current.run(until: Date().addingTimeInterval(s)) }

if !textEditPids().isEmpty { print("untested live: TextEdit is already running, and the probe would use that copy"); exit(3) }
if agentShown() { print("untested live: the agent workspace is shown; the probe keeps its windows out of sight"); exit(3) }

try? FileManager.default.createDirectory(at: handoff, withIntermediateDirectories: true)
let docs = ["one", "two"].map { handoff.appendingPathComponent("\(name)-\($0).txt") }
for d in docs { try? "layout-probe\n".write(to: d, atomically: true, encoding: .utf8) }
var failures: [String] = []
func cleanup() {
    _ = run(["layout", "delete", name])
    quitOurs()
    for d in docs { try? FileManager.default.removeItem(at: d) }
}

/// Opens each document on the agent workspace and gives each window `frames[i]`, relative to the agent area.
func openAll(at frames: [String]) -> [UInt32] {
    var ids: [UInt32] = []
    for (d, f) in zip(docs, frames) {
        let r = json(run(["agent", "open", "TextEdit", d.path]).line)
        guard let id = (((r["data"] as? [String: Any])?["window"] as? [String: Any])?["id"] as? NSNumber)?.uint32Value else {
            failures.append("open \(d.lastPathComponent): no window"); continue
        }
        let m = run(["agent", "move", "--window", "\(id)", "--frame", f])
        if m.status != 0 { failures.append("move \(id): \(m.line)") }
        ids.append(id)
    }
    pause(3)
    return ids
}

let placed = openAll(at: ["40,40,640,420", "700,160,560,380"])
let saved = records()
let before = placed.compactMap { saved[$0] }
if placed.count != 2 || before.count != 2 { failures.append("setup: \(placed.count) windows, \(before.count) parked records") }
let save = run(["layout", "save", name, "--workspace", "\(agentWorkspace)", "--json"])
if save.status != 0 { failures.append("save: \(save.line)") }
print("save: \(save.line)")
if failures.isEmpty {
    quitOurs()
    pause(1)
    // The same documents in a new process, deliberately somewhere else.
    let again = openAll(at: ["300,300,400,300", "320,320,400,300"])
    let restore = run(["layout", "restore", name, "--json"])
    print("restore: \(restore.line)")
    let r = json(restore.line)
    if restore.status != 0 { failures.append("restore: \(restore.line)") }
    if (r["missing"] as? String) != "0" { failures.append("missing: \(r["missing"] ?? "?")") }
    if let ms = Int(r["ms"] as? String ?? ""), ms > 300 { failures.append("restore took \(ms) ms (budget 300)") }
    pause(1)
    let now = records()
    for (i, id) in again.enumerated() where i < before.count {
        guard let f = now[id] else { failures.append("window \(i + 1): no parked record after restore"); continue }
        let b = before[i]
        let off = max(abs(f.minX - b.minX), abs(f.minY - b.minY), abs(f.maxX - b.maxX), abs(f.maxY - b.maxY))
        print("window \(i + 1): off by \(Int(off.rounded())) px")
        if off > 2 { failures.append("window \(i + 1) off its saved frame by \(Int(off.rounded())) px") }
    }
    if again.count != 2 { failures.append("relaunch: \(again.count) of 2 windows") }
}
cleanup()
if failures.isEmpty { print("layout-probe: pass"); exit(0) }
for f in failures { print("FAIL \(f)") }
print("layout-probe: fail")
exit(1)
