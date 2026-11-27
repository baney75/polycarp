import Foundation

/// The bar's battery as macOS draws its own in the menu bar (`battery.100percent` at the bar's 13 pt): a hairline body
/// about 23 by 11 with round corners, a small nub, and a fill inset inside it. Every measure is in points.
public enum BatteryGlyphSpec {
    /// The body, without the nub.
    public static let bodyWidth = 23.0
    public static let bodyHeight = 11.0
    /// The outline's width, drawn inside the body.
    public static let line = 1.0
    /// The body's corner radius (continuous).
    public static let radius = 3.0
    /// From the body's outer edge to the fill, on every side.
    public static let inset = 1.5
    /// The fill's corner radius, so it follows the outline.
    public static var fillRadius: Double { radius - inset }
    /// The nub on the right: a small rounded bar, centered on the body.
    public static let capWidth = 1.5
    public static let capHeight = 4.0
    public static let capGap = 1.0
    /// The whole glyph, nub included.
    public static var width: Double { bodyWidth + capGap + capWidth }
    /// The bolt's and the plug's point size, centered on the body: `bolt.fill` here is about 7.5 pt of ink tall, inside
    /// the fill's 8. It is cut out of the fill where it lies on it and drawn in ink on the empty body, with no ring.
    public static let badgeSize = 7.0
    /// The least the fill draws for any charge above zero, so 1% still shows.
    public static let leastFill = 1.5
    /// The outline's least opacity of the bar's ink, macOS's own hairline weight.
    public static let leastOutline = 0.38
    /// Non-text contrast (WCAG 1.4.11): the outline and the badge against the bar.
    public static let leastContrast = 3.0

    /// The fill's width for a charge from 0 to 1: the body inside its insets, filled to the charge; nothing at zero.
    public static func fillWidth(_ fill: Double) -> Double {
        let room = bodyWidth - 2 * inset
        let f = min(1, max(0, fill))
        return f <= 0 ? 0 : max(leastFill, room * f)
    }

    /// The outline's opacity of the ink: `leastOutline`, or more where that is under `leastContrast` against any of
    /// `backgrounds` (the theme's `background` for islands, `surface` for a solid bar). `inkAlpha` is the ink's own
    /// opacity, as the bar draws it (0.88 of the foreground). Up to 1 when even full ink can't reach it.
    public static func outlineOpacity(ink: RGB, inkAlpha: Double = 1, over backgrounds: [RGB]) -> Double {
        var a = leastOutline
        while a < 1, !backgrounds.allSatisfy({ ink.over($0, alpha: inkAlpha * a).contrast(with: $0) >= leastContrast }) {
            a = min(1, a + 0.01)
        }
        return (a * 100).rounded() / 100
    }
}
