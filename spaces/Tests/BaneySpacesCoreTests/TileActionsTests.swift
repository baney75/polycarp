import XCTest
@testable import BaneySpacesCore

/// spec/tiling-speed.md R-TS10, cases 37 to 40.
final class TileActionsTests: XCTestCase {
    private func line(_ a: TileActions.Action) -> String { TileActions.line(epoch: 1, a) }

    func testCase37ACloseIsTimedToItsLastWrite() {
        var t = TileActions()
        t.begin(.close, how: "destroyed", at: 10, workspace: 2)
        t.wrote([(1, 2), (2, 2)], looked: 10.002, at: 10.010)
        t.wrote([(1, 2)], looked: 10.015, at: 10.030)
        XCTAssertEqual(t.due(now: 10.4), [], "not yet 0.5 s quiet")
        let done = t.due(now: 10.530)
        XCTAssertEqual(done.map(line), ["1 close fill=30 writes=2 windows=2 how=destroyed"])
        XCTAssertTrue(t.open.isEmpty)
    }

    func testCase38ACloseWithNoWriteEndsAfterThreeSeconds() {
        var t = TileActions()
        t.begin(.close, how: "destroyed", at: 10, workspace: 2)
        XCTAssertEqual(t.due(now: 12.9), [], "no write and not yet 3 s")
        XCTAssertEqual(t.due(now: 13.0).map(line), ["1 close fill=- writes=0 windows=0 how=destroyed"])
    }

    func testCase39AMoveKeyWritesOncePerWindow() {
        var t = TileActions()
        t.begin(.move, how: "key", at: 10, workspace: 1)
        t.wrote([(1, 1), (2, 1)], looked: 10.001, at: 10.012)
        XCTAssertEqual(t.due(now: 10.6).map(line), ["1 move fill=12 writes=1 windows=2 how=key"])
    }

    func testAWriteOnAnotherWorkspaceDoesNotCount() {
        var t = TileActions()
        t.begin(.close, how: "quit", at: 10, workspace: 2)
        t.wrote([(1, 3)], looked: 10.001, at: 10.01)
        XCTAssertEqual(t.open.first?.last, nil)
        XCTAssertEqual(t.open.first?.writes, [:])
    }

    func testAWriteBackBeforeTheCauseDoesNotCount() {
        var t = TileActions()
        t.begin(.close, how: "minimized", at: 10, workspace: 2)
        t.wrote([(1, 2)], looked: 9.98, at: 9.99)
        XCTAssertEqual(t.open.first?.writes, [:])
        XCTAssertEqual(t.due(now: 10.6), [], "no write: waits the 3 s")
    }

    /// Case 40: a close of the last tiled window on its workspace isn't timed, since nothing is left to fill.
    func testCase40TheLastTiledWindowHasNoMates() {
        func engine(_ ids: [WindowID]) -> TilingEngine {
            var e = TilingEngine()
            var o = TilingOptions()
            o.everywhere = true
            e.apply(o)
            let windows = ids.map { TilingWindow(id: $0, pid: 7, bundle: "app", workspace: 1, frame: CGRect(x: 40, y: 60, width: 700, height: 500)) }
            _ = e.plan(TilingShot(windows: windows, shown: [1: .init(display: "D1", area: CGRect(x: 0, y: 25, width: 1728, height: 1050))], focused: nil))
            return e
        }
        XCTAssertEqual(engine([1]).staying(after: [1]), [1: 0])
        XCTAssertEqual(engine([1, 2]).staying(after: [1]), [1: 1])
        XCTAssertEqual(engine([1, 2]).staying(after: [9]), [:], "never tiled")
        // Review of #871, first-F3: two windows of one app quit together, the only tiled ones there: nothing stays.
        XCTAssertEqual(engine([1, 2]).staying(after: [1, 2]), [1: 0])
        XCTAssertEqual(engine([1, 2, 3]).staying(after: [1, 2]), [1: 1])
    }

    /// Review of #871, first-F1: two move keys on one workspace, each write counts toward its own key only.
    func testOverlappingActionsEachGetTheirOwnWrites() {
        var t = TileActions()
        t.begin(.move, how: "key", at: 0, workspace: 1)
        t.wrote([(1, 1)], looked: 0.001, at: 0.015)
        t.begin(.move, how: "key", at: 0.3, workspace: 1)
        t.wrote([(1, 1)], looked: 0.301, at: 0.320)
        XCTAssertEqual(t.due(now: 0.9).map(line), ["1 move fill=15 writes=1 windows=1 how=key", "1 move fill=20 writes=1 windows=1 how=key"])
    }

    /// Review of #871, first-F2: a write in flight from a look before the close returns after it and still isn't its
    /// fill; the close no look answered says so.
    func testAWriteFromALookBeforeTheCauseDoesNotCountThoughItReturnsAfter() {
        var t = TileActions()
        t.begin(.close, how: "destroyed", at: 10, workspace: 2)
        t.wrote([(1, 2)], looked: 9.995, at: 10.02)
        XCTAssertEqual(t.due(now: 13).map(line), ["1 close fill=- writes=0 windows=0 how=destroyed"])
    }
}
