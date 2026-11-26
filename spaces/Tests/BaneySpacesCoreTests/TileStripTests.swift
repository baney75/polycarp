import XCTest
@testable import BaneySpacesCore

/// `scrolling` and `floating`, the layouts that don't fit their windows to the area.
final class TileStripTests: XCTestCase {
    private let area = CGRect(x: 0, y: 25, width: 1616, height: 1016), gaps = TileGaps(inner: 8, outer: 8)
    private let corner = CGPoint(x: 1615, y: 1079)

    private func fake(_ n: WindowID, style: TileStyle = .scrolling, displays: [CGRect] = [CGRect(x: 0, y: 0, width: 1616, height: 1080)]) -> FakeWindows {
        var f = FakeWindows(area: area)
        f.displays = displays
        f.corner = corner
        f.engine.apply(FakeWindows.options { $0.style = style })
        for id in 1...n { f.open(id); f.focused = id; f.rest() }
        return f
    }

    func testTwoColumnsFillTheAreaAndMoreStandBesideIt() {
        var f = fake(4)
        XCTAssertEqual(f.tiled(1), [1, 2, 3, 4])
        XCTAssertEqual(f.wins[3]!.w.frame, CGRect(x: 8, y: 33, width: 796, height: 1000))
        XCTAssertEqual(f.wins[4]!.w.frame, CGRect(x: 812, y: 33, width: 796, height: 1000))
        for id: WindowID in [1, 2] { XCTAssertEqual(f.wins[id]!.w.frame, CGRect(x: 1615, y: 1079, width: 796, height: 1000)) }
        XCTAssertEqual(Set(f.engine.stowed.keys), [1, 2])
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0, "at rest nothing is written")
    }

    func testFocusScrollsNoFurtherThanItTakes() {
        var f = fake(4)
        XCTAssertFalse(f.engine.focused(3), "in view already")
        XCTAssertTrue(f.engine.focused(2))
        f.focused = 2; f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame.minX, 8)
        XCTAssertEqual(f.wins[3]!.w.frame.minX, 812)
        XCTAssertEqual(Set(f.engine.stowed.keys), [1, 4])
        f.focused = 3; f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame.minX, 8, "3 was in view, so nothing moved")
        XCTAssertEqual(f.engine.run(.focus(.left), on: 1, focused: 2), .focus(1))
    }

    func testAWindowOpenedOrClosedLeavesTheOthersTheirWidth() {
        var f = fake(3)
        f.focused = 2; f.rest()
        f.open(9); f.focused = 9; f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2, 9, 3], "beside the one in use")
        XCTAssertEqual(f.engine.frames(1).values.map(\.width), [796, 796, 796, 796])
        f.wins[9] = nil; f.focused = 3; f.rest()
        XCTAssertEqual(f.engine.frames(1).values.map(\.width), [796, 796, 796])
    }

    func testAColumnIsResizedAndTheOthersMoveOver() {
        var f = fake(3)
        f.focused = 2; f.rest()
        XCTAssertEqual(f.engine.run(.grow(.right), on: 1, focused: 2), .changed)
        f.rest()
        let w = f.engine.frames(1)
        XCTAssertEqual(w[2]!.width, 796 + TilingEngine.step, accuracy: 1)
        XCTAssertEqual([w[1]!.width, w[3]!.width], [796, 796])
        XCTAssertEqual(w[3]!.minX - w[2]!.maxX, 8)
        // Never wider than the area, and never under its minimum.
        f.engine.resized(2, to: CGRect(x: 8, y: 33, width: 9000, height: 1000))
        XCTAssertEqual(f.engine.frames(1)[2]!.width, 1600)
        f.engine.minimums[2] = CGSize(width: 500, height: 100)
        f.engine.resized(2, to: CGRect(x: 8, y: 33, width: 90, height: 1000))
        XCTAssertEqual(f.engine.frames(1)[2]!.width, 500)
        XCTAssertEqual(f.engine.run(.balance, on: 1, focused: 2), .changed)
        XCTAssertEqual(f.engine.frames(1)[2]!.width, 796)
    }

    func testAStripScrolledPastItsEndStandsAtItsEnd() {
        var f = fake(4)
        let key = f.engine.key(1)!
        for (scroll, edge) in [(5000.0, 1608.0), (-300, 8)] {
            f.engine.slots[key]!.layout.scroll = scroll
            let w = f.engine.frames(1)
            XCTAssertEqual(scroll > 0 ? w[4]!.maxX : w[1]!.minX, edge, "scrolled to \(scroll)")
        }
        f.focused = 4; f.rest()
        f.wins[4] = nil; f.focused = 3; f.rest()
        XCTAssertEqual(f.engine.frames(1)[3]!.maxX, 1608, "the last column closed, the strip ends at the area's edge")
    }

    func testAColumnIsNeverWiderThanTheAreaNorLeftUnderWhatItWasGiven() {
        var l = TileLayout(style: .scrolling)
        for id in WindowID(1)...3 { l.insert(id, beside: id == 1 ? nil : id - 1, area: area) }
        XCTAssertEqual(l.frames(in: area, gaps: gaps, minimums: [2: CGSize(width: 3000, height: 100)])[2]!.width, 1600, "a window that wants more still fits the area")
        var f = fake(3)
        f.focused = 2; f.rest()
        f.engine.minimums[2] = CGSize(width: 500, height: 100)
        f.engine.resized(2, to: CGRect(x: 8, y: 33, width: 90, height: 1000))
        f.engine.minimums[2] = nil
        f.rest()
        XCTAssertEqual(f.engine.frames(1)[2]!.width, 500, accuracy: 1, "as narrow as it went, not as asked")
    }

    func testColumnsNarrowerThanTheAreaStandInItsMiddle() {
        var f = fake(2)
        for id: WindowID in [1, 2] { f.engine.resized(id, to: CGRect(origin: f.wins[id]!.w.frame.origin, size: CGSize(width: 396, height: 1000))) }
        let w = f.engine.frames(1)
        XCTAssertEqual(w[1]!.minX - 8, 1608 - w[2]!.maxX, accuracy: 2)
        XCTAssertEqual(w[1]!.width, 396, accuracy: 1)
    }

    func testOneThatMostlyShowsStaysUnlessItWouldShowOnTheNextDisplay() {
        let mine = CGRect(x: 0, y: 0, width: 1616, height: 1080), right = CGRect(x: 1616, y: 0, width: 1616, height: 1080)
        for (displays, peeks) in [([mine], true), ([mine, right], false)] {
            var f = fake(3, displays: displays)
            f.focused = 1; f.rest()
            f.engine.resized(1, to: CGRect(x: 8, y: 33, width: 1000, height: 1000))
            f.rest()
            XCTAssertEqual(f.engine.stowed[2] == nil, peeks, "\(f.engine.frames(1)[2]!)")
            XCTAssertNotNil(f.engine.stowed[3])
            // Where one comes back when Polycarp quits is in reach.
            XCTAssertTrue(mine.insetBy(dx: -1, dy: -1).contains(f.engine.stowed[3]!))
        }
        var f = fake(3)
        f.focused = 1; f.rest()
        f.engine.resized(1, to: CGRect(x: 8, y: 33, width: 1300, height: 1000))
        f.rest()
        XCTAssertNotNil(f.engine.stowed[2], "under half of it shows: \(f.engine.frames(1)[2]!)")
    }

    func testAStackInAColumnAndTheStripItselfStay() {
        var f = fake(2)
        f.engine.drop(1, on: CGPoint(x: 1200, y: 900))
        f.rest()
        XCTAssertEqual(f.engine.frames(1)[1]!.minX, f.engine.frames(1)[2]!.minX, "dropped below 2, they share a column")
        f.open(3); f.focused = 3; f.rest()
        XCTAssertEqual(f.engine.frames(1)[3]!.height, 1000, "a new window is a column, not one more in the stack")
        let before = f.engine.frames(1)
        _ = f.engine.run(.flip, on: 1, focused: 3)
        XCTAssertEqual(f.engine.frames(1), before)
        f.shown[1]!.area = CGRect(x: 0, y: 25, width: 1080, height: 1800)
        f.rest()
        XCTAssertEqual(f.engine.frames(1)[3]!.minX > f.engine.frames(1)[2]!.minX, true, "on a portrait display it still runs across")
    }

    func testAWindowInAStackMovesOutAsAColumn() {
        var f = fake(2)
        f.engine.drop(1, on: CGPoint(x: 1200, y: 900)); f.rest()
        XCTAssertEqual(f.engine.run(.move(.left), on: 1, focused: 1), .changed)
        f.rest()
        XCTAssertEqual(f.engine.frames(1)[1], CGRect(x: 8, y: 33, width: 796, height: 1000))
        XCTAssertEqual(f.engine.frames(1)[2], CGRect(x: 812, y: 33, width: 796, height: 1000))
        XCTAssertEqual(f.engine.run(.move(.left), on: 1, focused: 1), .cross(.left, carrying: 1), "a column at the end goes to the next display")
    }

    func testTurningItOffBringsTheOnesOutOfSightBackWhereTheyWere() {
        var f = fake(4)
        f.engine.apply(TilingOptions())
        f.rest()
        XCTAssertTrue(f.engine.stowed.isEmpty)
        for id in WindowID(1)...4 { XCTAssertEqual(f.wins[id]!.w.frame.size, CGSize(width: 700, height: 500)) }
        XCTAssertEqual(f.wins[1]!.w.frame.origin, CGPoint(x: 52, y: 69))
    }

    func testTheLayoutAndItsScrollAreKept() throws {
        var f = fake(4)
        f.focused = 1; f.rest()
        let l = f.engine.slots[f.engine.key(1)!]!.layout
        XCTAssertEqual(try JSONDecoder().decode(TileLayout.self, from: JSONEncoder().encode(l)), l)
        f.focused = 4; f.rest()
        let far = f.engine.slots[f.engine.key(1)!]!.layout
        XCTAssertGreaterThan(far.scroll, 0)
        XCTAssertEqual(try JSONDecoder().decode(TileLayout.self, from: JSONEncoder().encode(far)), far)
    }

    func testAMinimizedWindowComesBackToItsColumn() {
        var f = fake(4)
        f.wins[2]!.w.away = true; f.focused = 4; f.rest()
        XCTAssertEqual(f.tiled(1), [1, 3, 4])
        f.focused = 1; f.rest()
        f.wins[2]!.w.away = false; f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2, 3, 4], "however far it was scrolled meanwhile")
    }

    func testRandomCallsKeepTheStripWhole() {
        for seed in 0..<150 {
            var r = TileRandom(state: UInt64(seed) &* 6007 &+ 3), l = TileLayout(style: .scrolling), there: Set<WindowID> = []
            let gaps = TileGaps(inner: Double(r.below(20)), outer: Double(r.below(30)))
            var minimums: [WindowID: CGSize] = [:]
            for id in WindowID(1)...20 where r.below(3) == 0 { minimums[id] = CGSize(width: r.between(50, 500), height: 60) }
            for step in 0..<50 {
                let area = TilePropertyTests.areas[(seed + step / 25) % 3]
                randomTileCall(&l, &there, &r, area: area, gaps: gaps, minimums: minimums)
                guard l.style == .scrolling, !l.full else { l.full = false; continue }
                let id = l.windows.isEmpty ? nil : l.windows[r.below(l.windows.count)]
                l.reveal(id, area: area, gaps: gaps, minimums: minimums)
                let f = l.frames(in: area, gaps: gaps, minimums: minimums), name = "seed \(seed) step \(step)"
                XCTAssertEqual(Set(f.keys), there, name)
                if let id {
                    XCTAssertGreaterThanOrEqual(f[id]!.minX, area.minX, name)
                    XCTAssertLessThanOrEqual(f[id]!.maxX, area.maxX, name)
                }
                for (a, x) in f {
                    XCTAssertTrue(x.minY >= area.minY && x.maxY <= area.maxY, "\(name): \(x)")
                    for (b, y) in f where b > a { XCTAssertFalse(x.intersects(y), "\(name): \(a) \(x) over \(b) \(y)") }
                }
                var again = l
                again.reveal(id, area: area, gaps: gaps, minimums: minimums)
                XCTAssertEqual(again, l, "\(name): scrolled twice for one window")
                if testRun?.failureCount ?? 0 > 3 { return }
            }
        }
    }

    // MARK: Floating

    func testFloatingPutsEachBackOnceAndThenLeavesItAlone() {
        var f = fake(3, style: .dwindle)
        XCTAssertEqual(f.engine.run(.style(.floating), on: 1, focused: 3), .changed)
        f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame, CGRect(x: 64, y: 78, width: 700, height: 500))
        f.wins[2]!.w.frame = CGRect(x: 300, y: 300, width: 500, height: 400)
        f.writes = 0
        f.rest(); f.rest()
        XCTAssertEqual(f.writes, 0, "where the person put it")
        XCTAssertEqual(f.engine.run(.style(.columns), on: 1, focused: 3), .changed)
        f.rest()
        XCTAssertEqual(f.tiled(1).count, 3)
        _ = f.engine.run(.style(.floating), on: 1, focused: 3)
        f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame, CGRect(x: 300, y: 300, width: 500, height: 400), "and back there after tiling")
    }

    func testTurningOffFloatingLeavesEachWhereThePersonPutIt() {
        var f = fake(3, style: .floating)
        f.wins[1]!.w.frame = CGRect(x: -200, y: 300, width: 500, height: 400)
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.minX, -200, "half off the screen is where the person put it")
        XCTAssertEqual(f.writes, 0)
        f.wins[2]!.w.frame = CGRect(x: 300, y: 300, width: 500, height: 400)
        f.rest()
        f.engine.apply(TilingOptions())
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame, CGRect(x: 300, y: 300, width: 500, height: 400))
        XCTAssertEqual(f.writes, 0)
    }

    func testFloatingHasFocusByPlaceAndNothingToMove() {
        var f = fake(3, style: .floating)
        f.wins[1]!.w.frame = CGRect(x: 100, y: 100, width: 300, height: 300)
        f.wins[2]!.w.frame = CGRect(x: 600, y: 120, width: 300, height: 300)
        f.wins[3]!.w.frame = CGRect(x: 500, y: 700, width: 300, height: 300)
        f.rest()
        XCTAssertEqual(f.engine.run(.focus(.right), on: 1, focused: 1), .focus(2), "3 is nearer across but far down")
        XCTAssertEqual(f.engine.run(.focus(.down), on: 1, focused: 1), .focus(3))
        XCTAssertEqual(f.engine.run(.focus(.left), on: 1, focused: 1), .cross(.left, carrying: nil))
        XCTAssertEqual(f.engine.run(.cycle(backward: false), on: 1, focused: 3), .focus(1))
        XCTAssertEqual(f.engine.run(.grow(.right), on: 1, focused: 1), .nothing("windows float on this workspace"))
        XCTAssertNil(f.engine.tile(of: 1))
        XCTAssertNil(f.engine.dropFrame(1, at: CGPoint(x: 700, y: 300)))
        XCTAssertFalse(f.engine.resized(1, to: CGRect(x: 0, y: 25, width: 900, height: 900)))
    }

    func testAnyStyleGivesWayToAnyOther() {
        var f = fake(4, style: .dwindle)
        for s in TileStyle.allCases + TileStyle.allCases.reversed() {
            _ = f.engine.run(.style(s), on: 1, focused: 4)
            XCTAssertLessThan(f.rest(), 12, "\(s)")
            XCTAssertEqual(Set(f.tiled(1)), [1, 2, 3, 4], "\(s)")
        }
    }
}
