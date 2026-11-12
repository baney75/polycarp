// Fails unless a filled window dragged by its title bar moves only with the pointer: at most one size change per drag,
// never against the pointer, the title bar under the pointer the whole drag, and the window on screen once it's let go
// (Donovan, 2026-11-12: Helium filled by a drag to the top jumped off the pointer when he dragged it down again, and
// came back 40% off the left edge).
//
// Each case opens its own window, asserts the state the case is about (macOS filled it, Polycarp filled it, the overview
// let it go over no workspace), and fails if that didn't happen, so a case can't pass without testing anything. The
// judged drags never stop at the top, where Polycarp's overview would take the drag. Samples go next to the trace.
//
// It takes the pointer, so it refuses to run unless the Mac has been idle 10 minutes. Before every press it checks that the
// window under the press point is its own, and stops if not, so no click can land in another app.
//
//   swift scripts/fill-drag-probe.swift --self-test   the judge alone, on the frames from the report (no pointer)
//   swift scripts/fill-drag-probe.swift [--record]    the live cases, with Polycarp installed and running
import AppKit
import Foundation

struct Sample { let t: Double; let pointer: CGPoint; let frame: CGRect; let down: Bool }

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
guard !NSRunningApplication.runningApplications(withBundleIdentifier: "com.baney.polycarp").isEmpty else {
    print("Polycarp isn't running"); exit(2)
}

// trace.log, read from an offset, so a case sees only what Polycarp logged while it ran.
let traceURL = support.appendingPathComponent("trace.log")
func traceEnd() -> UInt64 { ((try? FileManager.default.attributesOfItem(atPath: traceURL.path))?[.size] as? UInt64) ?? 0 }
func traceSince(_ offset: UInt64) -> [String] {
    guard let h = try? FileHandle(forReadingFrom: traceURL) else { return [] }
    defer { try? h.close() }
    let size = (try? h.seekToEnd()) ?? 0
    try? h.seek(toOffset: offset <= size ? offset : 0)
    return String(decoding: h.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
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

/// Presses `from`, glides through `path` at `speed` points a second sampling every 16 ms, holding `hold` seconds at each
/// stop, and releases at the end. Stops the probe if the press point isn't this probe's own window.
func drag(_ id: CGWindowID, from: CGPoint, path: [CGPoint], speed: CGFloat, hold: Double = 0.25) -> [Sample] {
    guard ownerAt(from) == getpid() else {
        print("the press point isn't this probe's window: stopped before any click"); exit(3)
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
    for _ in 0..<60 { usleep(16_000); sample(at, false) }  // a second for macOS and Polycarp to finish the drop
    return samples
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
                                              CGPoint(x: grab.x + 80, y: visible.maxY - 12)], speed: 250)
    let lines = samples.map { "\(String(format: "%.3f", $0.t)) \($0.down ? "down" : "up") p=\(Int($0.pointer.x)),\(Int($0.pointer.y)) f=\(Int($0.frame.minX)),\(Int($0.frame.minY)),\(Int($0.frame.width))x\(Int($0.frame.height))" }
    try? lines.joined(separator: "\n").write(to: support.appendingPathComponent("fill-drag-probe-\(name).log"), atomically: true, encoding: .utf8)
    let opened = traceSince(start).contains { $0.contains("overview open") && $0.contains("window=\(id)") }
    expect(!opened, "\(name): precondition, the overview stayed shut, so this was the plain drag")
    let problems = judge(samples, visible: visible)
    expect(problems.isEmpty, "\(name): the window followed the pointer and ended on screen \(problems)")
    return start
}

DispatchQueue.global().async {
    defer { DispatchQueue.main.async { app.terminate(nil) } }
    let home = currentWorkspace()

    // Case 1, Donovan's: macOS fills the window, then it's dragged down to the dock edge.
    print("macOS fill, then drag down")
    let (w1, id1) = makeWindow("Polycarp fill-drag probe (macOS fill)")
    let rec1 = capture("macos-fill", seconds: 12)
    if macOSFill(id1, "macos-fill") {
        let from = judgedDrag(id1, "macos-fill")
        expect(!traceSince(from).contains { $0.contains("off: dragged away") && $0.contains("window=\(id1)") },
               "macos-fill: Polycarp left the size to macOS")
    }
    rec1?.waitUntilExit()
    DispatchQueue.main.sync { w1.close() }

    // Case 2: Polycarp fills it (⌃⌘F, posted where Polycarp's key tap sees it), then the same drag: one resize, Polycarp's.
    print("Polycarp fill, then drag down")
    let (w2, id2) = makeWindow("Polycarp fill-drag probe (Polycarp fill)")
    let before2 = traceEnd()
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: 3, keyDown: down)
        e?.flags = [.maskControl, .maskCommand]
        e?.post(tap: .cgSessionEventTap)
    }
    usleep(1_200_000)
    let filledByUs = fills(frame(id2)) && traceSince(before2).contains { $0.contains("fill window=\(id2) on") }
    expect(filledByUs, "polycarp-fill: precondition, Polycarp filled the window (frame \(String(describing: frame(id2))))")
    let rec2 = capture("polycarp-fill", seconds: 10)
    if filledByUs {
        let from = judgedDrag(id2, "polycarp-fill")
        expect(traceSince(from).contains { $0.contains("fill window=\(id2) off: dragged away") }, "polycarp-fill: Polycarp gave its size back")
    }
    rec2?.waitUntilExit()
    DispatchQueue.main.sync { w2.close() }

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
        let samples = drag(id3, from: grab, path: [CGPoint(x: grab.x, y: 0), CGPoint(x: 160, y: 520)], speed: 500, hold: 0.7)
        let trace = traceSince(before)
        let none = trace.contains { $0.contains("overview open") && $0.contains("window=\(id3)") } && trace.contains { $0.contains("release target=none") }
        expect(none, "overview: precondition, the overview opened and let go over no workspace")
        if none {
            let after = samples.last?.frame ?? .null
            expect(visible.insetBy(dx: -2, dy: -2).contains(after), "overview: the window let go off screen came back on screen (\(after))")
            if macOSFill(id3, "overview") {
                if let saved = frame(id3) { print("  filled at \(saved)") }
                _ = judgedDrag(id3, "overview")
            }
        }
    }
    rec3?.waitUntilExit()
    DispatchQueue.main.sync { w3.close() }

    print(failures.isEmpty ? "PASS" : "FAIL: \(failures.count)")
    exit(failures.isEmpty ? 0 : 1)
}
app.run()
