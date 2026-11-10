import AppKit
import BaneySpacesCore
import QuartzCore

/// The "in use" veil over a window an agent is working in, as Core Animation layers. From the back: a faint scrim in
/// the status color, a soft inner glow and a rim along the window's edge, a light that travels around the edge in the
/// agent's own hue with a white head, and a pill at the top center in the cursor badge's style ("Claude · working").
///
/// Nothing here runs per frame. The light is three strokes of one path that goes twice around the window, and its
/// travel is a `strokeStart`/`strokeEnd` animation the render server plays forever; Reduce Motion draws the rim
/// still and nothing travels or pulses, Reduce Transparency drops the scrim and makes the pill opaque.
final class VeilLayer {
    let layer = CALayer()
    private let scrim = CALayer()
    private let glow = CAShapeLayer()
    private let rim = CAShapeLayer()
    /// Tail, body, head of the traveling light.
    private let light = [CAShapeLayer(), CAShapeLayer(), CAShapeLayer()]
    private let pills = CALayer()
    private(set) var look: VeilLook?
    private(set) var isShown = false
    private var size: CGSize = .zero
    private var scale: CGFloat = 2

    static let fadeIn: CFTimeInterval = 0.22, fadeOut: CFTimeInterval = 0.45
    static let travelKey = "travel", pulseKey = "pulse", fadeKey = "fade"
    /// The window's corner: a little rounder than most macOS 27 windows, so the rim never shows outside one.
    static let corner: CGFloat = 20
    /// How fast the light goes around, in points per second; a lap takes 2.5 to 7 s.
    static let travelSpeed: CGFloat = 720
    /// Each stroke of the light: its length along the edge (points), width, and how strong.
    private static let strokes: [(length: CGFloat, width: CGFloat, alpha: CGFloat)] = [(360, 7, 0.22), (150, 3, 0.9), (36, 2.5, 1)]

    init() {
        layer.opacity = 0
        layer.anchorPoint = .zero
        layer.masksToBounds = true
        layer.cornerRadius = Self.corner
        for l in [glow, rim] + light {
            l.fillColor = nil
            l.lineCap = .round
            l.lineJoin = .round
        }
        layer.addSublayer(scrim)
        layer.addSublayer(glow)
        layer.addSublayer(rim)
        light.forEach { layer.addSublayer($0) }
        layer.addSublayer(pills)
    }

    private func noActions(_ f: () -> Void) {
        CATransaction.begin(); CATransaction.setDisableActions(true); f(); CATransaction.commit()
    }

    static func color(_ c: RGB, alpha: CGFloat = 1) -> CGColor { AgentCursor.color(c, alpha: alpha) }

    // MARK: shape

    /// The window's edge as a closed path from the top center, clockwise on screen, `laps` times around. Layers are y up.
    static func edge(_ size: CGSize, inset: CGFloat, laps: Int = 1) -> CGPath {
        let r = CGRect(origin: .zero, size: size).insetBy(dx: inset, dy: inset)
        let c = max(0, min(corner - inset, min(r.width, r.height) / 2))
        let p = CGMutablePath()
        guard r.width > 0, r.height > 0 else { return p }
        p.move(to: CGPoint(x: r.midX, y: r.maxY))
        for _ in 0..<max(1, laps) {
            p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX, y: r.minY), radius: c)
            p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.minX, y: r.minY), radius: c)
            p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX, y: r.maxY), radius: c)
            p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.maxX, y: r.maxY), radius: c)
            p.addLine(to: CGPoint(x: r.midX, y: r.maxY))
        }
        return p
    }

    /// The length of one lap of `edge`.
    static func perimeter(_ size: CGSize, inset: CGFloat) -> CGFloat {
        let w = max(0, size.width - 2 * inset), h = max(0, size.height - 2 * inset)
        let c = max(0, min(corner - inset, min(w, h) / 2))
        return 2 * (w + h) - 8 * c + 2 * .pi * c
    }

    func resize(_ new: CGSize, scale newScale: CGFloat) {
        guard new != size || newScale != scale else { return }
        size = new; scale = newScale
        noActions {
            layer.frame = CGRect(origin: .zero, size: new)
            scrim.frame = layer.bounds
            let edge = Self.edge(new, inset: 1.25)
            rim.path = edge
            glow.path = edge
            glow.shadowPath = edge.copy(strokingWithWidth: 6, lineCap: .round, lineJoin: .round, miterLimit: 1)
            let twice = Self.edge(new, inset: 1.5, laps: 2)
            light.forEach { $0.path = twice }
            for l in [rim, glow] + light { l.contentsScale = newScale }
            layoutPills()
        }
        if isShown, let look, !look.still { startTravel() }
    }

    // MARK: look

    func apply(_ new: VeilLook, size: CGSize, scale: CGFloat) {
        let changedMotion = look?.still != new.still
        look = new
        resize(size, scale: scale)
        guard let lead = new.agents.first else { return }
        let status = lead.statusColor
        noActions {
            scrim.backgroundColor = Self.color(status, alpha: 0.07)
            scrim.isHidden = new.solid
            rim.strokeColor = Self.color(status, alpha: new.still ? 1 : 0.85)
            rim.lineWidth = 2.5
            glow.strokeColor = Self.color(status, alpha: 0.28)
            glow.lineWidth = 6
            glow.shadowColor = Self.color(status)
            glow.shadowOpacity = new.solid ? 0 : 0.8
            glow.shadowRadius = 10
            glow.shadowOffset = .zero
            for (l, s) in zip(light, Self.strokes) {
                // The head is white, so the light shows whatever the agent's hue (two of them are white and near black).
                l.strokeColor = l === light.last ? CGColor(gray: 1, alpha: 1) : Self.color(lead.identity, alpha: s.alpha)
                l.lineWidth = s.width
                l.isHidden = new.still
            }
            buildPills(new)
        }
        if new.still { stopTravel() } else if isShown && (changedMotion || light[0].animation(forKey: Self.travelKey) == nil) { startTravel() }
    }

    // MARK: the pill

    private func buildPills(_ look: VeilLook) {
        pills.sublayers?.forEach { $0.removeFromSuperlayer() }
        let shown = Array(look.agents.prefix(VeilLook.maxPills))
        let extra = look.agents.count - shown.count
        for a in shown { pills.addSublayer(pill(text: a.label, fill: a.statusColor, dot: a.identity, solid: look.solid, pulse: !look.still && a.status == .working)) }
        if extra > 0 { pills.addSublayer(pill(text: "+\(extra)", fill: RGB(r: 0.2, g: 0.2, b: 0.2), dot: nil, solid: look.solid, pulse: false)) }
        layoutPills()
    }

    private func pill(text: String, fill: RGB, dot: RGB?, solid: Bool, pulse: Bool) -> CALayer {
        let font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
        let textSize = (text as NSString).size(withAttributes: [.font: font])
        let dotSpace: CGFloat = dot == nil ? 0 : 14
        let h: CGFloat = 24, w = ceil(textSize.width) + 20 + dotSpace
        let shape = CAShapeLayer()
        let rect = CGRect(x: 0, y: 0, width: w, height: h)
        shape.bounds = rect
        shape.anchorPoint = .zero
        shape.path = CGPath(roundedRect: rect, cornerWidth: h / 2, cornerHeight: h / 2, transform: nil)
        shape.fillColor = Self.color(fill, alpha: solid ? 1 : 0.94)
        shape.strokeColor = CGColor(gray: 1, alpha: 0.85)
        shape.lineWidth = 1
        shape.shadowPath = shape.path
        shape.shadowColor = CGColor(gray: 0, alpha: 1)
        shape.shadowOpacity = 0.28
        shape.shadowRadius = 6
        shape.shadowOffset = CGSize(width: 0, height: -2)
        shape.contentsScale = scale
        if let dot {
            let d = CAShapeLayer()
            d.path = CGPath(ellipseIn: CGRect(x: 11, y: h / 2 - 3.5, width: 7, height: 7), transform: nil)
            d.fillColor = Self.color(dot)
            d.strokeColor = CGColor(gray: 1, alpha: 0.8)
            d.lineWidth = 0.75
            d.contentsScale = scale
            shape.addSublayer(d)
            if pulse {
                let a = CABasicAnimation(keyPath: "opacity")
                a.fromValue = 1; a.toValue = 0.35; a.duration = 0.9
                a.autoreverses = true; a.repeatCount = .infinity
                a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                d.add(a, forKey: Self.pulseKey)
            }
        }
        let t = CATextLayer()
        t.string = text
        t.font = font
        t.fontSize = 11.5
        t.alignmentMode = .left
        t.truncationMode = .end
        t.contentsScale = scale
        t.foregroundColor = fill.contrastWithWhite >= 3 ? CGColor(gray: 1, alpha: 1) : CGColor(gray: 0, alpha: 0.88)
        t.frame = CGRect(x: 10 + dotSpace, y: (h - ceil(textSize.height)) / 2, width: ceil(textSize.width) + 2, height: ceil(textSize.height))
        shape.addSublayer(t)
        return shape
    }

    /// The pills in a row, centered near the top of the window, inside it.
    private func layoutPills() {
        let items = pills.sublayers ?? []
        let gap: CGFloat = 6
        let total = items.reduce(0) { $0 + $1.bounds.width } + gap * CGFloat(max(0, items.count - 1))
        var x = max(8, (size.width - total) / 2)
        let y = size.height - 10 - 24
        for l in items {
            l.position = CGPoint(x: x, y: y)
            x += l.bounds.width + gap
        }
    }

    // MARK: travel

    private func startTravel() {
        let lap = Self.perimeter(size, inset: 1.5)
        guard lap > 0 else { return }
        let duration = CFTimeInterval(min(7, max(2.5, lap / Self.travelSpeed)))
        let longest = Self.strokes.map(\.length).max() ?? 0
        // On a path twice around, the head goes from just past the start through one full lap and starts over unseen.
        let head = min(0.5, longest / lap / 2)
        let begin = CACurrentMediaTime()
        for (l, s) in zip(light, Self.strokes) {
            let tail = head - min(0.5, s.length / lap / 2)
            let end = CABasicAnimation(keyPath: "strokeEnd")
            end.fromValue = head; end.toValue = head + 0.5
            let start = CABasicAnimation(keyPath: "strokeStart")
            start.fromValue = tail; start.toValue = tail + 0.5
            let group = CAAnimationGroup()
            group.animations = [start, end]
            group.duration = duration
            group.repeatCount = .infinity
            group.timingFunction = CAMediaTimingFunction(name: .linear)
            group.beginTime = begin
            group.isRemovedOnCompletion = false
            noActions { l.strokeStart = tail; l.strokeEnd = head }
            l.add(group, forKey: Self.travelKey)
        }
    }

    private func stopTravel() { light.forEach { $0.removeAnimation(forKey: Self.travelKey) } }

    /// For checks: the animations that move something (the travel and the pulse), none under Reduce Motion.
    var motionAnimationKeys: [String] {
        let layers: [CALayer] = light + (pills.sublayers ?? []).flatMap { $0.sublayers ?? [] }
        return layers.flatMap { $0.animationKeys() ?? [] }.filter { $0 != Self.fadeKey }
    }

    var pillCount: Int { pills.sublayers?.count ?? 0 }
    var scrimShown: Bool { !scrim.isHidden }

    // MARK: showing

    func show() {
        guard !isShown else { return }
        isShown = true
        let from = layer.presentation()?.opacity ?? 0
        noActions { layer.opacity = 1 }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = from; fade.toValue = 1; fade.duration = Self.fadeIn
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(fade, forKey: Self.fadeKey)
        if let look, !look.still { startTravel() }
    }

    func hide() {
        guard isShown else { return }
        isShown = false
        let from = layer.presentation()?.opacity ?? 1
        noActions { layer.opacity = 0 }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = from; fade.toValue = 0; fade.duration = Self.fadeOut
        fade.timingFunction = CAMediaTimingFunction(name: .easeIn)
        CATransaction.begin()
        // Once it has faded, nothing keeps animating out of sight.
        CATransaction.setCompletionBlock { [weak self] in
            guard let self, !self.isShown else { return }
            self.stopTravel()
            (self.pills.sublayers ?? []).flatMap { $0.sublayers ?? [] }.forEach { $0.removeAnimation(forKey: Self.pulseKey) }
        }
        layer.add(fade, forKey: Self.fadeKey)
        CATransaction.commit()
    }
}
