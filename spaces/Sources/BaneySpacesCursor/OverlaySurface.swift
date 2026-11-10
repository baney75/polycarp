import AppKit
import BaneySpacesCore
import QuartzCore

/// The real `CursorSurface`: Core Animation layers in click-through overlay panels, one per window an agent is drawn
/// over, each ordered directly above its window (`CursorOverlay`). Main thread only. Nothing here runs per frame: a
/// glide is one keyframe animation handed to the compositor, and the veil's light is a repeating stroke animation.
public final class OverlaySurface: CursorSurface {
    private var displays: [CursorDisplaySpec]
    private var overlays: [UInt32: CursorOverlay] = [:]
    private var cursors: [String: AgentCursor] = [:]

    private let ordersFront: Bool
    private let primaryTop: () -> CGFloat

    /// `ordersFront: false` builds the panels without ever putting one on screen (tests).
    public init(displays specs: [CursorDisplaySpec], ordersFront: Bool = true, primaryTop: (() -> CGFloat)? = nil) {
        self.ordersFront = ordersFront
        displays = specs
        self.primaryTop = primaryTop ?? { NSScreen.screens.first?.frame.maxY ?? 0 }
    }

    /// The displays changed. Each overlay keeps its window; a shown cursor whose point is on no display any more is
    /// hidden, and every other one stays where it was (its marks and look intact).
    public func setDisplays(_ specs: [CursorDisplaySpec]) {
        displays = specs
        for o in overlays.values { o.apply(o.placement, scale: scale(for: o.placement.frame), reorder: false) }
        for c in cursors.values where c.isShown && !specs.contains(where: { $0.globalFrame.contains(c.point) }) { c.hide() }
    }

    /// The displays' frames in the hands' coordinates.
    public var frames: [CGRect] { displays.map(\.globalFrame) }

    private func scale(for frame: CGRect) -> CGFloat {
        let center = CGPoint(x: frame.midX, y: frame.midY)
        return (displays.first { $0.globalFrame.contains(center) } ?? displays.first { $0.globalFrame.intersects(frame) })?.scale ?? 2
    }

    /// The overlay for a window, made on first use, and moved to where the window is now.
    private func overlay(_ w: CursorWindow) -> CursorOverlay {
        if let o = overlays[w.id] {
            o.apply(w, scale: scale(for: w.frame), reorder: true)
            return o
        }
        let o = CursorOverlay(w, scale: scale(for: w.frame), ordersFront: ordersFront, primaryTop: primaryTop)
        o.onIdle = { [weak self] o in self?.retire(o) }
        overlays[w.id] = o
        return o
    }

    /// Nothing is drawn on it any more: its cursors come off and the panel goes.
    private func retire(_ o: CursorOverlay) {
        guard overlays[o.target] === o, o.isIdle else { return }
        for c in cursors.values where c.display === o { c.detach() }
        overlays[o.target] = nil
        o.close()
        publish()
    }

    /// Tells the rest of the app which windows are overlays.
    private func publish() { CursorOverlayWindows.set(overlayWindows) }

    private func land(_ c: AgentCursor, at p: CGPoint, in o: CursorOverlay) {
        c.detach()
        c.attach(to: o)
        c.appear(at: p)
        publish()
    }

    public func configure(_ agent: String, look: CursorLook) {
        if let c = cursors[agent] { c.apply(look) } else { cursors[agent] = AgentCursor(id: agent, look: look) }
    }

    public func appear(_ agent: String, at point: CGPoint, in window: CursorWindow) {
        guard let c = cursors[agent] else { return }
        let o = overlay(window)
        c.attach(to: o)
        c.appear(at: point)
        publish()
    }

    public func move(_ agent: String, motion: CursorMotion, in window: CursorWindow) {
        guard let c = cursors[agent] else { return }
        let o = overlay(window)
        // In another window it lands instead of flying across the screen.
        guard c.display === o else { return land(c, at: motion.target, in: o) }
        c.glide(motion)
    }

    public func jump(_ agent: String, to point: CGPoint, in window: CursorWindow) {
        guard let c = cursors[agent] else { return }
        let o = overlay(window)
        guard c.display === o else { return land(c, at: point, in: o) }
        c.jump(to: point)
    }

    public func act(_ agent: String, effect: CursorEffect, point: CGPoint, frame: CGRect, delay: TimeInterval) {
        cursors[agent]?.act(effect, at: point, frame: frame, delay: delay)
    }

    public func hide(_ agent: String) { cursors[agent]?.hide() }

    public func remove(_ agent: String) {
        cursors[agent]?.detach()
        cursors[agent] = nil
    }

    public func place(_ window: CursorWindow, reorder: Bool) {
        guard let o = overlays[window.id] else { return }
        let old = o.frame
        o.apply(window, scale: scale(for: window.frame), reorder: reorder)
        let dx = window.frame.minX - old.minX, dy = window.frame.minY - old.minY
        if dx != 0 || dy != 0 { for c in cursors.values where c.display === o { c.shift(by: dx, dy) } }
        publish()
    }

    public func showVeil(_ window: CursorWindow, look: VeilLook) {
        overlay(window).showVeil(look)
        publish()
    }

    public func hideVeil(_ window: UInt32) { overlays[window]?.hideVeil() }

    public func windowGone(_ window: UInt32) {
        guard let o = overlays[window] else { return }
        for c in cursors.values where c.display === o { c.detach() }
        o.hideVeil()
        o.orderOut()
        retire(o)
    }

    public func overlayWindow(for window: UInt32) -> UInt32? { overlays[window]?.windowNumber }

    public var overlayWindows: Set<UInt32> { Set(overlays.values.compactMap(\.windowNumber)) }

    // MARK: for checks

    /// How many cursors the overlay holds, and whether one's marks are attached.
    public var cursorCount: Int { cursors.count }
    public func marksAreAttached(_ agent: String) -> Bool { cursors[agent]?.marksAreAttached ?? false }

    /// Where a cursor is drawn right now (its presentation layer), in the hands' coordinates: for the probe.
    public func presentedPoint(_ agent: String) -> CGPoint? {
        guard let c = cursors[agent], let d = c.display, let p = c.root.presentation()?.position else { return nil }
        return d.global(p)
    }

    /// Where a cursor's tip is in its panel (y up from the bottom-left corner), from the model layers: for checks.
    public func pointInPanel(_ agent: String) -> CGPoint? {
        guard let c = cursors[agent], let d = c.display else { return nil }
        return d.root.convert(c.root.position, from: d.stage)
    }

    /// The window a cursor is drawn over.
    public func window(of agent: String) -> UInt32? { cursors[agent]?.display?.target }

    /// For checks: the size and stroke animations a cursor has scheduled (none when motion is off).
    public func motionAnimationKeys(_ agent: String) -> [String] { cursors[agent]?.motionAnimationKeys ?? [] }

    public func isGliding(_ agent: String) -> Bool { cursors[agent]?.root.animation(forKey: AgentCursor.glideKey) != nil }

    public func isShown(_ agent: String) -> Bool { cursors[agent]?.isShown ?? false }

    /// Every overlay panel, for checks that they can't take focus.
    public var panels: [NSPanel] { overlays.values.map(\.panel) }

    /// An overlay's panel, its stage (the cursors' layers) and its veil, for checks.
    public func panel(for window: UInt32) -> NSPanel? { overlays[window]?.panel }
    public func stageLayerCount(_ window: UInt32) -> Int { overlays[window]?.stage.sublayers?.count ?? 0 }
    public func veilShown(_ window: UInt32) -> Bool { overlays[window]?.veil.isShown ?? false }
    public func veilMotionKeys(_ window: UInt32) -> [String] { overlays[window]?.veil.motionAnimationKeys ?? [] }
    public func veilPillCount(_ window: UInt32) -> Int { overlays[window]?.veil.pillCount ?? 0 }
    public func veilScrimShown(_ window: UInt32) -> Bool { overlays[window]?.veil.scrimShown ?? false }
    public func clipsToWindow(_ window: UInt32) -> Bool { overlays[window]?.root.masksToBounds ?? false }
}
