import AppKit
import BaneySpacesCore

/// The window an agent's cursor and veil are drawn in: one per target window, the same frame and level as that window,
/// ordered directly above it in the window server. Whatever covers the target covers the overlay too, and it lives on
/// the target's macOS Space only (`behavior(fullScreen:)`). It is never the pointer and never takes one: it ignores the mouse, is never key or
/// main, and `.nonactivatingPanel` keeps the app that owns it from being activated when it is shown (it is ordered in
/// with `order(_:relativeTo:)`, which activates nothing).
final class CursorPanel: NSPanel {
    /// Pinned to the Space it was ordered in on, its window's: `.managed`, never `.canJoinAllSpaces`, `.transient`
    /// (which floats across Spaces) or `.moveToActiveSpace`. Out of the window cycle. It may join a full-screen Space
    /// only when its window is itself full screen, so it never shows over another app's full-screen window.
    static func behavior(fullScreen: Bool) -> NSWindow.CollectionBehavior {
        fullScreen ? [.managed, .ignoresCycle, .fullScreenAuxiliary] : [.managed, .ignoresCycle]
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override var acceptsFirstResponder: Bool { false }

    init(frame: CGRect) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        ignoresMouseEvents = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        // Not a floating panel: its level is its window's (`CursorOverlay.apply`), so it can sit directly above it.
        isFloatingPanel = false
        level = .normal
        // Out of screenshots and recordings of the display unless `agent shot --cursor` asks for it.
        sharingType = .none
        collectionBehavior = Self.behavior(fullScreen: false)
        animationBehavior = .none
        let host = NSView(frame: CGRect(origin: .zero, size: frame.size))
        host.wantsLayer = true
        // A cursor never draws outside its window.
        host.layer?.masksToBounds = true
        contentView = host
    }
}

/// The overlays' own window numbers, for every part of the app that reads the window list: an overlay is clear, so it
/// never covers anything (`Windows.isCovered`) even though the window server lists it over its window.
public enum CursorOverlayWindows {
    private static let lock = NSLock()
    private static var ids: Set<UInt32> = []
    public static var all: Set<UInt32> { lock.lock(); defer { lock.unlock() }; return ids }
    public static func contains(_ id: UInt32) -> Bool { lock.lock(); defer { lock.unlock() }; return ids.contains(id) }
    static func set(_ new: Set<UInt32>) { lock.lock(); ids = new; lock.unlock() }
}

/// A display the cursors can be drawn on: its frame in the hands' coordinates (global, y down) and the panel's
/// frame in AppKit's (global, y up).
public struct CursorDisplaySpec: Equatable {
    public var globalFrame: CGRect
    public var panelFrame: CGRect
    public var scale: CGFloat
    public init(globalFrame: CGRect, panelFrame: CGRect, scale: CGFloat) {
        self.globalFrame = globalFrame; self.panelFrame = panelFrame; self.scale = scale
    }

    /// The Mac's displays.
    public static func screens() -> [CursorDisplaySpec] {
        guard let primary = NSScreen.screens.first else { return [] }
        let top = primary.frame.maxY
        return NSScreen.screens.map {
            CursorDisplaySpec(globalFrame: CGRect(x: $0.frame.minX, y: top - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height),
                              panelFrame: $0.frame, scale: $0.backingScaleFactor)
        }
    }
}

/// One target window's overlay: the panel, its layers, and the maths from the hands' coordinates to layer ones.
/// `stage` holds the cursors; its origin is the window's top-left corner, so a window resized from any edge but the
/// top or left keeps every cursor where it was in the window. The veil sits under the stage.
final class CursorOverlay {
    let target: UInt32
    private(set) var placement: CursorWindow
    let panel: CursorPanel
    let root: CALayer
    let stage = CALayer()
    let veil = VeilLayer()
    private(set) var scale: CGFloat
    private(set) var shownCount = 0
    private(set) var isOnScreen = false
    /// Off in tests, which build panels but never put one on screen.
    let ordersFront: Bool
    private let primaryTop: () -> CGFloat
    /// Called when nothing is drawn on it any more and its fade-out has played: the surface lets it go.
    var onIdle: ((CursorOverlay) -> Void)?

    init(_ w: CursorWindow, scale: CGFloat, ordersFront: Bool, primaryTop: @escaping () -> CGFloat) {
        target = w.id
        placement = w
        self.scale = scale
        self.ordersFront = ordersFront
        self.primaryTop = primaryTop
        panel = CursorPanel(frame: Self.appKitFrame(w.frame, top: primaryTop()))
        panel.level = NSWindow.Level(rawValue: w.layer)
        panel.collectionBehavior = CursorPanel.behavior(fullScreen: w.fullScreen)
        root = panel.contentView!.layer!
        stage.bounds = .zero
        stage.anchorPoint = .zero
        root.addSublayer(veil.layer)
        root.addSublayer(stage)
        layoutLayers()
    }

    static func appKitFrame(_ f: CGRect, top: CGFloat) -> CGRect { CGRect(x: f.minX, y: top - f.maxY, width: f.width, height: f.height) }

    var frame: CGRect { placement.frame }
    var windowNumber: UInt32? { isOnScreen && panel.windowNumber > 0 ? UInt32(panel.windowNumber) : nil }

    /// A point of the hands (global, y down) on the stage (y up, origin at the window's top-left).
    func local(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - frame.minX, y: frame.minY - p.y) }

    func local(_ r: CGRect) -> CGRect {
        let o = local(CGPoint(x: r.minX, y: r.maxY))
        return CGRect(x: o.x, y: o.y, width: r.width, height: r.height)
    }

    /// A stage point back in the hands' coordinates.
    func global(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x + frame.minX, y: frame.minY - p.y) }

    func contains(_ p: CGPoint) -> Bool { frame.contains(p) }

    private func layoutLayers() {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let size = frame.size
        stage.position = CGPoint(x: 0, y: size.height)
        veil.resize(size, scale: scale)
        CATransaction.commit()
    }

    /// The window moved, resized or changed level; with `reorder` the overlay is ordered directly above it again.
    func apply(_ w: CursorWindow, scale newScale: CGFloat, reorder: Bool) {
        let old = placement
        placement = w
        if newScale != scale { scale = newScale }
        if old.frame != w.frame {
            panel.setFrame(Self.appKitFrame(w.frame, top: primaryTop()), display: false)
            layoutLayers()
        }
        if old.layer != w.layer { panel.level = NSWindow.Level(rawValue: w.layer) }
        if old.fullScreen != w.fullScreen { panel.collectionBehavior = CursorPanel.behavior(fullScreen: w.fullScreen) }
        if reorder || old.layer != w.layer || old.fullScreen != w.fullScreen { orderIn() }
    }

    /// Directly above its window. It also orders the panel in when it is out, and activates nothing.
    private func orderIn() {
        guard ordersFront, shownCount > 0 || veil.isShown else { return }
        panel.order(.above, relativeTo: Int(placement.id))
        isOnScreen = true
    }

    func cursorShown() {
        shownCount += 1
        if shownCount == 1, !veil.isShown { orderIn() }
    }

    func cursorHidden() {
        shownCount = max(0, shownCount - 1)
        idleLater()
    }

    func showVeil(_ look: VeilLook) {
        let first = !veil.isShown
        veil.apply(look, size: frame.size, scale: scale)
        veil.show()
        if first, shownCount == 0 { orderIn() }
    }

    func hideVeil() {
        guard veil.isShown else { return }
        veil.hide()
        idleLater()
    }

    var isIdle: Bool { shownCount == 0 && !veil.isShown }

    /// After the fades have played, an overlay with nothing on it leaves the screen.
    private func idleLater() {
        guard isIdle else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + VeilLayer.fadeOut + 0.05) { [weak self] in
            guard let self, self.isIdle else { return }
            self.orderOut()
            self.onIdle?(self)
        }
    }

    func orderOut() {
        if ordersFront { panel.orderOut(nil) }
        isOnScreen = false
    }

    func close() { orderOut(); panel.close() }
}

/// The window server's on-screen list, front to back, in the hands' coordinates: one read per call.
public enum ScreenWindows {
    public static func onScreen() -> [ScreenWindow]? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        return list.compactMap { w in
            guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { return nil }
            return ScreenWindow(id: id, pid: pid, layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, bounds: b,
                                alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
        }
    }
}
