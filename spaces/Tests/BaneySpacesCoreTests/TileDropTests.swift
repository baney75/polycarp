import XCTest
@testable import BaneySpacesCore

final class TileDropTests: XCTestCase {
    let wide = CGRect(x: 0, y: 0, width: 1600, height: 1000)
    let tall = CGRect(x: 0, y: 0, width: 1000, height: 1600)
    let none = TileGaps()

    func layout(_ style: TileStyle, _ n: UInt32, in area: CGRect) -> TileLayout {
        var l = TileLayout(style: style)
        l.sync(Array(1...n), focused: nil, area: area)
        return l
    }

    func testWhereADropLandsSaysWhatItDoes() {
        let l = layout(.dwindle, 3, in: wide)  // 1 | 2 over 3, so 2 is 800...1600 by 0...500
        func drop(_ id: WindowID, _ x: Double, _ y: Double) -> TileDrop? {
            l.drop(id, at: CGPoint(x: x, y: y), area: wide, gaps: none)
        }
        XCTAssertEqual(drop(1, 1200, 250), .swap(2))
        XCTAssertEqual(drop(1, 1041, 151), .swap(2), "the middle 40% on both axes")
        XCTAssertEqual(drop(1, 1039, 250), .beside(2, .left))
        XCTAssertEqual(drop(1, 1361, 250), .beside(2, .right))
        XCTAssertEqual(drop(1, 1200, 149), .beside(2, .up))
        XCTAssertEqual(drop(1, 1200, 351), .beside(2, .down))
        XCTAssertEqual(drop(1, 830, 5), .beside(2, .up), "a corner goes to the edge it is nearer to for the tile's shape")
        XCTAssertEqual(drop(1, 1576, 250), .edge(.right))
        XCTAssertEqual(drop(1, 1575, 250), .beside(2, .right))
        XCTAssertEqual(drop(2, 23, 500), .edge(.left))
        XCTAssertEqual(drop(2, 24, 500), .beside(1, .left))
        XCTAssertEqual(drop(1, 1200, 0), .beside(2, .up), "top and bottom are no edges of a landscape area")
        for (id, x, y) in [(1, 400, 500), (1, 5, 500), (2, -1, 250), (1, 1600, 250), (9, 400, 500)] {
            XCTAssertNil(drop(WindowID(id), Double(x), Double(y)), "\(id): its own tile, outside, or not here")
        }
        let portrait = layout(.columns, 2, in: tall)
        XCTAssertEqual(portrait.drop(1, at: CGPoint(x: 500, y: 1590), area: tall, gaps: none), .edge(.down))
        XCTAssertEqual(portrait.drop(2, at: CGPoint(x: 500, y: 3), area: tall, gaps: none), .edge(.up))
        XCTAssertEqual(portrait.drop(2, at: CGPoint(x: 3, y: 400), area: tall, gaps: none), .beside(1, .left))
        // In the gap between two tiles and in the outer gap, the nearest tile takes it.
        let gaps = TileGaps(inner: 40, outer: 60)
        XCTAssertEqual(l.drop(1, at: CGPoint(x: 1200, y: 490), area: wide, gaps: gaps), .beside(2, .down))
        XCTAssertEqual(l.drop(1, at: CGPoint(x: 1200, y: 10), area: wide, gaps: gaps), .beside(2, .up))
    }

    func testADropBesideATileTakesHalfOfItAndTheOutlineSaysSo() {
        var l = layout(.dwindle, 3, in: wide)
        XCTAssertEqual(l.dropFrame(.beside(1, .up), 3, area: wide, gaps: none), CGRect(0, 0, 800, 500))
        l.apply(.beside(1, .up), to: 3, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none), [3: CGRect(0, 0, 800, 500), 1: CGRect(0, 500, 800, 1000), 2: CGRect(800, 0, 1600, 1000)])
        l.apply(.beside(2, .left), to: 3, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none), [1: CGRect(0, 0, 800, 1000), 3: CGRect(800, 0, 1200, 1000), 2: CGRect(1200, 0, 1600, 1000)])
        l.remove(1, area: wide)
        l.apply(.beside(2, .down), to: 3, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[3], CGRect(0, 500, 1600, 1000), "its side, though the pair fills a landscape area now")
        XCTAssertNil(l.dropFrame(.beside(2, .down), 3, area: wide, gaps: none), "where it is already")
        XCTAssertEqual(l.dropFrame(.swap(2), 3, area: wide, gaps: none), CGRect(0, 0, 1600, 500))
    }

    func testADropIsJudgedOnTheTilesMinimumsLeave() {
        let l = layout(.main, 3, in: wide)  // 1 beside 2 over 3, and 3 takes 300...1000
        let tall: [WindowID: CGSize] = [3: CGSize(width: 0, height: 700)]
        XCTAssertEqual(l.drop(1, at: CGPoint(x: 1240, y: 650), area: wide, gaps: none, minimums: tall), .swap(3))
        XCTAssertEqual(l.drop(1, at: CGPoint(x: 1240, y: 320), area: wide, gaps: none, minimums: tall), .beside(3, .up))
        let d = layout(.dwindle, 3, in: wide), broad: [WindowID: CGSize] = [3: CGSize(width: 600, height: 0)]
        XCTAssertEqual(d.dropFrame(.beside(1, .left), 3, area: wide, gaps: none, minimums: broad)?.width, 600)
    }

    func testTwoColumnsStillTurnWithTheDisplayAfterAnEdgeDrop() {
        var l = layout(.columns, 2, in: wide)
        l.apply(.edge(.left), to: 2, area: wide)
        XCTAssertEqual(l.windows, [2, 1])
        l.settle(tall)
        XCTAssertEqual(l.frames(in: tall, gaps: none)[2], CGRect(0, 0, 1000, 800))
    }

    func testDroppingBetweenSiblingsKeepsTheirSizes() {
        var l = layout(.columns, 3, in: wide)
        l.resize(1, axis: .horizontal, by: 267, area: wide, gaps: none)
        l.apply(.beside(3, .right), to: 1, area: wide)
        XCTAssertEqual(l.windows, [2, 3, 1])
        XCTAssertEqual(l.frames(in: wide, gaps: none)[1]!.width, 800, accuracy: 1)
        l.apply(.beside(2, .left), to: 1, area: wide)
        XCTAssertEqual(l.windows, [1, 2, 3])
        l.apply(.beside(2, .down), to: 3, area: wide)
        l.apply(.beside(1, .left), to: 3, area: wide)
        XCTAssertEqual(l.root?[split: []]?.parts.count, 3, "a window dropped beside a column is a column")
    }

    func testAnEdgeDropTakesHalfTheArea() {
        for style in [TileStyle.dwindle, .columns] {
            for (d, half) in [(TileDirection.left, CGRect(0, 0, 800, 1000)), (.right, CGRect(800, 0, 1600, 1000)), (.up, CGRect(0, 0, 1600, 500)),
                              (.down, CGRect(0, 500, 1600, 1000))] {
                let l = layout(style, 4, in: wide)
                XCTAssertEqual(l.dropFrame(.edge(d), 2, area: wide, gaps: none), half, "\(style) \(d)")
            }
        }
        var l = layout(.dwindle, 3, in: wide)
        l.apply(.edge(.left), to: 3, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[2], CGRect(800, 500, 1600, 1000), "the others chose again for the half they have")
        l.remove(3, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[2], CGRect(800, 0, 1600, 1000))
        var alone = layout(.dwindle, 1, in: wide)
        alone.apply(.edge(.left), to: 1, area: wide)
        XCTAssertEqual(alone, layout(.dwindle, 1, in: wide))
    }

    func testInMainADropOnlyChangesTheOrder() {
        var l = layout(.main, 4, in: wide)
        l.apply(.beside(2, .down), to: 4, area: wide)
        XCTAssertEqual(l.windows, [1, 2, 4, 3])
        l.apply(.edge(.left), to: 3, area: wide)
        XCTAssertEqual(l.windows, [3, 1, 2, 4])
        l.apply(.edge(.right), to: 1, area: wide)
        l.apply(.beside(3, .right), to: 4, area: wide)
        XCTAssertEqual(l.windows, [3, 4, 2, 1])
        XCTAssertEqual(l.frames(in: wide, gaps: none)[3], CGRect(0, 0, 880, 1000))
    }

    func testADropDoesNothingWhenFullOrForAWindowThatIsNotHere() {
        var l = layout(.dwindle, 3, in: wide)
        let before = l
        l.apply(.swap(9), to: 1, area: wide)
        l.apply(.beside(9, .left), to: 1, area: wide)
        l.apply(.beside(1, .left), to: 1, area: wide)
        l.apply(.edge(.left), to: 9, area: wide)
        XCTAssertEqual(l, before)
        XCTAssertNil(l.dropFrame(.swap(9), 1, area: wide, gaps: none))
        l.full = true
        l.apply(.swap(2), to: 1, area: wide)
        XCTAssertEqual(l.windows, before.windows)
        XCTAssertNil(l.drop(1, at: CGPoint(x: 1200, y: 250), area: wide, gaps: none))
        XCTAssertNil(l.dropFrame(.swap(2), 1, area: wide, gaps: none))
    }
}
