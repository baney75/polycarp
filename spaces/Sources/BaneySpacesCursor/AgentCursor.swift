import AppKit
import BaneySpacesCore
import QuartzCore

/// One agent's cursor as Core Animation layers: the arrow and its name badge, the focus box around the target,
/// a pool of ripples, and the last few marks. Everything moves by animations the compositor runs; nothing here
/// lays out or redraws per frame. All calls are on the main thread.
final class AgentCursor {
    let id: String
    private(set) var look: CursorLook
    private(set) weak var display: CursorDisplay?
    private(set) var isShown = false
    /// Where the arrow's tip is (the hands' coordinates), for putting it back after the displays change.
    private(set) var point: CGPoint = .zero

    /// The cursor itself: its position is the arrow's tip.
    let root = CALayer()
    private let body = CAShapeLayer()
    private let vein = CAShapeLayer()
    private let badge = CAShapeLayer()
    private let badgeText = CATextLayer()
    private let badgeDot = CAShapeLayer()
    private let focus = CAShapeLayer()
    private var ripples: [CAShapeLayer] = []
    /// A mark is a container (whose opacity dims it by age) holding the shape (whose opacity is its fade).
    private var marks: [CALayer] = []
    private var markShapes: [CAShapeLayer] = []
    private var markOrder: [Int] = []   // newest first
    private var nextRipple = 0
    private var scale: CGFloat = 2

    static let tiltKey = "tilt", glideKey = "glide", fadeKey = "fade", squishKey = "squish", focusKey = "focus", rippleKey = "ripple", markKey = "mark"

    init(id: String, look: CursorLook) {
        self.id = id
        self.look = look
        root.bounds = .zero
        root.opacity = 0
        root.addSublayer(body)
        body.addSublayer(vein)
        root.addSublayer(badge)
        badge.addSublayer(badgeText)
        badge.addSublayer(badgeDot)
        focus.opacity = 0
        build(count: look.theme.markCount)
        apply(look)
    }

    private func build(count: Int) {
        ripples = (0..<2).map { _ in let l = CAShapeLayer(); l.opacity = 0; l.fillColor = nil; return l }
        markShapes = (0..<max(1, count)).map { _ in let l = CAShapeLayer(); l.opacity = 0; return l }
        marks = markShapes.map { shape in let c = CALayer(); c.bounds = .zero; c.addSublayer(shape); return c }
        markOrder = []
    }

    // MARK: attaching

    /// Puts the layers on a display's overlay (below the cursor: focus box, ripples, marks).
    func attach(to d: CursorDisplay) {
        if display === d { return }
        detach()
        display = d
        scale = d.spec.scale
        d.root.addSublayer(focus)
        ripples.forEach { d.root.addSublayer($0) }
        marks.forEach { d.root.addSublayer($0) }
        d.root.addSublayer(root)
        applyScale()
    }

    /// Takes the layers off the display. The mark shapes stay inside their containers (only the containers are on
    /// the display's root), so they are still there when the cursor is attached again.
    func detach() {
        if isShown { display?.cursorHidden(); isShown = false }
        let top: [CALayer] = [focus, root] + ripples + marks
        (top + markShapes).forEach { $0.removeAllAnimations() }
        top.forEach { $0.removeFromSuperlayer() }
        display = nil
    }

    /// For checks: whether every mark shape is inside its container and every container on the display.
    var marksAreAttached: Bool {
        guard let d = display else { return false }
        return zip(marks, markShapes).allSatisfy { $0.superlayer === d.root && $1.superlayer === $0 }
    }

    /// For checks: the animations that change a layer's size or draw a stroke in (scale, growth, squish, trail).
    var motionAnimationKeys: [String] {
        let layers: [CALayer] = [root, body, badge, focus] + ripples + markShapes
        return layers.flatMap { l in
            (l.animationKeys() ?? []).filter { key in
                let path = (l.animation(forKey: key) as? CAPropertyAnimation)?.keyPath ?? ""
                return path.hasPrefix("transform") || path == "strokeEnd"
            }
        }
    }

    private func applyScale() {
        for l in [body, vein, badge, badgeDot, focus] + ripples + markShapes { l.contentsScale = scale }
        badgeText.contentsScale = scale
    }

    // MARK: look

    func apply(_ new: CursorLook) {
        look = new
        let t = new.theme
        // Switching to still must stop scale/ripple/squish/trail already in flight (and delayed starts).
        if new.still {
            let layers: [CALayer] = [root, body, badge, focus] + ripples + markShapes
            for l in layers {
                for key in l.animationKeys() ?? [] {
                    let path = (l.animation(forKey: key) as? CAPropertyAnimation)?.keyPath ?? ""
                    if path.hasPrefix("transform") || path == "strokeEnd" {
                        l.removeAnimation(forKey: key)
                    }
                }
            }
            noActions {
                body.transform = CATransform3DIdentity
                badge.transform = CATransform3DIdentity
                focus.transform = CATransform3DIdentity
                for l in ripples + markShapes { l.transform = CATransform3DIdentity }
            }
        }
        if marks.count != max(1, t.markCount), let d = display {
            (ripples + marks).forEach { $0.removeFromSuperlayer() }
            build(count: t.markCount)
            ripples.forEach { d.root.addSublayer($0) }
            marks.forEach { d.root.addSublayer($0) }
            d.root.addSublayer(root)
            applyScale()
        }
        noActions {
            // The arrow.
            let glyph = CursorGlyphs.path(t.glyph, size: t.size)
            var flip = CGAffineTransform(scaleX: 1, y: -1)
            let path = glyph.copy(using: &flip)
            body.path = path
            body.shadowPath = path
            body.lineJoin = t.glyph == .block ? .miter : .round
            switch t.fill {
            case .status:
                body.fillColor = Self.color(new.statusColor)
                body.strokeColor = CursorGlyphs.hasWhiteEdge(t.glyph) ? CGColor(gray: 1, alpha: 1) : Self.color(new.identity)
                body.lineWidth = t.ringWidth
            case .light:
                body.fillColor = Self.color(RGB(r: 1, g: 1, b: 1))
                body.strokeColor = Self.color(RGB(r: 0, g: 0, b: 0))
                body.lineWidth = 1.3
            }
            body.shadowColor = CGColor(gray: 0, alpha: 1)
            body.shadowOpacity = Float(t.shadowOpacity)
            body.shadowRadius = t.shadowRadius
            body.shadowOffset = CGSize(width: 0, height: -2)
            var veinFlip = CGAffineTransform(scaleX: 1, y: -1)
            vein.path = CursorGlyphs.vein(t.glyph, size: t.size)?.copy(using: &veinFlip)
            vein.fillColor = nil
            vein.strokeColor = CGColor(gray: 1, alpha: 0.42)
            vein.lineWidth = 1.25
            vein.lineCap = .round
            // The badge: the agent's name on its status color.
            let font = t.badgeMonospaced ? NSFont.monospacedSystemFont(ofSize: t.badgeFontSize, weight: .semibold)
                                         : NSFont.systemFont(ofSize: t.badgeFontSize, weight: .semibold)
            let text = new.badgeText
            let textSize = (text as NSString).size(withAttributes: [.font: font])
            // The dot in the agent's own hue tells apart two agents with the same name and status. A square badge shows
            // it in its border instead.
            let dot: CGFloat = t.badgeShape == .pill ? 11 : 0
            let w = ceil(textSize.width) + 14 + dot, h = ceil(textSize.height) + 4
            let rect = CGRect(x: 0, y: 0, width: w, height: h)
            let r = min(t.badgeRadius, h / 2)
            badge.path = t.badgeShape == .square ? CGPath(rect: rect, transform: nil) : CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
            badge.bounds = rect
            badge.anchorPoint = .zero
            badge.position = CGPoint(x: t.badgeOffsetX, y: -(t.badgeOffsetY + h))
            badge.fillColor = Self.color(new.statusColor, alpha: 0.96)
            badge.strokeColor = t.badgeShape == .square ? Self.color(new.identity) : CGColor(gray: 1, alpha: 0.85)
            badge.lineWidth = t.badgeShape == .square ? 2 : 1
            badge.shadowColor = CGColor(gray: 0, alpha: 1)
            badge.shadowOpacity = Float(min(0.3, t.shadowOpacity))
            badge.shadowRadius = max(0, t.shadowRadius - 1)
            badge.shadowOffset = CGSize(width: 0, height: -1)
            badge.shadowPath = badge.path
            badgeDot.isHidden = dot == 0
            badgeDot.path = CGPath(ellipseIn: CGRect(x: 8, y: h / 2 - 3, width: 6, height: 6), transform: nil)
            badgeDot.fillColor = Self.color(new.identity)
            badgeDot.strokeColor = CGColor(gray: 1, alpha: 0.7)
            badgeDot.lineWidth = 0.75
            badgeText.string = text
            badgeText.font = font
            badgeText.fontSize = t.badgeFontSize
            badgeText.alignmentMode = .center
            badgeText.truncationMode = .end
            badgeText.frame = CGRect(x: dot, y: (h - textSize.height) / 2, width: w - dot, height: ceil(textSize.height))
            badgeText.foregroundColor = new.statusColor.contrastWithWhite >= 3 ? CGColor(gray: 1, alpha: 1) : CGColor(gray: 0, alpha: 0.88)
            // The focus box and marks take the status color too.
            focus.strokeColor = Self.color(new.statusColor, alpha: 0.95)
            focus.fillColor = Self.color(new.statusColor, alpha: 0.10)
            focus.lineWidth = t.focusWidth
            for m in ripples {
                m.strokeColor = Self.color(new.statusColor, alpha: 0.95)
                m.lineWidth = t.glyph == .dot ? 1.5 : 2
            }
            // A thin light halo, because the status colors are dark: they have to show on a dark window too.
            for l in [focus] + ripples + markShapes {
                l.shadowColor = CGColor(gray: 1, alpha: 1)
                l.shadowOpacity = 0.9
                l.shadowRadius = 1
                l.shadowOffset = .zero
            }
            for m in markShapes {
                m.fillColor = Self.color(new.statusColor, alpha: 0.95)
                m.strokeColor = CGColor(gray: 1, alpha: 0.9)
                m.lineWidth = 1
                m.lineJoin = .round; m.lineCap = .round
            }
            applyScale()
        }
    }

    static func color(_ c: RGB, alpha: CGFloat = 1) -> CGColor {
        CGColor(srgbRed: CGFloat(c.r), green: CGFloat(c.g), blue: CGFloat(c.b), alpha: alpha)
    }

    private func noActions(_ f: () -> Void) {
        CATransaction.begin(); CATransaction.setDisableActions(true); f(); CATransaction.commit()
    }

    /// A time on the layer tree's clock for a moment of the system uptime clock.
    private func layerTime(_ uptime: TimeInterval) -> CFTimeInterval {
        let skew = CACurrentMediaTime() - ProcessInfo.processInfo.systemUptime
        return root.convertTime(uptime + skew, from: nil)
    }

    // MARK: moving

    func appear(at p: CGPoint) {
        guard let d = display else { return }
        let first = !isShown
        if first { isShown = true; d.cursorShown() }
        let t = look.theme
        point = p
        noActions {
            root.position = d.local(p)
            root.opacity = 1
        }
        guard first else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0; fade.toValue = 1; fade.duration = 0.14
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        root.add(fade, forKey: Self.fadeKey)
        if t.appearScale < 1 {
            let pop = CABasicAnimation(keyPath: "transform.scale")
            pop.fromValue = t.appearScale; pop.toValue = 1; pop.duration = 0.18
            pop.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 1.1, 0.4, 1)
            body.add(pop, forKey: "pop")
        }
    }

    func jump(to p: CGPoint) {
        guard let d = display else { return }
        point = p
        root.removeAnimation(forKey: Self.glideKey)
        noActions { root.position = d.local(p) }
    }

    /// One keyframe animation from the planner's samples. The model value is the target, so when the animation ends
    /// (or a new glide replaces it) the cursor is where the plan says.
    func glide(_ m: CursorMotion) {
        guard let d = display, m.points.count > 1, m.duration > 0 else { return jump(to: m.target) }
        let anim = CAKeyframeAnimation(keyPath: "position")
        anim.values = m.points.map { NSValue(point: d.local($0)) }
        anim.keyTimes = (0..<m.points.count).map { NSNumber(value: min(1, Double($0) * m.step / m.duration)) }
        anim.calculationMode = .linear
        anim.duration = m.duration
        anim.beginTime = layerTime(m.start)
        anim.isRemovedOnCompletion = true
        point = m.target
        noActions { root.position = d.local(m.target) }
        root.add(anim, forKey: Self.glideKey)
        tilt(m)
    }

    /// The cursor leans a little into a long move and settles as it lands. It turns about its tip, which stays on the
    /// glide's path, and never with motion off.
    private func tilt(_ m: CursorMotion) {
        guard !look.still, let first = m.points.first else { return }
        let lean = CursorMotionLean.radians(dx: m.target.x - first.x, distance: hypot(m.target.x - first.x, m.target.y - first.y))
        // A new move picks up from the lean in progress, and a short hop settles it, so nothing snaps.
        let now = (body.presentation()?.value(forKeyPath: "transform.rotation.z") as? Double) ?? 0
        guard lean != 0 || now != 0 else { return }
        let a = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        // Local layers are y up, so a turn toward the right is a negative angle.
        a.values = [now, -lean, 0]
        a.keyTimes = [0, 0.35, 1]
        a.duration = m.duration
        a.beginTime = layerTime(m.start)
        a.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
        body.add(a, forKey: Self.tiltKey)
    }

    func hide() {
        guard isShown else { return }
        isShown = false
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = root.presentation()?.opacity ?? 1; fade.toValue = 0; fade.duration = 0.12
        noActions { root.opacity = 0 }
        root.add(fade, forKey: Self.fadeKey)
        for l in [focus] + ripples + markShapes { l.removeAllAnimations(); noActions { l.opacity = 0 } }
        display?.cursorHidden()
    }

    // MARK: marking an action

    func act(_ effect: CursorEffect, at p: CGPoint, frame: CGRect, delay: TimeInterval) {
        guard let d = display else { return }
        let begin = CACurrentMediaTime() + delay
        let at = root.convertTime(begin, from: nil)
        // A target smaller than 8 points is outlined at 8, so the box can be seen.
        let box = frame.insetBy(dx: -max(0, 8 - frame.width) / 2, dy: -max(0, 8 - frame.height) / 2)
        showFocus(d.local(box), delay: delay)
        let pt = d.local(p)
        switch effect {
        case .click:
            ripple(at: pt, begin: at)
            squish(begin: at)
            mark(at: pt, begin: at) { path in
                path.addEllipse(in: CGRect(x: -4, y: -4, width: 8, height: 8))
            }
        case .type:
            let h = min(max(frame.height * 0.7, 12), 22)
            mark(at: pt, begin: at, blink: true) { path in
                path.addRoundedRect(in: CGRect(x: -1.25, y: -h / 2, width: 2.5, height: h), cornerWidth: 1, cornerHeight: 1)
            }
        case .scroll(let dx, let dy):
            // Local layers are y up; the hands' directions are y down.
            let ux = CGFloat(dx), uy = CGFloat(-dy)
            mark(at: pt, begin: at, trail: true) { path in
                let len: CGFloat = 30
                let tip = CGPoint(x: ux * len, y: uy * len)
                path.move(to: .zero)
                path.addLine(to: tip)
                let nx = -uy, ny = ux
                path.move(to: CGPoint(x: tip.x - ux * 7 + nx * 5, y: tip.y - uy * 7 + ny * 5))
                path.addLine(to: tip)
                path.addLine(to: CGPoint(x: tip.x - ux * 7 - nx * 5, y: tip.y - uy * 7 - ny * 5))
            }
        }
    }

    /// A rounded outline of the target that fades in with the glide and out after the action.
    private func showFocus(_ r: CGRect, delay: TimeInterval) {
        let t = look.theme
        let rad = min(t.focusRadius, min(r.width, r.height) / 2)
        noActions {
            focus.path = CGPath(roundedRect: r, cornerWidth: rad, cornerHeight: rad, transform: nil)
            focus.opacity = 0
        }
        let hold = delay + 0.55, out = 0.28, total = hold + out
        let a = CAKeyframeAnimation(keyPath: "opacity")
        a.values = [0, 1, 1, 0]
        a.keyTimes = [0, NSNumber(value: min(0.16, delay + 0.06) / total), NSNumber(value: hold / total), 1]
        a.duration = total
        a.calculationMode = .linear
        focus.add(a, forKey: Self.focusKey)
        if t.appearScale < 1 {
            let s = CABasicAnimation(keyPath: "transform.scale")
            s.fromValue = 1.04; s.toValue = 1; s.duration = max(0.12, delay)
            s.timingFunction = CAMediaTimingFunction(name: .easeOut)
            focus.add(s, forKey: "focusScale")
        }
    }

    private func ripple(at p: CGPoint, begin: CFTimeInterval) {
        let t = look.theme
        let layer = ripples[nextRipple % ripples.count]
        nextRipple += 1
        let r = t.rippleRadius
        noActions {
            layer.path = t.rippleSquare ? CGPath(rect: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r), transform: nil)
                                        : CGPath(ellipseIn: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r), transform: nil)
            layer.position = p
            layer.opacity = 0
        }
        layer.removeAllAnimations()
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0.9, 0.0]; fade.keyTimes = [0, 1]
        var anims: [String: CAAnimation] = [Self.rippleKey: fade]
        // With motion off the ring shows at full size and only fades.
        if !look.still {
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = t.appearScale < 1 ? 0.25 : 0.5; grow.toValue = 1
            anims["grow"] = grow
        }
        for (key, a) in anims {
            a.duration = t.rippleDuration
            a.beginTime = begin
            a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.3, 1)
            layer.add(a, forKey: key)
        }
    }

    /// The press: the glyph dips and springs back, as the ripple starts.
    private func squish(begin: CFTimeInterval) {
        let t = look.theme
        guard t.squish < 1 else { return }
        let a = CAKeyframeAnimation(keyPath: "transform.scale")
        a.values = [1, t.squish, 1.05, 1]
        a.keyTimes = [0, 0.3, 0.7, 1]
        a.duration = 0.26
        a.beginTime = begin
        a.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
        body.add(a, forKey: Self.squishKey)
    }

    /// A mark at an acted point. The last `markCount` stay, the newest brightest, and each fades after `markLife`.
    private func mark(at p: CGPoint, begin: CFTimeInterval, blink: Bool = false, trail: Bool = false, draw: (CGMutablePath) -> Void) {
        let t = look.theme
        let index = marks.indices.first { !markOrder.contains($0) } ?? markOrder.removeLast()
        markOrder.removeAll { $0 == index }
        markOrder.insert(index, at: 0)
        let container = marks[index], layer = markShapes[index]
        let path = CGMutablePath()
        draw(path)
        layer.removeAllAnimations()
        noActions {
            layer.path = path
            container.position = p
            layer.opacity = 0
            layer.fillColor = trail ? nil : Self.color(look.statusColor, alpha: 0.95)
            layer.strokeColor = trail ? Self.color(look.statusColor, alpha: 0.95) : CGColor(gray: 1, alpha: 0.9)
            layer.lineWidth = trail ? 2.5 : 1
            // Older marks dim, so a watcher can follow the order.
            for (rank, i) in markOrder.enumerated() { marks[i].opacity = rank == 0 ? 1 : rank == 1 ? 0.6 : 0.35 }
        }
        let life = t.markLife
        let a = CAKeyframeAnimation(keyPath: "opacity")
        if blink {
            a.values = [0, 1, 0.15, 1, 0.15, 1, 0]
            a.keyTimes = [0, 0.04, 0.2, 0.36, 0.52, 0.68, 1]
        } else {
            a.values = [0, 1, 1, 0]
            a.keyTimes = [0, 0.05, 0.62, 1]
        }
        a.duration = life
        a.beginTime = begin
        layer.add(a, forKey: Self.markKey)
        if trail && !look.still {
            let draw = CABasicAnimation(keyPath: "strokeEnd")
            draw.fromValue = 0; draw.toValue = 1; draw.duration = 0.18
            draw.beginTime = begin
            draw.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(draw, forKey: "trail")
        }
    }
}
