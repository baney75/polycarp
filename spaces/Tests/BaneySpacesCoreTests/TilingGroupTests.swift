import XCTest
@testable import BaneySpacesCore

/// A group: windows that share one tile, with a strip of tabs above it.
final class TilingGroupTests: XCTestCase {
    private func three(_ style: TileStyle = .columns) -> FakeWindows {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = style })
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        return f
    }

    private func run(_ f: inout FakeWindows, _ c: TilingCommand, _ id: WindowID? = nil) -> TilingOutcome {
        let out = f.engine.run(c, on: 1, focused: id ?? f.focused)
        if case .focus(let to) = out { f.engine.focused(to); f.focused = to }
        f.rest()
        return out
    }

    private func tabs(_ f: FakeWindows) -> [[WindowID]] { f.engine.tabs(1).map(\.windows) }
    private func frame(_ f: FakeWindows, _ id: WindowID) -> CGRect { f.wins[id]!.w.frame }

    func testAGroupIsOneTileWithAStripAboveIt() {
        var f = three()
        let tile = frame(f, 2)
        XCTAssertEqual(run(&f, .group, 2), .changed)
        XCTAssertEqual(tabs(f), [[2]])
        XCTAssertEqual(f.engine.tabs(1)[0].frame, CGRect(x: tile.minX, y: tile.minY, width: tile.width, height: 26))
        XCTAssertEqual(frame(f, 2), CGRect(x: tile.minX, y: tile.minY + 30, width: tile.width, height: tile.height - 30))
        XCTAssertEqual(run(&f, .join(.left), 3), .changed)
        XCTAssertEqual(tabs(f), [[2, 3]])
        XCTAssertEqual(f.engine.tabs(1)[0].front, 3)
        XCTAssertEqual(frame(f, 2), frame(f, 3), "they share the tile")
        XCTAssertEqual(f.tiled(1).sorted(), [1, 2, 3])
        XCTAssertEqual(frame(f, 1).width, frame(f, 2).width, accuracy: 1, "two tiles now")
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0)
    }

    func testJoiningATileMakesItAGroup() {
        var f = three()
        XCTAssertEqual(run(&f, .join(.left), 2), .changed)
        XCTAssertEqual(tabs(f), [[1, 2]])
        XCTAssertEqual(run(&f, .join(.left), 2), .changed, "in a group with another, out of it on that side")
        XCTAssertEqual(tabs(f), [[1]], "a group of one until it is taken apart")
        XCTAssertLessThan(frame(f, 2).midX, frame(f, 1).midX)
        XCTAssertEqual(run(&f, .join(.right), 3), .nothing("there is no window that way"))
        XCTAssertEqual(run(&f, .group, 1), .changed)
        XCTAssertEqual(tabs(f), [])
    }

    func testOutOfAGroupOnAnySide() {
        for d in TileDirection.allCases {
            var f = three(.dwindle)
            f.focused = 3
            XCTAssertEqual(run(&f, .group, 3), .changed)
            f.open(4); f.rest()
            XCTAssertEqual(tabs(f), [[3, 4]])
            f.focused = 4; f.rest()
            XCTAssertEqual(run(&f, .join(d), 4), .changed)
            let (a, b) = (frame(f, 3), frame(f, 4))
            switch d {
            case .left: XCTAssertLessThanOrEqual(b.maxX, a.minX)
            case .right: XCTAssertGreaterThanOrEqual(b.minX, a.maxX)
            case .up: XCTAssertLessThanOrEqual(b.maxY, a.minY)
            case .down: XCTAssertGreaterThanOrEqual(b.minY, a.maxY)
            }
        }
    }

    func testNextAndPreviousGoAroundItsTabs() {
        var f = three()
        XCTAssertEqual(run(&f, .groupCycle(backward: false), 1), .nothing("the window isn't in a group with another"))
        _ = run(&f, .join(.left), 2)
        XCTAssertEqual(run(&f, .groupCycle(backward: false), 2), .focus(1))
        XCTAssertEqual(f.engine.tabs(1)[0].front, 1)
        XCTAssertEqual(tabs(f), [[1, 2]], "the tabs keep their order")
        f.open(4); f.rest()
        XCTAssertEqual(tabs(f), [[1, 4, 2]], "after the one in front")
        XCTAssertEqual(f.engine.tabs(1)[0].front, 1, "until it has the focus")
        f.focused = 1; f.rest()
        XCTAssertEqual(run(&f, .groupCycle(backward: true), 1), .focus(2))
        XCTAssertEqual(run(&f, .groupCycle(backward: false), 2), .focus(1))
        XCTAssertEqual(run(&f, .groupCycle(backward: false), 1), .focus(4))
    }

    func testAWindowFocusedBehindItsTabComesToTheFront() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        XCTAssertTrue(f.engine.focused(1))
        XCTAssertEqual(f.engine.tabs(1)[0].front, 1)
        XCTAssertFalse(f.engine.focused(1))
        f.focused = 2; f.rest()
        XCTAssertEqual(f.engine.tabs(1)[0].front, 2)
        // A command on a hidden one acts on its tile.
        XCTAssertEqual(f.engine.run(.focus(.right), on: 1, focused: 1), .focus(3))
        XCTAssertEqual(f.engine.run(.cycle(backward: false), on: 1, focused: 3), .focus(1), "a group is one step")
    }

    func testTheNextTabShowsWhenOneCloses() {
        var f = three()
        _ = run(&f, .join(.left), 2); _ = run(&f, .join(.left), 3)
        XCTAssertEqual(tabs(f), [[1, 2, 3]])
        f.wins[2] = nil; f.rest()
        XCTAssertEqual(tabs(f), [[1, 3]])
        XCTAssertEqual(f.engine.tabs(1)[0].front, 3)
        f.wins[3] = nil; f.rest()
        XCTAssertEqual(f.engine.tabs(1)[0].front, 1, "the last one closed, so the one before")
        f.wins[1] = nil; f.rest()
        XCTAssertEqual(tabs(f), [])
        XCTAssertTrue(f.engine.slots.values.allSatisfy { $0.groups.isEmpty })
    }

    func testTheTabAfterTheOneThatClosedShows() {
        for (front, next) in [(WindowID(1), WindowID(2)), (2, 3), (3, 2)] {
            var f = three()
            _ = run(&f, .join(.left), 2); _ = run(&f, .join(.left), 3)
            f.focused = front; f.rest()
            f.focused = nil
            f.wins[front] = nil; f.rest()
            XCTAssertEqual(f.engine.tabs(1)[0].front, next, "\(front) closed")
            f.open(9); f.rest()
            XCTAssertEqual(tabs(f)[0].count, 3, "the tile is still the one in use")
            XCTAssertEqual(f.engine.tabs(1)[0].front, next, "one opened behind what has the focus stays behind")
        }
    }

    func testAShownTabIsTheOneInUse() {
        var f = three()
        f.focused = 2; f.rest()
        _ = run(&f, .join(.left))
        let key = f.engine.slots.keys.first!
        XCTAssertEqual(f.engine.slots[key]!.focused, 2)
        XCTAssertTrue(f.engine.slots[key]!.show(1))
        XCTAssertEqual(f.engine.slots[key]!.focused, 1)
    }

    func testAllOfAGroupComeBackToThePlaceItHad() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns })
        for id in WindowID(1)...5 { f.open(id); f.focused = id; f.rest() }
        _ = run(&f, .join(.left), 3)
        XCTAssertEqual(tabs(f), [[2, 3]])
        let was = f.wins.mapValues(\.w.frame)
        for order in [[WindowID(2), 3], [3, 2]] {
            f.focused = 5
            for id in [WindowID(2), 3] { f.wins[id]!.w.away = true }
            f.rest()
            for id in order { f.wins[id]!.w.away = false; f.rest() }
            XCTAssertEqual(f.wins.mapValues(\.w.frame), was, "\(order)")
            XCTAssertEqual(tabs(f), [[2, 3]])
        }
    }

    func testOneOfAGroupDroppedOnAnotherLeavesTheFirst() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns })
        for id in WindowID(1)...4 { f.open(id); f.focused = id; f.rest() }
        _ = run(&f, .join(.left), 2); _ = run(&f, .join(.left), 4)
        XCTAssertEqual(tabs(f), [[1, 2], [3, 4]])
        let strip = f.engine.tabs(1)[0].frame
        XCTAssertTrue(f.engine.drop(4, on: CGPoint(x: strip.midX, y: strip.midY)))
        f.rest()
        XCTAssertEqual(tabs(f), [[1, 2, 4], [3]])
    }

    func testAGroupScrolledOutOfSightOrTooLowHasNoStrip() {
        var f = three(.scrolling)
        f.displays = [CGRect(x: 0, y: 0, width: 1728, height: 1117)]
        f.corner = CGPoint(x: 1727, y: 1100)
        f.focused = 1; f.rest()
        _ = run(&f, .group, 1)
        XCTAssertEqual(tabs(f), [[1]])
        f.focused = 3; f.rest()
        XCTAssertNotNil(f.engine.stowed[1])
        XCTAssertEqual(tabs(f), [])
        f = FakeWindows(area: CGRect(x: 0, y: 0, width: 1728, height: 110))
        f.open(1); f.focused = 1; f.rest()
        _ = run(&f, .group, 1)
        XCTAssertEqual(tabs(f), [], "a low tile keeps its height")
        XCTAssertGreaterThan(frame(f, 1).height, 90)
    }

    func testOneThatComesBackFromTheDockIsInItsGroupAgain() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        f.wins[2]!.w.away = true; f.rest()
        XCTAssertEqual(tabs(f), [[1]])
        f.focused = 3
        f.wins[2]!.w.away = false; f.rest()
        XCTAssertEqual(tabs(f), [[1, 2]])
        // All of them at once, and back one by one.
        f.wins[1]!.w.away = true; f.wins[2]!.w.away = true; f.rest()
        XCTAssertEqual(tabs(f), [])
        XCTAssertEqual(f.tiled(1), [3])
        f.wins[1]!.w.away = false; f.rest()
        f.wins[2]!.w.away = false; f.rest()
        XCTAssertEqual(tabs(f), [[1, 2]])
        XCTAssertLessThan(frame(f, 1).minX, frame(f, 3).minX, "in the place they left")
    }

    func testAFrontBackFromTheDockAfterItsLastMateClosedHasATile() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        XCTAssertEqual(f.engine.tabs(1)[0].front, 2)
        f.wins[2]!.w.away = true; f.rest()
        f.wins[1] = nil; f.focused = 3; f.rest()
        f.wins[2]!.w.away = false; f.rest()
        XCTAssertEqual(f.tiled(1).sorted(), [2, 3])
        XCTAssertLessThan(frame(f, 2).minX, frame(f, 3).minX, "in the place it left")
        XCTAssertEqual(tabs(f), [[2]], "a group of one until it is taken apart")
    }

    func testAStripShowsATabPerWindowNamedByTitleOrApp() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        let tabs = f.engine.tabs(1)
        let names: [WindowID: (title: String, app: String, pid: Int32)] = [1: ("Notes", "TextEdit", 11), 2: ("", "Terminal", 22)]
        let drawn = TilingTabs.drawn(tabs, moving: nil) { names[$0]! }
        XCTAssertEqual(drawn, [TilingTabs.Drawn(frame: tabs[0].frame, tabs: [
            .init(id: 1, title: "Notes", pid: 11, front: false),
            .init(id: 2, title: "Terminal", pid: 22, front: true),
        ])], "a window with no title goes by its app")
        XCTAssertEqual(TilingTabs.drawn(tabs, moving: 2) { names[$0]! }, [], "none while its front is dragged")
        XCTAssertEqual(TilingTabs.drawn(tabs, moving: 1) { names[$0]! }.count, 1, "a window behind it on the move leaves it")
    }

    func testAGroupOfOneIsOneAgainWhenItComesBack() {
        var f = three()
        _ = run(&f, .group, 1)
        f.wins[1]!.w.away = true; f.rest()
        XCTAssertEqual(tabs(f), [])
        f.wins[1]!.w.away = false; f.rest()
        XCTAssertEqual(tabs(f), [[1]])
    }

    func testAWindowDraggedFromAnotherDisplayLandsWhereItWasLetGoNotInTheGroup() {
        var f = three()
        f.focused = 3
        _ = run(&f, .group, 3)
        f.open(9, workspace: 2)
        f.rest()
        let left = frame(f, 1)
        f.engine.lands(9, at: CGPoint(x: left.minX + 4, y: left.midY))
        f.wins[9]!.w.workspace = 1
        f.rest()
        XCTAssertEqual(tabs(f), [[3]])
        XCTAssertLessThan(frame(f, 9).midX, frame(f, 1).midX)
    }

    func testTakenApartItsWindowsStandBesideEachOther() {
        var f = three()
        _ = run(&f, .join(.left), 2); _ = run(&f, .join(.left), 3)
        XCTAssertEqual(run(&f, .group, 2), .changed)
        XCTAssertEqual(tabs(f), [])
        XCTAssertEqual(Set(f.engine.frames(1).values.map { "\($0)" }).count, 3)
        XCTAssertEqual(f.engine.slots.values.first!.layout.windows, [1, 2, 3], "in the order of their tabs")
        // Three of five, the rest where they were.
        f = three()
        f.focused = 2; f.rest()
        _ = run(&f, .join(.left))
        f.open(9); f.rest()
        XCTAssertEqual(tabs(f), [[1, 2, 9]])
        f.focused = 3; f.rest()
        XCTAssertEqual(run(&f, .group, 2), .changed)
        XCTAssertEqual(f.engine.slots.values.first!.layout.windows, [1, 2, 9, 3])
    }

    func testItsSmallestSizeIsTheLargestOfItsWindows() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns })
        f.open(1); f.focused = 1; f.rest()
        f.open(2, least: CGSize(width: 1100, height: 200)); f.focused = 2; f.rest()
        f.open(3); f.focused = 3; f.rest()
        _ = run(&f, .join(.left), 3)
        XCTAssertEqual(f.engine.tabs(1)[0].front, 3)
        XCTAssertEqual(frame(f, 3).width, 1100, "the one behind needs it")
        let slot = f.engine.slots.values.first!
        XCTAssertEqual(f.engine.needs(slot)[3], CGSize(width: 1100, height: TilingGroup.strip))
    }

    func testDroppingOnAStripJoinsIt() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        let strip = f.engine.tabs(1)[0].frame
        let p = CGPoint(x: strip.midX, y: strip.midY)
        XCTAssertEqual(f.engine.dropFrame(3, at: p), strip)
        XCTAssertTrue(f.engine.drop(3, on: p))
        f.rest()
        XCTAssertEqual(tabs(f), [[1, 2, 3]])
        XCTAssertEqual(f.engine.tabs(1)[0].front, 3)
        let own = f.engine.tabs(1)[0].frame
        XCTAssertNil(f.engine.dropFrame(3, at: CGPoint(x: own.midX, y: own.midY)), "its own strip is its own tile")
        f.engine.drop(3, on: CGPoint(x: own.midX, y: own.midY))
        f.rest()
        XCTAssertEqual(tabs(f), [[1, 2, 3]])
    }

    func testADropShowsTheWindowAtOnceAndAWorkspaceOutOfSightTakesNone() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        let strip = f.engine.tabs(1)[0].frame
        let p = CGPoint(x: strip.midX, y: strip.midY)
        var away = f
        away.shown = [:]
        away.look()
        XCTAssertNotEqual(away.engine.dropFrame(3, at: p), strip)
        XCTAssertTrue(f.engine.drop(3, on: p))
        XCTAssertEqual(f.engine.tabs(1)[0].front, 3, "before any look")
        XCTAssertEqual(f.engine.last(on: 1), 3)
        XCTAssertEqual(f.engine.run(.join(.right), on: 1, focused: 3), .changed)
        XCTAssertEqual(f.engine.last(on: 1), 3, "out of the group it is still the one in use")
    }

    func testAWindowAloneInItsGroupJoinsTheTileThatWay() {
        var f = three()
        _ = run(&f, .group, 2)
        XCTAssertEqual(run(&f, .join(.left), 2), .changed)
        XCTAssertEqual(tabs(f), [[1, 2]])
    }

    func testAGroupIsDraggedAndResizedAsOne() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        let there = frame(f, 3)
        XCTAssertTrue(f.engine.drop(2, on: CGPoint(x: there.midX, y: there.midY)))
        f.rest()
        XCTAssertEqual(tabs(f), [[1, 2]])
        XCTAssertGreaterThan(frame(f, 1).minX, frame(f, 3).minX)
        XCTAssertEqual(frame(f, 1), frame(f, 2))
        let was = frame(f, 2)
        var pulled = was
        pulled.origin.x -= 100; pulled.size.width += 100
        f.wins[2]!.w.frame = pulled
        XCTAssertTrue(f.engine.resized(2, to: pulled, from: was))
        f.rest()
        XCTAssertEqual(frame(f, 2), pulled, "its strip isn't taken for a pulled top edge")
        XCTAssertEqual(frame(f, 1), pulled)
    }

    func testTheTopOfAGroupPulledDownMovesItsTile() {
        var f = three(.dwindle)
        f.focused = 3
        _ = run(&f, .group, 3)
        let was = frame(f, 3), above = frame(f, 2)
        var pulled = was
        pulled.origin.y += 90; pulled.size.height -= 90
        f.wins[3]!.w.frame = pulled
        XCTAssertTrue(f.engine.resized(3, to: pulled, from: was))
        f.rest()
        XCTAssertEqual(frame(f, 3), pulled)
        XCTAssertEqual(frame(f, 2).height, above.height + 90, accuracy: 1)
    }

    func testOneMemberFloatedLeavesTheRest() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        XCTAssertEqual(run(&f, .float, 2), .changed)
        XCTAssertEqual(tabs(f), [[1]])
        XCTAssertFalse(f.tiled(1).contains(2))
        XCTAssertEqual(run(&f, .float, 2), .changed)
        XCTAssertTrue(f.tiled(1).contains(2))
    }

    func testAMemberSentToAnotherWorkspaceLeavesIt() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        f.wins[2]!.w.workspace = 2; f.rest()
        XCTAssertEqual(tabs(f), [[1]])
        XCTAssertEqual(f.tiled(1).sorted(), [1, 3])
    }

    func testANativeTabKeepsItsPlaceInTheGroup() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        var w = f.wins.removeValue(forKey: 2)!
        w.w.id = 9
        f.wins[9] = w
        f.focused = 9
        f.rest()
        XCTAssertEqual(tabs(f), [[1, 9]])
        XCTAssertEqual(f.engine.tabs(1)[0].front, 9)
    }

    func testAStripIsDrawnOnlyWhereItShows() {
        var f = three()
        _ = run(&f, .join(.left), 2)
        _ = run(&f, .full)
        XCTAssertEqual(tabs(f), [], "another tile's window lies over it")
        XCTAssertEqual(frame(f, 2).height, frame(f, 3).height)
        _ = run(&f, .full)
        XCTAssertEqual(tabs(f), [[1, 2]])
        _ = run(&f, .style(.floating))
        XCTAssertEqual(tabs(f), [], "no tiles to put one above")
        _ = run(&f, .style(.columns))
        XCTAssertEqual(tabs(f), [[1, 2]], "kept for when there are")
        f.engine.apply(FakeWindows.options { $0.off = [1] })
        XCTAssertEqual(tabs(f), [])
    }

    func testALowTileKeepsItsHeight() {
        XCTAssertEqual(TilingGroup.inner(CGRect(x: 0, y: 0, width: 300, height: 119)), CGRect(x: 0, y: 0, width: 300, height: 119))
        XCTAssertEqual(TilingGroup.inner(CGRect(x: 5, y: 7, width: 300, height: 120)), CGRect(x: 5, y: 37, width: 300, height: 90))
    }

    func testItsTabsAreKeptAcrossARestart() throws {
        var f = three()
        _ = run(&f, .join(.left), 2)
        let slot = f.engine.slots.values.first!
        XCTAssertEqual(slot.groups.map(\.members), [[1, 2]])
        XCTAssertEqual(slot.layout.windows, [2, 3])
        var again = TilingEngine.Slot(layout: slot.layout)
        again.restore([[1, 2], [1, 9], [3, 2], [7, 8]])
        XCTAssertEqual(again.groups.map(\.members), [[1, 2]], "one front each, and a window in one group")
        again.groups = []
        again.restore([[1, 2], [1, 3]])
        XCTAssertEqual(again.groups.map(\.members), [[1, 2]], "a hidden window in two")
        again.groups = []
        again.restore([[2, 3]])
        XCTAssertEqual(again.groups, [], "two fronts aren't a group")
    }
}
