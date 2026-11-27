import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Polycarp's app icon, and Polycarp Browser's, in the colors of the theme in force: the olive branch of
/// `brand/mark.svg` (`brand/mark-small.svg` below 48 px) on the rounded square of `brand/icon-macos.svg`. One
/// drawing for both apps, so they always match. Without a theme it is the brand's own icon, Cream on Vine green.
public enum ThemeIcon {
    public struct Colors: Equatable, Sendable {
        public let background: RGB
        public let mark: RGB

        public init(background: RGB, mark: RGB) {
            self.background = background
            self.mark = mark
        }
    }

    /// Vine green and Cream (brand/README.md), the icon Polycarp ships with.
    public static let brand = Colors(background: RGB(hex: "#59693F")!, mark: RGB(hex: "#F6F3E8")!)

    /// What a mark needs against its background (WCAG, for graphics).
    public static let minimumContrast = 3.0

    /// The first pair that reads: the accent with the text on it, then the surface with the accent, then the
    /// surface with the text. A theme with none of them, or no theme, has the brand's icon.
    public static func colors(roles: [String: RGB], onAccent: RGB?) -> Colors {
        let pairs: [(RGB?, RGB?)] = [
            (roles["accent"], onAccent ?? roles["on_accent"]),
            (roles["surface"], roles["accent"]),
            (roles["surface"], roles["foreground"]),
        ]
        for case let (background?, mark?) in pairs where background.contrast(with: mark) >= minimumContrast {
            return Colors(background: background, mark: mark)
        }
        return brand
    }

    public static func colors(_ theme: PolycarpTheme?, systemDark: Bool) -> Colors {
        guard let theme else { return brand }
        let mode = theme.colors(systemDark: systemDark)
        return colors(roles: mode.roles, onAccent: mode.onAccent)
    }

    /// The icon `pixels` wide and high.
    public static func image(_ colors: Colors, pixels: Int) -> CGImage? {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        guard pixels > 0, let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        let s = CGFloat(pixels)
        // Drawn in the SVGs' own units, 1024 to the side with y going down.
        context.translateBy(x: 0, y: s)
        context.scaleBy(x: s / 1024, y: -s / 1024)
        context.setShouldAntialias(true)
        func color(_ c: RGB) -> CGColor { CGColor(colorSpace: space, components: [c.r, c.g, c.b, 1])! }
        // brand/icon-macos.svg: the macOS grid's margin of 100 and corners of 186.
        context.addPath(CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 186, cornerHeight: 186, transform: nil))
        context.setFillColor(color(colors.background))
        context.fillPath()
        // The mark's 64-unit box is 700 wide, 162 in from each edge.
        context.translateBy(x: 162, y: 162)
        context.scaleBy(x: 700 / 64, y: 700 / 64)
        context.setFillColor(color(colors.mark))
        context.setStrokeColor(color(colors.mark))
        (pixels < 48 ? Mark.small : Mark.full).draw(in: context)
        return context.makeImage()
    }

    public static func png(_ colors: Colors, pixels: Int) -> Data? {
        guard let image = image(colors, pixels: pixels) else { return nil }
        let data = NSMutableData()
        guard let out = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(out, image, nil)
        return CGImageDestinationFinalize(out) ? data as Data : nil
    }

    /// The sizes an app's .icns holds, by the type each is stored under: 16 to 512 points at 1x and 2x.
    static let icnsTypes: [(String, Int)] = [
        ("icp4", 16), ("ic11", 32), ("icp5", 32), ("ic12", 64), ("ic07", 128),
        ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024),
    ]

    /// An .icns file: `icns`, its length, then each size as a PNG under its type.
    public static func icns(_ colors: Colors) -> Data? {
        var drawn: [Int: Data] = [:]
        var body = Data()
        for (type, pixels) in icnsTypes {
            guard let png = drawn[pixels] ?? png(colors, pixels: pixels) else { return nil }
            drawn[pixels] = png
            body.append(contentsOf: Array(type.utf8))
            body.append(bigEndian(UInt32(png.count + 8)))
            body.append(png)
        }
        var file = Data("icns".utf8)
        file.append(bigEndian(UInt32(body.count + 8)))
        file.append(body)
        return file
    }

    /// Keeps `file` holding `wanted`, or gone when it is nil: Polycarp Browser's icon beside its theme, which
    /// `polycarp browser update` builds in. True when the file changed, so the browser needs building again.
    public static func syncFile(_ wanted: Data?, at file: URL) -> Bool {
        let fm = FileManager.default
        let now = try? Data(contentsOf: file)
        guard now != wanted else { return false }
        guard let wanted else {
            try? fm.removeItem(at: file)
            return true
        }
        do {
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try wanted.write(to: file, options: .atomic)
            return true
        } catch { return false }
    }

    private static func bigEndian(_ n: UInt32) -> Data {
        withUnsafeBytes(of: n.bigEndian) { Data($0) }
    }

    /// The two olive branches, from the brand's SVGs, in their 64-unit box.
    enum Mark {
        case full, small

        func draw(in context: CGContext) {
            func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat, degrees: CGFloat) -> CGPath {
                var turn = CGAffineTransform(translationX: cx, y: cy).rotated(by: degrees * .pi / 180)
                return CGPath(ellipseIn: CGRect(x: -rx, y: -ry, width: 2 * rx, height: 2 * ry), transform: &turn)
            }
            func stroke(_ path: CGPath, width: CGFloat, cap: CGLineCap) {
                context.addPath(path)
                context.setLineWidth(width)
                context.setLineCap(cap)
                context.strokePath()
            }
            func fill(_ path: CGPath) {
                context.addPath(path)
                context.fillPath()
            }
            switch self {
            case .full:
                stroke(curve((10, 56), (20, 48), (33, 35), (45, 19)), width: 3.2, cap: .round)
                fill(leaves([
                    [(45.0, 19.0), (51.4, 17.6), (53.2, 11.2), (52.0, 5.8), (46.9, 7.8), (42.6, 12.9), (45.0, 19.0)],
                    [(40.0, 25.5), (42.9, 19.8), (39.2, 14.2), (34.4, 11.6), (32.7, 16.8), (34.0, 23.4), (40.0, 25.5)],
                    [(38.0, 27.5), (43.8, 31.0), (50.7, 27.9), (54.5, 23.4), (49.0, 21.2), (41.5, 21.7), (38.0, 27.5)],
                    [(28.0, 38.0), (30.1, 32.1), (25.9, 26.9), (21.0, 24.8), (20.0, 30.0), (22.0, 36.5), (28.0, 38.0)],
                ]))
                fill(ellipse(40, 44, 6.6, 8.4, degrees: -14))
                fill(ellipse(22, 54, 5.8, 7.4, degrees: -14))
                let stalks = CGMutablePath()
                stalks.addPath(curve((32.5, 33), (35, 34.5), (37, 35.5), (38.5, 36.5)))
                stalks.addPath(curve((16.5, 51), (18, 50.5), (19.5, 49), (20.5, 47.5)))
                stroke(stalks, width: 2, cap: .butt)
            case .small:
                stroke(curve((8, 58), (20, 49), (33, 36), (42, 23)), width: 5.4, cap: .round)
                fill(leaves([
                    [(42.0, 23.0), (52.4, 21.9), (55.8, 12.1), (54.2, 3.5), (45.8, 5.8), (38.5, 13.2), (42.0, 23.0)],
                    [(35.0, 31.5), (40.6, 23.5), (36.2, 14.1), (29.4, 9.2), (25.8, 16.7), (26.3, 27.0), (35.0, 31.5)],
                    [(39.0, 27.0), (45.8, 33.1), (54.7, 29.9), (59.8, 24.1), (53.3, 19.9), (43.8, 19.2), (39.0, 27.0)],
                ]))
                fill(ellipse(29, 52, 9.2, 10.6, degrees: -12))
            }
        }

        private func curve(_ a: (CGFloat, CGFloat), _ c1: (CGFloat, CGFloat), _ c2: (CGFloat, CGFloat), _ b: (CGFloat, CGFloat)) -> CGPath {
            let path = CGMutablePath()
            path.move(to: CGPoint(x: a.0, y: a.1))
            path.addCurve(to: CGPoint(x: b.0, y: b.1), control1: CGPoint(x: c1.0, y: c1.1), control2: CGPoint(x: c2.0, y: c2.1))
            return path
        }

        /// Each leaf: a start, two curves out to the tip and back (control, control, end each).
        private func leaves(_ all: [[(CGFloat, CGFloat)]]) -> CGPath {
            let path = CGMutablePath()
            for p in all {
                path.move(to: CGPoint(x: p[0].0, y: p[0].1))
                path.addCurve(to: CGPoint(x: p[3].0, y: p[3].1), control1: CGPoint(x: p[1].0, y: p[1].1), control2: CGPoint(x: p[2].0, y: p[2].1))
                path.addCurve(to: CGPoint(x: p[6].0, y: p[6].1), control1: CGPoint(x: p[4].0, y: p[4].1), control2: CGPoint(x: p[5].0, y: p[5].1))
                path.closeSubpath()
            }
            return path
        }
    }
}
