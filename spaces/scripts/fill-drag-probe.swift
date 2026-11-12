// Fails unless a filled window dragged by its title bar moves only with the pointer: no frame off the screen beyond what
// the drag explains, at most one size change per drag, and never against the pointer (Donovan, 2026-11-12: Helium filled
// by a drag to the top jumped off the pointer when he dragged it down again).
//
// Each case opens its own window, fills it, then drags it slowly to the top, away from the top, and down to the dock edge,
// sampling the window server's frame every 16 ms. It writes the samples next to the trace so a failure can be read back.
//
// It takes the pointer, so it refuses to run unless the Mac has been idle 10 minutes. Before every press it checks that the
// window under the press point is its own, and stops if not, so no click can land in another app.
//
//   swift scripts/fill-drag-probe.swift            run with Polycarp installed and running
//   swift scripts/fill-drag-probe.swift --record   also save a screen recording of each case
import AppKit
import Foundation

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
guard NSRunningApplication.runningApplications(withBundleIdentifier: "com.baney.polycarp").first != nil
        || NSWorkspace.shared.runningApplications.contains(where: { $0.localizedName == "Polycarp" }) else {
    print("Polycarp isn't running"); exit(2)
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

struct Sample { let t: Double; let pointer: CGPoint; let frame: CGRect }

var failures: [String] = []
func expect(_ ok: Bool, _ what: String) {
    print(ok ? "  ok    \(what)" : "  FAIL  \(what)")
    if !ok { failures.append(what) }
}

/// Presses `from`, glides through `path` at `speed` points a second sampling every 16 ms, and releases at the end.
/// Returns nil when the press point isn't this probe's own window.
func drag(_ id: CGWindowID, from: CGPoint, path: [CGPoint], speed: CGFloat) -> [Sample]? {
    guard ownerAt(from) == getpid() else { return nil }
    var samples: [Sample] = []
    let start = Date()
    func sample(_ p: CGPoint) { if let f = frame(id) { samples.append(Sample(t: -start.timeIntervalSinceNow, pointer: p, frame: f)) } }
    post(.leftMouseDown, from); usleep(120_000); sample(from)
    var at = from
    for to in path {
        let steps = max(1, Int((hypot(to.x - at.x, to.y - at.y) / speed) / 0.016))
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: at.x + (to.x - at.x) * t, y: at.y + (to.y - at.y) * t)
            post(.leftMouseDragged, p); usleep(16_000); sample(p)
        }
        at = to
        for _ in 0..<30 { post(.leftMouseDragged, at); usleep(16_000); sample(at) }  // a half second's hold at each stop
    }
    post(.leftMouseUp, at)
    for _ in 0..<40 { usleep(16_000); sample(at) }
    return samples
}

/// The checks the bug broke.
func judge(_ samples: [Sample], screen: CGRect, name: String) {
    var sizeChanges = 0, against = 0, offScreen = 0
    var changing = false
    for (a, b) in zip(samples, samples.dropFirst()) {
        let resized = abs(a.frame.width - b.frame.width) > 2 || abs(a.frame.height - b.frame.height) > 2
        // One animated resize is one change: count where a run of resizing frames starts.
        if resized && !changing { sizeChanges += 1 }
        changing = resized
        if !resized {
            let pdx = b.pointer.x - a.pointer.x, pdy = b.pointer.y - a.pointer.y
            let wdx = b.frame.minX - a.frame.minX, wdy = b.frame.minY - a.frame.minY
            if (pdx * wdx < 0 && abs(wdx) > 2) || (pdy * wdy < 0 && abs(wdy) > 2) { against += 1 }
        }
        // The pointer stays on the screen and holds the title bar, so a window mostly off it, or above it, is the bug.
        let visible = b.frame.intersection(screen)
        if b.frame.width > 0, visible.width * visible.height < 0.25 * b.frame.width * b.frame.height { offScreen += 1 }
        if b.frame.minY < screen.minY - 2 { offScreen += 1 }
    }
    let log = samples.map { "\(String(format: "%.3f", $0.t)) p=\(Int($0.pointer.x)),\(Int($0.pointer.y)) f=\(Int($0.frame.minX)),\(Int($0.frame.minY)),\(Int($0.frame.width))x\(Int($0.frame.height))" }
    try? log.joined(separator: "\n").write(to: support.appendingPathComponent("fill-drag-probe-\(name).log"), atomically: true, encoding: .utf8)
    expect(sizeChanges <= 1, "\(name): at most one size change in the drag (saw \(sizeChanges))")
    expect(against == 0, "\(name): the window never moves against the pointer (\(against) frames did)")
    expect(offScreen == 0, "\(name): no frame off the screen beyond the drag (\(offScreen) frames)")
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.screens[0]
// Window server coordinates: top left origin.
let full = CGRect(x: 0, y: 0, width: screen.frame.width, height: screen.frame.height)
let visibleTop = screen.frame.maxY - screen.visibleFrame.maxY
let visible = CGRect(x: screen.visibleFrame.minX, y: visibleTop, width: screen.visibleFrame.width, height: screen.visibleFrame.height)

func makeWindow(_ title: String) -> (NSWindow, CGWindowID) {
    var made: NSWindow!
    DispatchQueue.main.sync {
        made = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 900, height: 600),
                        styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        made.title = title
        made.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
    }
    usleep(1_500_000)
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

DispatchQueue.global().async {
    defer { DispatchQueue.main.async { app.terminate(nil) } }
    let titleY: (CGRect) -> CGFloat = { $0.minY + 14 }

    // Case 1, Donovan's: macOS fills the window (a drag to the top), then it's dragged slowly down to the dock edge.
    print("macOS fill, then drag down")
    let (w1, id1) = makeWindow("Polycarp fill-drag probe (macOS fill)")
    let rec = capture("macos-fill", seconds: 14)
    guard let f1 = frame(id1) else { print("no window"); exit(2) }
    let grab1 = CGPoint(x: f1.midX, y: titleY(f1))
    guard drag(id1, from: grab1, path: [CGPoint(x: grab1.x, y: 0)], speed: 400) != nil else {
        print("the press point isn't this probe's window: stopped before any click"); exit(3)
    }
    usleep(800_000)
    guard let filled = frame(id1) else { exit(2) }
    print("  filled to \(filled)")
    let grab2 = CGPoint(x: filled.midX, y: titleY(filled))
    let path = [CGPoint(x: grab2.x, y: 2),                               // slowly to the top
                CGPoint(x: grab2.x + 80, y: visible.minY + 160),         // away from the top
                CGPoint(x: grab2.x + 80, y: visible.maxY - 20)]          // down to the dock edge
    guard let samples = drag(id1, from: grab2, path: path, speed: 250) else {
        print("the press point isn't this probe's window: stopped before any click"); exit(3)
    }
    judge(samples, screen: full, name: "macos-fill")
    rec?.waitUntilExit()
    DispatchQueue.main.sync { w1.close() }

    // Case 2: Polycarp fills it (⌃⌘F), then the same drag. Polycarp gives its size back once, at the start.
    print("Polycarp fill, then drag down")
    let (w2, id2) = makeWindow("Polycarp fill-drag probe (Polycarp fill)")
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: 3, keyDown: down)
        e?.flags = [.maskControl, .maskCommand]
        e?.postToPid(getpid())
    }
    usleep(1_200_000)
    let rec2 = capture("polycarp-fill", seconds: 12)
    if let g = frame(id2) {
        let grab = CGPoint(x: g.midX, y: titleY(g))
        if let s = drag(id2, from: grab, path: [CGPoint(x: grab.x + 80, y: visible.minY + 160), CGPoint(x: grab.x + 80, y: visible.maxY - 20)], speed: 250) {
            judge(s, screen: full, name: "polycarp-fill")
        } else { print("the press point isn't this probe's window: stopped before any click"); exit(3) }
    }
    rec2?.waitUntilExit()
    DispatchQueue.main.sync { w2.close() }

    print(failures.isEmpty ? "PASS" : "FAIL: \(failures.count)")
    exit(failures.isEmpty ? 0 : 1)
}
app.run()
