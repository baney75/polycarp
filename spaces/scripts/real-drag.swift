// One real-pointer window drag, described on the command line, with the window's frames read from mouse-up and the
// trace lines Polycarp wrote meanwhile. It posts real mouse events at the session tap, so the drag goes through the
// window server: macOS's own edge tiling, and an app's own drag code (Chromium's tab strip) see it as a person's drag.
//
// Where it runs:
//   - In a Tart guest (scripts/guest-drag.sh), with --guest: the guest's pointer, never Donovan's. Runs any time.
//   - On the host, without --guest: only when the Mac has been idle 10 minutes (HIDIdleTime). Otherwise it prints
//     "untested live" and exits 3 before it touches anything. On the host it drags only a copy it starts itself with
//     --launch (a Chromium browser on a temp --user-data-dir, quit and removed on every way out), never his Helium.
// Either way it presses only on a window of the app it was told to drag (checked at the press point first) and stops
// before any click otherwise.
//
//   real-drag --app <name|pid> | --launch <app> [--plain] [--start x,y,w,h] [--grab title|strip|tab|DX,DY] [--to top|X,Y[;X,Y...]]
//             [--rest S] [--release here|X,Y] [--watch S] [--trace PATH] [--out DIR] [--expect fill|stay]
//             [--guest]
//   real-drag --self-test        the judge alone, on the frames from Donovan's reports (no pointer)
//
// --plain launches a native app without the Chromium flags (the macOS-alone arm: Chess, TextEdit).
// --grab is where on the window the press lands: title (the middle of a 28 pt title bar), strip (the empty end of a
// Chromium tab strip, 220 pt from the right), tab (the first tab), or an offset from the window's top-left corner.
// --to top glides to the top edge straight above the grab point. --rest is how long it holds there before the release.
// --expect fill fails (exit 1) unless the window ends filling the visible area and never sat in the lower half after it
// first filled; --expect stay fails unless it ends where it was let go. Exit 0 passed or nothing expected, 1 failed,
// 2 bad arguments or no window, 3 not run (untested live, or the press point was not the app's window).
import AppKit
import Foundation

// MARK: judge (pure; --self-test runs it)

enum Shape: String { case filled, lowerHalf = "lower-half", other }

/// What a frame looks like on a display whose visible area (menu bar excluded, window-server coordinates) is `visible`.
func shape(_ f: CGRect, visible v: CGRect, slack: CGFloat = 4) -> Shape {
    if abs(f.width - v.width) <= slack, abs(f.height - v.height) <= slack, abs(f.minY - v.minY) <= slack, abs(f.minX - v.minX) <= slack {
        return .filled
    }
    // Donovan's jump: full width, the top pushed below the upper third, the bottom at the screen's bottom.
    if f.width >= v.width * 0.9, f.minY >= v.minY + v.height * 0.35, f.maxY >= v.maxY - slack { return .lowerHalf }
    return .other
}

struct Watch { let ms: Int; let frame: CGRect? }

struct Verdict {
    var final: CGRect?
    var finalShape: Shape?
    var shapes: [(ms: Int, shape: Shape, frame: CGRect)] = [] // each change of shape after the release
    var flips: Int { max(0, shapes.count - 1) }
    var lowerHalfAfterFill: Int? // ms of the first lower-half frame after the window first filled
    var failure: String?
}

/// Reads the frames watched from mouse-up. `expect` is "fill", "stay" or nil; `letGo` is the frame the window had when
/// the button came up (for "stay").
func judge(_ watched: [Watch], visible: CGRect, expect: String?, letGo: CGRect? = nil) -> Verdict {
    var v = Verdict()
    var filledOnce = false
    for w in watched {
        guard let f = w.frame else { continue }
        let s = shape(f, visible: visible)
        if s == .filled { filledOnce = true }
        if s == .lowerHalf, filledOnce, v.lowerHalfAfterFill == nil { v.lowerHalfAfterFill = w.ms }
        if v.shapes.last?.shape != s { v.shapes.append((w.ms, s, f)) }
        v.final = f
        v.finalShape = s
    }
    switch expect {
    case "fill":
        if v.final == nil { v.failure = "the window could not be read after the release" }
        else if let ms = v.lowerHalfAfterFill { v.failure = "it filled, then sat in the lower half at +\(ms) ms (\(v.flips) shape changes)" }
        else if v.finalShape != .filled { v.failure = "it ended \(v.finalShape!.rawValue) at \(str(v.final!)), not filled" }
    case "stay":
        if let f = v.final, let l = letGo, abs(f.minX - l.minX) > 4 || abs(f.minY - l.minY) > 4 || abs(f.width - l.width) > 4 || abs(f.height - l.height) > 4 {
            v.failure = "it moved after the release: \(str(l)) to \(str(f))"
        } else if v.final == nil { v.failure = "the window could not be read after the release" }
    default: break
    }
    return v
}

func str(_ r: CGRect) -> String { "(\(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))x\(Int(r.height)))" }

func point(_ s: Substring) -> CGPoint? {
    let p = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    return p.count == 2 ? CGPoint(x: p[0], y: p[1]) : nil
}

/// Where on the window `grab` presses, in screen points.
func grabPoint(_ grab: String, window f: CGRect) -> CGPoint? {
    switch grab {
    case "title": return CGPoint(x: f.midX, y: f.minY + 14)
    case "strip": return CGPoint(x: f.maxX - 220, y: f.minY + 14)
    case "tab": return CGPoint(x: f.minX + 140, y: f.minY + 18)
    default: return point(Substring(grab)).map { CGPoint(x: f.minX + $0.x, y: f.minY + $0.y) }
    }
}

/// The stops of `--to`: "top" is the top edge above the grab point.
func path(_ to: String, from grab: CGPoint) -> [CGPoint]? {
    if to == "top" { return [CGPoint(x: grab.x, y: 0)] }
    let stops = to.split(separator: ";").map(point)
    return stops.isEmpty || stops.contains { $0 == nil } ? nil : stops.compactMap { $0 }
}

/// Whether the host may take the pointer: idle 10 minutes, or the last input of any kind was the driver's own previous
/// release (its events reset HIDIdleTime), so nobody has touched the Mac since a run that started on an idle Mac.
func idleAllows(idle: Double, now: Double, lastRelease: Double?) -> Bool {
    if idle >= 600 { return true }
    guard let last = lastRelease else { return false }
    return abs((now - idle) - last) < 2.5
}

func selfTest() -> Int32 {
    var failed = 0
    func expect(_ ok: Bool, _ what: String) { print((ok ? "ok    " : "FAIL  ") + what); if !ok { failed += 1 } }
    let visible = CGRect(x: 0, y: 33, width: 1512, height: 949) // Donovan's MacBook display, menu bar out
    expect(shape(CGRect(x: 0, y: 34, width: 1512, height: 949), visible: visible) == .filled, "macOS's fill (0,34 1512x949) is filled")
    expect(shape(CGRect(x: 0, y: 540, width: 1512, height: 444), visible: visible) == .lowerHalf, "the reported jump (0,540 1512x444) is the lower half")
    expect(shape(CGRect(x: 242, y: 33, width: 1101, height: 781), visible: visible) == .other, "a window let go part way down is neither")
    expect(shape(CGRect(x: 0, y: 507, width: 1512, height: 475), visible: visible) == .lowerHalf, "macOS's bottom-half tile counts as the lower half")
    // 11-16 recording: the release, then fill and lower half four times between +80 and +620 ms, ending low.
    let flipping = [Watch(ms: 0, frame: CGRect(x: 600, y: 33, width: 1100, height: 780))]
        + (0..<4).flatMap { i in [Watch(ms: 80 + i * 140, frame: CGRect(x: 0, y: 33, width: 1512, height: 949)),
                                  Watch(ms: 150 + i * 140, frame: CGRect(x: 0, y: 540, width: 1512, height: 444))] }
        + [Watch(ms: 3000, frame: CGRect(x: 0, y: 540, width: 1512, height: 444))]
    let bad = judge(flipping, visible: visible, expect: "fill")
    expect(bad.failure != nil && bad.lowerHalfAfterFill == 150, "the 11-16 flips fail --expect fill at +150 ms")
    expect(bad.flips == 8, "and count 8 shape changes (\(bad.flips))")
    // trace.log 2026-11-17, window 79165: macOS's fill animation from the release, then it holds.
    let clean = [(0, 190, 34, 1100, 780), (62, 125, 34, 1240, 838), (161, 21, 34, 1466, 930), (341, 0, 34, 1512, 949), (3000, 0, 34, 1512, 949)]
        .map { Watch(ms: $0.0, frame: CGRect(x: $0.1, y: $0.2, width: $0.3, height: $0.4)) }
    let good = judge(clean, visible: visible, expect: "fill")
    expect(good.failure == nil, "a clean macOS fill passes --expect fill (\(good.failure ?? "passed"))")
    expect(judge([Watch(ms: 0, frame: CGRect(x: 0, y: 540, width: 1512, height: 444))], visible: visible, expect: "fill").failure != nil,
           "a window that lands low without ever filling fails too")
    expect(judge([Watch(ms: 0, frame: nil)], visible: visible, expect: "fill").failure != nil, "an unreadable window fails")
    let letGo = CGRect(x: 100, y: 200, width: 900, height: 600)
    expect(judge([Watch(ms: 0, frame: letGo), Watch(ms: 900, frame: letGo)], visible: visible, expect: "stay", letGo: letGo).failure == nil,
           "--expect stay passes a window that stays")
    expect(judge([Watch(ms: 0, frame: letGo), Watch(ms: 900, frame: letGo.offsetBy(dx: 0, dy: 40))], visible: visible, expect: "stay", letGo: letGo).failure != nil,
           "--expect stay fails a window that moved after the release")
    let w = CGRect(x: 100, y: 50, width: 1000, height: 700)
    expect(grabPoint("strip", window: w) == CGPoint(x: 880, y: 64), "strip grabs 220 pt in from the right, in the tab row")
    expect(grabPoint("30,10", window: w) == CGPoint(x: 130, y: 60), "an offset grabs from the top-left corner")
    expect(path("top", from: CGPoint(x: 880, y: 64)) == [CGPoint(x: 880, y: 0)], "--to top is the top edge above the grab")
    expect(path("10,20;30,40", from: .zero) == [CGPoint(x: 10, y: 20), CGPoint(x: 30, y: 40)], "--to takes several stops")
    expect(path("10;x", from: .zero) == nil, "a bad stop is refused")
    expect(idleAllows(idle: 700, now: 10_000, lastRelease: nil), "idle 10 minutes allows a host drag")
    expect(!idleAllows(idle: 30, now: 10_000, lastRelease: nil), "30 s idle with no earlier run refuses")
    expect(idleAllows(idle: 120, now: 10_000, lastRelease: 9_880.5), "the last input being the driver's own release allows the next run")
    expect(!idleAllows(idle: 40, now: 10_000, lastRelease: 9_880.5), "a touch after the driver's release refuses")
    print(failed == 0 ? "real-drag self-test PASS" : "real-drag self-test FAIL (\(failed))")
    return failed == 0 ? 0 : 1
}

let args = CommandLine.arguments
if args.contains("--self-test") { exit(selfTest()) }

// MARK: live

func value(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
func fail(_ why: String, _ code: Int32 = 2) -> Never { print("real-drag: \(why)"); exit(code) }

func idleSeconds() -> Double {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    defer { IOObjectRelease(service) }
    let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    return ((value as? NSNumber)?.doubleValue ?? 0) / 1e9
}

let guest = args.contains("--guest")
// The driver's own events reset HIDIdleTime. A run may follow the driver's previous run when the last input of any kind
// was that run's own release: nobody has touched the Mac since a run that itself started on a 10-minute-idle Mac.
let lastRunURL = FileManager.default.temporaryDirectory.appendingPathComponent("real-drag-last-release")
if args.contains("--self-test") == false, !guest {
    let last = (try? String(contentsOf: lastRunURL, encoding: .utf8)).flatMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    guard idleAllows(idle: idleSeconds(), now: Date().timeIntervalSince1970, lastRelease: last) else {
        print("real-drag: untested live: the Mac has been idle \(Int(idleSeconds())) s, and a host drag needs 10 minutes (or run it in the guest with scripts/guest-drag.sh)")
        exit(3)
    }
}
guard AXIsProcessTrusted() else { fail("this process has no Accessibility permission (in the guest, guest-drag.sh grants it)") }

// --launch: a throwaway copy of a Chromium browser on a fresh profile (never the person's own), quit and removed on
// every way out. Chromium runs a second instance for a second --user-data-dir, so his own Helium is left alone.
var launched: Process?
var profile: URL?
func cleanup() {
    if let p = launched, p.isRunning { p.terminate(); usleep(800_000); if p.isRunning { kill(p.processIdentifier, SIGKILL) } }
    if let profile { try? FileManager.default.removeItem(at: profile) }
}
atexit { cleanup() }
for sig in [SIGINT, SIGTERM, SIGHUP] { signal(sig) { _ in exit(130) } }
var appArg = value("--app")
if !guest, appArg != nil {
    fail("on this Mac the driver drags only a copy it launched itself (--launch <app>), never an app already open")
}
if let bundle = value("--launch") {
    guard let exe = Bundle(path: bundle)?.executableURL else { fail("no app at \(bundle)") }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("real-drag-profile-\(getpid())")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    profile = dir
    let p = Process()
    p.executableURL = exe
    // --plain: a native app (Chess, TextEdit) for the macOS-alone arm; it takes no Chromium flags and keeps no profile.
    p.arguments = args.contains("--plain") ? ["-ApplePersistenceIgnoreState", "YES", "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO"]
        : ["--user-data-dir=\(dir.path)", "--no-first-run", "--no-default-browser-check", "--disable-sync", "about:blank"]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { fail("could not start \(bundle): \(error)") }
    launched = p
    appArg = String(p.processIdentifier)
    for _ in 0..<40 where NSRunningApplication(processIdentifier: p.processIdentifier) == nil { usleep(250_000) }
    sleep(3)
}
guard let appArg else { fail("--app <name|pid> or --launch <app> is required") }

let apps = NSWorkspace.shared.runningApplications
guard let target = Int32(appArg).flatMap({ pid in apps.first { $0.processIdentifier == pid } })
        ?? apps.first(where: { $0.localizedName == appArg }) else { fail("no running app \(appArg)") }
let pid = target.processIdentifier

func windows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}
func bounds(_ w: [String: Any]) -> CGRect? { (w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) } }
func frame(_ id: CGWindowID) -> CGRect? {
    // Not on-screen-only: a window mid-animation is still listed, and a closed one is not.
    (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first.flatMap(bounds)
}
/// The app's frontmost ordinary window.
func appWindow() -> (CGWindowID, CGRect)? {
    for w in windows() where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
        if let id = w[kCGWindowNumber as String] as? Int, let b = bounds(w), b.width > 200, b.height > 150 { return (CGWindowID(id), b) }
    }
    return nil
}
/// Whose window is on top at `p`, skipping windows that take no clicks (alpha 0).
func ownerAt(_ p: CGPoint) -> Int32? {
    for w in windows() where ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0 {
        if let b = bounds(w), b.contains(p) { return w[kCGWindowOwnerPID as String] as? Int32 }
    }
    return nil
}

let screen = NSScreen.screens[0]
let visible = CGRect(x: screen.visibleFrame.minX, y: screen.frame.maxY - screen.visibleFrame.maxY,
                     width: screen.visibleFrame.width, height: screen.visibleFrame.height)

target.activate()
usleep(400_000)
if let s = value("--start") {
    let n = s.split(separator: ",").compactMap { Double($0) }
    guard n.count == 4 else { fail("--start takes x,y,w,h") }
    let ax = AXUIElementCreateApplication(pid)
    var list: CFTypeRef?
    AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &list)
    guard let win = (list as? [AXUIElement])?.first else { fail("the app has no Accessibility window to place") }
    var size = CGSize(width: n[2], height: n[3]), origin = CGPoint(x: n[0], y: n[1])
    AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
    AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
    AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
    usleep(500_000)
}
guard let (id, startFrame) = appWindow() else { fail("\(target.localizedName ?? appArg) has no window on screen") }
let grabName = value("--grab") ?? "title"
guard let grab = grabPoint(grabName, window: startFrame) else { fail("bad --grab \(grabName)") }
guard let stops = path(value("--to") ?? "top", from: grab) else { fail("bad --to") }
let rest = Double(value("--rest") ?? "1") ?? 1
let releaseAt: CGPoint = value("--release").flatMap { $0 == "here" ? nil : point(Substring($0)) } ?? stops.last!
let watchFor = Double(value("--watch") ?? "3") ?? 3
let expectArg = value("--expect")
guard ownerAt(grab) == pid else { fail("the press point \(grab) is not \(target.localizedName ?? appArg)'s window: stopped before any click", 3) }

let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
let traceURL = value("--trace").map { URL(fileURLWithPath: $0) }
    ?? [support.appendingPathComponent("Polycarp/trace.log"), support.appendingPathComponent("BaneySpaces/trace.log")]
        .first { FileManager.default.fileExists(atPath: $0.path) }
func traceSize() -> UInt64 { traceURL.flatMap { (try? FileManager.default.attributesOfItem(atPath: $0.path))?[.size] as? UInt64 } ?? 0 }
let traceStart = traceSize()

func post(_ type: CGEventType, _ p: CGPoint) {
    // Session tap with a click count: macOS 27 starts a title-bar drag only for those (top-drag-probe, measured).
    let e = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    if type != .mouseMoved { e?.setIntegerValueField(.mouseEventClickState, value: 1) }
    e?.post(tap: .cgSessionEventTap)
}
func glide(_ a: CGPoint, _ b: CGPoint, speed: CGFloat = 1500) {
    let steps = max(2, Int(hypot(b.x - a.x, b.y - a.y) / speed / 0.012))
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        post(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
        usleep(12_000)
    }
}

// Where the pointer was before the drag; it goes back there after the watch, so a person finds it where they left it.
let home = CGEvent(source: nil)?.location
print("real-drag: \(target.localizedName ?? appArg) window \(id) at \(str(startFrame)), grab \(grabName) \(grab), to \(stops), rest \(rest) s, release \(releaseAt)\(guest ? ", in the guest" : "")")
post(.mouseMoved, grab); usleep(150_000)
post(.leftMouseDown, grab); usleep(150_000)
// A person's drag starts with a small wobble before it travels; Chromium's tab strip waits for a few points of motion.
post(.leftMouseDragged, CGPoint(x: grab.x + 3, y: grab.y + 2)); usleep(16_000)
var at = CGPoint(x: grab.x + 3, y: grab.y + 2)
for s in stops { glide(at, s); at = s }
let arrived = Date()
while -arrived.timeIntervalSinceNow < rest { post(.leftMouseDragged, at); usleep(30_000) }
if releaseAt != at { glide(at, releaseAt); usleep(100_000); at = releaseAt }
let letGo = frame(id)
post(.leftMouseUp, at)
let up = Date()
var watched: [Watch] = []
repeat { watched.append(Watch(ms: Int(-up.timeIntervalSinceNow * 1000), frame: frame(id))); usleep(10_000) } while -up.timeIntervalSinceNow < watchFor
// Input since the release that wasn't ours means a person is at the Mac: leave the pointer to them and end the chain.
let touched = !guest && idleSeconds() + 0.5 < -up.timeIntervalSinceNow
if touched {
    try? FileManager.default.removeItem(at: lastRunURL)
} else {
    if let home { post(.mouseMoved, home) }
    // The driver's last input, for the next run's idle gate (idleAllows).
    if !guest { try? String(Date().timeIntervalSince1970).write(to: lastRunURL, atomically: true, encoding: .utf8) }
}
usleep(300_000) // the trace writer is asynchronous
let rested = Int(up.timeIntervalSince(arrived) * 1000)

var traceLines: [String] = []
if let traceURL, let h = try? FileHandle(forReadingFrom: traceURL) {
    try? h.seek(toOffset: min(traceStart, traceSize()))
    traceLines = String(decoding: h.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
    try? h.close()
}

let v = judge(watched, visible: visible, expect: expectArg, letGo: letGo)
var out = touched ? ["someone used the Mac during the watch: the pointer stays where they put it, and the next host run waits for 10 idle minutes"] : []
out += ["held at the edge \(rested) ms; let go at \(at) with the window at \(letGo.map(str) ?? "?"); visible area \(str(visible))"]
out += v.shapes.map { "  +\($0.ms) ms \($0.shape.rawValue) \(str($0.frame))" }
var last: CGRect?
let changes = watched.compactMap { w -> String? in
    guard let f = w.frame, f != last else { return nil }
    last = f
    return "+\(w.ms) ms \(str(f))"
}
out.append("final \(v.final.map(str) ?? "unreadable") \(v.finalShape?.rawValue ?? "")")
out.append("trace (\(traceLines.count) lines since the press, \(traceURL?.path ?? "no trace.log")):")
out += traceLines.map { "  " + $0 }
if let e = expectArg { out.append(v.failure.map { "FAIL --expect \(e): \($0)" } ?? "PASS --expect \(e)") }
print(out.joined(separator: "\n"))
if let dir = value("--out") {
    let d = URL(fileURLWithPath: dir)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    try? out.joined(separator: "\n").appending("\n").write(to: d.appendingPathComponent("summary.txt"), atomically: true, encoding: .utf8)
    try? changes.joined(separator: "\n").appending("\n").write(to: d.appendingPathComponent("frames.txt"), atomically: true, encoding: .utf8)
    try? traceLines.joined(separator: "\n").appending("\n").write(to: d.appendingPathComponent("trace.txt"), atomically: true, encoding: .utf8)
}
exit(v.failure == nil ? 0 : 1)
