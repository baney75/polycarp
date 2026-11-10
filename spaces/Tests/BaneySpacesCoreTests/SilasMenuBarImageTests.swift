import AppKit
import XCTest
@testable import BaneySpacesCore

/// Issue 33: the menu bar image is drawn and its pixels read, so a broken drawing fails even if the source looks the same.
final class SilasMenuBarImageTests: XCTestCase {
    private let scale = 4

    /// A solid 16 by 16 square standing in for the workspace mark.
    private func base() -> NSImage {
        let b = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { r in NSColor.black.setFill(); r.fill(); return true }
        b.isTemplate = true
        b.accessibilityDescription = "Polycarp, workspace 2"
        return b
    }

    /// The image drawn at `scale` into a bitmap; `alpha(x, y)` takes points with y down from the top.
    private func render(_ image: NSImage) -> (Int, Int) -> CGFloat {
        let w = Int(image.size.width) * scale, h = Int(image.size.height) * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
        NSGraphicsContext.restoreGraphicsState()
        return { x, y in rep.colorAt(x: x, y: y)?.alphaComponent ?? 0 }
    }

    func testTheListeningImageIsTheMarkAGapAndThePenWithItsDot() {
        let image = SilasMenuBarImage.composite(base: base())
        XCTAssertEqual(image.size.width, 16 + SilasMenuBarImage.gap + 16, "base width + gap + pen")
        XCTAssertEqual(image.size.height, 16)
        XCTAssertTrue(image.isTemplate, "macOS tints it for the bar")
        XCTAssertEqual(image.accessibilityDescription, "Polycarp, workspace 2, Silas, listening")

        let alpha = render(image)
        let s = CGFloat(scale), penX = (16 + SilasMenuBarImage.gap) * s, unit = 16 * s / SilasMarkGeometry.grid
        /// A point on the 44-unit pen grid, as a pixel of the composite.
        func px(_ p: CGPoint) -> (Int, Int) { (Int(penX + p.x * unit), Int(p.y * unit)) }

        XCTAssertGreaterThan(alpha(8 * scale, 8 * scale), 0.9, "the workspace mark")
        // The gap, and the pen's own margin before its cap, are clear.
        for x in (16 * scale + 1)..<Int(penX + 11 * unit) { XCTAssertLessThan(alpha(x, 8 * scale), 0.05, "gap at x \(x)") }
        let dot = px(SilasMarkGeometry.dotCenter)
        XCTAssertGreaterThan(alpha(dot.0, dot.1), 0.9, "the listening dot")

        // Every pixel well inside the pen is set, every pixel well outside the pen and dot is clear.
        let pen = SilasMarkGeometry.pen(), dotPath = SilasMarkGeometry.dot()
        var inside = 0, outside = 0, wrong = 0
        for gy in stride(from: CGFloat(0.5), to: 44, by: 1) {
            for gx in stride(from: CGFloat(0.5), to: 44, by: 1) {
                let p = CGPoint(x: gx, y: gy)
                let near = [-1.0, 1.0].flatMap { d in [CGPoint(x: gx + d, y: gy), CGPoint(x: gx, y: gy + d)] }
                let on = { (q: CGPoint) in pen.contains(q, using: .evenOdd) || dotPath.contains(q) }
                let edge = near.contains { on($0) != on(p) }
                if edge { continue }   // antialiased
                let (x, y) = px(p), a = alpha(x, y)
                if on(p) { inside += 1; if a < 0.9 { wrong += 1 } } else { outside += 1; if a > 0.05 { wrong += 1 } }
            }
        }
        XCTAssertGreaterThan(inside, 200, "the pen has real area")
        XCTAssertGreaterThan(outside, 600)
        XCTAssertEqual(wrong, 0, "pixels that don't match the pen's shape")
    }

    func testThePenAloneHasNoDot() {
        let alpha = render(SilasMark.templateImage(size: 16, recording: false))
        let unit = CGFloat(16 * scale) / SilasMarkGeometry.grid
        XCTAssertLessThan(alpha(Int(SilasMarkGeometry.dotCenter.x * unit), Int(SilasMarkGeometry.dotCenter.y * unit)), 0.05)
        XCTAssertGreaterThan(alpha(Int(22 * unit), Int(10.5 * unit)), 0.9, "the cap bar")
    }
}
