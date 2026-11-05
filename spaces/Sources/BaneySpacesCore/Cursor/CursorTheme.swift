import CoreGraphics
import Foundation

/// How an agent's cursor looks and moves. A theme is shape, size and motion, drawn with Core Animation layers
/// (no Lottie, no images). Colors are the cursor's own and never the palette's, so agent activity is never
/// mistaken for yours (spec/themes.md): the glyph takes its agent's status color.
public struct CursorTheme: Equatable, Codable, Sendable {
    public enum Glyph: String, Codable, Sendable {
        case leaf, pointer, classic, dot, block

        /// `arrow` was the default glyph's name before the leaf; a theme that still says it gets the pointer.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = raw == "arrow" ? .pointer : (Glyph(rawValue: raw) ?? .leaf)
        }
    }
    public enum BadgeShape: String, Codable, Sendable { case pill, square }
    public enum Fill: String, Codable, Sendable {
        /// The agent's status color.
        case status
        /// White with a black edge (the macOS look); the badge carries the status color.
        case light
    }

    public var name: String
    public var glyph: Glyph
    public var fill: Fill
    /// The glyph's height in points (a dot's diameter).
    public var size: Double
    /// Width of the ring in the agent's identity color around the glyph.
    public var ringWidth: Double
    public var shadowRadius: Double
    public var shadowOpacity: Double
    public var badgeShape: BadgeShape
    public var badgeRadius: Double
    public var badgeFontSize: Double
    public var badgeMonospaced: Bool
    /// Badge position from the tip, y down.
    public var badgeOffsetX: Double
    public var badgeOffsetY: Double
    public var rippleRadius: Double
    public var rippleDuration: Double
    public var rippleSquare: Bool
    /// The glyph's scale at the bottom of a press; 1 means no squish.
    public var squish: Double
    /// Fade and appear animations scale from this; 1 means fades only.
    public var appearScale: Double
    public var focusRadius: Double
    public var focusWidth: Double
    /// How many marks stay on screen, and for how long (seconds) the newest stays.
    public var markCount: Int
    public var markLife: Double

    public static let defaultName = "default"

    /// The olive leaf: Polycarp's own cursor, with its point at the target.
    public static let standard = CursorTheme(
        name: "default", glyph: .leaf, fill: .status, size: 22, ringWidth: 2, shadowRadius: 6, shadowOpacity: 0.32,
        badgeShape: .pill, badgeRadius: 11, badgeFontSize: 11.5, badgeMonospaced: false, badgeOffsetX: 20, badgeOffsetY: 22,
        rippleRadius: 28, rippleDuration: 0.5, rippleSquare: false, squish: 0.82, appearScale: 0.6,
        focusRadius: 6, focusWidth: 2, markCount: 3, markLife: 1.6)

    /// A soft rounded pointer.
    public static let pointer = CursorTheme(
        name: "pointer", glyph: .pointer, fill: .status, size: 22, ringWidth: 2, shadowRadius: 6, shadowOpacity: 0.32,
        badgeShape: .pill, badgeRadius: 11, badgeFontSize: 11.5, badgeMonospaced: false, badgeOffsetX: 18, badgeOffsetY: 24,
        rippleRadius: 28, rippleDuration: 0.5, rippleSquare: false, squish: 0.82, appearScale: 0.6,
        focusRadius: 6, focusWidth: 2, markCount: 3, markLife: 1.6)

    /// A small dot and its badge.
    public static let minimal = CursorTheme(
        name: "minimal", glyph: .dot, fill: .status, size: 10, ringWidth: 1.5, shadowRadius: 2, shadowOpacity: 0.3,
        badgeShape: .pill, badgeRadius: 6, badgeFontSize: 10, badgeMonospaced: false, badgeOffsetX: 9, badgeOffsetY: 9,
        rippleRadius: 18, rippleDuration: 0.35, rippleSquare: false, squish: 0.75, appearScale: 0.5,
        focusRadius: 4, focusWidth: 1.5, markCount: 3, markLife: 1.2)

    /// The macOS arrow: white with a black edge.
    public static let classic = CursorTheme(
        name: "classic", glyph: .classic, fill: .light, size: 24, ringWidth: 0, shadowRadius: 3, shadowOpacity: 0.4,
        badgeShape: .pill, badgeRadius: 7, badgeFontSize: 11, badgeMonospaced: false, badgeOffsetX: 14, badgeOffsetY: 22,
        rippleRadius: 26, rippleDuration: 0.4, rippleSquare: false, squish: 0.85, appearScale: 0.7,
        focusRadius: 6, focusWidth: 2, markCount: 3, markLife: 1.5)

    /// Blocky like Omarchy: square corners, a square badge, a monospace font, fades only.
    public static let omarchy = CursorTheme(
        name: "omarchy", glyph: .block, fill: .status, size: 24, ringWidth: 2, shadowRadius: 0, shadowOpacity: 0,
        badgeShape: .square, badgeRadius: 0, badgeFontSize: 11, badgeMonospaced: true, badgeOffsetX: 16, badgeOffsetY: 24,
        rippleRadius: 24, rippleDuration: 0.3, rippleSquare: true, squish: 1, appearScale: 1,
        focusRadius: 0, focusWidth: 2, markCount: 3, markLife: 1.2)

    public static let builtIn: [CursorTheme] = [standard, pointer, minimal, classic, omarchy]
    public static var names: [String] { builtIn.map(\.name) }

    /// A built-in theme by name, ignoring case; nil for an unknown name.
    public static func named(_ name: String) -> CursorTheme? {
        builtIn.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }
}

/// The cursor's colors. Fixed, so nothing the person picks for the dock or the palette recolors an agent.
public enum CursorPalette {
    /// Status colors from the Polycarp brand: working vine, asking amber, failed deep clay, finished still water. White text
    /// reads on each at 4.5:1 or better, and the white edge keeps them visible on any background. Failed is darker than
    /// working, not only redder, so they differ for red-green color blindness; the badge also says it in text.
    public static func status(_ s: DockAgent.State) -> RGB {
        switch s {
        case .working: return RGB(r: 0x4F / 255, g: 0x6B / 255, b: 0x3A / 255)
        case .asking: return RGB(r: 0x85 / 255, g: 0x6A / 255, b: 0x29 / 255)
        case .failed: return RGB(r: 0x7F / 255, g: 0x26 / 255, b: 0x22 / 255)
        case .done: return RGB(r: 0x3F / 255, g: 0x6B / 255, b: 0x6A / 255)
        }
    }

    /// Eight calm hues for telling two agents with the same status apart: the dot in the name badge.
    public static let identity: [RGB] = [
        RGB(r: 1, g: 1, b: 1), RGB(r: 0.17, g: 0.18, b: 0.15), RGB(r: 0.52, g: 0.40, b: 0.62), RGB(r: 0.45, g: 0.72, b: 0.72),
        RGB(r: 0.82, g: 0.56, b: 0.60), RGB(r: 0.66, g: 0.76, b: 0.52), RGB(r: 0.62, g: 0.61, b: 0.56), RGB(r: 0.90, g: 0.76, b: 0.42),
    ]

    /// The same agent always gets the same hue (FNV-1a, not Swift's per-launch hash).
    public static func identityColor(for agent: String) -> RGB {
        var h: UInt64 = 0xcbf29ce484222325
        for b in agent.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return identity[Int(h % UInt64(identity.count))]
    }
}

/// Everything the renderer needs to draw one agent's cursor.
public struct CursorLook: Equatable, Sendable {
    public var name: String
    public var status: DockAgent.State
    public var identity: RGB
    public var theme: CursorTheme
    /// Motion is off (Reduce Motion, or a glide preset of `off`): nothing scales, grows or squishes, so the theme's
    /// `appearScale` and `squish` are 1 and the ripple and scroll trail appear at full size (spec/config.md).
    public var still: Bool
    public init(name: String, status: DockAgent.State, identity: RGB, theme: CursorTheme, still: Bool = false) {
        self.name = name; self.status = status; self.identity = identity; self.still = still
        var t = theme
        if still { t.appearScale = 1; t.squish = 1 }
        self.theme = t
    }
    public var statusColor: RGB { CursorPalette.status(status) }
    /// The badge's words. Every status but working has a mark too, because a color alone isn't enough for everyone.
    public var badgeText: String {
        switch status {
        case .asking: return "? " + name
        case .failed: return "! " + name
        case .done: return "✓ " + name
        case .working: return name
        }
    }
}

/// The glyph outlines, tip at the origin, y pointing down (the renderer flips them for AppKit).
public enum CursorGlyphs {
    public static func path(_ glyph: CursorTheme.Glyph, size s: Double) -> CGPath {
        switch glyph {
        case .leaf: return leaf(s)
        case .pointer: return rounded([(0, 0), (0.25, 0.93), (0.40, 0.54), (0.90, 0.36)], radii: [0, 0.09, 0.05, 0.09], size: s)
        case .classic:
            return rounded([(0, 0), (0, 0.84), (0.19, 0.66), (0.31, 0.95), (0.43, 0.89), (0.31, 0.62), (0.56, 0.62)],
                           radii: [0, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03], size: s)
        case .block:
            let p = CGMutablePath()
            let pts = [(0.0, 0.0), (0, 1.0), (0.30, 0.72), (0.52, 1.0), (0.66, 0.92), (0.44, 0.64), (0.74, 0.64)]
            p.addLines(between: pts.map { CGPoint(x: $0.0 * s, y: $0.1 * s) })
            p.closeSubpath()
            return p
        case .dot:
            let p = CGMutablePath()
            p.addEllipse(in: CGRect(x: -s / 2, y: -s / 2, width: s, height: s))
            return p
        }
    }

    /// The center line drawn on a glyph that has one (the leaf's vein).
    public static func vein(_ glyph: CursorTheme.Glyph, size s: Double) -> CGPath? {
        guard glyph == .leaf else { return nil }
        // Drawn in the leaf's own unfitted coordinates and then moved and scaled by the very transform the leaf gets,
        // so the vein stays on the leaf's axis whatever the size.
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 0.17 * s, y: 0.17 * s))
        p.addLine(to: CGPoint(x: 0.60 * s, y: 0.60 * s))
        var t = leafFit(size: s)
        return p.copy(using: &t) ?? p
    }

    /// The move and scale that fit the leaf to `size`: what `leaf` applies, shared with the vein.
    public static func leafFit(size s: Double) -> CGAffineTransform { fit(of: leafOutline(s), size: s) }

    /// Whether the glyph has a white edge, so it shows on any background, instead of an edge in the agent's identity color.
    public static func hasWhiteEdge(_ glyph: CursorTheme.Glyph) -> Bool { glyph != .block && glyph != .classic }

    private static func leaf(_ s: Double) -> CGPath { fitted(leafOutline(s), size: s) }

    /// The leaf before it is fitted.
    private static func leafOutline(_ s: Double) -> CGPath {
        func at(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * s, y: y * s) }
        let p = CGMutablePath()
        p.move(to: .zero)
        p.addCurve(to: at(0.62, 0.92), control1: at(0.02, 0.52), control2: at(0.22, 0.90))
        p.addCurve(to: at(0.92, 0.62), control1: at(0.82, 0.93), control2: at(0.93, 0.82))
        p.addCurve(to: .zero, control1: at(0.90, 0.22), control2: at(0.52, 0.02))
        p.closeSubpath()
        return p
    }

    /// Moved so the tip sits exactly on the origin (the point an agent acts on is where the cursor's tip is), and scaled
    /// so the glyph is `size` tall, as `CursorTheme.size` says.
    private static func fitted(_ p: CGPath, size s: Double) -> CGPath {
        var t = fit(of: p, size: s)
        return p.copy(using: &t) ?? p
    }

    private static func fit(of p: CGPath, size s: Double) -> CGAffineTransform {
        let box = p.boundingBoxOfPath
        guard box.height > 0 else { return .identity }
        let k = CGFloat(s) / box.height
        return CGAffineTransform(scaleX: k, y: k).translatedBy(x: -box.minX, y: -box.minY)
    }

    /// A polygon with rounded corners. The tip (the first point) has no radius: it is the action point, and the
    /// glyph's round line join softens it on screen.
    private static func rounded(_ pts: [(Double, Double)], radii: [Double], size s: Double) -> CGPath {
        let q = pts.map { CGPoint(x: $0.0 * s, y: $0.1 * s) }
        let p = CGMutablePath()
        p.move(to: q[0])
        for i in 1..<q.count {
            p.addArc(tangent1End: q[i], tangent2End: q[(i + 1) % q.count], radius: radii[i] * s)
        }
        p.closeSubpath()
        return fitted(p, size: s)
    }
}
