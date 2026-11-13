// Fails if `agent open` leaves a window off the agent workspace, misses its window, takes the keyboard, or if `close`
// answers something the window list doesn't show. 11-12: Calculator and Font Book waited 7.1 s, answered
// `window_identified: false`, and stayed drawn on Donovan's workspace; `close` answered `closed: false` for windows
// already gone. Opens each app <rounds> times (default 3) through `polycarp-spaces agent`, and for each open checks:
//   identified: `open` returned a window id;
//   stray: no window of the new process is drawn (window server, on screen) on any workspace but the agent one;
//   focus: the app in front never changed while it opened (sampled every 50 ms);
//   close: `close`'s `closed` matches whether the window server still lists the window;
//   seen: from the open until it settles, a sampler reads the window server every 4 ms (on screen only) and adds up the
//   time any window of the new process showed at least 8x8 pt on a display, not covered by a window in front of it.
//   The agent workspace is not shown while the probe runs, so all of that was on Donovan's workspace. With the cover on
//   (`defaults write com.baney.polycarp agentOpenFlashGuard cover`), over 50 ms in one open fails it (zero is the
//   target); with it off, the default, the times print as "known, flag off" and fail nothing. 11-12 on 639dd5f: Font Book and Dictionary showed for 0.7 to 1.5 s, and the
//   check above passed, because it looked only at where the window ended up.
// Apps already running are skipped (an open of a running app asks that copy, which isn't this probe's). It quits only
// the copies it started: new pids, started after the probe, run with -ApplePersistenceIgnoreState.
// Agent workspace only: it types, clicks and moves nothing. Run it with the build under test installed and running.
// It runs only when Donovan has been idle 10 minutes. 11-12: each open drew its window on his workspace for 0.7 to 1.7 s
// before it was parked, and a 10-open run while he worked read to him as "random windows keep opening like font book".
// Otherwise it prints "untested live" and exits 3, opening nothing. --force is for a Mac nobody is using.
//   swift scripts/agent-open-probe.swift [rounds] [App ...] [--force]
import AppKit

/// One window from the window server's on-screen list, front to back.
struct Seen {
    let pid: pid_t; let layer: Int; let alpha: Double; let bounds: CGRect
    /// Hides what is under it: fully opaque (alpha 1; a translucent window shows what is under it) and a window known
    /// to draw opaque: Polycarp's open cover (its pid, at `OpenFlashGuard.coverLevel`), or another app's ordinary
    /// window. Polycarp's own other windows (the agent cursor's overlay, at layer 0 or 25) and any other app's overlay
    /// hide nothing.
    func hides(cover polycarp: pid_t) -> Bool {
        alpha >= 0.999 && (pid == polycarp ? layer == coverLevel : layer == 0)
    }
}

/// `OpenFlashGuard.coverLevel`, the covers' window level (a Core test pins the two together).
let coverLevel = 4
/// Polycarp's pid, by bundle id, as the window server owns its covers (owner names can change; the pid can't).
let polycarpPid: pid_t = NSRunningApplication.runningApplications(withBundleIdentifier: "com.baney.polycarp").first?.processIdentifier ?? -1

/// The seen check gates only with the cover on (`agentOpenFlashGuard cover`). With it off (the default), the times are
/// printed as known and fail nothing: every open of a starting app shows for about 1 s until the cover is on by default.
func seenFails(_ ms: Double, guardOn: Bool, bar: Double = 50) -> Bool { guardOn && ms > bar }

/// The part of `list[i]` a person can see: on a display, not under an opaque window in front of it, measured on a grid
/// so overlaps of several windows count right. Returns the shown area in pt² and the bounding box of what shows.
func shown(_ i: Int, in list: [Seen], displays: [CGRect]) -> (area: CGFloat, box: CGRect) {
    let w = list[i].bounds
    let front = list[..<i].filter { $0.hides(cover: polycarpPid) }.map(\.bounds)
    let step: CGFloat = 4
    var area: CGFloat = 0, box = CGRect.null
    var y = w.minY + step / 2
    while y < w.maxY {
        var x = w.minX + step / 2
        while x < w.maxX {
            let p = CGPoint(x: x, y: y)
            if displays.contains(where: { $0.contains(p) }) && !front.contains(where: { $0.contains(p) }) {
                area += step * step; box = box.union(CGRect(x: x - step / 2, y: y - step / 2, width: step, height: step))
            }
            x += step
        }
        y += step
    }
    return (area, box)
}

/// Seen by a person: at least an 8x8 pt part shows. A parked window's corner sliver (1 pt) doesn't count.
func seen(_ i: Int, in list: [Seen], displays: [CGRect]) -> CGRect? {
    let s = shown(i, in: list, displays: displays)
    return s.area >= 64 && s.box.width >= 8 && s.box.height >= 8 ? s.box : nil
}

if CommandLine.arguments.contains("--selftest") {
    let screen = [CGRect(x: 0, y: 0, width: 1512, height: 982)]
    let app = Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 400, y: 300, width: 500, height: 400))
    var bad = 0
    func check(_ what: String, _ ok: Bool) { print((ok ? "ok   " : "FAIL ") + what); if !ok { bad += 1 } }
    check("a window in the middle of the screen is seen", seen(0, in: [app], displays: screen) != nil)
    check("a parked window's 1 pt corner is not", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 1511, y: 981, width: 500, height: 400))], displays: screen) == nil)
    check("a window macOS clamped to a 1x32 pt strip is not", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 1511, y: 950, width: 500, height: 400))], displays: screen) == nil)
    // The pid the real run uses, so the selftest goes through the same identity path (a stand-in when Polycarp isn't running).
    let pc = polycarpPid > 0 ? polycarpPid : 4242
    print("cover owner: pid \(pc)\(polycarpPid > 0 ? " (Polycarp, by bundle id)" : " (stand-in: Polycarp isn't running)")")
    let full = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let cover = Seen(pid: pc, layer: coverLevel, alpha: 1, bounds: full)
    check("one under Polycarp's cover is not", seen(1, in: [cover, app], displays: screen) == nil)
    check("one under another app's window at the cover's level is", seen(1, in: [Seen(pid: 3, layer: coverLevel, alpha: 1, bounds: full), app], displays: screen) != nil)
    check("one under another app's alpha-1 overlay is", seen(1, in: [Seen(pid: 3, layer: 25, alpha: 1, bounds: full), app], displays: screen) != nil)
    check("one under the agent cursor's overlay is", seen(1, in: [Seen(pid: pc, layer: 25, alpha: 1, bounds: full), app], displays: screen) != nil)
    check("one under a layer-0 Polycarp overlay is", seen(1, in: [Seen(pid: pc, layer: 0, alpha: 1, bounds: full), app], displays: screen) != nil)
    check("one under a translucent ordinary window (alpha 0.6) is", seen(1, in: [Seen(pid: 3, layer: 0, alpha: 0.6, bounds: full), app], displays: screen) != nil)
    check("with the cover off, a 1 s open is known, not failed", !seenFails(1000, guardOn: false))
    check("with it on, 51 ms fails and 50 ms passes", seenFails(51, guardOn: true) && !seenFails(50, guardOn: true))
    check("one under a clear overlay is", seen(1, in: [Seen(pid: pc, layer: 25, alpha: 0, bounds: full), app], displays: screen) != nil)
    let half = Seen(pid: 2, layer: 0, alpha: 1, bounds: CGRect(x: 400, y: 300, width: 250, height: 400))
    check("half covered, the other half shows", seen(1, in: [half, app], displays: screen).map { $0.minX >= 646 } == true)
    check("off every display is not", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 3000, y: 0, width: 500, height: 400))], displays: screen) == nil)
    print(bad == 0 ? "selftest: pass" : "selftest: fail"); exit(bad == 0 ? 0 : 1)
}

let force = CommandLine.arguments.contains("--force")
let idleSeconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
if !force && idleSeconds < 600 {
    print("untested live: you were active \(Int(idleSeconds)) s ago; the probe needs 10 idle minutes (or --force on an unused Mac)")
    exit(3)
}

let defaults = ["Calculator", "Font Book", "Chess", "Dictionary", "Grapher", "Activity Monitor", "Console",
                "Digital Color Meter", "System Information", "TextEdit"]
var args = Array(CommandLine.arguments.dropFirst()).filter { $0 != "--force" }
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

/// Whether a display shows the agent workspace (then a window there is meant to be seen, and "seen" says nothing).
func agentShown() -> Bool {
    guard let data = try? Data(contentsOf: support.appendingPathComponent("state.json")),
          let s = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
    let agent = (s["agentWorkspace"] as? NSNumber)?.intValue ?? 9
    return ((s["displays"] as? [String: Any]) ?? [:]).values.contains { ($0 as? NSNumber)?.intValue == agent }
}

func displayRects() -> [CGRect] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16), n: UInt32 = 0
    CGGetActiveDisplayList(16, &ids, &n)
    return ids.prefix(Int(n)).map { CGDisplayBounds($0) }
}

/// Samples the window server every 4 ms on its own thread until stopped, and adds up the time any window of a process
/// that `isNew` accepts was seen. A sample's time runs until the next one, so a slow read counts in full.
final class Sampler {
    private let lock = NSLock()
    private var stopped = false
    private(set) var seenMs = 0.0, firstMs: Double?, samples = 0, worstGapMs = 0.0
    private(set) var frames: [CGRect] = []
    private let done = DispatchSemaphore(value: 0)
    init(app: String, isNew: @escaping (pid_t) -> Bool) {
        let displays = displayRects()
        Thread { [self] in
            let t0 = ProcessInfo.processInfo.systemUptime
            var last = t0, wasSeen = false
            while true {
                lock.lock(); let stop = stopped; lock.unlock()
                if stop { break }
                let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                let now = ProcessInfo.processInfo.systemUptime
                let list = info.compactMap { w -> (Seen, String)? in
                    guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                          let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { return nil }
                    return (Seen(pid: pid, layer: (w[kCGWindowLayer as String] as? Int) ?? 0, alpha: (w[kCGWindowAlpha as String] as? Double) ?? 1, bounds: b),
                            (w[kCGWindowOwnerName as String] as? String) ?? "")
                }
                let windows = list.map(\.0)
                lock.lock()
                if wasSeen { seenMs += (now - last) * 1000 }
                worstGapMs = max(worstGapMs, (now - last) * 1000)
                samples += 1
                wasSeen = false
                for (i, (w, owner)) in list.enumerated() where w.layer == 0 && owner == app && isNew(w.pid) {
                    if let box = seen(i, in: windows, displays: displays) {
                        wasSeen = true
                        if firstMs == nil { firstMs = (now - t0) * 1000 }
                        if !frames.contains(where: { $0.insetBy(dx: -2, dy: -2).contains(box) }) { frames.append(box) }
                    }
                }
                lock.unlock()
                last = now
                Thread.sleep(forTimeInterval: 0.004)
            }
            done.signal()
        }.start()
    }
    func stop() { lock.lock(); stopped = true; lock.unlock(); done.wait() }
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

if agentShown() { print("untested live: the agent workspace is shown, so a window there can't be told from a flash"); exit(3) }
let seenBarMs = 50.0
// The app's own domain, the one it reads the flag from (`OpenFlashGuard.defaultsDomain`).
let guardOn = UserDefaults(suiteName: "com.baney.polycarp")?.string(forKey: "agentOpenFlashGuard") == "cover"
print(guardOn ? "seen check: gating (agentOpenFlashGuard cover)" : "seen check: known, flag off (times printed, not failed)")
var opens = 0, identified = 0, strays = 0, focusChanges = 0, closes = 0, closeMismatches = 0, flashes = 0
var seenAll: [Double] = []
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
        // Running copies of other names are never this app's; a pid that was running before the open is not new.
        let sampler = Sampler(app: app) { !before.contains($0) }
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
        sampler.stop()
        seenAll.append(sampler.seenMs)
        if seenFails(sampler.seenMs, guardOn: guardOn, bar: seenBarMs) {
            flashes += 1
            failures.append("\(app) #\(round): seen on Donovan's workspace for \(Int(sampler.seenMs)) ms (bar \(Int(seenBarMs)) ms) at \(sampler.frames.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" })")
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
        let seenNote = String(format: "seen_ms=%.0f first_at=%@ frames=%@ samples=%d worst_gap_ms=%.0f", sampler.seenMs,
                              sampler.firstMs.map { String(format: "%.0fms", $0) } ?? "-",
                              sampler.frames.isEmpty ? "-" : sampler.frames.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" }.joined(separator: ";"),
                              sampler.samples, sampler.worstGapMs)
        print("\(app) #\(round): \(secs)s window=\(wid.map(String.init) ?? "none") stray=\(off.count) front_changed=\(frontChanged) \(closeNote) \(seenNote)")
        for pid in fresh { quit(pid) }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
}
print("opens \(opens), identified \(identified), stray \(strays), focus changes \(focusChanges), close answers wrong \(closeMismatches) of \(closes), seen over \(Int(seenBarMs)) ms \(guardOn ? "\(flashes)" : "known, flag off") (worst \(Int(seenAll.max() ?? 0)) ms, total \(Int(seenAll.reduce(0, +))) ms)")
if failures.isEmpty && opens > 0 { print("agent-open-probe: pass"); exit(0) }
for f in failures { print("FAIL \(f)") }
print(opens == 0 ? "agent-open-probe: nothing ran (every app was already running)" : "agent-open-probe: fail")
exit(1)
