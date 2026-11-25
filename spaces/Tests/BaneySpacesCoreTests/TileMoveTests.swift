import XCTest
@testable import BaneySpacesCore

final class TileMoveTests: XCTestCase {
    let wide = CGRect(x: 0, y: 0, width: 1600, height: 1000)
    let none = TileGaps()

    func layout(_ style: TileStyle, _ n: UInt32) -> TileLayout {
        var l = TileLayout(style: style)
        l.sync(Array(1...n), focused: nil, area: wide)
        return l
    }

    func split(_ axis: TileAxis, _ nodes: TileNode..., automatic: Bool = true, weights: [Double]? = nil) -> TileNode {
        .split(TileSplit(axis, automatic: automatic, nodes, weights: weights))
    }

    func tree(_ root: TileNode) -> TileLayout { var l = TileLayout(); l.root = root; return l }

    // MARK: Focus

    func testTheNeighborIsTheOneAcrossTheEdge() {
        let l = layout(.dwindle, 4)  // 1 | 2 over (3 | 4)
        func over(_ id: WindowID, _ d: TileDirection, _ recent: [WindowID] = []) -> WindowID? {
            l.neighbor(of: id, toward: d, in: wide, gaps: TileGaps(inner: 13, outer: 5), recent: recent)
        }
        XCTAssertEqual(over(1, .right), 2, "2 and 3 share as much of the edge and are as near: the first")
        XCTAssertEqual(over(1, .right, [4, 1, 3, 2]), 3, "the one used last; 4 isn't across the edge")
        XCTAssertEqual(over(4, .left), 3)
        XCTAssertEqual(over(2, .down), 3)
        XCTAssertEqual(over(2, .down, [4]), 4)
        for (id, d) in [(1, TileDirection.left), (1, .up), (1, .down), (2, .up), (4, .right), (99, .left)] {
            XCTAssertNil(over(WindowID(id), d), "\(id) \(d): the workspace's edge")
        }
        let uneven = tree(split(.horizontal, .window(1), split(.vertical, .window(2), .window(3), weights: [1, 2])))
        XCTAssertEqual(uneven.neighbor(of: 1, toward: .right, in: wide, gaps: none), 3, "the most of the edge")
        // What a minimum pushed is judged where it is on screen.
        let rows = tree(split(.horizontal, split(.vertical, .window(1), .window(2), .window(3)), split(.vertical, .window(4), .window(5))))
        let tall: [WindowID: CGSize] = [5: CGSize(width: 0, height: 700)]
        XCTAssertEqual(rows.neighbor(of: 2, toward: .right, in: wide, gaps: none, minimums: tall, recent: [4]), 5)
    }

    func testATileShorterThanTheGapStillHasANeighbor() {
        let l = tree(split(.horizontal, split(.vertical, .window(1), .window(2), .window(3), weights: [500, 11, 489]),
                           split(.vertical, .window(4), .window(5))))
        XCTAssertNotNil(l.neighbor(of: 2, toward: .right, in: wide, gaps: TileGaps(inner: 60, outer: 0)))
    }

    func testTheRingWraps() {
        let l = layout(.dwindle, 3)
        XCTAssertEqual([1, 2, 3].map { l.next(after: $0, backward: false) }, [2, 3, 1])
        XCTAssertEqual([1, 2, 3].map { l.next(after: $0, backward: true) }, [3, 1, 2])
        XCTAssertNil(l.next(after: 9, backward: false))
        XCTAssertEqual(layout(.main, 1).next(after: 1, backward: true), 1)
    }

    // MARK: Moving

    func testMovingAlongASplitTradesPlacesUntilTheEdge() {
        var l = layout(.columns, 3)
        XCTAssertTrue(l.move(1, toward: .right, area: wide))
        XCTAssertEqual(l.windows, [2, 1, 3])
        XCTAssertTrue(l.move(1, toward: .right, area: wide))
        XCTAssertFalse(l.move(1, toward: .right, area: wide))
        XCTAssertFalse(l.move(1, toward: .up, area: wide))
        XCTAssertEqual(l.windows, [2, 3, 1])
        var nested = tree(split(.horizontal, .window(1), split(.horizontal, .window(2), .window(3)), weights: [2, 1]))
        XCTAssertTrue(nested.move(1, toward: .right, area: wide))
        XCTAssertEqual(nested.root, split(.horizontal, .window(2), split(.horizontal, .window(1), .window(3)), weights: [2, 1]), "slots keep their size")
    }

    func testMovingAcrossStepsIntoAndOutOfASplit() {
        var l = tree(split(.horizontal, .window(1), split(.vertical, .window(2), .window(3), .window(4), .window(5))))
        XCTAssertTrue(l.move(4, toward: .left, area: wide))
        XCTAssertEqual(l.windows, [1, 4, 2, 3, 5])
        XCTAssertEqual(l.frames(in: wide, gaps: none)[4], CGRect(533, 0, 1067, 1000), "out of the stack, to a column of its own")
        XCTAssertTrue(l.move(4, toward: .right, area: wide))
        XCTAssertEqual(l.windows, [1, 2, 4, 3, 5], "back in, at its height")
        XCTAssertTrue(l.move(1, toward: .right, area: wide))
        XCTAssertEqual(l.root, split(.vertical, .window(2), .window(4), .window(1), .window(3), .window(5), automatic: false),
                       "the stack it joined keeps its direction though it has the whole width now")
        XCTAssertFalse(l.move(1, toward: .right, area: wide))
    }

    func testInMainAMoveIsATradeAndPromoteTakesTheMainSlot() {
        var l = layout(.main, 4)
        XCTAssertTrue(l.move(3, toward: .left, area: wide))
        XCTAssertEqual(l.windows, [3, 2, 1, 4])
        XCTAssertTrue(l.move(2, toward: .down, area: wide))
        XCTAssertFalse(l.move(2, toward: .right, area: wide))
        XCTAssertEqual(l.windows, [3, 1, 2, 4])
        l.promote(4)
        XCTAssertEqual(l.windows, [4, 1, 2, 3])
        XCTAssertEqual(l.frames(in: wide, gaps: none)[4], CGRect(0, 0, 880, 1000))
        var columns = layout(.columns, 3)
        columns.promote(3)
        columns.swap(1, 99)
        XCTAssertEqual(columns, layout(.columns, 3))
        columns.swap(1, 3)
        XCTAssertEqual(columns.windows, [3, 2, 1])
    }

    // MARK: Sizes

    func testAKeyResizeTakesFromTheSiblingsInProportionAndStopsAtTheirMinimums() {
        var l = tree(split(.horizontal, .window(1), .window(2), .window(3), weights: [4, 8, 4]))
        XCTAssertTrue(l.resize(1, axis: .horizontal, by: 120, area: wide, gaps: none))
        XCTAssertEqual([1, 2, 3].map { l.frames(in: wide, gaps: none)[$0]!.width }, [520, 720, 360])
        let gaps = TileGaps(inner: 10, outer: 10)
        let minimums: [WindowID: CGSize] = [2: CGSize(width: 700, height: 0), 1: CGSize(width: 100, height: 0)]
        XCTAssertTrue(l.resize(3, axis: .horizontal, by: 5000, area: wide, gaps: gaps, minimums: minimums))
        XCTAssertEqual([1, 2, 3].map { l.frames(in: wide, gaps: gaps)[$0]!.width }, [100, 700, 760], "weights alone now, every point kept")
        XCTAssertFalse(l.resize(3, axis: .horizontal, by: 5, area: wide, gaps: gaps, minimums: minimums))
        XCTAssertFalse(l.resize(3, axis: .vertical, by: 5, area: wide, gaps: gaps), "no split on that axis")
        XCTAssertTrue(l.resize(3, axis: .horizontal, by: -60, area: wide, gaps: gaps, minimums: minimums))
        XCTAssertEqual(l.frames(in: wide, gaps: gaps)[3]!.width, 700)
    }

    func testResizingFromAFrameAMinimumPushedDoesNotJump() {
        var l = layout(.columns, 3)
        let minimums: [WindowID: CGSize] = [1: CGSize(width: 1000, height: 0)]
        XCTAssertTrue(l.resize(2, axis: .horizontal, by: 50, area: wide, gaps: none, minimums: minimums))
        XCTAssertEqual([1, 2, 3].map { l.frames(in: wide, gaps: none, minimums: minimums)[$0]!.width }, [1000, 350, 250])
    }

    func testADraggedEdgeMovesOnlyItsOwnCutLine() {
        let gaps = TileGaps(inner: 8, outer: 8)
        // 1 | (2 | 3) with 3 above 4, and 2's left edge is the outer cut line.
        var l = tree(split(.horizontal, .window(1), split(.horizontal, .window(2), split(.vertical, .window(3), .window(4)))))
        let was = l.frames(in: wide, gaps: gaps)
        var f = was[2]!
        (f.origin.x, f.size.width) = (f.minX - 100, f.width + 100)
        XCTAssertTrue(l.resize(2, to: f, area: wide, gaps: gaps))
        XCTAssertEqual(l.frames(in: wide, gaps: gaps)[2], f)
        XCTAssertEqual(l.frames(in: wide, gaps: gaps)[3], was[3], "the far side stays")
        f = l.frames(in: wide, gaps: gaps)[3]!  // the bottom left corner
        let corner = CGRect(x: f.minX + 40, y: f.minY, width: f.width - 40, height: f.height + 60)
        XCTAssertTrue(l.resize(3, to: corner, area: wide, gaps: gaps))
        XCTAssertEqual(l.frames(in: wide, gaps: gaps)[3], corner)
        XCTAssertEqual(l.frames(in: wide, gaps: gaps)[1]!.width, was[1]!.width - 100)
        let before = l
        XCTAssertFalse(l.resize(3, to: corner.offsetBy(dx: 30, dy: 9), area: wide, gaps: gaps), "moved, not resized")
        l = before
        XCTAssertFalse(l.resize(1, to: l.frames(in: wide, gaps: gaps)[1]!.insetBy(dx: 0, dy: 50), area: wide, gaps: gaps), "the area's own edges")
        XCTAssertFalse(l.resize(1, to: .null, area: wide, gaps: gaps))
        XCTAssertEqual(l, before)
    }

    func testARowNestedInARowResizesAsOneRow() {
        let area = CGRect(x: 0, y: 0, width: 3440, height: 1440)
        var start = TileLayout(style: .dwindle)  // 1 | (2 | 3)
        start.sync([1, 2, 3], focused: nil, area: area)
        func widths(_ l: TileLayout, _ minimums: [WindowID: CGSize]) -> [Double] {
            [1, 2, 3].map { Double(l.frames(in: area, gaps: none, minimums: minimums)[$0]!.width) }
        }
        XCTAssertEqual(widths(start, [:]), [1720, 860, 860])
        let minimums: [WindowID: CGSize] = [2: CGSize(width: 700, height: 0)]
        var l = start
        XCTAssertTrue(l.resize(1, to: CGRect(0, 0, 2120, 1440), area: area, gaps: none, minimums: minimums))
        XCTAssertEqual(widths(l, minimums), [2120, 700, 620], "past its minimum the next one pays, and the edge lands where it was let go")
        var pushed = start
        let fixed: [WindowID: CGSize] = [2: CGSize(width: 860, height: 0)]
        XCTAssertTrue(pushed.resize(3, to: CGRect(2480, 0, 3440, 1440), area: area, gaps: none, minimums: fixed))
        XCTAssertEqual(widths(pushed, fixed), [1620, 860, 960], "pushed along, as in a flat row")
        var key = start
        XCTAssertTrue(key.resize(3, axis: .horizontal, by: 100, area: area, gaps: none, minimums: fixed))
        XCTAssertEqual(widths(key, fixed), [1620, 860, 960])
    }

    func testTheWindowAtTheEdgePaysAndTheRestStay() {
        var l = layout(.columns, 4)
        let widths = { (l: TileLayout) in (WindowID(1)...4).map { Double(l.frames(in: self.wide, gaps: self.none)[$0]!.width) } }
        XCTAssertTrue(l.resize(1, to: CGRect(0, 0, 490, 1000), area: wide, gaps: none))
        XCTAssertEqual(widths(l), [490, 310, 400, 400])
        XCTAssertTrue(l.resize(1, to: CGRect(0, 0, 400, 1000), area: wide, gaps: none))
        XCTAssertEqual(widths(l), [400, 400, 400, 400])
        XCTAssertTrue(l.resize(4, to: CGRect(700, 0, 1600, 1000), area: wide, gaps: none, minimums: [3: CGSize(width: 150, height: 0)]))
        XCTAssertEqual(widths(l), [400, 150, 150, 900], "the one past it once the first is at its minimum")
    }

    func testAWindowSmallerThanItsTileOnlyMovesTheEdgeThatWasPulled() {
        // A terminal that snapped to its rows and columns: 793 of 800 points.
        var l = layout(.columns, 2)
        let start = CGRect(x: 0, y: 0, width: 793, height: 1000), before = l
        XCTAssertFalse(l.resize(1, to: start.offsetBy(dx: 300, dy: 0), from: start, area: wide, gaps: none), "only moved")
        XCTAssertFalse(l.resize(1, to: CGRect(0, 0, 793, 900), from: start, area: wide, gaps: none), "the other axis")
        XCTAssertEqual(l, before)
        XCTAssertTrue(l.resize(1, to: CGRect(0, 0, 893, 1000), from: start, area: wide, gaps: none))
        XCTAssertEqual(l.frames(in: wide, gaps: none)[1]!.width, 900, "by as much as it was pulled")
    }

    func testBalanceEvensOneSplitOrAll() {
        let start = tree(split(.horizontal, .window(1), split(.horizontal, .window(2), split(.vertical, .window(3), .window(4), weights: [9, 1]),
                                                              weights: [5, 1]), weights: [1, 7]))
        var l = start
        l.balance(4)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[4]!.height, 500)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[1], start.frames(in: wide, gaps: none)[1])
        l.balance(nil)
        XCTAssertEqual([1, 2, 3].map { l.frames(in: wide, gaps: none)[$0]!.width }, [533, 534, 533], "a nested row comes out even")
        for id in [WindowID(1), 2] {
            var row = start
            row.balance(id)
            XCTAssertEqual([1, 2, 3].map { row.frames(in: wide, gaps: none)[$0]!.width }, [533, 534, 533], "its whole row, from \(id)")
            XCTAssertEqual(row.frames(in: wide, gaps: none)[4]!.height, 100, "and nothing else")
        }
        var m = layout(.main, 4)
        m.resize(1, axis: .horizontal, by: 200, area: wide, gaps: none)
        m.resize(2, axis: .vertical, by: 100, area: wide, gaps: none)
        XCTAssertEqual(m.frames(in: wide, gaps: none)[1]!.width, 1080)
        m.balance(3)
        XCTAssertEqual(m.frames(in: wide, gaps: none)[1]!.width, 1080)
        m.balance(nil)
        XCTAssertEqual(m, layout(.main, 4))
    }

    func testFlipTurnsASplitForGood() {
        var l = layout(.dwindle, 4)  // 1 | 2 over (3 | 4)
        l.flip(nil, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[1], CGRect(0, 0, 1600, 500))
        XCTAssertEqual(l.frames(in: wide, gaps: none)[2], CGRect(0, 500, 800, 1000), "the automatic split inside chose again")
        l.flip(4, area: wide)
        let turned = l
        l.insert(9, beside: 1, area: wide)
        l.remove(9, area: wide)
        XCTAssertEqual(l, turned, "a person's direction stays")
        var m = layout(.main, 3)
        m.flip(nil, area: wide)
        XCTAssertEqual(m.frames(in: wide, gaps: none), [1: CGRect(0, 0, 1600, 550), 2: CGRect(0, 550, 800, 1000), 3: CGRect(800, 550, 1600, 1000)])
        m.sync([1, 2, 3, 4], focused: 3, area: wide)
        XCTAssertEqual(m.frames(in: wide, gaps: none)[1]!.width, 1600)
        var one = layout(.dwindle, 1)
        one.flip(nil, area: wide)
        one.flip(1, area: wide)
        XCTAssertEqual(one, layout(.dwindle, 1))
    }

    // MARK: Full

    func testFullGivesEveryTileTheAreaAndKeepsTheTree() {
        var l = layout(.dwindle, 3)
        l.resize(1, axis: .horizontal, by: 90, area: wide, gaps: none)
        let before = l
        l.full = true
        let gaps = TileGaps(inner: 10, outer: 20)
        let whole = wide.insetBy(dx: 20, dy: 20)
        XCTAssertEqual(l.frames(in: wide, gaps: gaps, loneMax: CGSize(width: 9, height: 9)), [1: whole, 2: whole, 3: whole])
        XCTAssertFalse(l.move(1, toward: .right, area: wide))
        XCTAssertFalse(l.resize(1, axis: .horizontal, by: 50, area: wide, gaps: gaps))
        XCTAssertFalse(l.resize(1, to: CGRect(x: 0, y: 0, width: 400, height: 400), area: wide, gaps: gaps))
        l.flip(nil, area: wide)
        l.balance(nil)
        l.swap(1, 2)
        for (d, e) in [(TileDirection.right, TileDirection.left), (.down, .up)] {
            XCTAssertEqual([1, 2, 3].map { l.neighbor(of: $0, toward: d, in: wide, gaps: gaps) }, [2, 3, nil])
            XCTAssertEqual([1, 2, 3].map { l.neighbor(of: $0, toward: e, in: wide, gaps: gaps) }, [nil, 1, 2])
        }
        l.full = false
        XCTAssertEqual(l, before)
    }
}
