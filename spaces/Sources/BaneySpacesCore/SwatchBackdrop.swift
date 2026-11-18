import Foundation

/// What a row of color swatches sits on must match the page. In dark mode the workspace colors in Settings > Appearance sat
/// in a white box, because each was an `NSColorWell` drawing its own light bezel (gap X1). The render check
/// (`BANEYSPACES_RENDER_SWATCHES=1`, `scripts/swatch-check.sh`) samples the pixels around and between the swatches with this.
public enum SwatchBackdrop {
    /// Relative luminance (WCAG) at or above which a pixel on a dark page reads as white. A dark page is about 0.03, the
    /// muted text about 0.3, and the white box was 0.9 and up.
    public static let nearWhite = 0.6
    /// The share of sampled pixels that may be near-white: anti-aliased edges, never a box.
    public static let allowedShare = 0.02
    /// Pixels kept clear around each swatch, so its own border and focus ring aren't counted.
    public static let ring = 3

    public struct Rect: Equatable, Sendable {
        public var x, y, width, height: Int
        public init(x: Int, y: Int, width: Int, height: Int) { self.x = x; self.y = y; self.width = width; self.height = height }
        func contains(_ px: Int, _ py: Int) -> Bool { px >= x && px < x + width && py >= y && py < y + height }
        func grown(_ by: Int) -> Rect { Rect(x: x - by, y: y - by, width: width + 2 * by, height: height + 2 * by) }
    }

    public struct Result: Equatable, Sendable {
        public let sampled: Int
        public let light: Int
        public var share: Double { sampled == 0 ? 1 : Double(light) / Double(sampled) }
        /// Nothing sampled is a failure too: the swatches weren't found.
        public var passes: Bool { sampled > 0 && share <= SwatchBackdrop.allowedShare }
    }

    /// A pixel as seen over white. The color wells didn't paint white: they left a see-through hole in the pane (alpha 0 from
    /// x 454 to 1354 in main's 2x render), which every image viewer, and a light desktop, shows as white.
    public static func overWhite(_ c: RGB, alpha: Double) -> RGB {
        RGB(r: c.r * alpha + (1 - alpha), g: c.g * alpha + (1 - alpha), b: c.b * alpha + (1 - alpha))
    }

    public static func luminance(_ c: RGB) -> Double {
        func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
    }

    /// The band holding `swatches` (their bounds grown by `margin` pixels), less each swatch and its ring, in an image
    /// `width` by `height` whose pixel `(x, y)` (top-left origin) is `pixel(x, y)`.
    public static func sample(width: Int, height: Int, swatches: [Rect], margin: Int = 8, pixel: (Int, Int) -> RGB) -> Result {
        guard let first = swatches.first else { return Result(sampled: 0, light: 0) }
        var minX = first.x, minY = first.y, maxX = first.x + first.width, maxY = first.y + first.height
        for s in swatches { minX = min(minX, s.x); minY = min(minY, s.y); maxX = max(maxX, s.x + s.width); maxY = max(maxY, s.y + s.height) }
        let keepOut = swatches.map { $0.grown(ring) }
        var sampled = 0, light = 0
        for y in max(0, minY - margin)..<min(height, maxY + margin) {
            for x in max(0, minX - margin)..<min(width, maxX + margin) where !keepOut.contains(where: { $0.contains(x, y) }) {
                sampled += 1
                if luminance(pixel(x, y)) >= nearWhite { light += 1 }
            }
        }
        return Result(sampled: sampled, light: light)
    }

    /// The line the render check prints and `swatch-check.sh` reads.
    public static func report(_ r: Result, swatches: Int, dark: Bool) -> String {
        let pct = String(format: "%.1f", r.share * 100)
        return "swatch check: \(dark ? "dark" : "NOT DARK"), \(swatches) swatches, \(r.sampled) pixels around them, \(r.light) near-white (\(pct)%, limit \(Int(allowedShare * 100))%) "
            + (r.passes && dark ? "PASS" : "FAIL")
    }
}
