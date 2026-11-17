// Fails if `agent open` leaves a window off the agent workspace, misses its window, takes the keyboard, or if `close`
// answers something the window list doesn't show. 11-12: Calculator and Font Book waited 7.1 s, answered
// `window_identified: false`, and stayed drawn on Donovan's workspace; `close` answered `closed: false` for windows
// already gone. Opens each app <rounds> times (default 3) through `polycarp-spaces agent`, and for each open checks:
//   identified: `open` returned a window id;
//   stray: no window of the new process is drawn (window server, on screen) on any workspace but the agent one;
//   focus: the app in front never changed while it opened (sampled every 50 ms);
//   close: `close`'s `closed` matches whether the window server still lists the window;
//   seen: from the open until it settles, a sampler reads the window server every 4 ms (on screen only) and adds up the
//   time any window of the new process (alpha 0.1 or more) showed at least 8x8 pt on a display, not covered by a window
//   in front of it.
//   frames: every display is captured (ScreenCaptureKit, half size, up to 60 frames a second) from just before the
//   open until it settles, and a frame in which the place where a window of the new process is listed differs from the
//   first frame (8x8 pt or more, luma off by over 24) shows that window. A cover is painted from the screen as it
//   was, so a covered window shows nothing. Council gap G9 ("an occasional 1 s screen flash"): zero frames is the bar.
//   The agent workspace is not shown while the probe runs, so all of that was on Donovan's workspace. With the cover on,
//   the default, over 50 ms seen or any frame showing a window fails the open; with
//   `defaults write com.baney.polycarp agentOpenFlashGuard off` both print as "known, flag off" and fail nothing.
//   The frame check needs Screen Recording for the process running the probe; the probe never asks for it, and without
//   it says "untested live" and exits 3 (`--no-frames` runs the rest). 11-12 on 639dd5f: Font Book and Dictionary
//   showed for 0.7 to 1.5 s, and the check above passed, because it looked only at where the window ended up.
// Apps already running are skipped (an open of a running app asks that copy, which isn't this probe's). It quits only
// the copies it started: new pids, started after the probe, run with -ApplePersistenceIgnoreState.
// Agent workspace only: it types, clicks and moves nothing. Run it with the build under test installed and running.
// It runs only when Donovan has been idle 10 minutes. 11-12: each open drew its window on his workspace for 0.7 to 1.7 s
// before it was parked, and a 10-open run while he worked read to him as "random windows keep opening like font book".
// Otherwise it prints "untested live" and exits 3, opening nothing. --force is for a Mac nobody is using. A run whose
// samples were ever over 16 ms apart is invalid (exit 4), not passed.
//   swift scripts/agent-open-probe.swift [rounds] [App ...] [--force] [--no-frames]
// Default: 5 rounds of 10 apps, 50 opens.
import AppKit
import CoreMedia
import ScreenCaptureKit

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
/// A run whose samples were ever more than this apart is invalid, not passed: a flash could hide in the gap (review of
/// PR 225, sol-F3).
let gapLimitMs = 16.0
func gapInvalid(_ worstGapMs: Double) -> Bool { worstGapMs > gapLimitMs }

/// When the sampler reads next: every `period` from its first read, never early, and at once after a read that ran past
/// its turn, with no burst to catch up. The old loop slept 4 ms after each read, so a 3 ms read put samples 7 ms apart
/// (#304: at load 2 to 3 its worst gaps were 24 to 67 ms).
struct Pace {
    let period: Double
    var due: Double
    /// Seconds to wait from `now` until the next read.
    mutating func wait(now: Double) -> Double {
        due += period
        if due <= now { due = now; return 0 }
        return due - now
    }
}

/// Seconds on the raw monotonic clock, which neither NTP nor a clock change moves.
func uptime() -> Double { Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e9 }

/// The part of `list[i]` a person can see: on a display, not under an opaque window in front of it. Exact: the window is
/// cut at every edge of a display or a window in front, and each cell is in or out whole, so overlaps of several windows
/// count right. A 4 pt grid over the window took about 200 ms a look under 30 windows, past the sampler's 16 ms gap
/// (issue #252, second-S2). Returns the shown area in pt² and the bounding box of what shows.
func shown(_ i: Int, in list: [Seen], displays: [CGRect], cover: pid_t = polycarpPid) -> (area: CGFloat, box: CGRect) {
    let w = list[i].bounds
    func clip(_ r: CGRect) -> CGRect? { let c = r.intersection(w); return c.isNull || c.isEmpty ? nil : c }
    let front = list[..<i].filter { $0.hides(cover: cover) }.compactMap { clip($0.bounds) }
    let screens = displays.compactMap(clip)
    let xs = Array(Set([w.minX, w.maxX] + (front + screens).flatMap { [$0.minX, $0.maxX] })).sorted()
    let ys = Array(Set([w.minY, w.maxY] + (front + screens).flatMap { [$0.minY, $0.maxY] })).sorted()
    let nx = xs.count - 1, ny = ys.count - 1
    guard nx > 0, ny > 0 else { return (0, .null) }
    // 1: on a display; 0 after: under a window in front. Cells by index ranges, so each rect marks only its own cells.
    var cell = [UInt8](repeating: 0, count: nx * ny)
    func mark(_ r: CGRect, _ v: UInt8) {
        guard let x0 = xs.firstIndex(of: r.minX), let x1 = xs.firstIndex(of: r.maxX),
              let y0 = ys.firstIndex(of: r.minY), let y1 = ys.firstIndex(of: r.maxY) else { return }
        for y in y0..<y1 { for x in x0..<x1 { cell[y * nx + x] = v } }
    }
    for r in screens { mark(r, 1) }
    for r in front { mark(r, 0) }
    var area: CGFloat = 0, box = CGRect.null
    for y in 0..<ny { for x in 0..<nx where cell[y * nx + x] == 1 {
        let c = CGRect(x: xs[x], y: ys[y], width: xs[x + 1] - xs[x], height: ys[y + 1] - ys[y])
        area += c.width * c.height; box = box.union(c)
    } }
    return (area, box)
}

/// Seen by a person: at least an 8x8 pt part shows. A parked window's corner sliver (1 pt) doesn't count. `cover` is the
/// pid that owns the covers: Polycarp's in a real run, the fixtures' in the selftest.
func seen(_ i: Int, in list: [Seen], displays: [CGRect], cover: pid_t = polycarpPid) -> CGRect? {
    // A window under alpha 0.1 shows nothing, the same line the guard draws (`OpenFlashGuard.needsGuard`): a clear
    // helper of the app isn't a flash (issue #252, sol-F3).
    guard list[i].alpha >= 0.1 else { return nil }
    let s = shown(i, in: list, displays: displays, cover: cover)
    return s.area >= 64 && s.box.width >= 8 && s.box.height >= 8 ? s.box : nil
}

/// A frame's brightness, one byte a pixel, as captured: `w` by `h`.
struct Luma {
    let w: Int, h: Int, px: [UInt8]
}

/// How many pixels inside `boxes` (pixel rects of the frame) differ from `base` by more than `level`.
func changed(_ base: Luma, _ frame: Luma, in boxes: [CGRect], level: Int = 24) -> Int {
    guard base.w == frame.w, base.h == frame.h else { return Int.max }
    var seen = [Bool](repeating: false, count: base.w * base.h), n = 0
    for b in boxes {
        let x0 = max(0, Int(b.minX.rounded(.down))), x1 = min(base.w, Int(b.maxX.rounded(.up)))
        let y0 = max(0, Int(b.minY.rounded(.down))), y1 = min(base.h, Int(b.maxY.rounded(.up)))
        guard x0 < x1, y0 < y1 else { continue }
        for y in y0..<y1 { for x in x0..<x1 {
            let i = y * base.w + x
            if seen[i] { continue }
            seen[i] = true
            if abs(Int(base.px[i]) - Int(frame.px[i])) > level { n += 1 }
        } }
    }
    return n
}

/// A frame shows a window when at least 8x8 pt of it changed. Frames are half size, so that is 4x4 pixels.
let framePixelBar = 16
func frameShows(_ base: Luma, _ frame: Luma, in boxes: [CGRect]) -> Bool { changed(base, frame, in: boxes) >= framePixelBar }

if CommandLine.arguments.contains("--selftest") {
    let screen = [CGRect(x: 0, y: 0, width: 1512, height: 982)]
    let app = Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 400, y: 300, width: 500, height: 400))
    var bad = 0
    func check(_ what: String, _ ok: Bool) { print((ok ? "ok   " : "FAIL ") + what); if !ok { bad += 1 } }
    check("a window in the middle of the screen is seen", seen(0, in: [app], displays: screen) != nil)
    check("a parked window's 1 pt corner is not", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 1511, y: 981, width: 500, height: 400))], displays: screen) == nil)
    check("a window macOS clamped to a 1x32 pt strip is not", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 1511, y: 950, width: 500, height: 400))], displays: screen) == nil)
    // The cover fixtures run under the pid the real run uses (Polycarp's, by bundle id) and under a stand-in, so both
    // the running and the not-running case are checked on every selftest; each classifies with its own fixture pid.
    let owners = polycarpPid > 0 ? [polycarpPid, 4242] : [4242]
    let full = CGRect(x: 0, y: 0, width: 1512, height: 982)
    for pc in owners {
        print("cover owner: pid \(pc)\(pc == polycarpPid ? " (Polycarp, by bundle id)" : " (stand-in, as when Polycarp isn't running)")")
        let cover = Seen(pid: pc, layer: coverLevel, alpha: 1, bounds: full)
        check("one under Polycarp's cover is not", seen(1, in: [cover, app], displays: screen, cover: pc) == nil)
        check("one under another app's window at the cover's level is", seen(1, in: [Seen(pid: 3, layer: coverLevel, alpha: 1, bounds: full), app], displays: screen, cover: pc) != nil)
        check("one under another app's alpha-1 overlay is", seen(1, in: [Seen(pid: 3, layer: 25, alpha: 1, bounds: full), app], displays: screen, cover: pc) != nil)
        check("one under the agent cursor's overlay is", seen(1, in: [Seen(pid: pc, layer: 25, alpha: 1, bounds: full), app], displays: screen, cover: pc) != nil)
        check("one under a layer-0 Polycarp overlay is", seen(1, in: [Seen(pid: pc, layer: 0, alpha: 1, bounds: full), app], displays: screen, cover: pc) != nil)
        check("one under a translucent ordinary window (alpha 0.6) is", seen(1, in: [Seen(pid: 3, layer: 0, alpha: 0.6, bounds: full), app], displays: screen, cover: pc) != nil)
    }
    check("with the cover off, a 1 s open is known, not failed", !seenFails(1000, guardOn: false))
    check("with it on, 51 ms fails and 50 ms passes", seenFails(51, guardOn: true) && !seenFails(50, guardOn: true))
    check("a run with a 17 ms sample gap is invalid, 16 ms is not", gapInvalid(17) && !gapInvalid(16))
    // #304: reads of 3, 3, 20 and 3 ms on a 4 ms pace. Samples land 4 ms apart, the slow read counts in full (21 ms from
    // the last sample), and the next read starts at once (3 ms later), not after another wait.
    var pace = Pace(period: 0.004, due: 0), t = 0.0, at: [Double] = []
    for read in [0.003, 0.003, 0.020, 0.003, 0.003] { t += read; at.append(t); t += pace.wait(now: t) }
    let gaps = zip(at.dropFirst(), at).map { (($0 - $1) * 1000).rounded() }
    check("samples on a 4 ms pace with 3 ms reads are 4 ms apart, a 20 ms read 21, the next 3 then 4: \(gaps)", gaps == [4, 21, 3, 4])
    let qos = Sampler(app: "agent-open-probe selftest") { _ in false }
    Thread.sleep(forTimeInterval: 0.05); qos.stop()
    check("the sampler reads at user-interactive QoS", qos.qos == QOS_CLASS_USER_INTERACTIVE)
    check("one under a clear overlay is", seen(1, in: [Seen(pid: 4242, layer: 25, alpha: 0, bounds: full), app], displays: screen, cover: 4242) != nil)
    let half = Seen(pid: 2, layer: 0, alpha: 1, bounds: CGRect(x: 400, y: 300, width: 250, height: 400))
    check("half covered, the other half shows", seen(1, in: [half, app], displays: screen, cover: 4242).map { $0.minX >= 646 } == true)
    check("off every display is not", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 3000, y: 0, width: 500, height: 400))], displays: screen, cover: 4242) == nil)
    // Issue #252: a clear helper shows nothing (sol-F3), and one look at a full-screen window under 30 others leaves the
    // 4 ms sampler room under its 16 ms gap (second-S2: a 4 pt grid over the window ran past it).
    check("a clear (alpha 0) window of the app is not", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 0, bounds: full)], displays: screen) == nil)
    check("nor one at alpha 0.05", seen(0, in: [Seen(pid: 7, layer: 0, alpha: 0.05, bounds: full)], displays: screen) == nil)
    let others = (0..<30).map { k in Seen(pid: 3, layer: 0, alpha: 1, bounds: CGRect(x: 40 + Double(k % 6) * 240, y: 30 + Double(k / 6) * 190, width: 150, height: 120)) }
    let t0 = ProcessInfo.processInfo.systemUptime
    var shownAt = 0
    for _ in 0..<20 { if seen(30, in: others + [Seen(pid: 7, layer: 0, alpha: 1, bounds: full)], displays: screen) != nil { shownAt += 1 } }
    let perLook = (ProcessInfo.processInfo.systemUptime - t0) * 1000 / 20
    check(String(format: "a full-screen window under 30 others is seen, in %.2f ms a look (bar 2 ms)", perLook), shownAt == 20 && perLook < 2)
    let exact = shown(30, in: others + [Seen(pid: 7, layer: 0, alpha: 1, bounds: full)], displays: screen).area
    check("its shown area is exact: the screen less the 30 windows", abs(exact - (1512 * 982 - 30 * 150 * 120)) < 1)
    // Frames: a window drawn where it is listed shows; the same change elsewhere, or a cover's near-copy, doesn't.
    let blank = Luma(w: 40, h: 30, px: [UInt8](repeating: 100, count: 1200))
    func painted(_ r: CGRect, _ v: UInt8) -> Luma {
        var px = blank.px
        for y in Int(r.minY)..<Int(r.maxY) { for x in Int(r.minX)..<Int(r.maxX) { px[y * 40 + x] = v } }
        return Luma(w: 40, h: 30, px: px)
    }
    let box = CGRect(x: 10, y: 10, width: 10, height: 8)
    check("an unchanged frame shows nothing", !frameShows(blank, blank, in: [box]))
    check("a window drawn in its listed place shows", frameShows(blank, painted(box, 230), in: [box]))
    check("the same change outside every listed place doesn't", !frameShows(blank, painted(CGRect(x: 25, y: 2, width: 10, height: 8), 230), in: [box]))
    check("a cover's copy, off by 20 levels, doesn't", !frameShows(blank, painted(box, 120), in: [box]))
    check("a 3x3 pixel change (6x6 pt) doesn't, 4x4 does", !frameShows(blank, painted(CGRect(x: 10, y: 10, width: 3, height: 3), 230), in: [box])
          && frameShows(blank, painted(CGRect(x: 10, y: 10, width: 4, height: 4), 230), in: [box]))
    check("overlapping places count a pixel once", changed(blank, painted(box, 230), in: [box, box]) == 80)
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
let noFrames = args.contains("--no-frames")
args.removeAll { $0 == "--no-frames" }
let rounds = args.first.flatMap(Int.init) ?? 5
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

/// Samples the window server every 4 ms (`Pace`) on its own user-interactive thread until stopped, and adds up the time
/// any window of a process that `isNew` accepts was seen. A sample's time runs until the next one, so a slow read counts
/// in full. `worstReadMs` is how long the window server took to answer the read that ended the worst gap: when it is
/// most of the gap, the window server was late, not this thread.
final class Sampler {
    private let lock = NSLock()
    private var stopped = false
    private(set) var seenMs = 0.0, firstMs: Double?, samples = 0, worstGapMs = 0.0, worstReadMs = 0.0
    private(set) var qos = QOS_CLASS_UNSPECIFIED
    private(set) var frames: [CGRect] = []
    /// Where windows of the new process have been listed on screen so far, covered or not (the frame check's places).
    private var placesSoFar: [CGRect] = []
    var places: [CGRect] { lock.lock(); defer { lock.unlock() }; return placesSoFar }
    private let done = DispatchSemaphore(value: 0)
    init(app: String, isNew: @escaping (pid_t) -> Bool) {
        let displays = displayRects()
        let thread = Thread { [self] in
            let t0 = uptime()
            var last = t0, wasSeen = false, pace = Pace(period: 0.004, due: t0)
            lock.lock(); qos = qos_class_self(); lock.unlock()
            while true {
                lock.lock(); let stop = stopped; lock.unlock()
                if stop { break }
                let asked = uptime()
                let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                let now = uptime()
                let list = info.compactMap { w -> (Seen, String)? in
                    guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                          let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { return nil }
                    return (Seen(pid: pid, layer: (w[kCGWindowLayer as String] as? Int) ?? 0, alpha: (w[kCGWindowAlpha as String] as? Double) ?? 1, bounds: b),
                            (w[kCGWindowOwnerName as String] as? String) ?? "")
                }
                let windows = list.map(\.0)
                lock.lock()
                if wasSeen { seenMs += (now - last) * 1000 }
                if (now - last) * 1000 > worstGapMs { worstGapMs = (now - last) * 1000; worstReadMs = (now - asked) * 1000 }
                samples += 1
                wasSeen = false
                for (i, (w, owner)) in list.enumerated() where w.layer == 0 && owner == app && isNew(w.pid) {
                    if w.alpha >= 0.1, !placesSoFar.contains(w.bounds) { placesSoFar.append(w.bounds) }
                    if let box = seen(i, in: windows, displays: displays) {
                        wasSeen = true
                        if firstMs == nil { firstMs = (now - t0) * 1000 }
                        if !frames.contains(where: { $0.insetBy(dx: -2, dy: -2).contains(box) }) { frames.append(box) }
                    }
                }
                lock.unlock()
                last = now
                let wait = pace.wait(now: uptime())
                if wait > 0 { usleep(useconds_t(wait * 1e6)) }
            }
            done.signal()
        }
        thread.qualityOfService = .userInteractive
        thread.start()
    }
    func stop() { lock.lock(); stopped = true; lock.unlock(); done.wait() }
}

/// Records one display from just before an open until it settles, judging each frame as it comes against the first:
/// `showing` counts frames in which a place the sampler lists differs from it. Frames are never kept.
final class FrameWatch: NSObject, SCStreamOutput {
    private let lock = NSLock()
    private let bounds: CGRect
    private let places: () -> [CGRect]
    private var stream: SCStream?
    private var base: Luma?
    private(set) var frames = 0, showing = 0, worst = 0
    private let queue = DispatchQueue(label: "agent-open-probe.frames", qos: .userInteractive)
    private let first = DispatchSemaphore(value: 0)

    init(display: SCDisplay, places: @escaping () -> [CGRect]) {
        bounds = CGDisplayBounds(display.displayID)
        self.places = places
        super.init()
        let config = SCStreamConfiguration()
        config.width = max(2, Int(bounds.width / 2)); config.height = max(2, Int(bounds.height / 2))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.showsCursor = false
        config.queueDepth = 6
        let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: nil)
        try? s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        stream = s
    }

    /// Starts and waits for the first frame (the "before"); false when none came in a second.
    func start() -> Bool {
        let started = DispatchSemaphore(value: 0)
        var ok = false
        stream?.startCapture { ok = $0 == nil; started.signal() }
        started.wait()
        return ok && first.wait(timeout: .now() + 1) == .success
    }

    func stop() {
        let stopped = DispatchSemaphore(value: 0)
        stream?.stopCapture { _ in stopped.signal() }
        _ = stopped.wait(timeout: .now() + 2)
        queue.sync {}
    }

    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let info = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              (info[.status] as? Int).flatMap(SCFrameStatus.init(rawValue:)) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let raw = CVPixelBufferGetBaseAddress(pb) else { return }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), row = CVPixelBufferGetBytesPerRow(pb)
        let bytes = raw.assumingMemoryBound(to: UInt8.self)
        var px = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h { for x in 0..<w {
            let p = bytes + y * row + x * 4   // B, G, R, A
            px[y * w + x] = UInt8((Int(p[2]) * 77 + Int(p[1]) * 150 + Int(p[0]) * 29) >> 8)
        } }
        let frame = Luma(w: w, h: h, px: px)
        lock.lock(); defer { lock.unlock() }
        guard let base else { base = frame; first.signal(); return }
        let sx = CGFloat(w) / bounds.width, sy = CGFloat(h) / bounds.height
        let boxes = places().compactMap { r -> CGRect? in
            let c = r.intersection(bounds)
            return c.isNull || c.isEmpty ? nil : CGRect(x: (c.minX - bounds.minX) * sx, y: (c.minY - bounds.minY) * sy, width: c.width * sx, height: c.height * sy)
        }
        frames += 1
        let n = changed(base, frame, in: boxes)
        worst = max(worst, n == Int.max ? 0 : n)
        if n >= framePixelBar { showing += 1 }
    }
    var result: (frames: Int, showing: Int, worst: Int) { lock.lock(); defer { lock.unlock() }; return (frames, showing, worst) }
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
// The cover is on unless the flag says exactly `off` (`OpenFlashGuard.from`).
let guardOn = UserDefaults(suiteName: "com.baney.polycarp")?.string(forKey: "agentOpenFlashGuard") != "off"
print(guardOn ? "seen and frame checks: gating (the cover is on)" : "seen and frame checks: known, flag off (printed, not failed)")
/// The displays to record, or nil with --no-frames. No Screen Recording permission: untested live (never asked for here).
let displays: [SCDisplay]? = {
    if noFrames { return nil }
    let got = DispatchSemaphore(value: 0)
    var list: [SCDisplay] = [], problem: Error?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
        list = content?.displays ?? []; problem = error; got.signal()
    }
    got.wait()
    if problem != nil || list.isEmpty {
        print("untested live: the frame check can't capture the displays (\(problem?.localizedDescription ?? "no display")); this process needs Screen Recording, which the probe never asks for. --no-frames runs the rest.")
        exit(3)
    }
    return list
}()
var opens = 0, identified = 0, strays = 0, focusChanges = 0, closes = 0, closeMismatches = 0, flashes = 0
var framesAll = 0, framesShowing = 0, frameOpens = 0
var seenAll: [Double] = []
var failures: [String] = [], invalid: [String] = []
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
        let watches = (displays ?? []).map { FrameWatch(display: $0, places: { sampler.places }) }
        let recording = watches.allSatisfy { $0.start() }
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
        watches.forEach { $0.stop() }
        let shot = watches.map(\.result).reduce((frames: 0, showing: 0, worst: 0)) { ($0.frames + $1.frames, $0.showing + $1.showing, max($0.worst, $1.worst)) }
        if displays != nil {
            if !recording { invalid.append("\(app) #\(round): a display gave no first frame, so its frames can't be judged") }
            else { frameOpens += 1; framesAll += shot.frames; framesShowing += shot.showing }
            if guardOn, shot.showing > 0 {
                failures.append("\(app) #\(round): \(shot.showing) of \(shot.frames) captured frames show a window of it on Donovan's workspace (up to \(shot.worst) px changed)")
            }
        }
        seenAll.append(sampler.seenMs)
        if seenFails(sampler.seenMs, guardOn: guardOn, bar: seenBarMs) {
            flashes += 1
            failures.append("\(app) #\(round): seen on Donovan's workspace for \(Int(sampler.seenMs)) ms (bar \(Int(seenBarMs)) ms) at \(sampler.frames.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" })")
        }
        if gapInvalid(sampler.worstGapMs) {
            invalid.append("\(app) #\(round): samples \(Int(sampler.worstGapMs)) ms apart at worst (limit \(Int(gapLimitMs)) ms), \(Int(sampler.worstReadMs)) ms of it waiting on the window server's answer, so its seen time can't be trusted")
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
        let frameNote = displays == nil ? "" : " captured=\(shot.frames) showing=\(shot.showing) worst_px=\(shot.worst)"
        let seenNote = String(format: "seen_ms=%.0f first_at=%@ frames=%@ samples=%d worst_gap_ms=%.0f (read %.0f)", sampler.seenMs,
                              sampler.firstMs.map { String(format: "%.0fms", $0) } ?? "-",
                              sampler.frames.isEmpty ? "-" : sampler.frames.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" }.joined(separator: ";"),
                              sampler.samples, sampler.worstGapMs, sampler.worstReadMs) + frameNote
        print("\(app) #\(round): \(secs)s window=\(wid.map(String.init) ?? "none") stray=\(off.count) front_changed=\(frontChanged) \(closeNote) \(seenNote)")
        for pid in fresh { quit(pid) }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
}
print("opens \(opens), identified \(identified), stray \(strays), focus changes \(focusChanges), close answers wrong \(closeMismatches) of \(closes), seen over \(Int(seenBarMs)) ms \(guardOn ? "\(flashes)" : "known, flag off") (worst \(Int(seenAll.max() ?? 0)) ms, total \(Int(seenAll.reduce(0, +))) ms)")
if displays != nil {
    print("frames: \(framesShowing) of \(framesAll) captured over \(frameOpens) opens show an agent window\(guardOn ? "" : " (known, flag off)")")
}
if failures.isEmpty && invalid.isEmpty && opens > 0 { print("agent-open-probe: pass"); exit(0) }
for f in failures { print("FAIL \(f)") }
for f in invalid { print("INVALID \(f)") }
if failures.isEmpty && opens > 0 { print("agent-open-probe: invalid (rerun on a quieter Mac)"); exit(4) }
print(opens == 0 ? "agent-open-probe: nothing ran (every app was already running)" : "agent-open-probe: fail")
exit(1)
