import XCTest
@testable import BaneySpacesCore

extension CGRect {
    /// Four edges, short enough to read in a table of frames.
    init(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double) { self.init(x: x0, y: y0, width: x1 - x0, height: y1 - y0) }
}

final class TileLayoutTests: XCTestCase {
    let wide = CGRect(x: 0, y: 0, width: 1600, height: 1000)
    let tall = CGRect(x: -1000, y: 40, width: 1000, height: 1600)
    let none = TileGaps()

    func layout(_ style: TileStyle, _ n: UInt32, in area: CGRect) -> TileLayout {
        var l = TileLayout(style: style)
        if n > 0 { l.sync(Array(1...n), focused: nil, area: area) }
        return l
    }

    // MARK: Styles

    func testDwindleSplitsTheFocusedTileAlongItsLongerSide() {
        var l = layout(.dwindle, 3, in: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none), [1: CGRect(0, 0, 800, 1000), 2: CGRect(800, 0, 1600, 500), 3: CGRect(800, 500, 1600, 1000)])
        l.insert(4, beside: 1, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[4], CGRect(0, 500, 800, 1000))
        l.insert(5, beside: nil, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[5], CGRect(1200, 500, 1600, 1000), "no focus: the last tile splits")
        XCTAssertEqual(l.windows, [1, 4, 2, 3, 5])
        XCTAssertEqual(layout(.dwindle, 2, in: tall).frames(in: tall, gaps: none)[2], CGRect(-1000, 840, 0, 1640))
    }

    func testColumnsStandBesideEachOtherAndStackOnAPortraitArea() {
        var l = layout(.columns, 4, in: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[2], CGRect(400, 0, 800, 1000))
        l.insert(9, beside: 1, area: wide)
        XCTAssertEqual(l.windows, [1, 9, 2, 3, 4])
        l.insert(10, beside: 77, area: wide)
        XCTAssertEqual(l.windows.last, 10, "an unknown focus joins the root at its end")
        XCTAssertTrue(l.sync(l.windows, focused: nil, area: tall), "the display turned")
        XCTAssertEqual(Set(l.frames(in: tall, gaps: none).values.map(\.width)), [1000])
        XCTAssertFalse(l.sync(l.windows, focused: nil, area: tall))
    }

    func testMainKeepsOneWindowAt55PercentAndStacksTheRestEvenly() {
        var l = layout(.main, 4, in: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[1], CGRect(0, 0, 880, 1000))
        XCTAssertEqual(l.frames(in: wide, gaps: none)[3], CGRect(880, 333, 1600, 667))
        l.insert(5, beside: 1, area: wide)
        l.insert(6, beside: 2, area: wide)
        XCTAssertEqual(l.windows, [1, 5, 2, 6, 3, 4], "beside the main window is the top of the stack")
        XCTAssertEqual(l.frames(in: wide, gaps: none)[5]?.height, 200)
        l.remove(1, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[5], CGRect(0, 0, 880, 1000), "the next window becomes the main one")
        XCTAssertEqual(layout(.main, 3, in: tall).frames(in: tall, gaps: none)[1], CGRect(-1000, 40, 0, 920))
        l.sync([5, 2, 6], focused: nil, area: tall)
        XCTAssertEqual(l.frames(in: tall, gaps: none)[6], CGRect(-500, 920, 0, 1640), "turned: the stack is a row under the main window")
    }

    func testChangingTheStyleKeepsTheOrderAndTheSameStyleKeepsTheArrangement() {
        for (from, to) in [(TileStyle.dwindle, TileStyle.main), (.main, .columns), (.columns, .dwindle)] {
            var l = layout(from, 6, in: wide)
            let order = l.windows
            l.setStyle(to, area: wide)
            XCTAssertEqual(l.windows, order)
            XCTAssertEqual(l, { var fresh = TileLayout(style: to); fresh.sync(order, focused: nil, area: wide); return fresh }())
            let same = l
            l.setStyle(to, area: tall)
            XCTAssertEqual(l, same)
        }
    }

    // MARK: Coming and going

    func testOpeningAndClosingAWindowPutsTheLayoutBack() {
        for style in TileStyle.allCases {
            for n in UInt32(1)...9 {
                for focused in 1...n {
                    var l = layout(style, n, in: wide)
                    let before = l
                    l.insert(99, beside: focused, area: wide)
                    l.remove(99, area: wide)
                    XCTAssertEqual(l.frames(in: wide, gaps: none), before.frames(in: wide, gaps: none), "\(style) \(n) beside \(focused)")
                }
            }
        }
    }

    func testSplitsTurnForTheirNewShapeWhenAWindowLeavesButNotAnArrangedOne() {
        var l = layout(.dwindle, 4, in: wide)  // 1 | 2 over (3 | 4)
        l.remove(1, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none), [2: CGRect(0, 0, 800, 1000), 3: CGRect(800, 0, 1600, 500), 4: CGRect(800, 500, 1600, 1000)],
                       "the outer split turned first, then the one inside it for the shape that left")
        var inner = layout(.dwindle, 4, in: wide)
        inner.remove(2, area: wide)
        XCTAssertEqual(inner.frames(in: wide, gaps: none), [1: CGRect(0, 0, 800, 1000), 3: CGRect(800, 0, 1600, 500), 4: CGRect(800, 500, 1600, 1000)],
                       "3 and 4 have a tall shape now, and only their split changed")
        var resized = layout(.dwindle, 4, in: wide)
        resized.root![split: [1]]!.parts[0].weight = 0.1
        resized.insert(9, beside: 1, area: wide)
        resized.remove(9, area: wide)
        XCTAssertEqual(resized.frames(in: wide, gaps: none)[3]!.width, 400, "a split whose shape didn't change doesn't turn")
        var arranged = layout(.dwindle, 4, in: wide)
        var split = arranged.root![split: [1]]!
        split.automatic = false
        split.parts[0].weight = 3
        arranged.root![split: [1]] = split
        arranged.remove(1, area: wide)
        XCTAssertEqual(arranged.frames(in: wide, gaps: none)[2], CGRect(0, 0, 1600, 750), "direction and weights stay")
    }

    func testMergingAnAutomaticSplitIntoItsParentMovesNoFrame() {
        var plain = TileSplit(.horizontal, automatic: true, [.window(1), .split(TileSplit(.horizontal, automatic: true, [.window(2), .window(3)],
                                                                                           weights: [2, 5])), .window(4)], weights: [3, 2, 1])
        let l = { (s: TileSplit) in var l = TileLayout(); l.root = .split(s); return l }
        let nested = l(plain)
        plain.merge(at: 1)
        XCTAssertEqual(plain.parts.count, 4)
        let cases: [[WindowID: CGSize]] = [[:], [2: CGSize(width: 500, height: 10)],
                                           [3: CGSize(width: 1500, height: 10), 1: CGSize(width: 900, height: 10)]]
        for minimums in cases {
            for inner in [0.0, 7, 30] {
                let gaps = TileGaps(inner: inner, outer: 9)
                XCTAssertEqual(l(plain).frames(in: wide, gaps: gaps, minimums: minimums), nested.frames(in: wide, gaps: gaps, minimums: minimums))
            }
        }
        // 1 | ((2 | 3) over 4): closing 4 leaves a side-by-side split inside a side-by-side one.
        var closing = TileLayout()
        closing.sync([1, 2, 4], focused: nil, area: CGRect(x: 0, y: 0, width: 3200, height: 1700))
        closing.insert(3, beside: 2, area: CGRect(x: 0, y: 0, width: 3200, height: 1700))
        closing.remove(4, area: CGRect(x: 0, y: 0, width: 3200, height: 1500))
        XCTAssertEqual(closing.root?[split: []]?.parts.count, 3)
        var kept = TileSplit(.horizontal, automatic: false, [.window(1), .split(TileSplit(.horizontal, automatic: true, [.window(2), .window(3)]))])
        kept.merge(at: 1)
        XCTAssertEqual(kept.parts.count, 2, "a split a person arranged takes nothing in")
    }

    func testSyncDropsTheGoneAndAddsTheNewInOrder() {
        for style in TileStyle.allCases {
            var l = layout(style, 3, in: wide)
            XCTAssertTrue(l.sync([3, 1, 8, 7, 8], focused: 1, area: wide))
            XCTAssertEqual(l.windows, [1, 8, 7, 3], "\(style): new ones in their order, after the focused one")
            XCTAssertFalse(l.sync([7, 8, 3, 1], focused: 3, area: wide), "another order alone changes nothing")
            XCTAssertTrue(l.sync([], focused: 3, area: wide))
            XCTAssertEqual(l, TileLayout(style: style))
        }
    }

    func testAReplacedWindowKeepsTheSlotAndUnknownWindowsDoNothing() {
        var l = layout(.dwindle, 4, in: wide)
        let before = l.frames(in: wide, gaps: none)
        l.replace(3, with: 30)
        XCTAssertEqual(l.frames(in: wide, gaps: none)[30], before[3])
        let same = l
        l.replace(30, with: 2); l.replace(5, with: 6); l.remove(77, area: wide); l.insert(2, beside: 1, area: wide)
        XCTAssertEqual(l, same)
    }

    // MARK: Frames

    func testGapsAreExactAndTheOuterOnesGiveWay() {
        let l = layout(.dwindle, 5, in: wide)
        let f = l.frames(in: wide, gaps: TileGaps(inner: 9, top: 30, bottom: 4, left: 6, right: 8))
        XCTAssertEqual([f[1]!.minX, f[1]!.minY, f[1]!.maxY, f[2]!.maxX], [6, 30, 996, 1592])
        XCTAssertEqual(f[2]!.minX - f[1]!.maxX, 9)
        XCTAssertEqual(f[3]!.minY - f[2]!.maxY, 9)
        let small = CGRect(x: 10.5, y: 5, width: 401, height: 250)
        let g = layout(.dwindle, 1, in: small).frames(in: small, gaps: TileGaps(inner: 0, top: 60, bottom: 20, left: 60, right: 20))[1]!
        XCTAssertEqual(g, CGRect(71, 12, 391, 253), "whole points inside the area, never under 320 by 240 for gaps")
        let squeezed = layout(.columns, 5, in: small).frames(in: small, gaps: TileGaps(inner: 900, outer: 0))
        XCTAssertGreaterThanOrEqual(squeezed.values.map(\.width).min()!, 1)
        XCTAssertEqual(layout(.dwindle, 3, in: wide).frames(in: .null, gaps: none), [:])
        XCTAssertEqual(layout(.dwindle, 3, in: wide).frames(in: CGRect(x: 0, y: 0, width: 0.4, height: 9), gaps: none), [:])
    }

    func testALoneTileIsCenteredAtItsMost() {
        var l = layout(.columns, 1, in: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none, loneMax: CGSize(width: 1001, height: 5000))[1], CGRect(299, 0, 1300, 1000))
        XCTAssertEqual(l.frames(in: wide, gaps: none, minimums: [1: CGSize(width: 1200, height: 1)], loneMax: CGSize(width: 1000, height: 600))[1],
                       CGRect(200, 200, 1400, 800))
        l.insert(2, beside: 1, area: wide)
        XCTAssertEqual(l.frames(in: wide, gaps: none, loneMax: CGSize(width: 10, height: 10))[2], CGRect(800, 0, 1600, 1000))
    }

    func testMinimumsAreMetBySiblingsInProportionToWhatTheyCanSpare() {
        let l = layout(.columns, 4, in: wide)  // 400 each
        let f = l.frames(in: wide, gaps: none, minimums: [1: CGSize(width: 700, height: 1), 2: CGSize(width: 301, height: 1), 3: CGSize(width: 201, height: 1)])
        // 300 short; 2, 3 and 4 can spare 99, 199 and 399.
        XCTAssertEqual(f, [1: CGRect(0, 0, 700, 1000), 2: CGRect(700, 0, 1057, 1000), 3: CGRect(1057, 0, 1372, 1000), 4: CGRect(1372, 0, 1600, 1000)])
        let nested = layout(.dwindle, 4, in: wide)  // 1 | 2 over (3 | 4)
        let g = nested.frames(in: wide, gaps: TileGaps(inner: 10, outer: 0), minimums: [3: CGSize(width: 500, height: 600), 4: CGSize(width: 500, height: 1)])
        XCTAssertEqual(g[3]?.size, CGSize(width: 500, height: 600))
        XCTAssertEqual(g[4]?.size, CGSize(width: 500, height: 600))
        XCTAssertEqual(g[1], CGRect(0, 0, 580, 1000))
    }

    func testMinimumsThatCannotFitShrinkInProportion() {
        let l = layout(.columns, 3, in: wide)
        let f = l.frames(in: wide, gaps: TileGaps(inner: 50, outer: 0), minimums: [1: CGSize(width: 2000, height: 1), 2: CGSize(width: 1000, height: 1),
                                                                                    3: CGSize(width: 3000, height: 1)])
        XCTAssertEqual([f[1]!.width, f[2]!.width, f[3]!.width], [500, 250, 750])
        let g = l.frames(in: wide, gaps: none, minimums: [1: CGSize(width: 90_000, height: 9e9)])
        XCTAssertEqual([g[1]!.width, g[2]!.width, g[3]!.width], [1598, 1, 1], "a point at least")
        XCTAssertTrue(g.values.allSatisfy { wide.contains($0) })
    }

    // MARK: Saving

    func testASavedLayoutComesBackTheSameAndABrokenOneIsRepaired() throws {
        for style in TileStyle.allCases {
            let l = layout(style, 7, in: wide)
            XCTAssertEqual(try JSONDecoder().decode(TileLayout.self, from: JSONEncoder().encode(l)), l)
        }
        let broken = """
            {"style":"main","root":{"axis":"vertical","automatic":false,"parts":[{"weight":-3,"node":4},{"weight":1,"node":4},
            {"weight":1,"node":{"axis":"horizontal","automatic":true,"parts":[]}},
            {"weight":2,"node":{"axis":"horizontal","automatic":true,"parts":[{"weight":1,"node":6}]}}]}}
            """
        let l = try JSONDecoder().decode(TileLayout.self, from: Data(broken.utf8))
        XCTAssertEqual(l.frames(in: wide, gaps: none), [4: CGRect(0, 0, 1600, 333), 6: CGRect(0, 333, 1600, 1000)])
    }
}
