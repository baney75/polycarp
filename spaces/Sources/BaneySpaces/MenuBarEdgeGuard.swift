import AppKit
import BaneySpacesCore
import CoreGraphics

/// Keeps macOS's auto-hidden menu bar from sliding in over Polycarp's bar: while the bar is up on a screen, the pointer
/// is held one point under that screen's top edge (`MenuBarEdge`), in full screen too. A pointer that never reaches
/// the edge never brings the macOS bar. The tap uses the Accessibility access Polycarp already has and runs on its own
/// thread, so it never waits on the main thread. Without a bar on any screen it is off and the edge is macOS's again.
final class MenuBarEdgeGuard {
    static let shared = MenuBarEdgeGuard()

    private var tap: CFMachPort?
    private var thread: Thread?
    private var runLoop: CFRunLoop?
    private let lock = NSLock()
    private var _edges: [MenuBarEdge.Edge] = []
    private var edges: [MenuBarEdge.Edge] {
        lock.lock(); defer { lock.unlock() }
        return _edges
    }

    /// The screens whose top edge to guard (main thread). An empty list switches the guard off.
    func guardScreens(_ guarded: [NSScreen]) {
        let all = NSScreen.screens.map(Self.quartz)
        let edges = MenuBarEdge.edges(guarded: guarded.map(Self.quartz), all: all)
        lock.lock()
        let changed = edges != _edges
        _edges = edges
        lock.unlock()
        if edges.isEmpty { stop() } else { start() }
        if changed { Trace.log("menu bar edge: \(edges.isEmpty ? "off" : "held on \(edges.count) screen(s)")") }
    }

    /// An AppKit screen frame (origin bottom left of the main screen) in Quartz global coordinates.
    private static func quartz(_ s: NSScreen) -> MenuBarEdge.Screen {
        let mainHeight = NSScreen.screens.first?.frame.height ?? s.frame.height
        return MenuBarEdge.Screen(x: s.frame.minX, y: mainHeight - s.frame.maxY, width: s.frame.width, height: s.frame.height)
    }

    private func start() {
        guard tap == nil else { return }
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | CGEventMask(1 << $1.rawValue) }
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: mask, callback: MenuBarEdgeGuard.callback, userInfo: me)
                ?? CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                     eventsOfInterest: mask, callback: MenuBarEdgeGuard.callback, userInfo: me)
        else { return Trace.log("menu bar edge: macOS refused the pointer tap (Accessibility?)") }
        self.tap = tap
        let t = Thread { [weak self] in
            guard let self else { return }
            let loop = CFRunLoopGetCurrent()
            self.lock.lock()
            guard self.tap === tap else { self.lock.unlock(); return }
            self.runLoop = loop
            self.lock.unlock()
            CFRunLoopAddSource(loop, CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            CFRunLoopRun()
        }
        t.name = "Polycarp menu bar edge"
        t.qualityOfService = .userInteractive
        thread = t
        t.start()
    }

    private func stop() {
        lock.lock()
        defer { lock.unlock() }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let runLoop { CFRunLoopStop(runLoop) }
        tap = nil
        runLoop = nil
        thread = nil
    }

    private static let callback: CGEventTapCallBack = { _, type, event, info in
        guard let info else { return Unmanaged.passUnretained(event) }
        let me = Unmanaged<MenuBarEdgeGuard>.fromOpaque(info).takeUnretainedValue()
        // macOS switches a slow tap off; switch it back on.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = me.tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let p = event.location
        guard let held = MenuBarEdge.clamp(x: p.x, y: p.y, edges: me.edges) else { return Unmanaged.passUnretained(event) }
        let to = CGPoint(x: held.x, y: held.y)
        event.location = to
        CGWarpMouseCursorPosition(to)
        // A warp holds the pointer still for a moment; join them again so it keeps moving sideways along the bar.
        CGAssociateMouseAndMouseCursorPosition(1)
        return Unmanaged.passUnretained(event)
    }
}
