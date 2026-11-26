import XCTest
@testable import BaneySpacesCore

/// spec/tiling-speed.md R-TS9, case 36: a close or a move key asks each window for one frame, and no plan asks again
/// while it flies or once it landed. Donovan, 2026-11-26: windows moving twice on a close, and moving tiles, was the jank.
final class CloseFillMovesTests: XCTestCase {
    private func landed(_ e: inout TilingEngine, _ shot: inout TilingShot, _ moves: [TilingMove]) {
        for m in moves { shot.windows[shot.windows.firstIndex { $0.id == m.id }!].frame = m.to }
        let targets = Dictionary(uniqueKeysWithValues: moves.map { ($0.id, $0.to) })
        e.flying(Set(targets.keys))
        _ = e.landed(targets, targets: targets)
        e.grounded(Set(targets.keys))
    }

    func testAMoveKeyWritesEachWindowOnce() throws {
        var e = TilingEngine()
        var o = TilingOptions()
        o.everywhere = true
        e.apply(o)
        let start = CGRect(x: 40, y: 60, width: 700, height: 500)
        var shot = TilingShot(windows: [1, 2, 3].map { TilingWindow(id: $0, pid: 7, bundle: "app", workspace: 1, frame: start) },
                              shown: [1: .init(display: "D1", area: CGRect(x: 0, y: 25, width: 1728, height: 1050))], focused: nil)
        landed(&e, &shot, e.plan(shot))
        XCTAssertEqual(e.plan(shot), [], "at rest")
        XCTAssertEqual(e.run(.move(.right), on: 1, focused: 1), .changed)
        let moves = e.plan(shot)
        XCTAssertFalse(moves.isEmpty)
        XCTAssertEqual(moves.count, Set(moves.map(\.id)).count, "one frame per window, none twice")
        e.flying(Set(moves.map(\.id)))
        XCTAssertEqual(e.plan(shot), [], "nothing asked again while they fly")
        landed(&e, &shot, moves)
        XCTAssertEqual(e.plan(shot), [], "nothing asked again once they landed")
    }

    func testCase36TheMiddleOfThreeLeavesAndEachOtherMovesOnce() throws {
        var e = TilingEngine()
        var o = TilingOptions()
        o.everywhere = true
        e.apply(o)
        let start = CGRect(x: 40, y: 60, width: 700, height: 500)
        var shot = TilingShot(windows: [1, 2, 3].map { TilingWindow(id: $0, pid: 7, bundle: "app", workspace: 1, frame: start) },
                              shown: [1: .init(display: "D1", area: CGRect(x: 0, y: 25, width: 1728, height: 1050))], focused: nil)
        // Three tiles, landed.
        let first = e.plan(shot)
        XCTAssertEqual(Set(first.map(\.id)), [1, 2, 3])
        for m in first { shot.windows[shot.windows.firstIndex { $0.id == m.id }!].frame = m.to }
        e.flying(Set(first.map(\.id)))
        _ = e.landed(Dictionary(uniqueKeysWithValues: first.map { ($0.id, $0.to) }), targets: Dictionary(uniqueKeysWithValues: first.map { ($0.id, $0.to) }))
        e.grounded([1, 2, 3])
        XCTAssertEqual(e.plan(shot), [], "at rest")

        // The middle one closes.
        shot.windows.removeAll { $0.id == 2 }
        let fill = e.plan(shot)
        XCTAssertFalse(fill.isEmpty, "the space is filled")
        XCTAssertEqual(fill.count, Set(fill.map(\.id)).count, "one frame per window, none twice")
        XCTAssertTrue(Set(fill.map(\.id)).isSubset(of: [1, 3]))
        e.flying(Set(fill.map(\.id)))
        XCTAssertEqual(e.plan(shot), [], "nothing asked again while they fly")
        for m in fill { shot.windows[shot.windows.firstIndex { $0.id == m.id }!].frame = m.to }
        let targets = Dictionary(uniqueKeysWithValues: fill.map { ($0.id, $0.to) })
        _ = e.landed(targets, targets: targets)
        e.grounded(Set(fill.map(\.id)))
        XCTAssertEqual(e.plan(shot), [], "nothing asked again once they landed")
        // The two that stay share the area side by side, with no overlap.
        let (a, b) = (shot.windows[0].frame, shot.windows[1].frame)
        XCTAssertFalse(a.intersects(b))
        XCTAssertEqual(a.height, b.height)
    }
}
