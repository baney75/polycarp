import BaneySpacesCore
import CoreGraphics
import Foundation
import ImageIO
import XCTest

/// Gap X1: in dark mode the workspace colors in Settings > Appearance sat in a white box.
final class SwatchBackdropTests: XCTestCase {
    /// An image drawn over white, so a see-through pixel reads as it shows in a viewer.
    private func overWhite(_ path: String) throws -> (width: Int, height: Int, pixel: (Int, Int) -> RGB) {
        let url = Repo.root.appendingPathComponent(path)
        let src = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        let w = image.width, h = image.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = try XCTUnwrap(CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        let pixels = bytes
        // The context's rows run top to bottom in memory.
        return (w, h, { x, y in
            let i = (y * w + x) * 4
            return RGB(r: Double(pixels[i]) / 255, g: Double(pixels[i + 1]) / 255, b: Double(pixels[i + 2]) / 255)
        })
    }

    /// The row of nine color wells cut from main's 2x render of Settings > Appearance in dark mode (x 440, y 680). Each well's
    /// color fill is 76 by 34 pixels, 100 apart; around them the pane is see-through.
    func testMainsColorWellsSitInAWhiteBox() throws {
        let img = try overWhite("Tests/BaneySpacesCoreTests/Fixtures/swatches-main-dark.png")
        let fills = (0..<9).map { SwatchBackdrop.Rect(x: 26 + 100 * $0, y: 20, width: 76, height: 34) }
        let r = SwatchBackdrop.sample(width: img.width, height: img.height, swatches: fills, pixel: img.pixel)
        XCTAssertGreaterThan(r.sampled, 10_000)
        XCTAssertGreaterThan(r.share, 0.5, "most of what the wells sit on is white")
        XCTAssertFalse(r.passes)
    }

    /// The same row after the fix, cut from the 2x render `scripts/swatch-check.sh` makes (x 448, y 1104): nine swatches 72
    /// by 42 pixels, 96 apart, on the dark panel.
    func testTheSwatchesSitOnTheDarkPanel() throws {
        let img = try overWhite("Tests/BaneySpacesCoreTests/Fixtures/swatches-x1-dark.png")
        let fills = (0..<9).map { SwatchBackdrop.Rect(x: 16 + 96 * $0, y: 14, width: 72, height: 42) }
        let r = SwatchBackdrop.sample(width: img.width, height: img.height, swatches: fills, pixel: img.pixel)
        XCTAssertGreaterThan(r.sampled, 10_000)
        XCTAssertTrue(r.passes, "\(r.light) of \(r.sampled) pixels around the swatches are near white")
    }

    func testLightSwatchesOnADarkPagePass() {
        let page = RGB(r: 0.17, g: 0.18, b: 0.15), swatch = RGB(r: 0.85, g: 0.9, b: 0.8)
        let swatches = (0..<3).map { SwatchBackdrop.Rect(x: 20 + 60 * $0, y: 20, width: 44, height: 22) }
        let r = SwatchBackdrop.sample(width: 220, height: 60, swatches: swatches) { x, y in
            swatches.contains { x >= $0.x && x < $0.x + $0.width && y >= $0.y && y < $0.y + $0.height } ? swatch : page
        }
        XCTAssertGreaterThan(r.sampled, 1000)
        XCTAssertEqual(r.light, 0)
        XCTAssertTrue(r.passes)
    }

    func testAWhiteGapBetweenSwatchesFails() {
        let swatches = [SwatchBackdrop.Rect(x: 10, y: 10, width: 30, height: 20), SwatchBackdrop.Rect(x: 60, y: 10, width: 30, height: 20)]
        let r = SwatchBackdrop.sample(width: 100, height: 40, swatches: swatches) { x, _ in
            x > 44 && x < 56 ? RGB(r: 1, g: 1, b: 1) : RGB(r: 0.1, g: 0.1, b: 0.1)
        }
        XCTAssertFalse(r.passes)
    }

    func testNoSwatchesFoundFails() {
        XCTAssertFalse(SwatchBackdrop.sample(width: 10, height: 10, swatches: []) { _, _ in RGB(r: 0, g: 0, b: 0) }.passes)
    }

    func testASeeThroughPixelIsWhite() {
        let dark = RGB(r: 0.1, g: 0.1, b: 0.1)
        XCTAssertEqual(SwatchBackdrop.overWhite(dark, alpha: 0), RGB(r: 1, g: 1, b: 1))
        XCTAssertEqual(SwatchBackdrop.overWhite(dark, alpha: 1), dark)
        XCTAssertGreaterThanOrEqual(SwatchBackdrop.luminance(SwatchBackdrop.overWhite(dark, alpha: 0.2)), SwatchBackdrop.nearWhite)
    }

    /// The color wells are gone from Settings and the theme editor: a `ColorPicker` is an `NSColorWell`, which leaves the hole.
    func testSettingsDrawNoColorWell() throws {
        for path in ["Sources/BaneySpaces/Setup.swift", "Sources/BaneySpaces/Appearance/ThemeEditorView.swift"] {
            XCTAssertFalse(try Repo.code(path).contains("ColorPicker("), path)
        }
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/Render.swift").contains("BANEYSPACES_RENDER_SWATCHES"))
    }
}
