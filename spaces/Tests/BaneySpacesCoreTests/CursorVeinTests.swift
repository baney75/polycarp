import XCTest
import CoreGraphics
@testable import BaneySpacesCore

/// The leaf cursor's vein is drawn in the leaf's own coordinates and moved by the leaf's own fit.
final class CursorVeinTests: XCTestCase {
    func testTheVeinUsesTheLeafsFit() throws {
        for size in [10.0, 22.0, 40.0] {
            let fit = CursorGlyphs.leafFit(size: size)
            let vein = try XCTUnwrap(CursorGlyphs.vein(.leaf, size: size))
            let b = vein.boundingBoxOfPath
            let a = CGPoint(x: 0.17 * size, y: 0.17 * size).applying(fit), c = CGPoint(x: 0.60 * size, y: 0.60 * size).applying(fit)
            XCTAssertEqual(b.minX, min(a.x, c.x), accuracy: 0.001, "size \(size)")
            XCTAssertEqual(b.maxY, max(a.y, c.y), accuracy: 0.001, "size \(size)")
            // And it is on the leaf: both ends inside its outline.
            let leaf = CursorGlyphs.path(.leaf, size: size)
            XCTAssertTrue(leaf.contains(a) && leaf.contains(c), "size \(size): the vein stays on the leaf")
            XCTAssertEqual(leaf.boundingBoxOfPath.height, size, accuracy: 0.001)
        }
        XCTAssertNil(CursorGlyphs.vein(.pointer, size: 22))
    }

    func testTheFitIsTheOneTheLeafGets() {
        // The fit sends the leaf's own outline to the box the leaf path has: the tip at the origin, `size` tall.
        let leaf = CursorGlyphs.path(.leaf, size: 22)
        XCTAssertEqual(leaf.boundingBoxOfPath.minX, 0, accuracy: 0.001)
        XCTAssertEqual(leaf.boundingBoxOfPath.minY, 0, accuracy: 0.001)
    }
}
