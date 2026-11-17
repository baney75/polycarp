import AppKit
import BaneySpacesCore

/// Settings › Appearance › Window borders: a border in the theme's accent around the focused window, and with "Other
/// windows" one in its border color around the rest. Each border is a clear window of Polycarp's own, a little bigger
/// than its window, ordered directly above it (so whatever covers the window covers its border), ignoring the mouse.
/// Nothing is sent to the other app, and no Accessibility call is made: the window server's list says where windows are.
///
/// Off, it holds nothing: no window, timer, thread or event monitor. On, it looks at the bordered windows' frames ten
/// times a second (one window-server call for all of them, about 0.15 ms). While a mouse button is down or one of them
/// moved in the last 0.4 s (`BorderPace`), a real-time thread looks every millisecond instead, so a dragged window's
/// border moves within the frame the window does. A look once per display frame always trailed by a frame, and by two
/// whenever the main thread missed one.
final class WindowBorders: NSObject {
    static let shared = WindowBorders()

    /// What is drawn now: off, or the style and whether unfocused windows get one.
    private(set) var on = false
    private var others = false
    private var style: WindowBorderStyle?
    /// The window each border is around, and its border.
    private var panels: [CGWindowID: BorderPanel] = [:]
    private var frames: [CGWindowID: CGRect] = [:]
    private var focused: CGWindowID?
    private var pace = BorderPace()
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var mouse: Any?
    private var idle: Timer?
    private var list: Timer?
    private lazy var follower = BorderFollower { [weak self] in self?.moved($0) }
    /// For the lag probe: follow this one window, whatever is in front, every display frame.
    private var pinned: CGWindowID?
    /// For the lag probe: told the time and the window's place (window-server coordinates) each time a border moves.
    var probeMoved: ((Double, CGPoint) -> Void)?

    /// Reads Settings › Appearance and the look, and turns the borders on, off or restyles them. Main thread.
    func sync() {
        let a = Appearance.shared
        let want = a.settings.windowBorders
        let newStyle = WindowBorderStyle(a.look)
        let newOthers = want && a.settings.otherWindowBorders
        guard want else { if on { stop() }; return }
        let restyle = newStyle != style || newOthers != others
        style = newStyle
        others = newOthers
        if !on { start() } else if restyle { refresh() }
    }

    private func start() {
        on = true
        let ws = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification,
                     NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
            observers.append((ws, ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refresh() }))
        }
        let nc = NotificationCenter.default
        observers.append((nc, nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        }))
        // A press may raise another window of the app in front, and starts a drag: look now, and follow every frame.
        mouse = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] e in
            guard let self else { return }
            self.refresh()
            if e.type == .leftMouseDown { self.goFast(true) }
        }
        idle = Timer.scheduledTimer(withTimeInterval: BorderPace.idleInterval, repeats: true) { [weak self] _ in self?.follow() }
        idle?.tolerance = BorderPace.idleInterval / 2
        // Windows opening, closing and coming forward without an activation: a full look twice a second.
        list = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }

    private func stop() {
        on = false
        for (center, o) in observers { center.removeObserver(o) }
        observers = []
        if let mouse { NSEvent.removeMonitor(mouse) }
        mouse = nil
        idle?.invalidate(); idle = nil
        list?.invalidate(); list = nil
        goFast(false)
        for p in panels.values { p.orderOut(nil); p.close() }
        panels = [:]; frames = [:]; focused = nil
        style = nil
        BorderOverlayWindows.set([])
    }

    /// Something changed in front (Polycarp's own workspace switch calls this too): which windows get a border, and each
    /// border ordered above its window again.
    func refresh() {
        guard on, pinned == nil, let style else { return }
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let mine = Set(panels.values.map { CGWindowID($0.windowNumber) })
        let candidates = info.compactMap { BorderList.candidate($0) }.filter { !mine.contains($0.id) }
        let t = WindowBorderPlan.targets(candidates, frontPID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                                         selfPID: getpid(), screens: BorderList.screens(), others: others)
        focused = t.focused
        let want = (t.focused.map { [$0] } ?? []) + t.others
        let byID = Dictionary(candidates.map { ($0.id, $0.frame) }, uniquingKeysWith: { a, _ in a })
        for (id, p) in panels where !want.contains(id) { p.orderOut(nil); p.close(); panels[id] = nil; frames[id] = nil }
        // Front to back: a border already directly in front of its window is left where it is.
        var place: [CGWindowID: Int] = [:]
        for (i, w) in info.enumerated() { if let n = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value { place[n] = i } }
        for id in want {
            guard let frame = byID[id] else { continue }
            let fresh = panels[id] == nil
            let p = panels[id] ?? BorderPanel()
            panels[id] = p
            p.show(style: style, color: id == focused ? style.focused : style.unfocused, around: frame)
            frames[id] = frame
            let own = CGWindowID(p.windowNumber)
            if fresh || place[own] == nil || place[own] != place[id].map({ $0 - 1 }) { p.order(.above, relativeTo: Int(id)) }
        }
        BorderOverlayWindows.set(Set(panels.values.map { CGWindowID($0.windowNumber) }))
        follower.watch(Array(panels.keys))
    }

    /// The idle look at every bordered window's frame (one window-server call).
    private func follow() {
        guard on, !panels.isEmpty else { return }
        let ids = Array(panels.keys)
        let now = BorderList.frames(ids)
        let gone = ids.contains { now[$0] == nil }
        let moved = place(now)
        if gone, pinned == nil { refresh() }
        if pinned != nil { return }
        goFast(pace.look(moved: moved, buttonDown: NSEvent.pressedMouseButtons & 1 != 0, now: ProcessInfo.processInfo.systemUptime))
    }

    /// The fast look's news: frames that changed since its last look.
    private func moved(_ now: [CGWindowID: CGRect]) {
        guard on else { return }
        if place(now), pinned == nil { _ = pace.look(moved: true, buttonDown: false, now: ProcessInfo.processInfo.systemUptime) }
    }

    /// Moves each border whose window is somewhere new; true when one moved.
    private func place(_ now: [CGWindowID: CGRect]) -> Bool {
        guard let style else { return false }
        var moved = false
        for (id, f) in now where f != frames[id] {
            guard let p = panels[id] else { continue }
            frames[id] = f
            p.move(style: style, around: f)
            probeMoved?(ProcessInfo.processInfo.systemUptime, f.origin)
            moved = true
        }
        return moved
    }

    /// The real-time look every millisecond, or only the idle looks.
    private func goFast(_ fast: Bool) {
        if fast { follower.start(Array(panels.keys)) } else { follower.stop() }
    }

    /// The lag probe: one border around `id`, followed every millisecond until `unpin`. Never used by the app.
    func pin(_ id: CGWindowID, style: WindowBorderStyle) {
        on = true
        self.style = style
        pinned = id
        guard let f = BorderList.frames([id])[id] else { return }
        let p = BorderPanel()
        panels[id] = p
        frames[id] = f
        p.show(style: style, color: style.focused, around: f)
        p.order(.above, relativeTo: Int(id))
        goFast(true)
    }

    func border(of id: CGWindowID) -> CGWindowID? { panels[id].map { CGWindowID($0.windowNumber) } }

    func unpin() { pinned = nil; stop() }
}

/// While a window may be moving: a real-time thread reads the bordered windows' frames every millisecond and hands the
/// main thread any that changed, at most one hand-off waiting at a time (it takes the newest frames).
final class BorderFollower: @unchecked Sendable {
    static let interval = 0.001
    private let lock = NSLock()
    private var ids: [CGWindowID] = []
    private var running = false
    private var latest: [CGWindowID: CGRect] = [:]
    private var handing = false
    private let onMove: ([CGWindowID: CGRect]) -> Void

    init(onMove: @escaping ([CGWindowID: CGRect]) -> Void) { self.onMove = onMove }

    func watch(_ new: [CGWindowID]) { lock.lock(); ids = new; lock.unlock() }

    func start(_ new: [CGWindowID]) {
        lock.lock(); ids = new
        let already = running; running = true
        lock.unlock()
        guard !already else { return }
        let t = Thread { [self] in loop() }
        t.name = "polycarp.borders"
        t.qualityOfService = .userInteractive
        t.start()
    }

    func stop() { lock.lock(); running = false; lock.unlock() }

    private func loop() {
        RealTime.join(period: Self.interval, work: 0.0003)
        var last: [CGWindowID: CGRect] = [:]
        while true {
            lock.lock(); let go = running, now = ids; lock.unlock()
            guard go else { return }
            let frames = BorderList.frames(now)
            if frames != last {
                last = frames
                lock.lock(); latest = frames; let hand = !handing; handing = true; lock.unlock()
                if hand {
                    DispatchQueue.main.async { [self] in
                        lock.lock(); let f = latest; handing = false; lock.unlock()
                        onMove(f)
                    }
                }
            }
            RealTime.wait(Self.interval)
        }
    }
}

/// A thread the scheduler runs on time (like an audio thread), with waits that are never coalesced.
enum RealTime {
    private static let timebase: mach_timebase_info_data_t = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return t }()
    static func ticks(_ seconds: Double) -> UInt64 { UInt64(seconds * 1e9 * Double(timebase.denom) / Double(timebase.numer)) }

    static func join(period: Double, work: Double) {
        var p = thread_time_constraint_policy_data_t(period: UInt32(ticks(period)), computation: UInt32(ticks(work)),
                                                     constraint: UInt32(ticks(period)), preemptible: 1)
        let count = mach_msg_type_number_t(MemoryLayout<thread_time_constraint_policy_data_t>.size / MemoryLayout<integer_t>.size)
        _ = withUnsafeMutablePointer(to: &p) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                thread_policy_set(pthread_mach_thread_np(pthread_self()), thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), $0, count)
            }
        }
    }

    static func wait(_ seconds: Double) { mach_wait_until(mach_absolute_time() + ticks(seconds)) }
}

/// The window list as borders read it.
enum BorderList {
    static func candidate(_ w: [String: Any]) -> BorderCandidate? {
        guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let frame = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { return nil }
        return BorderCandidate(id: id, pid: pid, frame: frame, layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                               alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }

    /// The displays in the window server's coordinates (y down from the primary's top).
    static func screens() -> [CGRect] {
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        return NSScreen.screens.map { CGRect(x: $0.frame.minX, y: top - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
    }

    /// The frames of these windows now, those still on screen only.
    static func frames(_ ids: [CGWindowID]) -> [CGWindowID: CGRect] {
        var raw = ids.map { UnsafeRawPointer(bitPattern: UInt($0)) }
        guard let array = CFArrayCreate(nil, &raw, raw.count, nil),
              let list = CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]] else { return [:] }
        var out: [CGWindowID: CGRect] = [:]
        for w in list {
            guard (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false, let c = candidate(w) else { continue }
            out[c.id] = c.frame
        }
        return out
    }
}

/// The border windows' numbers, so the parts of the app that read the window list never count one as covering its
/// window (`Windows.isCovered`): it is clear inside.
enum BorderOverlayWindows {
    private static let lock = NSLock()
    private static var ids: Set<CGWindowID> = []
    static func contains(_ id: CGWindowID) -> Bool { lock.lock(); defer { lock.unlock() }; return ids.contains(id) }
    static func set(_ new: Set<CGWindowID>) { lock.lock(); ids = new; lock.unlock() }
}

/// One border: a clear, mouse-transparent panel with a stroked rounded rectangle, never key, never activating.
final class BorderPanel: NSPanel {
    private let shape = CAShapeLayer()
    private var size: CGSize = .zero

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init() {
        super.init(contentRect: CGRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        ignoresMouseEvents = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        isFloatingPanel = false
        level = .normal
        // Its window's Space only, out of the window cycle, like the agent cursor's overlay.
        collectionBehavior = [.managed, .ignoresCycle]
        animationBehavior = .none
        let host = NSView(frame: .zero)
        host.wantsLayer = true
        host.layer?.addSublayer(shape)
        contentView = host
        shape.fillColor = nil
        // No implicit animation: a border is where its window is, on the same frame.
        shape.actions = ["path": NSNull(), "strokeColor": NSNull(), "lineWidth": NSNull(), "bounds": NSNull(), "position": NSNull()]
    }

    /// `window` is in the window server's coordinates.
    func show(style: WindowBorderStyle, color: RGB, around window: CGRect) {
        shape.strokeColor = CGColor(srgbRed: color.r, green: color.g, blue: color.b, alpha: 1)
        shape.lineWidth = style.width
        size = .zero
        move(style: style, around: window)
    }

    func move(style: WindowBorderStyle, around window: CGRect) {
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let f = style.panelFrame(window)
        setFrame(CGRect(x: f.minX, y: top - f.maxY, width: f.width, height: f.height), display: false)
        guard f.size != size else { return }
        size = f.size
        let s = style.stroke(in: f.size)
        shape.frame = CGRect(origin: .zero, size: f.size)
        let r = min(s.radius, s.rect.width / 2, s.rect.height / 2)
        shape.path = CGPath(roundedRect: s.rect, cornerWidth: r, cornerHeight: r, transform: nil)
    }
}
