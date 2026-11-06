import CoreGraphics

/// Silas's mark: a fountain pen nib (the cap bar, the nib, its centre slit and the two side slots), drawn as vectors on a 44 by
/// 44 grid with y pointing down. It follows the silhouette of `voice/src-tauri/icons/tray@2x.png`, redrawn so it stays crisp at
/// any size. Fill it with the even-odd rule: the slit and the slots are cut out of the nib. No colors here; the caller chooses.
public enum SilasMarkGeometry {
    public static let grid: CGFloat = 44

    public static func pen() -> CGPath {
        let p = CGMutablePath()
        // The cap bar.
        p.addRoundedRect(in: CGRect(x: 14.5, y: 8, width: 15, height: 5.5), cornerWidth: 0.7, cornerHeight: 0.7)
        // The nib: flat top, straight shoulders, then a taper to the tip.
        p.addLines(between: [CGPoint(x: 12.4, y: 15.6), CGPoint(x: 31.6, y: 15.6), CGPoint(x: 31.9, y: 17.6), CGPoint(x: 31.9, y: 23.5),
                             CGPoint(x: 23.4, y: 38.6), CGPoint(x: 20.6, y: 38.6), CGPoint(x: 12.1, y: 23.5), CGPoint(x: 12.1, y: 17.6)])
        p.closeSubpath()
        // The centre slit, cut through the whole nib.
        p.addRect(CGRect(x: 20.55, y: 15.6, width: 2.9, height: 23))
        // The two side slots.
        p.addRoundedRect(in: CGRect(x: 16, y: 18.6, width: 2.7, height: 9.4), cornerWidth: 1.2, cornerHeight: 1.2)
        p.addRoundedRect(in: CGRect(x: 25.3, y: 18.6, width: 2.7, height: 9.4), cornerWidth: 1.2, cornerHeight: 1.2)
        return p
    }

    /// The small dot that says it is listening, at the lower right (the "recording" tray icon's dot).
    public static let dotCenter = CGPoint(x: 36.2, y: 35)
    public static let dotRadius: CGFloat = 6

    public static func dot() -> CGPath {
        CGPath(ellipseIn: CGRect(x: dotCenter.x - dotRadius, y: dotCenter.y - dotRadius, width: dotRadius * 2, height: dotRadius * 2), transform: nil)
    }
}
