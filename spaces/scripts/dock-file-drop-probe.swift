// Fails unless a file dragged from another app onto an app's icon in the Workspace Dock opens in that app, an icon whose
// app can't open it stays dark and takes nothing, and a file dragged out of a window up to the top of the screen is let go
// by Polycarp's window-drag watcher instead of being taken for the window (Donovan, 2026-11-22: "the drag files on app
// isn't working").
//
// The probe is the drag source: its own window starts a real drag of a text file it writes to a temp folder, with real
// mouse events, so the dock sees what Finder's drag would give it. TextEdit (launched by the probe, with a document of
// its own) is the app that opens the file; the probe's own icon, a process with no document types, is the one that
// can't. It runs on the agent workspace only and comes back to the workspace you were on.
//
//   swift scripts/dock-file-drop-probe.swift --self-test   the trace judges alone (no pointer)
//   swift scripts/dock-file-drop-probe.swift               the drags
//
// It takes the pointer, so it refuses to run unless the Mac has been idle 10 minutes, Polycarp is running with the dock on
// the bottom edge and an agent workspace set, and TextEdit isn't running (it never touches a TextEdit you are using).
// Before each press it checks that its own window is under the press point, and stops if not.
import AppKit

var failures: [String] = []
func expect(_ ok: Bool, _ what: String) {
    print((ok ? "ok    " : "FAIL  ") + what)
    if !ok { failures.append(what) }
}

// MARK: Judges (pure, on trace lines)

/// The key the dock traced a file drag over, and whether that tile took it.
func hovered(_ lines: [String]) -> [(key: String, takes: Bool)] {
    lines.compactMap { line in
        guard let r = line.range(of: "dock file drag over ") else { return nil }
        let rest = line[r.upperBound...]
        guard let key = rest.split(separator: " ").first else { return nil }
        return (String(key), rest.hasSuffix("takes them"))
    }
}
func dropped(_ lines: [String], on key: String) -> Bool { lines.contains { $0.contains("dock drop: ") && $0.hasSuffix(" item(s) on \(key)") } }
func opened(_ lines: [String], by app: String) -> Bool { lines.contains { $0.contains("dock drop: \(app) opened ") } }
func refused(_ lines: [String]) -> Bool { lines.contains { $0.contains("dock drop: ") && $0.hasSuffix("; not taken") } }
func dockUp(_ lines: [String]) -> Bool { lines.contains { $0.contains(" dock up: ") } }
func dockDown(_ lines: [String]) -> Bool { lines.contains { $0.contains(" dock down: ") } }
func watcherLetGo(_ lines: [String], window: UInt32) -> Bool { lines.contains { $0.hasSuffix("topDrag let go window=\(window): a drag of its content, not of the window") } }
func overviewOpened(_ lines: [String]) -> Bool { lines.contains { $0.contains("topDrag open ") || $0.contains("topDrag overview open") } }

if CommandLine.arguments.contains("--self-test") {
    let sample = [
        "1795400000.1 dock up: bottom edge, pointer 700,0, panel 480x134",
        "1795400000.2 dock file drag over 9:812 (app): 1 item(s), can't open them",
        "1795400000.3 dock file drag over 9:901 (app): 1 item(s), takes them",
        "1795400000.4 dock drop: 1 item(s) on 9:901",
        "1795400000.5 dock drop: TextEdit opened 1 item(s)",
        "1795400000.6 topDrag let go window=4242: a drag of its content, not of the window",
    ]
    let h = hovered(sample)
    expect(h.count == 2 && h[0].key == "9:812" && !h[0].takes && h[1].key == "9:901" && h[1].takes, "hover lines parse with what each tile takes")
    expect(dropped(sample, on: "9:901") && !dropped(sample, on: "9:812"), "a drop is read for its key only")
    expect(opened(sample, by: "TextEdit") && !opened(sample, by: "Preview"), "an open is read for its app only")
    expect(!refused(sample) && refused(["1 dock drop: 1 item(s) let go on 9:812; not taken"]), "a refused drop is told apart")
    expect(dockUp(sample) && !dockDown(sample), "dock up and down lines")
    expect(watcherLetGo(sample, window: 4242) && !watcherLetGo(sample, window: 42), "the watcher's let-go is read for its window")
    expect(!overviewOpened(sample) && overviewOpened(["1 topDrag open window=5 from=2"]), "the overview opening is seen")
    print(failures.isEmpty ? "PASS" : "FAIL: \(failures.count)")
    exit(failures.isEmpty ? 0 : 1)
}

// MARK: Preconditions

let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Polycarp")
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
guard NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").isEmpty else {
    print("TextEdit is running: the probe uses a TextEdit of its own and never touches yours; quit it first"); exit(2)
}
func state() -> (current: Int, agent: Int?) {
    let j = (try? JSONSerialization.jsonObject(with: Data(contentsOf: support.appendingPathComponent("state.json")))) as? [String: Any] ?? [:]
    return (j["current"] as? Int ?? 0, j["agentWorkspace"] as? Int)
}
let start = state()
guard start.current > 0, let agent = start.agent else { print("no agent workspace in state.json: the probe runs only there"); exit(2) }

let traceURL = support.appendingPathComponent("trace.log")
func traceEnd() -> UInt64 { ((try? FileManager.default.attributesOfItem(atPath: traceURL.path))?[.size] as? UInt64) ?? 0 }
func traceSince(_ offset: UInt64) -> [String] {
    guard let h = try? FileHandle(forReadingFrom: traceURL) else { expect(false, "trace.log readable"); return [] }
    defer { try? h.close() }
    let size = traceEnd()
    // Rotated since the mark: read it all.
    try? h.seek(toOffset: offset <= size ? offset : 0)
    return String(decoding: h.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
}

func run(_ path: String, _ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    try? p.run()
    p.waitUntilExit()
}
func go(_ n: Int) { run("/usr/bin/open", ["-g", "polycarp://switch/\(n)"]); usleep(900_000) }

// The files: one TextEdit opens at launch (so it has a window on the agent workspace), one the drop opens.
let folder = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-file-drop-\(getpid())")
try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
let launchDoc = folder.appendingPathComponent("probe-launch.txt")
let dropDoc = folder.appendingPathComponent("probe-drop.txt")
try? "Polycarp dock file-drop probe: launch\n".write(to: launchDoc, atomically: true, encoding: .utf8)
try? "Polycarp dock file-drop probe: dropped\n".write(to: dropDoc, atomically: true, encoding: .utf8)

var cleaned = false
func cleanup() {
    guard !cleaned else { return }
    cleaned = true
    for app in NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit") { app.terminate() }
    usleep(500_000)
    try? FileManager.default.removeItem(at: folder)
    if state().current != start.current { go(start.current) }
}
atexit { cleanup() }

// MARK: The probe's window, a drag source of the drop file

final class Source: NSView, NSDraggingSource {
    var file: URL!
    private var down: NSEvent?
    override func mouseDown(with event: NSEvent) { down = event }
    override func mouseDragged(with event: NSEvent) {
        guard let down else { return }
        self.down = nil
        let item = NSDraggingItem(pasteboardWriter: file as NSURL)
        let icon = NSWorkspace.shared.icon(forFile: file.path)
        item.setDraggingFrame(NSRect(origin: convert(down.locationInWindow, from: nil), size: NSSize(width: 32, height: 32)), contents: icon)
        beginDraggingSession(with: [item], event: down, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { [.copy, .generic] }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.main!
let screenRect = CGRect(origin: .zero, size: screen.frame.size)
let made = NSWindow(contentRect: NSRect(x: screen.frame.midX - 200, y: screen.frame.midY - 120, width: 400, height: 240),
                    styleMask: [.titled, .closable], backing: .buffered, defer: false)
made.title = "Polycarp dock file-drop probe"
made.isReleasedWhenClosed = false
let source = Source()
source.file = dropDoc
made.contentView = source

func windows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}
func bounds(_ w: [String: Any]) -> CGRect? { (w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) } }
func ownerAt(_ p: CGPoint) -> pid_t? {
    for w in windows() {
        guard let b = bounds(w), b.contains(p) else { continue }
        if let alpha = w[kCGWindowAlpha as String] as? Double, alpha == 0 { continue }
        return w[kCGWindowOwnerPID as String] as? pid_t
    }
    return nil
}
/// The dock: a Polycarp window along the bottom of the screen, short of half its height.
func dockFrame() -> CGRect? {
    windows().first { w in
        let owner = NSRunningApplication(processIdentifier: w[kCGWindowOwnerPID as String] as? pid_t ?? 0)?.bundleIdentifier
        return owner == "com.baney.polycarp" && (bounds(w).map { $0.maxY >= screenRect.maxY - 12 && $0.height < screenRect.height / 2 } ?? false)
            && (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.5
    }.flatMap(bounds)
}

func post(_ type: CGEventType, _ p: CGPoint) {
    let e = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    if type != .mouseMoved { e?.setIntegerValueField(.mouseEventClickState, value: 1) }
    e?.post(tap: .cgSessionEventTap)
}
func glide(_ a: CGPoint, _ b: CGPoint, steps: Int = 30, pause: useconds_t = 12_000, until: () -> Bool = { false }) -> CGPoint {
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        post(.leftMouseDragged, p)
        usleep(pause)
        if until() { return p }
    }
    return b
}
func hold(_ p: CGPoint, _ seconds: Double) {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { post(.leftMouseDragged, p); usleep(30_000) }
}

/// Presses the probe's window and drags the file out of it; `then` moves on from `from` and returns where to let go.
func dragFile(then: (CGPoint) -> CGPoint) {
    guard let f = windows().first(where: { ($0[kCGWindowNumber as String] as? Int) == made.windowNumber }).flatMap(bounds) else {
        print("the probe's window isn't on screen"); exit(2)
    }
    let press = CGPoint(x: f.midX, y: f.midY + 20)
    guard ownerAt(press) == getpid() else { print("the probe's window isn't under \(press): stopped before any click"); exit(3) }
    post(.mouseMoved, press)
    usleep(100_000)
    post(.leftMouseDown, press)
    usleep(120_000)
    // Past the drag threshold, so AppKit starts the drag session.
    let started = glide(press, CGPoint(x: press.x + 24, y: press.y + 24), steps: 6)
    usleep(150_000)
    let release = then(started)
    post(.leftMouseUp, release)
    usleep(1_200_000)
}

DispatchQueue.global().async {
    go(agent)
    // TextEdit with a document of its own on the agent workspace.
    run("/usr/bin/open", ["-g", "-a", "TextEdit", launchDoc.path])
    let launchedBy = Date().addingTimeInterval(10)
    while NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").isEmpty && Date() < launchedBy { usleep(100_000) }
    guard let textEdit = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").first else {
        print("TextEdit didn't start"); exit(2)
    }
    DispatchQueue.main.sync {
        made.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
    }
    usleep(2_000_000)
    let editKey = "\(agent):\(textEdit.processIdentifier)"
    let selfKey = "\(agent):\(getpid())"
    let edge = CGPoint(x: screenRect.midX, y: screenRect.maxY - 1)

    // 1. Onto TextEdit's icon: the dock comes up for the file, stays up, lights TextEdit, and the drop opens the file there.
    var mark = traceEnd()
    var seenDock: CGRect?
    dragFile { from in
        _ = glide(from, edge)
        hold(edge, 0.6)
        seenDock = dockFrame()
        expect(seenDock != nil, "the dock came up for a file held on the bottom edge")
        guard let dock = seenDock else { return edge }
        let row = dock.maxY - 40
        var at = glide(edge, CGPoint(x: dock.minX + 16, y: row), steps: 15)
        at = glide(at, CGPoint(x: dock.maxX - 16, y: row), steps: 140, pause: 15_000) {
            hovered(traceSince(mark)).last.map { $0.key == editKey && $0.takes } ?? false
        }
        let lines = traceSince(mark)
        expect(hovered(lines).contains { $0.key == editKey && $0.takes }, "TextEdit's icon (\(editKey)) lit for the text file")
        expect(!dockDown(lines), "the dock stayed up while the file hovered it")
        return at
    }
    var lines = traceSince(mark)
    expect(dropped(lines, on: editKey), "the drop went to TextEdit's icon")
    let openedBy = Date().addingTimeInterval(5)
    while !opened(lines, by: "TextEdit") && Date() < openedBy { usleep(200_000); lines = traceSince(mark) }
    expect(opened(lines, by: "TextEdit"), "TextEdit opened the dropped file (trace: dock drop: TextEdit opened 1 item(s))")

    // 2. Onto the probe's own icon: a process with no document types can't open it; it stays dark and takes nothing.
    DispatchQueue.main.sync { made.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true) }
    usleep(800_000)
    mark = traceEnd()
    dragFile { from in
        _ = glide(from, edge)
        hold(edge, 0.6)
        guard let dock = dockFrame() else { expect(false, "the dock came up again"); return edge }
        let row = dock.maxY - 40
        var at = glide(edge, CGPoint(x: dock.minX + 16, y: row), steps: 15)
        at = glide(at, CGPoint(x: dock.maxX - 16, y: row), steps: 140, pause: 15_000) {
            hovered(traceSince(mark)).last?.key == selfKey
        }
        expect(hovered(traceSince(mark)).contains { $0.key == selfKey && !$0.takes }, "the probe's own icon (\(selfKey)) can't open a text file")
        return at
    }
    lines = traceSince(mark)
    expect(!dropped(lines, on: selfKey) && !lines.contains { $0.contains("dock drop: ") && $0.contains(" opened ") }, "nothing opened on the probe's icon")

    // 3. Up to the top of the screen and held there: a file, not the window, so the watcher lets the press go and no
    // overview opens.
    DispatchQueue.main.sync { made.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true) }
    usleep(800_000)
    mark = traceEnd()
    dragFile { from in
        let top = CGPoint(x: screenRect.midX, y: 1)
        _ = glide(from, top)
        hold(top, 0.8)
        // Back over the probe's own window, which takes no drop, so nothing lands in TextEdit's document.
        return glide(top, from)
    }
    lines = traceSince(mark)
    expect(watcherLetGo(lines, window: UInt32(made.windowNumber)), "the watcher let the file drag go (topDrag let go window=\(made.windowNumber))")
    expect(!overviewOpened(lines), "no overview opened for a file dragged to the top")

    DispatchQueue.main.sync { made.close() }
    cleanup()
    print(failures.isEmpty ? "a file dropped on an app's icon in the dock opens in that app" : "FAIL: \(failures.count)")
    exit(failures.isEmpty ? 0 : 1)
}
app.run()
