import XCTest
@testable import BaneySpacesCore

final class TilingPopTests: XCTestCase {
    private func three(_ style: TileStyle = .columns) -> FakeWindows {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = style })
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        return f
    }

    private func pop(_ f: inout FakeWindows, _ id: WindowID, sized: Bool = true) {
        f.engine.popOut(id, sized: sized)
        f.wins[id]!.w.over = .pinned
        f.rest()
    }

    func testTheCommandsNeedAWindowAndAPersonsWorkspace() {
        var f = three()
        XCTAssertEqual(f.engine.run(.pop, on: 1, focused: 2), .pin(2, sized: true))
        XCTAssertEqual(f.engine.run(.pin, on: 1, focused: 2), .pin(2, sized: false))
        XCTAssertEqual(f.engine.run(.pin, on: 1, focused: nil), .nothing("no window is in front"))
        f.engine.apply(FakeWindows.options { $0.everywhere = false; $0.agentWorkspace = 9 })
        XCTAssertEqual(f.engine.run(.pin, on: 1, focused: 77), .pin(77, sized: false), "on a workspace that doesn't tile too")
        XCTAssertEqual(f.engine.run(.pop, on: 9, focused: 77), .nothing("a window of the agent workspace stays there"))
    }

    func testAPoppedOutWindowFloatsInTheMiddleAndComesBackToItsPlace() {
        var f = three()
        let was = f.engine.frames(1), own = f.engine.before[2]
        pop(&f, 2)
        XCTAssertEqual(f.tiled(1), [1, 3])
        XCTAssertEqual(f.wins[2]!.w.frame, CGRect(x: 216, y: 130, width: 1296, height: 840))
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0, "it is placed once")
        f.wins[2]!.w.over = nil
        f.rest()
        XCTAssertEqual(f.engine.frames(1), was)
        XCTAssertEqual(f.engine.before[2], own, "untiling still gives it the frame it came with")
    }

    func testOnABigDisplayItHasItsOwnSize() {
        var f = FakeWindows(area: CGRect(x: 100, y: 0, width: 3440, height: 1440))
        f.open(1); f.open(2); f.rest()
        pop(&f, 1)
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 1170, y: 270, width: 1300, height: 900))
    }

    func testAPinnedWindowStaysWhereItIs() {
        var f = three()
        let tile = f.wins[2]!.w.frame
        pop(&f, 2, sized: false)
        XCTAssertEqual(f.wins[2]!.w.frame, tile)
        XCTAssertEqual(f.tiled(1), [1, 3])
    }

    func testAFixedWindowKeepsItsSize() {
        var f = three()
        f.open(4); f.wins[4]!.w.fixed = true
        let was = f.wins[4]!.w.frame
        f.rest()
        pop(&f, 4)
        XCTAssertEqual(f.wins[4]!.w.frame, was)
    }

    func testOnAnotherWorkspaceItIsNoOnesTileAndItsOldPlaceWaits() {
        var f = three()
        let was = f.engine.frames(1)
        pop(&f, 2)
        f.open(7, workspace: 2)
        f.wins[2]!.w.workspace = 2
        f.shown = [2: f.shown[1]!]
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.tiled(2), [7])
        XCTAssertFalse(f.log.contains { $0.0.id == 2 && $0.1.w.workspace == 2 })
        f.wins[2]!.w.workspace = 1
        f.wins[2]!.w.over = nil
        f.shown = [1: f.shown[2]!]
        f.rest()
        XCTAssertEqual(f.engine.frames(1), was)
    }

    func testLetGoOnAnotherWorkspaceItTilesThere() {
        var f = three()
        pop(&f, 2)
        f.open(7, workspace: 2)
        f.wins[2]!.w.workspace = 2
        f.wins[2]!.w.over = nil
        f.shown = [2: f.shown[1]!]
        f.rest()
        XCTAssertEqual(f.tiled(2).sorted(), [2, 7])
        f.shown = [1: f.shown[2]!]
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 3])
    }

    func testAFloatedWindowGoesBackToItsPlaceToo() {
        var f = three(.dwindle)
        let was = f.engine.frames(1)
        XCTAssertEqual(f.engine.run(.float, on: 1, focused: 2), .changed)
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 3])
        XCTAssertEqual(f.engine.run(.float, on: 1, focused: 2), .changed)
        f.rest()
        XCTAssertEqual(f.engine.frames(1), was)
    }

    func testWithTheLayoutChangedItGoesBesideItsOldNeighbor() {
        var f = three()
        f.engine.setFloating(2, true)
        f.rest()
        XCTAssertEqual(f.engine.run(.style(.dwindle), on: 1, focused: 3), .changed)
        f.engine.setFloating(2, false)
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2, 3])
    }

    func testAGroupedWindowGoesBackIntoItsGroup() {
        var f = three()
        f.focused = 2
        XCTAssertEqual(f.engine.run(.group, on: 1, focused: 2), .changed)
        XCTAssertEqual(f.engine.run(.join(.left), on: 1, focused: 3), .changed)
        f.focused = 3
        f.rest()
        let groups = f.engine.slots.values.first!.groups
        XCTAssertEqual(groups.map(\.members.count), [2])
        pop(&f, 3)
        f.focused = 1
        f.wins[3]!.w.over = nil
        f.rest()
        XCTAssertEqual(f.engine.slots.values.first!.groups, groups)
    }

    func testFloatLetsAPinnedWindowGoAndTilesIt() {
        var f = three()
        pop(&f, 2)
        XCTAssertEqual(f.engine.run(.float, on: 1, focused: 2), .pin(2, sized: false))
        f.wins[2]!.w.over = nil
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2, 3])
        f.open(4, bundle: "float")
        f.engine.apply(FakeWindows.options { $0.style = .columns; $0.floatApps = ["float"] })
        f.wins[4]!.w.over = .pinned
        f.rest()
        XCTAssertEqual(f.engine.run(.float, on: 1, focused: 4), .pin(4, sized: false))
        f.wins[4]!.w.over = nil
        f.rest()
        XCTAssertTrue(f.tiled(1).contains(4), "whatever its app's rule says")
    }

    func testPinnedAndLetGoAgainAndAgainItIsStillPutBack() {
        var f = three()
        let tile = f.wins[2]!.w.frame
        for n in 0..<8 {
            pop(&f, 2, sized: false)
            f.wins[2]!.w.frame = CGRect(x: 300 + n * 10, y: 200, width: 400, height: 300)
            f.wins[2]!.w.over = nil
            f.rest()
            XCTAssertEqual(f.wins[2]!.w.frame, tile, "time \(n)")
        }
    }

    func testMinimizedWhilePinnedItStillComesBackToItsPlace() {
        var f = three()
        let was = f.engine.frames(1)
        pop(&f, 2)
        f.wins[2]!.w.away = true
        f.rest()
        f.wins[2]!.w.away = false
        f.wins[2]!.w.over = nil
        f.rest()
        XCTAssertEqual(f.engine.frames(1), was)
    }

    func testClosedItsPlaceIsForgotten() {
        var f = three()
        pop(&f, 2)
        f.wins[2] = nil
        f.rest()
        XCTAssertEqual(f.engine.slots.values.first!.away.count, 0)
    }

    func testAWindowFloatingAloneIsNoLayoutToComeBackTo() {
        var f = FakeWindows()
        f.open(1); f.rest()
        pop(&f, 1)
        // The first of a fresh layout stand in the order they are on screen.
        f.open(8, frame: CGRect(x: 900, y: 50, width: 300, height: 300))
        f.open(9, frame: CGRect(x: 10, y: 50, width: 300, height: 300))
        f.rest()
        XCTAssertEqual(f.tiled(1), [9, 8])
    }

    func testAFloatingWindowIsSavedAsOneAndNotAsATile() {
        var f = three()
        f.engine.setFloating(2, true)
        f.rest()
        let saved = f.engine.saved {
            WindowRecord(bundle: "app", title: "t", order: 0, workspace: 1, frame: nil, displays: [], window: $0, pid: 100, at: 1, key: Data())
        }
        XCTAssertEqual(saved.slots.first?.layout.windows, [1, 3])
        XCTAssertEqual(saved.windows.first { $0.record.window == 2 }?.floats, true)
    }

    func testAnotherTabOfAPinnedWindowIsNotTiled() {
        var f = three()
        let own = f.engine.before[2]
        pop(&f, 2)
        var tab = f.wins.removeValue(forKey: 2)!
        tab.w.id = 20
        tab.w.over = nil
        f.wins[20] = tab
        f.writes = 0
        f.look()
        XCTAssertEqual(f.engine.swaps, [2: 20])
        XCTAssertEqual(f.engine.run(.float, on: 1, focused: 20), .pin(20, sized: false))
        XCTAssertEqual(f.tiled(1), [1, 3])
        XCTAssertEqual(f.writes, 0)
        f.wins[20]!.w.over = .pinned
        f.look()
        XCTAssertEqual(f.engine.swaps, [:])
        f.wins[20]!.w.over = nil
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 20, 3], "its tab takes its old place")
        XCTAssertEqual(f.engine.before[20], own)
    }

    func testATabOfATiledWindowIsNoSwapToReport() {
        var f = three()
        var tab = f.wins.removeValue(forKey: 2)!
        tab.w.id = 20
        f.wins[20] = tab
        f.look()
        XCTAssertEqual(f.engine.swaps, [:])
        XCTAssertEqual(f.tiled(1), [1, 20, 3])
    }
}
