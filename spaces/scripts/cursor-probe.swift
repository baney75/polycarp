// The agent cursor's frame-timing and window probe (docs/agent-computer-use.md, "The agent cursor"; spec/config.md,
// the animation bar).
//
//   swift run -c release cursor-probe              100 glides in a window on the main display, then the window checks
//   swift run -c release cursor-probe --glides 40  fewer glides
//   swift run -c release cursor-probe --order      the window checks only, with every window off all displays: nothing
//                                                  is visible and nothing is activated, so it runs any time
//
// The target window W and a window X that comes over part of it belong to a helper process (this probe, started with
// `--helper`), so the overlay is ordered against another app's window as it is in real use. The window checks, against
// the window server's own list (CGWindowListCopyWindowInfo):
//   - the overlay sits directly above W, and the veil and cursor are shown;
//   - X raised over part of W lies above the overlay, and the overlay stays directly above W;
//   - an action at a point under X draws nothing (no overlay update, the cursor hidden);
//   - an action elsewhere in W draws again;
//   - W moved: within 0.4 s the overlay has W's new frame and is still directly above it;
//   - the overlay is on exactly the macOS Spaces W is on (one), never every Space (CGSCopySpacesForWindows);
//   - on the display only: W sent to another macOS Space (the helper moves its own window there with
//     CGSMoveWindowsToManagedSpace): within 0.4 s the overlay is off this Space's list and the cursor and veil are
//     hidden; W comes back afterwards. With a single Space on the display, or when the window server refuses the
//     move, the step says "not run" and counts neither way. A Space switch you make yourself (Control-arrow) needs
//     posted keys, which the probe never sends: that one is checked by hand;
//   - W ordered out: within 0.4 s the overlay is off screen and the cursor and veil are hidden.
//
// It drives the real director (registered with HandsEvents, and fed the way the router feeds it: an action with
// `frameComing`, then the measured frame a few milliseconds later from another queue) and the real overlay (Core
// Animation layers in a click-through panel), and records CADisplayLink frame times while 100 glides run (every fifth
// is cut short by a new target). The overlay is ON the display, because a panel outside every display gets no display
// link and is never composited: the cursor is visible while it runs, which is why it needs Donovan away.
//
// Passing needs all of these:
//   - frame time: at most 1 frame in 200 over 1.5x the display's frame interval and none over 2x;
//   - something was drawn: one overlay update per action, and the cursor layer moved through at least one distinct
//     position per glide;
//   - the drawn path matches the plan: at every frame during a glide the cursor layer's presentation position is
//     within 3 pt + one frame of travel at the planned speed of where the plan says it is (the allowance is for the
//     frame the display link reports lagging the layer tree by up to one frame); at most 1 frame in 200 may be outside;
//     and after the last glide it stands on its target to 1.5 pt;
//   - the real pointer: sampled every millisecond throughout, at least 1000 samples, zero changes;
//   - the overlay never became key or main, and the front app never changed.
//
// It runs only when Donovan has been idle 10 minutes (HIDIdleTime >= 600 s, the number `ioreg -c IOHIDSystem`
// shows), and stops, reporting "not run", the moment he is back. Exit 0 pass, 1 fail, 2 not run.
import AppKit
import BaneySpacesCore
import BaneySpacesCursor
import QuartzCore

@_silgen_name("CGSMainConnectionID") func CGSMainConnectionID() -> Int32
@_silgen_name("CGSCopySpacesForWindows") func CGSCopySpacesForWindows(_ cid: Int32, _ mask: Int32, _ windows: CFArray) -> Unmanaged<CFArray>?
@_silgen_name("CGSCopyManagedDisplaySpaces") func CGSCopyManagedDisplaySpaces(_ cid: Int32) -> CFArray
@_silgen_name("CGSMoveWindowsToManagedSpace") func CGSMoveWindowsToManagedSpace(_ cid: Int32, _ windows: CFArray, _ space: UInt64)

/// The macOS Spaces a window is on (all of them, shown or not).
func spaces(of window: Int) -> Set<UInt64> {
    Set((CGSCopySpacesForWindows(CGSMainConnectionID(), 0x7, [window] as CFArray)?.takeRetainedValue() as? [NSNumber] ?? []).map(\.uint64Value))
}

/// Another ordinary (not full-screen) Space on the display that holds `space`, if the display has one.
func otherUserSpace(than space: UInt64) -> UInt64? {
    let displays = CGSCopyManagedDisplaySpaces(CGSMainConnectionID()) as? [[String: Any]] ?? []
    for d in displays {
        let ids = (d["Spaces"] as? [[String: Any]] ?? []).filter { ($0["type"] as? Int) == 0 }.compactMap { ($0["ManagedSpaceID"] as? NSNumber)?.uint64Value }
        if ids.contains(space) { return ids.first { $0 != space } }
    }
    return nil
}

/// Forwards to the real overlay and times each call, so the main-thread cost of an action is known.
final class TimedSurface: CursorSurface {
    let inner: OverlaySurface
    var applySeconds: [Double] = []
    var lastMotion: CursorMotion?
    /// Counts the glides handed to the overlay, so each frame is compared with the right one.
    var motionIndex = 0
    private var pending = 0.0
    init(_ inner: OverlaySurface) { self.inner = inner }
    private func timed(_ f: () -> Void) {
        let t0 = CACurrentMediaTime(); f(); pending += CACurrentMediaTime() - t0
    }
    func configure(_ agent: String, look: CursorLook) { timed { inner.configure(agent, look: look) } }
    func appear(_ agent: String, at point: CGPoint, in window: CursorWindow) { timed { inner.appear(agent, at: point, in: window) } }
    func move(_ agent: String, motion: CursorMotion, in window: CursorWindow) { lastMotion = motion; motionIndex += 1; timed { inner.move(agent, motion: motion, in: window) } }
    func jump(_ agent: String, to point: CGPoint, in window: CursorWindow) { timed { inner.jump(agent, to: point, in: window) } }
    func act(_ agent: String, effect: CursorEffect, point: CGPoint, frame: CGRect, delay: TimeInterval) {
        timed { inner.act(agent, effect: effect, point: point, frame: frame, delay: delay) }
        applySeconds.append(pending); pending = 0
    }
    func hide(_ agent: String) { timed { inner.hide(agent) } }
    func remove(_ agent: String) { timed { inner.remove(agent) } }
    func place(_ window: CursorWindow, reorder: Bool) { timed { inner.place(window, reorder: reorder) } }
    func showVeil(_ window: CursorWindow, look: VeilLook) { timed { inner.showVeil(window, look: look) } }
    func hideVeil(_ window: UInt32) { timed { inner.hideVeil(window) } }
    func windowGone(_ window: UInt32) { timed { inner.windowGone(window) } }
    func overlayWindow(for window: UInt32) -> UInt32? { inner.overlayWindow(for: window) }
    var overlayWindows: Set<UInt32> { inner.overlayWindows }
}

/// The other app: W, and X which comes over part of W on command. Commands arrive on stdin, one per line.
enum Helper {
    static var w: NSWindow!
    static var x: NSWindow!

    static func window(_ r: CGRect, gray: CGFloat) -> NSWindow {
        let win = NSWindow(contentRect: r, styleMask: [.borderless], backing: .buffered, defer: false)
        win.isReleasedWhenClosed = false
        win.backgroundColor = NSColor(white: gray, alpha: 1)
        win.collectionBehavior = [.ignoresCycle]
        return win
    }

    static func run(offscreen: Bool) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let visible = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1200, height: 800)
        let wFrame = offscreen ? CGRect(x: -30000, y: 200, width: 900, height: 600) : visible.insetBy(dx: 60, dy: 60)
        w = window(wFrame, gray: 0.93)
        w.orderFrontRegardless()
        x = window(CGRect(x: wFrame.minX + 40, y: wFrame.maxY - 40 - 260, width: 360, height: 260), gray: 0.35)
        print("ready \(w.windowNumber) \(x.windowNumber)")
        fflush(stdout)
        DispatchQueue.global().async {
            while let line = readLine() { DispatchQueue.main.async { handle(line) } }
            exit(0)
        }
        RunLoop.main.run()
    }

    static var home: UInt64?

    static func handle(_ line: String) {
        let parts = line.split(separator: " ")
        switch parts.first {
        case "raiseX": x.orderFrontRegardless()
        case "moveW":
            // The hands' y goes down, AppKit's up.
            let dx = CGFloat(Double(parts[1]) ?? 0), dy = CGFloat(Double(parts[2]) ?? 0)
            w.setFrameOrigin(CGPoint(x: w.frame.minX + dx, y: w.frame.minY - dy))
        case "hideW": w.orderOut(nil)
        case "spaceW":
            // Its own window only, to another Space on the same display; "spaceBack" returns it.
            if let here = spaces(of: w.windowNumber).first, let there = otherUserSpace(than: here) {
                home = here
                CGSMoveWindowsToManagedSpace(CGSMainConnectionID(), [w.windowNumber] as CFArray, there)
            }
        case "spaceBack":
            if let home { CGSMoveWindowsToManagedSpace(CGSMainConnectionID(), [w.windowNumber] as CFArray, home) }
        default: exit(0)
        }
    }
}

/// What the pointer sampler (a background queue) and the main thread both touch.
final class SharedState {
    private let lock = NSLock()
    private var _samples = 0, _moves = 0, _interrupted = false
    func sampled(moved: Bool, interrupted: Bool) {
        lock.lock(); _samples += 1; if moved { _moves += 1 }; if interrupted { _interrupted = true }; lock.unlock()
    }
    var samples: Int { lock.lock(); defer { lock.unlock() }; return _samples }
    var moves: Int { lock.lock(); defer { lock.unlock() }; return _moves }
    var interrupted: Bool { lock.lock(); defer { lock.unlock() }; return _interrupted }
}

@main
final class CursorProbe: NSObject {
    static var probe: CursorProbe?
    static func main() {
        if CommandLine.arguments.contains("--helper") { return Helper.run(offscreen: CommandLine.arguments.contains("--offscreen")) }
        let p = CursorProbe()
        probe = p
        p.start()
        RunLoop.main.run()
    }

    let args = CommandLine.arguments
    var glides = 100
    let agentID = "probe"
    var surface: TimedSurface!
    var director: CursorDirector!
    var link: AnyObject?
    /// Kept for the whole run: a dispatch source nobody holds is cancelled, and the probe would sample nothing.
    var sampler: DispatchSourceTimer?
    let shared = SharedState()
    var stamps: [Double] = []
    var intervals: [Double] = []
    struct Position: Hashable { var x: Int, y: Int }
    /// Per glide: frames compared with the plan, frames outside the tolerance, distinct drawn positions.
    var perGlide: [Int: (compared: Int, bad: Int, positions: Set<Position>)] = [:]
    var errors: [Double] = []
    var pointerStart = CGPoint.zero
    var idleAtStart = 0.0
    var frontStart: pid_t = 0
    var frontChanges = 0
    var keyOrMain = 0
    var done = false
    var running = false
    var lastTarget = CGPoint.zero
    var lateFrames = 0
    /// `--order`: only the window checks, every window off all displays.
    var orderOnly = false
    var helper: Process?
    var helperIn: FileHandle?
    var helperPID: Int32 = 0
    var targetW: UInt32 = 0
    var coverX: UInt32 = 0
    var displays: [CGRect] = []
    var checks: [(String, Bool)] = []

    func idle() -> Double {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
    }

    func pointer() -> CGPoint? { CGEvent(source: nil)?.location }

    /// Starts the helper and reads its window numbers.
    func startHelper() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        p.arguments = ["--helper"] + (orderOnly ? ["--offscreen"] : [])
        let out = Pipe(), inp = Pipe()
        p.standardOutput = out; p.standardInput = inp
        do { try p.run() } catch { print("cursor-probe: not run (the helper did not start: \(error))"); exit(2) }
        var text = ""
        let deadline = Date().addingTimeInterval(10)
        while !text.contains("\n"), Date() < deadline {
            let d = out.fileHandleForReading.availableData
            if d.isEmpty { break }
            text += String(decoding: d, as: UTF8.self)
        }
        let parts = text.split(whereSeparator: \.isWhitespace)
        guard parts.count >= 3, parts[0] == "ready", let w = UInt32(parts[1]), let x = UInt32(parts[2]) else {
            print("cursor-probe: not run (the helper said \(text.debugDescription))"); p.terminate(); exit(2)
        }
        helper = p; helperIn = inp.fileHandleForWriting; helperPID = p.processIdentifier; targetW = w; coverX = x
    }

    func tell(_ command: String) { helperIn?.write((command + "\n").data(using: .utf8)!) }

    func list() -> [ScreenWindow] { ScreenWindows.onScreen() ?? [] }
    func bounds(_ id: UInt32) -> CGRect? { list().first { $0.id == id }?.bounds }

    func start() {
        if let i = args.firstIndex(of: "--glides"), i + 1 < args.count, let n = Int(args[i + 1]), n > 0 { glides = n }
        orderOnly = args.contains("--order")
        idleAtStart = idle()
        guard orderOnly || idleAtStart >= 600 else {
            print("cursor-probe: not run (Donovan has been idle \(Int(idleAtStart)) s; the probe needs 600 s; `--order` runs off every display at any time)")
            exit(2)
        }
        guard #available(macOS 14, *), let screen = NSScreen.main else {
            print("cursor-probe: not run (needs macOS 14 and a display)")
            exit(2)
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        let primary = NSScreen.screens[0]
        let top = primary.frame.maxY
        var spec = CursorDisplaySpec(globalFrame: CGRect(x: screen.frame.minX, y: top - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height),
                                     panelFrame: screen.frame, scale: screen.backingScaleFactor)
        // Off every display: a pretend display where the helper's windows are, so the rules that need a display hold.
        if orderOnly { spec = CursorDisplaySpec(globalFrame: CGRect(x: -31000, y: -20000, width: 6000, height: 40000), panelFrame: .zero, scale: 2) }
        displays = [spec.globalFrame]
        startHelper()
        let overlay = OverlaySurface(displays: [spec])
        surface = TimedSurface(overlay)
        var host = CursorDirector.Host()
        host.agent = { _ in ("Probe", .working) }
        host.windows = { ScreenWindows.onScreen() }
        host.windowFrame = { [weak self] id in self?.bounds(id) }
        director = CursorDirector(surface: surface, queue: .main, host: host, idleAfter: 30)
        var env = CursorEnvironment()
        env.shownWorkspaces = [9]; env.agentWorkspace = 9; env.displays = [spec.globalFrame]
        director.setEnvironment(env)
        // The hands report through HandsEvents; without this nothing would ever reach the director.
        HandsEvents.setListener(director)
        pointerStart = pointer() ?? .zero
        frontStart = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if orderOnly {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.windowChecks { self.reportOrder() } }
            return
        }

        // CADisplayLink on the display: one callback per frame.
        let dl = screen.displayLink(target: self, selector: #selector(tick(_:)))
        dl.add(to: .main, forMode: .common)
        link = dl
        // The real pointer, sampled every millisecond off the main thread, so a stall can't hide a move.
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "pointer", qos: .userInteractive))
        timer.schedule(deadline: .now(), repeating: .milliseconds(1))
        var last = pointerStart
        let startIdle = idleAtStart
        let shared = self.shared
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let p = self.pointer() ?? last
            let moved = p != last
            last = p
            shared.sampled(moved: moved, interrupted: self.idle() < startIdle - 5)
        }
        sampler = timer
        timer.resume()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.begin() }
    }

    var index = 0
    var rng = SystemRandomNumberGenerator()

    func begin() {
        running = true
        step()
    }

    /// One action, fed as the router does: announced with `frameComing`, its measured frame a few milliseconds later
    /// from another queue. A new target at least 300 points away; every fifth is sent 60 ms after the last, mid-glide.
    func step() {
        guard index < glides, !shared.interrupted else { return finish() }
        let area = (bounds(targetW) ?? NSScreen.main!.frame).insetBy(dx: 80, dy: 80)
        let kinds = ["click", "type", "scroll", "click"]
        let dirs = ["down", "up", "left", "right"]
        var p: CGPoint
        var tries = 0
        repeat {
            p = CGPoint(x: CGFloat.random(in: area.minX...area.maxX, using: &rng), y: CGFloat.random(in: area.minY...area.maxY, using: &rng))
            tries += 1
        } while far(p) == false && tries < 50
        last = p
        lastTarget = p
        let kind = kinds[index % kinds.count]
        let id = HandsEvents.newActionID()
        let frame = CGRect(x: p.x - 40, y: p.y - 12, width: 80, height: 24)
        HandsEvents.willAct(HandsActionEvent(kind: kind, ref: "@s1:e\(index)", window: targetW, pid: helperPID, app: "Probe", point: nil, frame: nil, session: agentID,
                                             scope: "agent_workspace", workspace: 9, direction: kind == "scroll" ? dirs[(index / 4) % 4] : nil,
                                             id: id, frameComing: true))
        let delay = Double.random(in: 0.002...0.030, using: &rng)
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + delay) { HandsEvents.frameMeasured(actionID: id, frame: frame) }
        index += 1
        let cut = index % 5 == 0
        DispatchQueue.main.asyncAfter(deadline: .now() + (cut ? 0.06 : 0.42)) { self.step() }
    }
    var last: CGPoint?
    func far(_ p: CGPoint) -> Bool { last.map { hypot(p.x - $0.x, p.y - $0.y) >= 300 } ?? true }

    /// Where the plan puts the cursor `t` seconds into a glide, and how fast it is going (points per second).
    func planned(_ m: CursorMotion, at t: Double) -> (point: CGPoint, speed: Double) {
        let f = max(0, t) / m.step
        let i = min(m.points.count - 1, Int(f))
        let j = min(m.points.count - 1, i + 1)
        let frac = CGFloat(min(1, f - Double(i)))
        let a = m.points[i], b = m.points[j]
        return (CGPoint(x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac), Double(hypot(b.x - a.x, b.y - a.y)) / m.step)
    }

    @available(macOS 14, *)
    @objc func tick(_ link: CADisplayLink) {
        guard running, !done else { return }
        stamps.append(link.timestamp)
        let interval = link.targetTimestamp - link.timestamp
        intervals.append(interval)
        if NSApp.keyWindow != nil || NSApp.mainWindow != nil || surface.inner.panels.contains(where: { $0.isKeyWindow || $0.isMainWindow || $0.canBecomeKey || $0.canBecomeMain }) { keyOrMain += 1 }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != frontStart { frontChanges += 1; frontStart = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0 }
        // How far the drawn cursor is from the planned glide right now, glide by glide.
        guard let m = surface.lastMotion, let drawn = surface.inner.presentedPoint(agentID) else { return }
        let t = ProcessInfo.processInfo.systemUptime - m.start
        var g = perGlide[surface.motionIndex] ?? (0, 0, [])
        g.positions.insert(Position(x: Int(drawn.x.rounded()), y: Int(drawn.y.rounded())))
        if t >= 0, t <= m.duration {
            let (want, speed) = planned(m, at: t)
            let err = Double(hypot(drawn.x - want.x, drawn.y - want.y))
            errors.append(err)
            g.compared += 1
            if err > 3 + speed * interval { g.bad += 1 }
        }
        perGlide[surface.motionIndex] = g
    }

    func finish() {
        // Let the last glide settle, then measure, then the window checks.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            self.measureEnd()
            self.windowChecks { self.report() }
        }
    }

    // MARK: the window checks

    /// One click at `p` in W, reported the way the router does, with its frame known at once.
    func act(at p: CGPoint) {
        HandsEvents.willAct(HandsActionEvent(kind: "click", ref: "@s1:w", window: targetW, pid: helperPID, app: "Probe", point: p,
                                             frame: CGRect(x: p.x - 20, y: p.y - 10, width: 40, height: 20), session: agentID,
                                             scope: "agent_workspace", workspace: 9, id: HandsEvents.newActionID()))
    }

    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        checks.append((name, ok))
        print("  \(ok ? "ok  " : "FAIL") \(name)" + (detail.isEmpty ? "" : ": " + detail))
    }

    /// The window server's order of W, X and the overlay, front to back.
    func order() -> String {
        let overlay = surface.inner.overlayWindow(for: targetW)
        return list().compactMap { $0.id == targetW ? "W" : $0.id == coverX ? "X" : $0.id == overlay ? "overlay" : nil }.joined(separator: " > ")
    }

    func directlyAbove() -> Bool { WindowCover.isDirectlyAbove(surface.inner.overlayWindow(for: targetW), window: targetW, windows: list()) }

    func windowChecks(_ done: @escaping () -> Void) {
        running = false
        guard let w = bounds(targetW) else { check("W is on screen", false); return done() }
        let clear = CGPoint(x: w.maxX - 120, y: w.maxY - 120)
        let steps: [(TimeInterval, () -> Void)] = [
            (0.0, { self.act(at: clear) }),
            (0.4, {
                self.check("the overlay sits directly above W", self.directlyAbove(), self.order())
                self.check("the cursor and the veil are drawn over W", self.surface.inner.isShown(self.agentID) && self.surface.inner.veilShown(self.targetW)
                           && self.surface.inner.window(of: self.agentID) == self.targetW)
                self.tell("raiseX")
            }),
            (0.4, {
                let o = self.order()
                self.check("X raised over W lies above the overlay, which stays directly above W", o == "X > overlay > W" && self.directlyAbove(), o)
                self.actsBefore = self.surface.applySeconds.count
                if let x = self.bounds(self.coverX) { self.act(at: CGPoint(x: x.midX, y: x.midY)) }
            }),
            (0.3, {
                self.check("an action at a point under X draws nothing", self.surface.applySeconds.count == self.actsBefore && !self.surface.inner.isShown(self.agentID),
                           "\(self.surface.applySeconds.count - self.actsBefore) overlay updates, cursor shown: \(self.surface.inner.isShown(self.agentID))")
                self.act(at: clear)
            }),
            (0.3, {
                self.check("an action elsewhere in W draws again", self.surface.inner.isShown(self.agentID))
                self.tell("moveW 40 30")
            }),
            (0.4, {
                let now = self.bounds(self.targetW) ?? .null
                let top = NSScreen.screens.first?.frame.maxY ?? 0
                let want = CGRect(x: now.minX, y: top - now.maxY, width: now.width, height: now.height)
                let got = self.surface.inner.panel(for: self.targetW)?.frame ?? .null
                self.check("W moved: the overlay has its new frame and is still directly above it", got == want && self.directlyAbove(), "overlay \(got), W \(want)")
                let overlay = self.surface.inner.overlayWindow(for: self.targetW).map { spaces(of: Int($0)) } ?? []
                let wSpaces = spaces(of: Int(self.targetW))
                self.check("the overlay is on W's macOS Space only", overlay == wSpaces && overlay.count == 1, "overlay \(overlay.sorted()), W \(wSpaces.sorted())")
                if self.orderOnly { self.tell("hideW"); return }
                self.spaceHome = wSpaces.first
                if let home = self.spaceHome, otherUserSpace(than: home) != nil { self.tell("spaceW") }
            }),
            (0.4, {
                guard !self.orderOnly else { return }
                guard let home = self.spaceHome, otherUserSpace(than: home) != nil else {
                    print("  not run: W sent to another macOS Space (one Space on this display)"); return self.tell("hideW")
                }
                guard !spaces(of: Int(self.targetW)).contains(home) else {
                    print("  not run: W sent to another macOS Space (the window server did not move it)"); return self.tell("hideW")
                }
                let overlay = self.surface.inner.overlayWindow(for: self.targetW)
                let listed = overlay.map { id in self.list().contains { $0.id == id } } ?? false
                self.check("W sent to another macOS Space: the overlay leaves this one, the cursor and veil hide",
                           !listed && !self.surface.inner.isShown(self.agentID) && !self.surface.inner.veilShown(self.targetW))
                self.spaceMoved = true
                self.tell("spaceBack")
            }),
            (0.4, { if self.spaceMoved { self.act(at: clear) } }),
            (0.3, {
                if self.spaceMoved {
                    self.check("W back on this Space: an action draws again, directly above it", self.surface.inner.isShown(self.agentID) && self.directlyAbove(), self.order())
                }
                if !self.orderOnly { self.tell("hideW") }
            }),
            (0.4, {
                let overlay = self.surface.inner.overlayWindow(for: self.targetW)
                let listed = overlay.map { id in self.list().contains { $0.id == id } } ?? false
                self.check("W ordered out: the overlay leaves the screen, the cursor and veil hide", !listed && !self.surface.inner.isShown(self.agentID) && !self.surface.inner.veilShown(self.targetW))
            }),
        ]
        func run(_ i: Int) {
            guard i < steps.count else { tell("quit"); return done() }
            DispatchQueue.main.asyncAfter(deadline: .now() + steps[i].0) { steps[i].1(); run(i + 1) }
        }
        run(0)
    }
    var actsBefore = 0
    var spaceHome: UInt64?
    var spaceMoved = false

    func reportOrder() {
        let keyMain = surface.inner.panels.contains { $0.isKeyWindow || $0.isMainWindow || $0.canBecomeKey || $0.canBecomeMain }
        check("the overlay never became key or main, and the front app never changed",
              !keyMain && NSWorkspace.shared.frontmostApplication?.processIdentifier == frontStart)
        let ok = checks.allSatisfy(\.1) && checks.count >= 8
        print(ok ? "cursor-probe --order: pass" : "cursor-probe --order: FAIL")
        helper?.terminate()
        exit(ok ? 0 : 1)
    }

    func percentile(_ xs: [Double], _ p: Double) -> Double {
        guard !xs.isEmpty else { return 0 }
        let s = xs.sorted(); return s[min(s.count - 1, Int(Double(s.count) * p))]
    }

    var endError = Double.infinity
    func measureEnd() {
        if let end = surface.inner.presentedPoint(agentID) { endError = Double(hypot(end.x - lastTarget.x, end.y - lastTarget.y)) }
    }

    func report() {
        running = false; done = true
        sampler?.cancel()
        sampler = nil
        let deltas = zip(stamps, stamps.dropFirst()).map { $1 - $0 }
        let nominal = percentile(intervals, 0.5)
        let over15 = deltas.filter { $0 > nominal * 1.5 }.count
        let over2 = deltas.filter { $0 > nominal * 2 }.count
        let frames = deltas.count
        let ms = { (x: Double) in String(format: "%.2f", x * 1000) }
        print("cursor-probe: \(index) glides on the main display, \(frames) frames, display \(String(format: "%.0f", 1 / max(nominal, 1e-6))) Hz (interval \(ms(nominal)) ms)")
        print("  frame time: median \(ms(percentile(deltas, 0.5))) ms, p99 \(ms(percentile(deltas, 0.99))) ms, max \(ms(deltas.max() ?? 0)) ms")
        print("  frames over 1.5x the interval: \(over15) of \(frames) (limit 1 in 200 = \(frames / 200)); over 2x: \(over2) (limit 0)")
        let apply = surface.applySeconds
        print("  main thread, per action: median \(ms(percentile(apply, 0.5))) ms, max \(ms(apply.max() ?? 0)) ms (director + layers, off the hands' thread)")
        let compared = perGlide.values.map(\.compared).reduce(0, +)
        let bad = perGlide.values.map(\.bad).reduce(0, +)
        let withFrames = perGlide.values.filter { $0.compared >= 1 }.count
        let moving = perGlide.values.filter { $0.positions.count >= 2 }.count
        print("  drawn vs planned (tolerance 3 pt + one frame of travel): median \(String(format: "%.2f", percentile(errors, 0.5))) pt, p95 \(String(format: "%.2f", percentile(errors, 0.95))) pt, max \(String(format: "%.2f", errors.max() ?? 0)) pt; \(bad) of \(compared) frames outside (limit 1 in 200)")
        print("  drawn: \(perGlide.count) glides seen, \(withFrames) compared with the plan, \(moving) moved the cursor layer; \(apply.count) overlay updates for \(index) actions")
        print("  after the last glide the cursor stands \(String(format: "%.2f", endError)) pt from its target (limit 1.5)")
        print("  real pointer: \(shared.moves) changes in \(shared.samples) samples (limit 0 changes; at least 1000 samples); overlay key/main frames: \(keyOrMain) (limit 0); front app changes: \(frontChanges) (limit 0)")
        helper?.terminate()
        if shared.interrupted { print("cursor-probe: interrupted (input arrived; Donovan is back). Result discarded: not run"); exit(2) }
        // A run that drew nothing, or sampled nothing, cannot pass.
        let drew = apply.count == index && perGlide.count >= index * 8 / 10 && withFrames >= perGlide.count * 9 / 10 && moving >= perGlide.count * 9 / 10
        let sampled = shared.samples >= 1000
        let onPlan = compared > 0 && bad <= compared / 200 && endError <= 1.5
        if !drew { print("  FAIL: not enough was drawn: expected \(index) overlay updates and a moving, compared glide for nearly every action") }
        if !sampled { print("  FAIL: the pointer was sampled \(shared.samples) times; at least 1000 are needed to say it did not move") }
        if !onPlan { print("  FAIL: the drawn path left the plan, or the cursor did not end on its target") }
        let windowsOK = checks.count >= 7 && checks.allSatisfy(\.1)
        if !windowsOK { print("  FAIL: a window check failed (above)") }
        let ok = windowsOK && drew && sampled && onPlan && over15 <= frames / 200 && over2 == 0 && shared.moves == 0 && keyOrMain == 0 && frontChanges == 0 && frames >= 100
        print(ok ? "cursor-probe: pass" : "cursor-probe: FAIL")
        exit(ok ? 0 : 1)
    }
}
