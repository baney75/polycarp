// Workspace switches on the real window server, with about 40 windows of the probe's own spread over every workspace.
//
//   swift scripts/switch-probe.swift speed [--switches 200] [--windows 40] [--url] [--idle 600] [--seed 1]
//
// speed: switches --switches times between random workspaces and times each from the key-down (⌘N, or whichever
// modifier Polycarp uses; --url sends polycarp://switch/N instead and times from the request) to the last frame the
// window server confirms: every probe window of that workspace back where it stood, every other one off screen or
// parked with at most a point showing, held to the end of an 800 ms watch. It prints p50, p90 and max and fails
// (exit 1) when p90 or max is over spec/speed.json's spacesSwitch budgets (switch_total_ms_p90, switch_total_ms_max).
// Polycarp's own timing.log numbers for the same switches print beside them.
//
// The windows belong to small helper apps it builds with swiftc into a temporary folder: some apps keep every window on
// one workspace (Polycarp hides them whole), the rest spread their windows over several (Polycarp parks those). It needs
// Polycarp installed and running with Accessibility. It switches the screen and opens windows, so it runs only after
// the Mac has been idle --idle seconds (600; 0 when you are watching it yourself) and stops at the first sign of a
// person (pointer moved, click, scroll; any input with --url). It always closes its windows and returns to the
// workspace you were on. Exit 3: couldn't run (not idle, Polycarp not running, setup failed, interrupted).
import AppKit
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
var argv = Array(CommandLine.arguments.dropFirst())
let mode = argv.isEmpty ? "" : argv.removeFirst()
func option(_ name: String, _ fallback: Int) -> Int {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count, let v = Int(argv[i + 1]) else { return fallback }
    return v
}
guard mode == "speed" else {
    FileHandle.standardError.write("usage: swift scripts/switch-probe.swift speed [--switches N] [--windows N] [--url] [--idle S] [--seed N]\n".data(using: .utf8)!)
    exit(2)
}
let switches = option("--switches", 200), windowCount = option("--windows", 40), idleNeeded = option("--idle", 600)
let useURL = argv.contains("--url")
var seeded = UInt64(option("--seed", 1))
func random(_ n: Int) -> Int {
    seeded = seeded &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    return Int((seeded >> 33) % UInt64(n))
}

var helpers: [Helper] = []
let work = FileManager.default.temporaryDirectory.appendingPathComponent("switch-probe-\(getpid())")
var original: Int?
var cleaned = false
func cleanUp() {
    guard !cleaned else { return }
    cleaned = true
    helpers.forEach { $0.quit() }
    if let original { _ = go(original) }
    try? FileManager.default.removeItem(at: work)
}
for sig in [SIGINT, SIGTERM, SIGHUP] { signal(sig) { _ in cleanUp(); exit(3) } }

func couldNotRun(_ why: String) -> Never { print("switch-probe: untested live: \(why)"); cleanUp(); exit(3) }

// MARK: The Mac and Polycarp

func hidIdle() -> Double {
    let p = Process(), pipe = Pipe()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/ioreg")
    p.arguments = ["-c", "IOHIDSystem"]
    p.standardOutput = pipe
    try? p.run()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    p.waitUntilExit()
    guard let r = out.range(of: #""HIDIdleTime" = (\d+)"#, options: .regularExpression) else { return 0 }
    return (Double(out[r].split(separator: " ").last ?? "0") ?? 0) / 1e9
}
/// Seconds since a person touched the pointer: the probe never posts pointer events, so these are always a person's.
func pointerIdle() -> Double {
    [CGEventType.mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel, .leftMouseDragged]
        .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
}

let folder: URL = {
    let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
    let polycarp = support.appendingPathComponent("Polycarp")
    return FileManager.default.fileExists(atPath: polycarp.appendingPathComponent("state.json").path) ? polycarp : support.appendingPathComponent("BaneySpaces")
}()
struct State { var current: Int; var agent: Int; var homes: [UInt32: Int] }
func state() -> State? {
    guard let data = try? Data(contentsOf: folder.appendingPathComponent("state.json")),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let current = json["current"] as? Int else { return nil }
    var homes: [UInt32: Int] = [:]
    for (k, list) in json["workspaces"] as? [String: [[String: Any]]] ?? [:] {
        for w in list { if let id = (w["id"] as? NSNumber)?.uint32Value, let n = Int(k) { homes[id] = n } }
    }
    return State(current: current, agent: json["agentWorkspace"] as? Int ?? 0, homes: homes)
}
func polycarpRunning() -> Bool {
    NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.baney.polycarp" && !$0.isTerminated }
}
let modifier: CGEventFlags = {
    switch UserDefaults(suiteName: "com.baney.polycarp")?.string(forKey: "modifier") ?? "command" {
    case "control": .maskControl
    case "option": .maskAlternate
    case "controlOption": [.maskControl, .maskAlternate]
    default: .maskCommand
    }
}()
let digitKeys: [CGKeyCode] = [18, 19, 20, 21, 23, 22, 26, 28, 25]
/// Asks for workspace `n` and returns when the request went out: the key-down, or the URL handed to Launch Services.
func request(_ n: Int, url: Bool) -> Double {
    if url {
        let t = CFAbsoluteTimeGetCurrent()
        NSWorkspace.shared.open(URL(string: "polycarp://switch/\(n)")!, configuration: { let c = NSWorkspace.OpenConfiguration(); c.activates = false; return c }())
        return t
    }
    let src = CGEventSource(stateID: .privateState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: digitKeys[n - 1], keyDown: true)!
    let up = CGEvent(keyboardEventSource: src, virtualKey: digitKeys[n - 1], keyDown: false)!
    down.flags = modifier
    up.flags = modifier
    let t = CFAbsoluteTimeGetCurrent()
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return t
}
func wait(_ seconds: Double, until done: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { if done() { return true }; usleep(20_000) }
    return done()
}
func go(_ n: Int) -> Bool {
    _ = request(n, url: true)
    return wait(3) { state()?.current == n }
}

// MARK: Helper apps

let helperSource = #"""
import AppKit
setvbuf(stdout, nil, _IOLBF, 0)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
var windows: [NSWindow] = []
let tag = CommandLine.arguments.dropFirst().first ?? "?"
Thread.detachNewThread {
    while let line = readLine() {
        let parts = line.split(separator: " ").map(String.init)
        DispatchQueue.main.async {
            switch parts.first {
            case "open":
                let i = Int(parts.last ?? "0") ?? 0
                let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
                let r = NSRect(x: vis.minX + 30 + CGFloat(i % 7) * 110, y: vis.maxY - 360 - CGFloat(i / 7 % 6) * 70, width: 420, height: 300)
                let w = NSWindow(contentRect: r, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
                w.title = "switch-probe \(tag) \(i)"
                w.isReleasedWhenClosed = false
                w.backgroundColor = NSColor(hue: CGFloat(i % 12) / 12, saturation: 0.5, brightness: 0.9, alpha: 1)
                w.orderFrontRegardless()
                windows.append(w)
                print("id \(i) \(w.windowNumber)")
            default:
                exit(0)
            }
        }
    }
    exit(0)
}
app.run()
"""#

final class Helper {
    let process = Process()
    let input = Pipe(), output = Pipe()
    var buffer = ""
    init(binary: URL, tag: String) throws {
        process.executableURL = binary
        process.arguments = [tag]
        process.standardInput = input
        process.standardOutput = output
        try process.run()
    }
    func open(_ i: Int) -> UInt32? {
        input.fileHandleForWriting.write("open \(i)\n".data(using: .utf8)!)
        let end = Date().addingTimeInterval(5)
        while Date() < end {
            if let r = buffer.range(of: "id \(i) ") {
                let rest = buffer[r.upperBound...]
                if let nl = rest.firstIndex(of: "\n") { return UInt32(rest[..<nl]) }
            }
            let data = output.fileHandleForReading.availableData
            if data.isEmpty { return nil }
            buffer += String(data: data, encoding: .utf8) ?? ""
        }
        return nil
    }
    func quit() {
        try? input.fileHandleForWriting.write(contentsOf: "quit\n".data(using: .utf8)!)
        let end = Date().addingTimeInterval(2)
        while process.isRunning, Date() < end { usleep(20_000) }
        if process.isRunning { process.terminate() }
    }
}


// MARK: Windows on screen

struct Seen { var onScreen: Bool; var bounds: CGRect }
func windowServer(_ ids: Set<UInt32>) -> [UInt32: CGRect] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    var out: [UInt32: CGRect] = [:]
    for w in list {
        guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value, ids.contains(id),
              let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { continue }
        out[id] = b
    }
    return out
}
let screens: [CGRect] = {
    let h = NSScreen.screens.first?.frame.height ?? 0
    return NSScreen.screens.map { CGRect(x: $0.frame.minX, y: h - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
}()
func visibleArea(_ r: CGRect) -> CGFloat {
    screens.reduce(0) { sum, s in let i = s.intersection(r); return i.isNull ? sum : sum + i.width * i.height }
}

// MARK: Setup

guard polycarpRunning(), let start = state() else { couldNotRun("Polycarp isn't running (or has no state.json)") }
let idle = hidIdle()
guard idle >= Double(idleNeeded) else { couldNotRun(String(format: "the Mac has been idle %.0f s, under %d s", idle, idleNeeded)) }
original = start.current
let spaces = (1...9).filter { $0 != start.agent }
print("switch-probe speed: \(switches) switches, \(windowCount) windows on workspaces \(spaces.map(String.init).joined(separator: ",")), \(useURL ? "URL" : "keys")")

try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
let helperSwift = work.appendingPathComponent("helper.swift"), helperBin = work.appendingPathComponent("switch-probe-helper")
try? helperSource.write(to: helperSwift, atomically: true, encoding: .utf8)
let compile = Process()
compile.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
compile.arguments = ["swiftc", "-O", "-o", helperBin.path, helperSwift.path]
try? compile.run()
compile.waitUntilExit()
guard compile.terminationStatus == 0 else { couldNotRun("swiftc couldn't build the helper app") }

// A third of the windows belong to apps with all their windows on one workspace (hidden whole on a switch); the rest
// to apps spread over several (parked).
let wholeApps = 4, spreadApps = 4
let wholeWindows = windowCount * 3 / 10
var plan: [(helper: Int, index: Int, workspace: Int)] = []
for i in 0..<windowCount {
    if i < wholeWindows {
        let h = i % wholeApps
        plan.append((h, i, spaces[h % spaces.count]))
    } else {
        let j = i - wholeWindows
        plan.append((wholeApps + j % spreadApps, i, spaces[(j + j / spreadApps) % spaces.count]))
    }
}
do {
    for h in 0..<(wholeApps + spreadApps) { helpers.append(try Helper(binary: helperBin, tag: "\(h < wholeApps ? "whole" : "spread")\(h)")) }
} catch { couldNotRun("couldn't start the helper apps: \(error)") }
usleep(800_000)

var home: [UInt32: (workspace: Int, frame: CGRect)] = [:]
for n in spaces {
    guard go(n) else { couldNotRun("Polycarp didn't switch to \(n) for setup") }
    var opened: [UInt32] = []
    for p in plan where p.workspace == n {
        guard let id = helpers[p.helper].open(p.index) else { couldNotRun("a helper didn't open window \(p.index)") }
        opened.append(id)
    }
    usleep(400_000)
    // A switch to the workspace you're on records where every window lives (state.json).
    _ = request(n, url: true)
    guard wait(5, until: { let s = state(); return opened.allSatisfy { s?.homes[$0] == n } }) else {
        couldNotRun("Polycarp didn't place the probe's windows on workspace \(n)")
    }
    let frames = windowServer(Set(opened))
    for id in opened { home[id] = (n, frames[id] ?? .null) }
}
let ids = Set(home.keys)
print("setup: \(ids.count) windows placed")

// MARK: speed

/// Whether the window server shows workspace `n` as it should be: its probe windows where they stood, every other one
/// off screen or showing a point at most.
func settled(on n: Int, _ seen: [UInt32: CGRect]) -> Bool {
    home.allSatisfy { id, h in
        if h.workspace == n {
            guard let b = seen[id] else { return false }
            return abs(b.minX - h.frame.minX) < 2 && abs(b.minY - h.frame.minY) < 2
        }
        return seen[id].map { visibleArea($0) <= 2 } ?? true
    }
}

let watch = 0.8, hold = 0.3
var totals: [Double] = []
var missed = 0
let begun = Date()
let pointerAtStart = pointerIdle()
var current = spaces.last!
for s in 0..<switches + 4 {
    if pointerIdle() < min(pointerAtStart, Date().timeIntervalSince(begun)) - 0.5 { couldNotRun("a person moved the pointer after \(s) switches") }
    if useURL, hidIdle() < Date().timeIntervalSince(begun) - 1 { couldNotRun("a person used the Mac after \(s) switches") }
    var target = spaces[random(spaces.count)]
    while target == current { target = spaces[random(spaces.count)] }
    let t0 = request(target, url: useURL)
    var okSince: Double?
    while CFAbsoluteTimeGetCurrent() - t0 < watch {
        let t = CFAbsoluteTimeGetCurrent()
        if settled(on: target, windowServer(ids)) { if okSince == nil { okSince = t } } else { okSince = nil }
        usleep(1000)
    }
    current = target
    // The first switches warm Polycarp's caches and the helpers; they don't count.
    guard s >= 4 else { continue }
    if let ok = okSince, CFAbsoluteTimeGetCurrent() - ok >= hold {
        totals.append((ok - t0) * 1000)
    } else {
        missed += 1
        totals.append(watch * 1000)
        print("switch \(s - 3) to \(target): not settled within \(Int(watch * 1000)) ms")
    }
}
guard state()?.current == current else { couldNotRun("Polycarp's state.json doesn't show the last switch: the keys may not be its shortcuts") }

func pct(_ v: [Double], _ p: Double) -> Double { let s = v.sorted(); return s[max(0, Int((Double(s.count) * p).rounded(.up)) - 1)] }
let p50 = pct(totals, 0.5), p90 = pct(totals, 0.9), worst = totals.max() ?? 0

// Polycarp's own phases for the same switches (timing.log keeps its last 500 lines).
let since = Int(begun.timeIntervalSince1970)
var parked: [Double] = [], doneMs: [Double] = []
for line in (try? String(contentsOf: folder.appendingPathComponent("timing.log"), encoding: .utf8))?.split(separator: "\n") ?? [] {
    let f = line.split(separator: " ")
    guard let ts = Int(f.first ?? ""), ts >= since, line.contains(" ws=") else { continue }
    var kv: [String: String] = [:]
    for part in f.dropFirst() { let p = part.split(separator: "="); if p.count == 2, kv[String(p[0])] == nil { kv[String(p[0])] = String(p[1]) } }
    guard kv["ws"] != kv["from"] else { continue }
    if let d = kv["done"].flatMap(Double.init) { doneMs.append(d) }
    if let d = kv["parked"].flatMap(Double.init) { parked.append(d) }
}

let budgets: (p90: Double, max: Double) = {
    let spec = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("spec/speed.json")
    let json = (try? Data(contentsOf: spec)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    let s = json?["spacesSwitch"] as? [String: Any]
    return ((s?["switch_total_ms_p90"] as? NSNumber)?.doubleValue ?? 120, (s?["switch_total_ms_max"] as? NSNumber)?.doubleValue ?? 250)
}()
cleanUp()
print(String(format: "switch_total_ms: p50 %.0f, p90 %.0f, max %.0f over %d switches, %d windows, %d workspaces (%d not settled)",
             p50, p90, worst, totals.count, ids.count, spaces.count, missed))
if !doneMs.isEmpty {
    print(String(format: "timing.log: done p50 %.0f p90 %.0f, parked p50 %.0f p90 %.0f max %.0f (%d lines)",
                 pct(doneMs, 0.5), pct(doneMs, 0.9), parked.isEmpty ? 0 : pct(parked, 0.5), parked.isEmpty ? 0 : pct(parked, 0.9),
                 parked.max() ?? 0, doneMs.count))
}
let pass = p90 < budgets.p90 && worst < budgets.max
print("switch-probe speed: \(pass ? "pass" : "FAIL") (budgets: p90 under \(Int(budgets.p90)) ms, max under \(Int(budgets.max)) ms)")
exit(pass ? 0 : 1)
