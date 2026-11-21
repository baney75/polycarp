import AppKit
import BaneySpacesCore

/// Settings › Appearance › Window borders: a border in the theme's accent around the focused window, and with "Other
/// windows" one in its border color around the rest. Each border is a clear window of Polycarp's own, a little bigger
/// than its window, ordered directly above it (so whatever covers the window covers its border), ignoring the mouse.
/// Nothing is sent to the other app, and no Accessibility call is made.
///
/// A border never trails its window (`BorderFollowMode`). Live: the window server says the moment a bordered window
/// moves and `BorderMoves` moves the border in the same breath. Where macOS gives no such notice, a border hides while
/// its window may move and comes back where the window settles (`BorderHideWhileMoving`), and `trace.log` says so once.
///
/// Off, it holds nothing: no window, timer, notice or event monitor. On, it also looks at the bordered windows' frames
/// ten times a second (one window-server call for all of them, about 0.15 ms), for windows that close or move unnoticed.
final class WindowBorders: NSObject {
    static let shared = WindowBorders()

    /// What is drawn now: off, or the style and whether unfocused windows get one.
    private(set) var on = false
    private var others = false
    private var style: WindowBorderStyle?
    private var mode = BorderFollowMode.live
    /// The mode the last start chose, for the lag probe.
    var lastMode: BorderFollowMode { mode }
    private var gate = BorderHideWhileMoving()
    private static var toldFallback = false
    /// The window each border is around, and its border.
    private var panels: [CGWindowID: BorderPanel] = [:]
    private var frames: [CGWindowID: CGRect] = [:]
    private var focused: CGWindowID?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var mouse: Any?
    private var idle: Timer?
    private var list: Timer?
    /// For the lag probe: follow this one window, whatever is in front.
    private var pinned: CGWindowID?
    /// For the lag probe: told the time and the window's place (window-server coordinates) each time a border moves or
    /// is drawn, on the thread that did it.
    var probeMoved: ((Double, CGPoint) -> Void)? {
        didSet { BorderMoves.probe = probeMoved }
    }

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

    /// Live when the window server's move notices register, else hide-while-moving (said once in `trace.log`).
    /// `BANEYSPACES_BORDER_FALLBACK=1` forces the fallback, for the lag probe and live checks of it.
    private func begin() {
        let forced = ProcessInfo.processInfo.environment["BANEYSPACES_BORDER_FALLBACK"] == "1"
        let why = forced ? nil : BorderMoves.start()
        mode = BorderFollowMode.choose(notices: why == nil, forced: forced)
        gate = BorderHideWhileMoving()
        if mode == .live {
            BorderMoves.onMoved = { [weak self] in self?.moved($0) }
        } else if !Self.toldFallback {
            Self.toldFallback = true
            Trace.log("window borders: \(forced ? "fallback forced" : "no window-move notices from macOS (\(why ?? ""))"); "
                      + "a border hides while its window moves and comes back where it settles")
        }
        idle = Timer.scheduledTimer(withTimeInterval: BorderPace.idleInterval, repeats: true) { [weak self] _ in self?.follow() }
        idle?.tolerance = BorderPace.idleInterval / 4
    }

    private func start() {
        on = true
        begin()
        let ws = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification,
                     NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
            observers.append((ws, ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refresh() }))
        }
        let nc = NotificationCenter.default
        observers.append((nc, nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        }))
        // A press may raise another window of the app in front, or start a drag (the fallback hides that border first).
        mouse = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] e in
            guard let self else { return }
            if e.type == .leftMouseDown, self.mode == .hideWhileMoving { self.pressed() }
            self.refresh()
        }
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
        BorderMoves.stop()
        BorderMoves.onMoved = nil
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
        var place: [CGWindowID: Int] = [:]
        for (i, w) in info.enumerated() { if let n = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value { place[n] = i } }
        draw(want.reduce(into: [:]) { $0[$1] = byID[$1] }, style: style, place: place)
    }

    /// Shows each border at its window's frame (the fallback only where `gate` allows) and hides the rest. Front to
    /// back: a border already directly in front of its window is left where it is.
    private func draw(_ want: [CGWindowID: CGRect], style: WindowBorderStyle, place: [CGWindowID: Int] = [:]) {
        let shown = mode == .live ? want : gate.look(want, buttonDown: NSEvent.pressedMouseButtons & 1 != 0, now: ProcessInfo.processInfo.systemUptime)
        for (id, frame) in want {
            let fresh = panels[id] == nil
            let p = panels[id] ?? BorderPanel()
            panels[id] = p
            let old = frames[id]
            frames[id] = frame
            guard let at = shown[id] else { if p.isVisible { p.orderOut(nil) }; continue }
            let again = !p.isVisible
            let color = id == focused || id == pinned ? style.focused : style.unfocused
            if mode == .live, !fresh, !again, p.drawn == BorderPanel.Paint(color: color, width: style.width, size: style.panelFrame(at).size) {
                // Live, the window list can trail a moving window: only a fresh read moves a border that is up.
                if old != at { BorderMoves.follow(id) }
            } else {
                p.show(style: style, color: color, around: at)
            }
            let own = CGWindowID(p.windowNumber)
            // With no list (the looks between), only a border just shown is ordered.
            if fresh || again || (!place.isEmpty && place[own] != place[id].map({ $0 - 1 })) { p.order(.above, relativeTo: Int(id)) }
            if mode == .hideWhileMoving, fresh || again { probeMoved?(ProcessInfo.processInfo.systemUptime, at.origin) }
        }
        BorderOverlayWindows.set(Set(panels.values.map { CGWindowID($0.windowNumber) }))
        if mode == .live {
            BorderMoves.watch(panels.reduce(into: [:]) { m, e in
                m[e.key] = BorderMoves.Target(border: UInt32(e.value.windowNumber), style: style, size: e.value.frame.size)
            })
        }
    }

    /// The fallback: a left press that may start a move or resize of a bordered window hides its border now.
    private func pressed() {
        let p = NSEvent.mouseLocation
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let at = CGPoint(x: p.x, y: top - p.y)
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let mine = Set(panels.values.map { CGWindowID($0.windowNumber) })
        let front = info.compactMap { BorderList.candidate($0) }.filter { !mine.contains($0.id) && $0.layer == 0 }.map { (id: $0.id, frame: $0.frame) }
        if let id = gate.press(at: at, frames: front, now: ProcessInfo.processInfo.systemUptime) { panels[id]?.orderOut(nil) }
    }

    /// The look ten times a second: a window gone means a full look; one somewhere new moves its border (live: by a
    /// fresh read and a transaction; the fallback: hidden until it settles).
    private func follow() {
        guard on, !panels.isEmpty, let style else { return }
        let ids = Array(panels.keys)
        let now = BorderList.frames(ids)
        if ids.contains(where: { now[$0] == nil }), pinned == nil { refresh(); return }
        if mode == .live {
            for (id, f) in now where f != frames[id] { BorderMoves.follow(id) }
        } else {
            draw(now, style: style)
        }
    }

    /// Live: the borders have moved; note where, and reshape through AppKit any whose window changed size.
    private func moved(_ now: [CGWindowID: CGRect]) {
        guard on, let style, mode == .live else { return }
        for (id, f) in now {
            guard let p = panels[id] else { continue }
            let old = frames[id]
            frames[id] = f
            guard old?.size != f.size else { continue }
            p.move(style: style, around: f)
            BorderMoves.reshaped(id, size: p.frame.size)
        }
    }

    /// The lag probe: one border around `id`, followed the way the app follows any, until `unpin`. Never used by the app.
    func pin(_ id: CGWindowID, style: WindowBorderStyle) {
        on = true
        self.style = style
        pinned = id
        begin()
        guard let f = BorderList.frames([id])[id] else { return }
        draw([id: f], style: style)
    }

    func border(of id: CGWindowID) -> CGWindowID? { panels[id].map { CGWindowID($0.windowNumber) } }

    func unpin() { pinned = nil; stop() }
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
    struct Paint: Equatable { var color: RGB; var width: Double; var size: CGSize }
    /// The color, width and size it was last drawn with.
    private(set) var drawn: Paint?

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
        drawn = Paint(color: color, width: style.width, size: style.panelFrame(window).size)
    }

    func move(style: WindowBorderStyle, around window: CGRect) {
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let f = style.panelFrame(window)
        setFrame(CGRect(x: f.minX, y: top - f.maxY, width: f.width, height: f.height), display: false)
        if drawn != nil { drawn?.size = f.size }
        guard f.size != size else { return }
        size = f.size
        let s = style.stroke(in: f.size)
        shape.frame = CGRect(origin: .zero, size: f.size)
        let r = min(s.radius, s.rect.width / 2, s.rect.height / 2)
        shape.path = CGPath(roundedRect: s.rect, cornerWidth: r, cornerHeight: r, transform: nil)
    }
}
