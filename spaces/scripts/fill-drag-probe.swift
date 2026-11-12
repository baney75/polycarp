// Fails unless a filled window dragged by its title bar moves only with the pointer: at most one size change per drag,
// never against the pointer, the title bar under the pointer the whole drag, and the window on screen once it's let go
// (Donovan, 2026-11-12: Helium filled by a drag to the top jumped off the pointer when he dragged it down again, and
// came back 40% off the left edge).
//
// Each case opens its own window, asserts the state the case is about (macOS filled it, Polycarp filled it, the overview
// let it go over no workspace, it was let go hanging off the edge, macOS filled it and it must hold), and, with Polycarp
// running, asserts the trace lines that show Polycarp took part, so a case can't pass without testing anything; an
// unreadable trace fails. The judged drags never stop at the top, where Polycarp's overview would take the drag. Samples
// go next to the trace.
//
// Case 5 is the lower-half jump (Helium, 2026-11-12 10:32:29.69 and 34.42, 0.7 s and 1 s after macOS filled it). It is
// watched from mouse-up with no gap for 3 s. Its arms split the cause between Polycarp, Chromium and macOS:
//   (none)           the probe's own window, Polycarp running
//   --no-polycarp    the probe's own window, Polycarp quit first: macOS alone, judged by frames only
//   --chromium       a Chrome for Testing window the probe launches with a fresh profile (never his Helium), Polycarp running
//   --chromium --no-polycarp   Chromium and macOS alone
// The arms with either flag run case 5 only. --chromium installs nothing: without Chrome for Testing it says so and stops.
//
// It takes the pointer, so it refuses to run unless the Mac has been idle 10 minutes. Before every press it checks that the
// window under the press point is the one it means to drag, and stops if not, so no click can land in another app. It
// posts ⌃⌘F only when its own window is frontmost and key, checked just before, so no key can land in another app either.
//
//   swift scripts/fill-drag-probe.swift --self-test   the judges alone, on the frames from the report (no pointer)
//   swift scripts/fill-drag-probe.swift [--record] [--no-polycarp] [--chromium]   the live cases
import AppKit
import Foundation

struct Sample { let t: Double; let pointer: CGPoint; let frame: CGRect; let down: Bool }
/// A frame read after mouse-up: `t` is seconds since the release, and a frame that can't be read is nil.
struct Watch { let t: Double; let frame: CGRect? }

/// What's wrong with a drag, from its samples. `visible` is the display's visible area in window-server coordinates.
func judge(_ samples: [Sample], visible: CGRect) -> [String] {
    var out: [String] = []
    var sizeChanges = 0, against = 0, offPointer = 0
    var changing = false, sinceResize = 99
    var growing: Bool?
    for (a, b) in zip(samples, samples.dropFirst()) {
        let resized = abs(a.frame.width - b.frame.width) > 2 || abs(a.frame.height - b.frame.height) > 2
        // One animated resize is one change: count where a run of resizing frames starts, and again where it turns
        // around (shrunk, then grown back: two resizes back to back, the flicker from the report).
        let grows = b.frame.width * b.frame.height > a.frame.width * a.frame.height
        if resized && (!changing || growing != grows) { sizeChanges += 1 }
        if resized { growing = grows } else { growing = nil }
        changing = resized
        sinceResize = resized ? 0 : sinceResize + 1
        guard b.down, !resized else { continue }
        let pdx = b.pointer.x - a.pointer.x, pdy = b.pointer.y - a.pointer.y
        let wdx = b.frame.minX - a.frame.minX, wdy = b.frame.minY - a.frame.minY
        if (pdx * wdx < 0 && abs(wdx) > 2) || (pdy * wdy < 0 && abs(wdy) > 2) { against += 1 }
        // The pointer holds the title bar: once a resize has settled (two samples), it stays over the bar.
        let bar = CGRect(x: b.frame.minX - 2, y: b.frame.minY - 2, width: b.frame.width + 4, height: 44)
        if sinceResize >= 2, !bar.contains(b.pointer) { offPointer += 1 }
    }
    if sizeChanges > 1 { out.append("\(sizeChanges) size changes in one drag") }
    if against > 0 { out.append("\(against) frames moved against the pointer") }
    if offPointer > 0 { out.append("\(offPointer) frames with the title bar away from the pointer") }
    if let last = samples.last, !visible.insetBy(dx: -2, dy: -2).contains(last.frame) {
        out.append("let go off screen at \(last.frame)")
    }
    return out
}

/// The trace lines not found: each entry is the parts one line must hold together. An empty trace misses them all.
func missing(_ trace: [String], _ wanted: [[String]]) -> [[String]] {
    wanted.filter { parts in !trace.contains { line in parts.allSatisfy(line.contains) } }
}
/// Polycarp watched a drag of `id` and left a full-size window's size to macOS.
func macOSFillDrag(_ id: UInt32) -> [[String]] { [["topDrag moving window=\(id)"], ["fill window=\(id) drag left to macOS"]] }
/// The overview opened over `id`, let it go over no workspace, and the window went back to where it was.
func overviewPutBack(_ id: UInt32) -> [[String]] {
    [["topDrag overview open", "window=\(id)"], ["topDrag release at=", "target=none"], ["drag end window=\(id) back to its frame before the overview"]]
}
enum FillHold: Equatable {
    case held(CGRect)
    case neverFilled(CGRect?)
    case changed(at: Double, from: CGRect, to: CGRect?)
    case short(Double)
}
/// How a window let go at the top fared over the `over` seconds from mouse-up, watched with no gap. macOS fills it within
/// the first second, and from the first filled frame on it must stay filled where it filled. The lower-half jump came
/// 0.7 s and 1 s after the fill, so a watch that starts a second after the release can't see it (review of #154).
func fillHeld(_ watched: [Watch], fills: (CGRect) -> Bool, over: Double = 3, slack: CGFloat = 4) -> FillHold {
    guard let last = watched.last, last.t >= over - 0.05 else { return .short(watched.last?.t ?? 0) }
    guard let i = watched.firstIndex(where: { $0.t <= 1 && $0.frame.map(fills) == true }), let held = watched[i].frame else {
        return .neverFilled(watched.last(where: { $0.t <= 1 })?.frame)
    }
    for w in watched[(i + 1)...] {
        guard let f = w.frame, fills(f), abs(f.minX - held.minX) <= slack, abs(f.minY - held.minY) <= slack else {
            return .changed(at: w.t, from: held, to: w.frame)
        }
    }
    return .held(held)
}
/// Polycarp watched a drag of `id` reach the top and rest there: the drag macOS fills (review of #154, second-F5).
func topRestSeen(_ id: UInt32) -> [[String]] { [["topDrag moving window=\(id)"], ["topDrag dwell start window=\(id)"]] }
/// The lines where Polycarp itself moved or filled `id`, which a window macOS filled must not have.
func polycarpMoved(_ trace: [String], _ id: UInt32) -> [String] {
    trace.filter { $0.contains("drag end window=\(id) ") || $0.contains("fill window=\(id) on") }
}
/// The newest of several Chrome for Testing apps, by the build number in their paths.
func newest(_ paths: [String]) -> String? { paths.max { $0.compare($1, options: .numeric) == .orderedAscending } }

/// ⌃⌘F goes to whatever app is frontmost, so the probe posts it only into its own key window.
func mayPostKey(frontmost: pid_t?, me: pid_t, probeWindowIsKey: Bool) -> Bool { frontmost == me && probeWindowIsKey }
func backNear(_ a: CGRect?, _ b: CGRect?, within d: CGFloat) -> Bool {
    guard let a, let b else { return false }
    return abs(a.minX - b.minX) <= d && abs(a.minY - b.minY) <= d && abs(a.width - b.width) <= d && abs(a.height - b.height) <= d
}
/// Lines appended to `url` since `offset`, or nil when the file can't be read.
func traceSince(_ offset: UInt64, in url: URL) -> [String]? {
    guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? h.close() }
    let size = (try? h.seekToEnd()) ?? 0
    try? h.seek(toOffset: offset <= size ? offset : 0)
    return String(decoding: h.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
}

var failures: [String] = []
func expect(_ ok: Bool, _ what: String) {
    print(ok ? "  ok    \(what)" : "  FAIL  \(what)")
    if !ok { failures.append(what) }
}

if CommandLine.arguments.contains("--self-test") {
    let visible = CGRect(x: 0, y: 35, width: 1512, height: 947)
    func s(_ t: Double, _ p: (CGFloat, CGFloat), _ f: (CGFloat, CGFloat, CGFloat, CGFloat), down: Bool = true) -> Sample {
        Sample(t: t, pointer: CGPoint(x: p.0, y: p.1), frame: CGRect(x: f.0, y: f.1, width: f.2, height: f.3), down: down)
    }
    // 10:32:04 to 05: filled, Polycarp shrinks it, macOS animates it back to its saved frame, off the left edge.
    let reported = [s(0, (400, 40), (0, 35, 1512, 947)), s(0.02, (400, 44), (-145, 39, 1089, 759)), s(0.04, (400, 48), (155, 240, 1185, 799)),
                    s(0.06, (400, 52), (-608, 478, 1492, 928)), s(0.08, (400, 60), (-608, 478, 1492, 928)), s(0.10, (400, 70), (-608, 478, 1492, 928)),
                    s(0.12, (400, 80), (-608, 478, 1492, 928)), s(0.3, (400, 80), (-608, 478, 1492, 928), down: false)]
    let r = judge(reported, visible: visible)
    expect(r.contains { $0.contains("size changes") }, "the reported drag fails on its two size changes (\(r))")
    expect(r.contains { $0.contains("away from the pointer") }, "the reported drag fails on the title bar left behind")
    expect(r.contains { $0.contains("off screen") }, "the reported frame (-608, 478, 1492x928) fails as off screen")
    // Let go over no workspace with the overview up: a drag that followed the pointer, ending off the left edge.
    let blind = [s(0, (300, 300), (-200, 290, 1492, 928)), s(0.02, (200, 400), (-300, 390, 1492, 928)), s(0.04, (290, 490), (-210, 480, 1492, 928)),
                 s(0.2, (290, 490), (-608, 478, 1492, 928), down: false)]
    expect(judge(blind, visible: visible).contains { $0.contains("off screen") }, "a window let go off screen fails")
    // Donovan's gesture done right: macOS untiles once, the window follows the pointer, ends on screen.
    let good = [s(0, (700, 40), (0, 35, 1512, 947)), s(0.02, (700, 50), (100, 40, 1200, 800)), s(0.04, (700, 60), (100, 45, 1200, 800)),
                s(0.06, (710, 80), (110, 65, 1200, 800)), s(0.08, (720, 100), (120, 85, 1200, 800)), s(0.3, (720, 100), (120, 85, 1200, 800), down: false)]
    expect(judge(good, visible: visible).isEmpty, "a clean drag passes (\(judge(good, visible: visible)))")

    // Review of #150: case 1 passed when Polycarp never saw the drag, case 3 never showed the correction ran.
    let seen = ["10:32:04.100 topDrag moving window=7", "10:32:04.101 fill window=7 drag left to macOS: full size, no record, frame=(0,35,1512,947)"]
    expect(missing(seen, macOSFillDrag(7)).isEmpty, "case 1 passes on the lines Polycarp logs")
    expect(missing([], macOSFillDrag(7)).count == 2, "case 1 fails on an empty trace")
    expect(!missing(["10:32:04.100 topDrag moving window=8"] + seen.dropFirst(), macOSFillDrag(7)).isEmpty, "case 1 fails on another window's drag")
    let putBack = ["10:31:56.9 topDrag overview open after 410 ms window=7", "10:32:00.279 topDrag release at=0,498 target=none",
                   "10:32:00.5 drag end window=7 back to its frame before the overview: (-608,478) to (65,35)"]
    expect(missing(putBack, overviewPutBack(7)).isEmpty, "case 3 passes when the correction ran")
    expect(missing(Array(putBack.prefix(2)), overviewPutBack(7)).count == 1, "case 3 fails when the correction never ran")
    expect(backNear(CGRect(x: 66, y: 35, width: 900, height: 600), CGRect(x: 65, y: 36, width: 900, height: 600), within: 3), "back near its frame")
    expect(!backNear(CGRect(x: -608, y: 478, width: 900, height: 600), CGRect(x: 65, y: 35, width: 900, height: 600), within: 40), "left off screen is not back")
    expect(!backNear(nil, CGRect(x: 65, y: 35, width: 900, height: 600), within: 40), "no frame is not back")
    expect(traceSince(0, in: URL(fileURLWithPath: "/nonexistent/trace.log")) == nil, "an unreadable trace is nil, not an empty pass")
    // Review of #150, F3: ⌃⌘F only into the probe's own key window.
    expect(mayPostKey(frontmost: 42, me: 42, probeWindowIsKey: true), "frontmost and key: posts")
    expect(!mayPostKey(frontmost: 99, me: 42, probeWindowIsKey: true), "another app frontmost: no key")
    expect(!mayPostKey(frontmost: nil, me: 42, probeWindowIsKey: true), "frontmost unknown: no key")
    expect(!mayPostKey(frontmost: 42, me: 42, probeWindowIsKey: false), "probe frontmost but its window not key: no key")
    // Review of #154, first-F1: case 5 watches from mouse-up with no gap, 3 s, and a change at 0.7 s fails.
    // 2026-11-12 10:32:29.69: Helium went from (0, 35, 1512x949) to (0, 540, 1512x444) with no input.
    let filled = CGRect(x: 0, y: 35, width: 1512, height: 949)
    let fullSize: (CGRect) -> Bool = { abs($0.width - visible.width) <= 3 && abs($0.height - visible.height) <= 3 }
    let atTop = CGRect(x: 306, y: 0, width: 900, height: 600)
    let lowerHalf = CGRect(x: 0, y: 540, width: 1512, height: 444)
    func watch(_ frameAt: (Double) -> CGRect?, until end: Double = 3) -> [Watch] {
        stride(from: 0.0, through: end, by: 0.016).map { Watch(t: $0, frame: frameAt($0)) }
    }
    let holds = watch { $0 < 0.25 ? atTop : filled }
    expect(fillHeld(holds, fills: fullSize) == .held(filled), "a fill that holds 3 s from mouse-up passes (\(fillHeld(holds, fills: fullSize)))")
    let jumps = watch { $0 < 0.25 ? atTop : ($0 >= 0.7 && $0 < 1.2) ? lowerHalf : filled }
    if case let .changed(at, from, to) = fillHeld(jumps, fills: fullSize) {
        expect(abs(at - 0.7) < 0.02 && from == filled && to == lowerHalf, "a jump to the lower half 0.7 s after mouse-up fails at 0.7 s (\(at))")
    } else {
        expect(false, "a jump to the lower half 0.7 s after mouse-up fails (\(fillHeld(jumps, fills: fullSize)))")
    }
    let late = jumps.filter { $0.t >= 1.3 }.map { Watch(t: $0.t, frame: $0.frame) }
    expect(fillHeld(late, fills: fullSize) == .neverFilled(nil), "a watch that starts a second late can't vouch for the fill")
    let moves = watch { $0 < 0.25 ? atTop : $0 < 1.5 ? filled : filled.offsetBy(dx: 0, dy: 30) }
    expect(fillHeld(moves, fills: fullSize) != .held(filled), "a filled window that slides down without resizing fails")
    expect(fillHeld(watch { $0 < 0.25 ? atTop : $0 < 2 ? filled : nil }, fills: fullSize) != .held(filled), "a filled window that can't be read fails")
    expect(fillHeld(watch { _ in atTop }, fills: fullSize) == .neverFilled(atTop), "a window macOS never filled fails as a precondition, not a jump")
    expect(fillHeld(watch({ $0 < 0.25 ? atTop : filled }, until: 2), fills: fullSize) == .short(2), "a watch shorter than 3 s fails")
    expect(fillHeld(watch { $0 < 0.4 ? atTop.insetBy(dx: -100, dy: 0) : filled.offsetBy(dx: 2, dy: 0) }, fills: fullSize) == .held(filled.offsetBy(dx: 2, dy: 0)),
           "the fill's own animation before the first filled frame doesn't count")
    // Review of #154, second-F5: case 5 shows Polycarp saw the drag reach the top, and that Polycarp didn't move it.
    let rested = ["10:32:28.1 topDrag moving window=7", "10:32:28.4 topDrag dwell start window=7", "10:32:28.8 topDrag overview open after 410 ms window=7"]
    expect(missing(rested, topRestSeen(7)).isEmpty, "case 5 passes on the lines Polycarp logs for a rest at the top")
    expect(missing([], topRestSeen(7)).count == 2, "case 5 fails on an empty trace")
    expect(missing(Array(rested.prefix(1)), topRestSeen(7)).count == 1, "case 5 fails when Polycarp never saw the rest at the top")
    expect(polycarpMoved(rested + ["10:32:29.7 drag end window=7 back to its frame before the overview: (0,35) to (0,540)"], 7).count == 1, "a correction of the window is caught")
    expect(polycarpMoved(rested + ["10:32:29.7 fill window=7 on frame=(0,35,1512,947)"], 7).count == 1, "a Polycarp fill of the window is caught")
    expect(polycarpMoved(rested + ["10:32:29.7 drag end window=70 back to its frame before the overview"], 7).isEmpty, "another window's correction isn't")
    // Review of #154, second-F4: the newest Chrome for Testing by build number, not by spelling.
    let cft = "chrome-mac-arm64/Google Chrome for Testing.app"
    expect(newest(["/c/ms-playwright/chromium-999/\(cft)", "/c/ms-playwright/chromium-1248/\(cft)", "/c/ms-playwright/chromium-1200/\(cft)"]) == "/c/ms-playwright/chromium-1248/\(cft)",
           "the newest Chrome for Testing is the highest build")
    expect(newest([]) == nil, "no Chrome for Testing is nil")
    print(failures.isEmpty ? "PASS" : "FAIL: \(failures.count)")
    exit(failures.isEmpty ? 0 : 1)
}

let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Polycarp")
let record = CommandLine.arguments.contains("--record")

func idleSeconds() -> Double {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    defer { IOObjectRelease(service) }
    let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    return ((value as? NSNumber)?.doubleValue ?? 0) / 1e9
}

guard idleSeconds() >= 600 else {
    print("not idle 10 minutes (\(Int(idleSeconds())) s): this probe takes the pointer, so it waits for an idle Mac")
    exit(2)
}
let noPolycarp = CommandLine.arguments.contains("--no-polycarp")
let chromium = CommandLine.arguments.contains("--chromium")
let polycarpRunning = !NSRunningApplication.runningApplications(withBundleIdentifier: "com.baney.polycarp").isEmpty
if noPolycarp {
    guard !polycarpRunning else {
        print("--no-polycarp tests macOS without Polycarp, but Polycarp is running: quit it first (the probe won't quit it)"); exit(2)
    }
    print("Polycarp was not running: case 5 only, judged by frames alone, no trace")
} else {
    guard polycarpRunning else { print("Polycarp isn't running (pass --no-polycarp to test macOS without it)"); exit(2) }
}

/// The newest Chrome for Testing on this Mac: Playwright's and Puppeteer's caches, then the Applications folders.
func chromeForTesting() -> URL? {
    let fm = FileManager.default, home = fm.homeDirectoryForCurrentUser
    let name = "Google Chrome for Testing.app"
    var cached: [String] = []
    for root in ["Library/Caches/ms-playwright", ".cache/puppeteer/chrome"].map({ home.appendingPathComponent($0) }) {
        for build in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] {
            let dir = root.appendingPathComponent(build)
            for arch in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where arch.hasPrefix("chrome-mac") {
                let app = dir.appendingPathComponent(arch).appendingPathComponent(name)
                if fm.fileExists(atPath: app.appendingPathComponent("Contents/MacOS/Google Chrome for Testing").path) { cached.append(app.path) }
            }
        }
    }
    let installed = ["/Applications", home.appendingPathComponent("Applications").path].map { "\($0)/\(name)" }.filter(fm.fileExists)
    return (newest(cached) ?? installed.first).map(URL.init(fileURLWithPath:))
}
let chrome: URL? = chromium ? chromeForTesting() : nil
if chromium, chrome == nil {
    print("--chromium needs Google Chrome for Testing, which isn't on this Mac. Install it (for example `npx @puppeteer/browsers install chrome@stable`), then run again. The probe installs nothing.")
    exit(2)
}

// trace.log, read from an offset, so a case sees only what Polycarp logged while it ran.
let traceURL = support.appendingPathComponent("trace.log")
func traceEnd() -> UInt64 { ((try? FileManager.default.attributesOfItem(atPath: traceURL.path))?[.size] as? UInt64) ?? 0 }
func traceSince(_ offset: UInt64) -> [String] {
    guard let lines = traceSince(offset, in: traceURL) else {
        expect(false, "trace.log readable at \(traceURL.path)")
        return []
    }
    return lines
}
func currentWorkspace() -> (current: Int, agent: Int?, used: Set<Int>) {
    let url = support.appendingPathComponent("state.json")
    let j = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? [:]
    let used = Set(((j["workspaces"] as? [String: Any]) ?? [:]).keys.compactMap(Int.init))
    return (j["current"] as? Int ?? 1, j["agentWorkspace"] as? Int, used)
}
func go(_ n: Int) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-g", "polycarp://switch/\(n)"]
    try? p.run(); p.waitUntilExit()
    usleep(900_000)
}

func windows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}
func bounds(_ w: [String: Any]) -> CGRect? {
    (w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
}
func frame(_ id: CGWindowID) -> CGRect? {
    var ids = [UnsafeRawPointer(bitPattern: UInt(id))]
    guard let array = CFArrayCreate(nil, &ids, 1, nil) else { return nil }
    return (CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]])?.first.flatMap(bounds)
}
/// The pid of the first visible window under `p`, the one a press there would reach.
func ownerAt(_ p: CGPoint) -> pid_t? {
    for w in windows() {
        guard let b = bounds(w), b.contains(p) else { continue }
        if let alpha = w[kCGWindowAlpha as String] as? Double, alpha == 0 { continue }
        return w[kCGWindowOwnerPID as String] as? pid_t
    }
    return nil
}

func post(_ type: CGEventType, _ p: CGPoint) {
    let e = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    e?.setIntegerValueField(.mouseEventClickState, value: 1)
    e?.post(tap: .cgSessionEventTap)
}

struct Drag { let samples: [Sample]; let watched: [Watch] }
/// Presses `from`, glides through `path` at `speed` points a second sampling every 16 ms, holding `hold` seconds at each
/// stop, and releases at the end, then reads the frame every 16 ms from mouse-up for `after` seconds. Stops the probe if
/// the press point isn't a window of `owner` (the probe's own, or the Chromium it launched).
func drag(_ id: CGWindowID, from: CGPoint, path: [CGPoint], speed: CGFloat, hold: Double = 0.25, owner: pid_t = getpid(), after: Double = 1) -> Drag {
    guard ownerAt(from) == owner else {
        print("the press point isn't the probe's window: stopped before any click"); exit(3)
    }
    var samples: [Sample] = []
    let start = Date()
    func sample(_ p: CGPoint, _ down: Bool) {
        if let f = frame(id) { samples.append(Sample(t: -start.timeIntervalSinceNow, pointer: p, frame: f, down: down)) }
    }
    post(.leftMouseDown, from); usleep(120_000); sample(from, true)
    var at = from
    for to in path {
        let steps = max(1, Int((hypot(to.x - at.x, to.y - at.y) / speed) / 0.016))
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: at.x + (to.x - at.x) * t, y: at.y + (to.y - at.y) * t)
            post(.leftMouseDragged, p); usleep(16_000); sample(p, true)
        }
        at = to
        for _ in 0..<Int(hold / 0.016) { post(.leftMouseDragged, at); usleep(16_000); sample(at, true) }
    }
    post(.leftMouseUp, at)
    // From the release on with no gap: macOS and Polycarp finish the drop here, and case 5's jump came 0.7 s in.
    let up = Date()
    var watched: [Watch] = []
    repeat {
        let f = frame(id)
        watched.append(Watch(t: -up.timeIntervalSinceNow, frame: f))
        if let f { samples.append(Sample(t: -start.timeIntervalSinceNow, pointer: at, frame: f, down: false)) }
        usleep(16_000)
    } while -up.timeIntervalSinceNow < after
    return Drag(samples: samples, watched: watched)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.screens[0]
let visibleTop = screen.frame.maxY - screen.visibleFrame.maxY
let visible = CGRect(x: screen.visibleFrame.minX, y: visibleTop, width: screen.visibleFrame.width, height: screen.visibleFrame.height)
func fills(_ r: CGRect?) -> Bool {
    guard let r else { return false }
    return abs(r.width - visible.width) <= 3 && abs(r.height - visible.height) <= 3
}

func makeWindow(_ title: String) -> (NSWindow, CGWindowID) {
    var made: NSWindow!
    DispatchQueue.main.sync {
        made = NSWindow(contentRect: NSRect(x: 260, y: 220, width: 900, height: 600),
                        styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        made.title = title
        made.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
    }
    usleep(1_500_000)  // Polycarp places a new window on its next scan
    return (made, CGWindowID(made.windowNumber))
}

func capture(_ name: String, seconds: Int) -> Process? {
    guard record else { return nil }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-v", "-V", "\(seconds)", support.appendingPathComponent("fill-drag-probe-\(name).mov").path]
    try? p.run()
    usleep(500_000)
    return p
}

let titleY: (CGRect) -> CGFloat = { $0.minY + 14 }

/// A drag to the top and a hold there, let go at the top: macOS fills the window. Fails the case if it didn't.
func macOSFill(_ id: CGWindowID, _ name: String) -> Bool {
    guard let f = frame(id) else { return false }
    let grab = CGPoint(x: f.midX, y: titleY(f))
    _ = drag(id, from: grab, path: [CGPoint(x: grab.x, y: 0)], speed: 500, hold: 0.8)
    usleep(800_000)
    let filled = fills(frame(id))
    expect(filled, "\(name): precondition, macOS filled the window (frame \(String(describing: frame(id))))")
    return filled
}

/// The gesture Donovan reported: from the filled position, away from the top and down to the dock edge, no stop at the top.
func judgedDrag(_ id: CGWindowID, _ name: String) -> UInt64 {
    let start = traceEnd()
    guard let f = frame(id) else { return start }
    let grab = CGPoint(x: f.midX, y: titleY(f))
    let samples = drag(id, from: grab, path: [CGPoint(x: grab.x + 60, y: visible.minY + 220),
                                              CGPoint(x: grab.x + 80, y: visible.maxY - 12)], speed: 250).samples
    let lines = samples.map { "\(String(format: "%.3f", $0.t)) \($0.down ? "down" : "up") p=\(Int($0.pointer.x)),\(Int($0.pointer.y)) f=\(Int($0.frame.minX)),\(Int($0.frame.minY)),\(Int($0.frame.width))x\(Int($0.frame.height))" }
    try? lines.joined(separator: "\n").write(to: support.appendingPathComponent("fill-drag-probe-\(name).log"), atomically: true, encoding: .utf8)
    let trace = traceSince(start)
    expect(missing(trace, [["topDrag moving window=\(id)"]]).isEmpty, "\(name): precondition, Polycarp watched the drag")
    let opened = trace.contains { $0.contains("overview open") && $0.contains("window=\(id)") }
    expect(!opened, "\(name): precondition, the overview stayed shut, so this was the plain drag")
    let problems = judge(samples, visible: visible)
    expect(problems.isEmpty, "\(name): the window followed the pointer and ended on screen \(problems)")
    return start
}

/// Case 5: a drag to the top, a rest there and a release, watched from mouse-up with no gap for 3 s. macOS must fill the
/// window, and from the first filled frame it must hold. With Polycarp running, the trace must show Polycarp saw the drag
/// reach the top and never moved or filled the window itself.
func fillHolds(_ id: CGWindowID, grab: CGPoint, owner: pid_t, _ name: String) {
    let before = traceEnd()
    let d = drag(id, from: grab, path: [CGPoint(x: grab.x, y: 0)], speed: 500, hold: 0.8, owner: owner, after: 3)
    let lines = d.watched.map { w in "\(String(format: "%.3f", w.t)) f=\(w.frame.map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width))x\(Int($0.height))" } ?? "none")" }
    try? lines.joined(separator: "\n").write(to: support.appendingPathComponent("fill-drag-probe-\(name).log"), atomically: true, encoding: .utf8)
    switch fillHeld(d.watched, fills: { fills($0) }) {
    case let .held(f):
        expect(true, "\(name): precondition, macOS filled the window within 1 s of mouse-up")
        expect(true, "\(name): the filled frame \(f) held 3 s from mouse-up")
    case let .changed(at, from, to):
        expect(true, "\(name): precondition, macOS filled the window within 1 s of mouse-up")
        expect(false, "\(name): the filled frame \(from) held 3 s from mouse-up, but changed \(Int(at * 1000)) ms after it to \(String(describing: to))")
    case let .neverFilled(f):
        expect(false, "\(name): precondition, macOS filled the window within 1 s of mouse-up (frame \(String(describing: f)))")
    case let .short(t):
        expect(false, "\(name): watched 3 s from mouse-up (only \(String(format: "%.2f", t)) s)")
    }
    guard !noPolycarp else { return print("  Polycarp was not running: no trace to check") }
    let trace = traceSince(before)
    expect(missing(trace, topRestSeen(id)).isEmpty, "\(name): Polycarp saw the drag reach the top and rest there \(missing(trace, topRestSeen(id)))")
    expect(polycarpMoved(trace, id).isEmpty, "\(name): Polycarp never moved or filled the window itself \(polycarpMoved(trace, id))")
    let opened = trace.contains { $0.contains("overview open") && $0.contains("window=\(id)") }
    print("  the overview \(opened ? "opened" : "stayed shut") during the rest at the top")
}

/// Case 5 on a Chrome for Testing window with a profile of its own, the stand-in for Helium.
func chromiumFillHolds(_ app: URL) {
    print("Chromium (\(app.path)): macOS fill, then hold 3 s")
    let profile = FileManager.default.temporaryDirectory.appendingPathComponent("fill-drag-probe-chrome-\(getpid())")
    let p = Process()
    p.executableURL = app.appendingPathComponent("Contents/MacOS/Google Chrome for Testing")
    p.arguments = ["--user-data-dir=\(profile.path)", "--no-first-run", "--no-default-browser-check", "--disable-sync",
                   "--window-position=260,220", "--window-size=900,600", "about:blank"]
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    defer {
        if p.isRunning { p.terminate(); p.waitUntilExit() }
        try? FileManager.default.removeItem(at: profile)
    }
    do { try p.run() } catch { return expect(false, "chromium: precondition, Chrome for Testing launched (\(error))") }
    var window: CGWindowID?
    for _ in 0..<50 where window == nil {
        usleep(200_000)
        window = windows().lazy.compactMap { w -> CGWindowID? in
            guard w[kCGWindowOwnerPID as String] as? pid_t == p.processIdentifier, w[kCGWindowLayer as String] as? Int == 0,
                  let b = bounds(w), b.height > 200 else { return nil }
            return w[kCGWindowNumber as String] as? CGWindowID
        }.first
    }
    guard let id = window else { return expect(false, "chromium: precondition, Chrome for Testing opened a window") }
    usleep(1_500_000)  // Polycarp places a new window on its next scan
    guard let f = frame(id) else { return expect(false, "chromium: precondition, its window has a frame") }
    // The empty tab strip right of the one tab, which drags the window as a title bar does.
    let rec = capture("chromium-fill-holds", seconds: 7)
    fillHolds(id, grab: CGPoint(x: f.maxX - 220, y: f.minY + 10), owner: p.processIdentifier, "chromium-fill-holds")
    rec?.waitUntilExit()
}

DispatchQueue.global().async {
    defer { DispatchQueue.main.async { app.terminate(nil) } }
    if let chrome {
        chromiumFillHolds(chrome)
        print(failures.isEmpty ? "PASS" : "FAIL: \(failures.count)")
        exit(failures.isEmpty ? 0 : 1)
    }
    if !noPolycarp { cases1to4() }
    // Case 5, the lower-half jump (10:32:29.69 and 34.42).
    print("macOS fill, then hold 3 s from mouse-up")
    let (w5, id5) = makeWindow("Polycarp fill-drag probe (fill holds)")
    let rec5 = capture("fill-holds", seconds: 7)
    if let f = frame(id5) { fillHolds(id5, grab: CGPoint(x: f.midX, y: titleY(f)), owner: getpid(), "fill-holds") }
    rec5?.waitUntilExit()
    DispatchQueue.main.sync { w5.close() }

    print(failures.isEmpty ? "PASS" : "FAIL: \(failures.count)")
    exit(failures.isEmpty ? 0 : 1)
}

/// Cases 1 to 4, which need Polycarp: its fill, its overview and its trace.
func cases1to4() {
    let home = currentWorkspace()

    // Case 1, Donovan's: macOS fills the window, then it's dragged down to the dock edge.
    print("macOS fill, then drag down")
    let (w1, id1) = makeWindow("Polycarp fill-drag probe (macOS fill)")
    let rec1 = capture("macos-fill", seconds: 12)
    if macOSFill(id1, "macos-fill") {
        let from = judgedDrag(id1, "macos-fill")
        let trace = traceSince(from)
        expect(missing(trace, macOSFillDrag(id1)).isEmpty, "macos-fill: Polycarp saw the drag and left the size to macOS \(missing(trace, macOSFillDrag(id1)))")
        expect(!trace.contains { $0.contains("off: dragged away") && $0.contains("window=\(id1)") }, "macos-fill: Polycarp didn't resize it")
    }
    rec1?.waitUntilExit()
    DispatchQueue.main.sync { w1.close() }

    // Case 2: Polycarp fills it (⌃⌘F, posted where Polycarp's key tap sees it), then the same drag: one resize, Polycarp's.
    print("Polycarp fill, then drag down")
    let (w2, id2) = makeWindow("Polycarp fill-drag probe (Polycarp fill)")
    let before2 = traceEnd()
    var posted = false
    DispatchQueue.main.sync {
        // Checked just before the post, in one main-thread turn. The window server delivers the key later, so focus could
        // still move in between; the check after the post catches that, though it can't call the key back. Posting to
        // the probe's own pid instead would skip Polycarp's session tap, and with it the fill under test.
        guard mayPostKey(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier, me: getpid(), probeWindowIsKey: w2.isKeyWindow) else { return }
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: 3, keyDown: down)
            e?.flags = [.maskControl, .maskCommand]
            e?.post(tap: .cgSessionEventTap)
        }
        posted = true
    }
    expect(posted, "polycarp-fill: the probe's window was frontmost and key, so ⌃⌘F could go only to it")
    if posted {
        usleep(200_000)
        var stillOurs = false
        DispatchQueue.main.sync { stillOurs = NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() && w2.isKeyWindow }
        expect(stillOurs, "polycarp-fill: still frontmost and key once ⌃⌘F was delivered (if not, it may have reached another app)")
        usleep(1_000_000)
    }
    let filledByUs = posted && fills(frame(id2)) && traceSince(before2).contains { $0.contains("fill window=\(id2) on") }
    expect(filledByUs, "polycarp-fill: precondition, Polycarp filled the window (frame \(String(describing: frame(id2))))")
    let rec2 = capture("polycarp-fill", seconds: 10)
    if filledByUs {
        let from = judgedDrag(id2, "polycarp-fill")
        expect(traceSince(from).contains { $0.contains("fill window=\(id2) off: dragged away") }, "polycarp-fill: Polycarp gave its size back")
    }
    rec2?.waitUntilExit()
    DispatchQueue.main.sync { w2.close() }

    // Case 4, review of #150: a window dragged on purpose until a third hangs off the right edge stays where it was put.
    print("drag off the right edge, let go")
    let (w4, id4) = makeWindow("Polycarp fill-drag probe (off the edge)")
    if let f = frame(id4) {
        let before = traceEnd()
        let grab = CGPoint(x: f.midX, y: titleY(f))
        let samples = drag(id4, from: grab, path: [CGPoint(x: visible.maxX - 150, y: grab.y + 40)], speed: 400).samples
        usleep(800_000)
        let trace = traceSince(before)
        let put = samples.last(where: { $0.down })?.frame
        expect(put.map { $0.maxX > visible.maxX + 100 } == true, "off-edge: precondition, let go with part of it past the right edge (\(String(describing: put)))")
        expect(missing(trace, [["topDrag moving window=\(id4)"]]).isEmpty, "off-edge: precondition, Polycarp watched the drag")
        expect(!trace.contains { $0.contains("drag end window=\(id4)") }, "off-edge: Polycarp didn't correct it")
        expect(backNear(frame(id4), put, within: 3), "off-edge: it stayed where it was let go (\(String(describing: frame(id4))))")
    }
    DispatchQueue.main.sync { w4.close() }

    // Case 3, the sequence before Donovan's glitch: a workspace switch away and back, the overview let go over no
    // workspace with the window off the left edge, then a fill and the drag down.
    print("switch, overview let go over nothing, fill, drag down")
    let (w3, id3) = makeWindow("Polycarp fill-drag probe (overview)")
    let rec3 = capture("overview", seconds: 22)
    if let other = (2...8).first(where: { $0 != home.current && $0 != home.agent && !home.used.contains($0) }) ?? (2...8).first(where: { $0 != home.current && $0 != home.agent }) {
        go(other); go(home.current)
    }
    expect(frame(id3).map { visible.intersects($0) } == true, "overview: the window came back with its workspace")
    if let f = frame(id3) {
        let before = traceEnd()
        // Held near its right end, so letting go at x 160 leaves most of the window off the left edge.
        let grab = CGPoint(x: f.maxX - 60, y: titleY(f))
        let samples = drag(id3, from: grab, path: [CGPoint(x: grab.x, y: 0), CGPoint(x: 160, y: 520)], speed: 500, hold: 0.7).samples
        usleep(800_000)
        let trace = traceSince(before)
        let none = missing(trace, Array(overviewPutBack(id3).prefix(2))).isEmpty
        expect(none, "overview: precondition, the overview opened and let go over no workspace")
        // The frame while it waited at the top, which is the frame the overview opened over.
        let covered = samples.last(where: { $0.down && $0.pointer.y <= 2 })?.frame
        let letGo = samples.last(where: { $0.down })?.frame
        expect(letGo.map { !visible.contains($0) } == true, "overview: precondition, let go with the window off screen (\(String(describing: letGo)))")
        if none {
            expect(missing(trace, overviewPutBack(id3)).isEmpty, "overview: Polycarp put it back \(missing(trace, overviewPutBack(id3)))")
            expect(backNear(frame(id3), covered, within: 40),
                   "overview: back at its frame from before the overview (\(String(describing: frame(id3))) vs \(String(describing: covered)))")
            if macOSFill(id3, "overview") {
                if let saved = frame(id3) { print("  filled at \(saved)") }
                _ = judgedDrag(id3, "overview")
            }
        }
    }
    rec3?.waitUntilExit()
    DispatchQueue.main.sync { w3.close() }
}
app.run()
