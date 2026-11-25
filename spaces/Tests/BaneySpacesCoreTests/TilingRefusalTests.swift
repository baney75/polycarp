import XCTest
@testable import BaneySpacesCore

/// Apps that keep their own size, put a window back or never move one: each is asked a few times and then left alone.
final class TilingRefusalTests: XCTestCase {
    private func two() -> FakeWindows {
        var f = FakeWindows()
        f.open(1); f.open(2)
        f.focused = 1
        f.rest()
        return f
    }

    func testAMinimumIsLearnedAndTheLayoutSolvedOnceMore() {
        var f = FakeWindows()
        f.open(1, least: CGSize(width: 1100, height: 200)); f.open(2)
        f.look()
        XCTAssertEqual(f.engine.minimums[1]?.width, 1100)
        XCTAssertEqual(f.log.filter { $0.0.id == 1 }.count, 1, "it took another size, so that is its answer")
        XCTAssertEqual(f.wins[2]!.w.frame, CGRect(x: 1116, y: 33, width: 604, height: 1034))
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0)
    }

    func testAMinimumTooBigWasTheAppBeingBusy() {
        var f = FakeWindows()
        f.open(1, least: CGSize(width: 1100, height: 200)); f.open(2)
        f.look()
        f.wins[1]!.least.width = 300
        f.wins[1]!.w.frame.size.width = 852
        f.rest()
        XCTAssertLessThanOrEqual(f.engine.minimums[1]!.width, 852)
    }

    func testAWindowThatNeverMovesIsAskedThreeTimesAtMost() {
        var f = two()
        f.open(3); f.wins[3]!.stuck = true
        for _ in 0..<20 { f.look() }
        XCTAssertLessThanOrEqual(f.log.filter { $0.0.id == 3 }.count, TilingEngine.mostTries + TilingEngine.mostLessons)
        // After that its size is its own, and the others make room.
        f = two()
        f.open(3, frame: CGRect(x: 100, y: 100, width: 1200, height: 900)); f.wins[3]!.stuck = true; f.focused = 3
        for _ in 0..<5 { f.look() }
        XCTAssertEqual(f.engine.minimums[3]?.width, 1200)
        XCTAssertEqual(f.engine.frames(1)[3]?.width, 1200)
    }

    func testAnAppThatPutsItsWindowBackIsNotFought() {
        var f = two()
        f.wins[2]!.stubborn = CGRect(x: 500, y: 300, width: 400, height: 300)
        f.wins[2]!.w.frame = f.wins[2]!.stubborn!
        f.log = []
        for n in 0..<30 {
            f.wins[2]!.w.frame.origin.x = 500 + CGFloat(n * 7)
            f.look()
        }
        XCTAssertLessThanOrEqual(f.log.filter { $0.0.id == 2 }.count, TilingEngine.mostTries)
        f.engine.touched(2)
        f.look()
        XCTAssertGreaterThan(f.log.filter { $0.0.id == 2 }.count, TilingEngine.mostTries - 1, "the person's own move asks again")
    }

    func testAWindowThatRoundsToItsGridIsLeftThere() {
        var f = two()
        f.open(3); f.wins[3]!.grid = 17
        f.rest()
        XCTAssertEqual(f.log.filter { $0.0.id == 3 }.count, 1)
        f.writes = 0
        for _ in 0..<5 { f.look() }
        XCTAssertEqual(f.writes, 0)
    }

    func testWindowsThatCannotFitStackAndSpreadOutAgain() {
        var f = FakeWindows()
        for id in WindowID(1)...3 { f.open(id, least: CGSize(width: 800, height: 600)); f.focused = id; f.rest() }
        let t = f.engine.frames(1)
        XCTAssertEqual(Set(t.values.map { "\($0)" }).count, 2, "two fit; the third shares a tile")
        XCTAssertNotEqual(t[3], t[2], "the window in use keeps a tile of its own beside \(t)")
        f.shown[1]!.area.size = CGSize(width: 3000, height: 1600)
        f.rest()
        XCTAssertEqual(Set(f.engine.frames(1).values.map { "\($0)" }).count, 3)
    }

    func testOneUsedLeastKeepsItsTileWhenItsAbsenceDoesNotHelp() {
        var f = FakeWindows()
        f.open(1, least: CGSize(width: 1200, height: 200)); f.open(2, least: CGSize(width: 1200, height: 200)); f.open(3)
        f.rest()
        for id in [WindowID(3), 2, 1] { f.focused = id; f.rest() }
        let t = f.engine.frames(1)
        XCTAssertEqual(t[2], t[1], "two that wide can't stand side by side")
        XCTAssertNotEqual(t[3], t[1], "the third fits beside them")
        XCTAssertEqual(f.wins[3]!.w.frame, t[3])
        // Where only one more fits, it is the one used later.
        f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns })
        for (id, w) in [(WindowID(1), 1000.0), (2, 1200), (3, 400), (4, 400)] { f.open(id, least: CGSize(width: w, height: 200)) }
        f.rest()
        for id in [WindowID(4), 3, 2, 1] { f.focused = id; f.rest() }
        let c = f.engine.frames(1)
        XCTAssertNotEqual(c[3], c[1])
        XCTAssertEqual(c[4], c[3])
    }

    func testAMinimumSeenToBeWrongCountsNoMoreInTheSameLook() {
        var f = FakeWindows()
        f.open(1, least: CGSize(width: 1100, height: 200)); f.open(2)
        f.rest()
        f.wins[1]!.w.frame.size.width = 500
        f.engine.touched(1)
        XCTAssertEqual(f.engine.plan(f.shot).first { $0.id == 1 }?.to.width, 852)
    }

    func testASizeThatComesLateIsNoMinimum() {
        var f = FakeWindows()
        f.open(1, frame: CGRect(x: 100, y: 100, width: 1300, height: 900)); f.open(2)
        f.wins[1]!.slow = 1
        f.look()
        XCTAssertNil(f.engine.minimums[1])
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 868, y: 33, width: 852, height: 1034))
        // Its height alone.
        f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .main })
        f.open(1, frame: CGRect(x: 0, y: 100, width: 700, height: 900))
        f.open(2, frame: CGRect(x: 10, y: 100, width: 700, height: 900)); f.open(3, frame: CGRect(x: 20, y: 100, width: 700, height: 900))
        f.wins[3]!.slow = 1
        f.look()
        XCTAssertNil(f.engine.minimums[3])
        // One that keeps its size when asked twice has that minimum, in the same look.
        f = FakeWindows()
        f.open(1, frame: CGRect(x: 100, y: 100, width: 1300, height: 900)); f.open(2)
        f.wins[1]!.slow = 9
        f.look()
        XCTAssertEqual(f.engine.minimums[1]?.width, 1300)
        XCTAssertEqual(f.log.filter { $0.0.id == 1 }.count, 3, "twice for the first tile, once for the one that fits")
    }

    func testAFrameFromBeforeIsOwedUntilTheWindowHasItsSizeToo() {
        var f = two()
        let was = f.engine.before[1]!
        f.wins[1]!.slow = 1
        f.engine.apply(TilingOptions())
        f.look()
        XCTAssertEqual(f.wins[1]!.w.frame, was)
        XCTAssertNil(f.engine.before[1])
        // Asked three times at most.
        f = two()
        f.wins[1]!.slow = 99
        f.log = []
        f.engine.apply(TilingOptions())
        for _ in 0..<9 { f.look() }
        XCTAssertEqual(f.log.filter { $0.0.id == 1 }.count, TilingEngine.mostTries)
        XCTAssertNil(f.engine.before[1])
    }

    func testTiledAgainBeforeItWasBackItsFrameFromBeforeIsKept() {
        var f = two()
        let was = f.engine.before[1]!
        f.wins[1]!.busy = 1
        f.engine.apply(TilingOptions())
        _ = f.engine.landed(Dictionary(uniqueKeysWithValues: f.engine.plan(f.shot).map { ($0.id, f.wins[$0.id]!.w.frame) }))
        XCTAssertEqual(f.engine.asked[1]?.back, true)
        f.engine.apply(FakeWindows.options())
        f.rest()
        f.engine.touched(1)
        f.rest()
        XCTAssertEqual(f.engine.before[1], was)
    }

    func testAWindowThatSharesATileStaysOnTheDisplay() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns })
        for (id, w) in [(WindowID(1), 1000.0), (2, 400), (3, 1200)] { f.open(id, least: CGSize(width: w, height: 200)) }
        f.rest()
        for id in [WindowID(3), 2, 1] { f.focused = id; f.rest() }
        let t = f.engine.frames(1)
        XCTAssertEqual(t[3], CGRect(x: 520, y: 33, width: 1200, height: 1034))
        XCTAssertEqual(f.wins[3]!.w.frame, t[3])
        // Its height too.
        f = FakeWindows(area: CGRect(x: 0, y: 25, width: 900, height: 700))
        f.engine.apply(FakeWindows.options { $0.style = .main })
        for (id, h) in [(WindowID(1), 200.0), (2, 200), (3, 200), (4, 600)] { f.open(id, least: CGSize(width: 100, height: h)) }
        f.rest()
        for id in [WindowID(4), 3, 2, 1] { f.focused = id; f.rest() }
        XCTAssertEqual(f.engine.frames(1)[3]?.minY, 379)
        XCTAssertEqual(f.engine.frames(1)[4]?.minY, 117)
        XCTAssertEqual(f.engine.frames(1)[4]?.height, 600)
    }

    func testAnAppBusyForOneWriteTeachesNothing() {
        var f = FakeWindows()
        f.open(1, frame: CGRect(x: 100, y: 100, width: 1300, height: 900)); f.open(2)
        f.wins[1]!.busy = 1
        f.look()
        XCTAssertNil(f.engine.minimums[1])
        XCTAssertEqual(f.wins[1]!.w.frame, f.engine.frames(1)[1])
        // Busy for two, it is there after the next look.
        f = FakeWindows()
        f.open(1, frame: CGRect(x: 100, y: 100, width: 1300, height: 900)); f.open(2)
        f.wins[1]!.busy = 2
        f.look(); f.look()
        XCTAssertNil(f.engine.minimums[1])
        XCTAssertEqual(f.wins[1]!.w.frame, f.engine.frames(1)[1])
    }

    func testAFrameFromBeforeIsOwedUntilABusyAppTakesIt() {
        for busy in 1...2 {
            var f = two()
            let was = f.engine.before
            f.wins[1]!.busy = busy
            f.engine.apply(TilingOptions())
            f.look(); f.look()
            XCTAssertEqual(f.wins.mapValues(\.w.frame), was, "busy for \(busy)")
            XCTAssertTrue(f.engine.before.isEmpty)
        }
        var f = two()
        f.wins[1]!.stuck = true
        f.engine.apply(TilingOptions())
        f.log = []
        for _ in 0..<9 { f.look() }
        XCTAssertEqual(f.log.filter { $0.0.id == 1 }.count, TilingEngine.mostTries, "and given up on when it never does")
        XCTAssertFalse(f.engine.wanted(on: [1]))
    }

    func testAPersonsDragEndsAWindowsWayBack() {
        var f = two()
        f.wins[1]!.busy = 2
        f.engine.apply(TilingOptions())
        f.look()
        f.engine.touched(1)
        let put = CGRect(x: 600, y: 400, width: 500, height: 300)
        f.wins[1]!.w.frame = put
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame, put)
        // A tiled window's drag ends nothing.
        f = two()
        let was = f.engine.before
        f.engine.touched(1)
        XCTAssertEqual(f.engine.before, was)
        // Back where it was, it goes where it is put from then on.
        f = two()
        f.engine.apply(TilingOptions())
        f.look()
        f.wins[1]!.w.frame = put
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame, put)
    }

    func testAWindowThatRoundsUpGetsThatMuchRoomAndNoMinimum() {
        var f = FakeWindows()
        f.open(1); f.open(2)
        f.wins[1]!.grid = 17; f.wins[1]!.roundsUp = true
        for width in [1728.0, 1900, 2300, 1610, 1728] {
            f.shown[1]!.area.size.width = width
            f.rest()
            XCTAssertNil(f.engine.minimums[1])
            let a = f.wins[1]!.w.frame, b = f.wins[2]!.w.frame
            XCTAssertEqual(b.minX - a.maxX, 8, accuracy: 1, "\(width): \(a) \(b)")
            XCTAssertEqual(a.maxY, 1074, accuracy: 17)
            XCTAssertLessThan(a.width - b.width, 40, "only as much as its grid needs")
            XCTAssertTrue(f.shown[1]!.area.contains(f.engine.frames(1)[1]!), "and never past the area")
        }
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0)
        // Its next tab rounds the same, so it isn't asked what is known.
        f.open(50, frame: f.wins[1]!.w.frame); f.wins[50]!.grid = 17; f.wins[50]!.roundsUp = true; f.wins[1] = nil
        f.rest()
        XCTAssertEqual(f.writes, 0)
        f.wins[50] = nil
        f.rest()
        XCTAssertTrue(f.engine.rounded.isEmpty)
        // Never at the cost of another's minimum.
        f = FakeWindows()
        f.open(1, least: CGSize(width: 1300, height: 200)); f.open(2, least: CGSize(width: 404, height: 200))
        f.rest()
        f.wins[2]!.grid = 17; f.wins[2]!.roundsUp = true
        f.shown[1]!.area.origin.x = 20
        f.rest()
        XCTAssertEqual(f.engine.rounded[2]?.width, 408)
        XCTAssertEqual(f.engine.frames(1)[1]?.width, 1300)
    }

    func testOneThatWontKeepToItsOwnRoundingIsLeftAlone() {
        for size in [CGSize(width: 1728, height: 1050), CGSize(width: 1050, height: 1728)] {
            var f = FakeWindows(area: CGRect(origin: .zero, size: size))
            f.open(1); f.open(2)
            f.rest()
            for n in 0..<9 {
                // The area moves under it, so it is asked again each time.
                f.shown[1]!.area.origin.y = CGFloat(n % 2) * 30
                var asked = 0
                for _ in 0..<20 {
                    let moves = f.engine.plan(f.shot)
                    asked += moves.filter { $0.id == 1 }.count
                    for m in moves {
                        f.wins[m.id]!.w.frame = m.to
                        if m.id == 1 { size.width > size.height ? (f.wins[1]!.w.frame.size.width += 6) : (f.wins[1]!.w.frame.size.height += 6) }
                    }
                    if moves.isEmpty || !f.engine.landed(f.wins.mapValues(\.w.frame)) { break }
                }
                XCTAssertLessThanOrEqual(asked, TilingEngine.mostLessons + 1, "round \(n)")
                XCTAssertEqual(f.engine.plan(f.shot), [])
            }
            XCTAssertNil(f.engine.minimums[1])
            XCTAssertNil(f.engine.lessons[1], "rounding never spends what a minimum may need")
        }
    }

    func testOneThatGrowsPastEverySizeTeachesThreeMinimumsAtMost() {
        for size in [CGSize(width: 1728, height: 1050), CGSize(width: 1050, height: 1728)] {
            var f = FakeWindows(area: CGRect(origin: .zero, size: size))
            f.open(1); f.open(2)
            f.rest()
            let wide = size.width > size.height
            for n in 0..<9 {
                // The area moves under it, so it is asked again each time, and it lands wider (or higher) than asked.
                f.shown[1]!.area.origin.y = CGFloat(n % 2 + 1) * 30
                var looks = 0
                for _ in 0..<20 {
                    looks += 1
                    let moves = f.engine.plan(f.shot)
                    for m in moves {
                        f.wins[m.id]!.w.frame = m.to
                        if m.id == 1 { wide ? (f.wins[1]!.w.frame.size.width += 40) : (f.wins[1]!.w.frame.size.height += 40) }
                    }
                    if moves.isEmpty || !f.engine.landed(f.wins.mapValues(\.w.frame)) { break }
                }
                XCTAssertLessThan(looks, 20, "\(size) round \(n): it never stops asking")
            }
            XCTAssertEqual(f.engine.lessons[1], TilingEngine.mostLessons, "\(size)")
            let least = f.engine.minimums[1] ?? .zero
            XCTAssertLessThanOrEqual(wide ? least.width : least.height, 852 + 40 * Double(TilingEngine.mostLessons), "\(size): \(least)")
        }
    }
}
