import XCTest
@testable import BaneySpacesCore

final class TilingZoomTests: XCTestCase {
    private let area = CGRect(x: 0, y: 25, width: 1728, height: 1050)

    private func three(_ style: TileStyle = .columns) -> FakeWindows {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = style })
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        return f
    }

    private func run(_ f: inout FakeWindows, _ c: TilingCommand, _ id: WindowID, _ out: TilingOutcome = .changed) {
        XCTAssertEqual(f.engine.run(c, on: 1, focused: id), out)
        f.focused = id
        f.rest()
    }

    func testFullScreenIsTheWholeAreaAndBack() {
        var f = three()
        let was = f.engine.frames(1)
        run(&f, .zoom(.screen), 2)
        XCTAssertEqual(f.wins[2]!.w.frame, area)
        XCTAssertEqual(f.engine.frames(1)[1], was[1])
        XCTAssertEqual(f.engine.frames(1)[3], was[3])
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0)
        run(&f, .zoom(.screen), 2)
        XCTAssertEqual(f.engine.frames(1), was)
    }

    func testFullWidthKeepsTheRow() {
        var f = three(.main)
        let was = f.engine.frames(1)[3]!
        run(&f, .zoom(.width), 3)
        XCTAssertEqual(f.wins[3]!.w.frame, CGRect(x: 8, y: was.minY, width: 1712, height: was.height))
        XCTAssertGreaterThan(was.minY, 500, "a lower row")
        run(&f, .zoom(.screen), 3)
        XCTAssertEqual(f.wins[3]!.w.frame, area, "from the one to the other")
        run(&f, .zoom(.screen), 3)
        XCTAssertEqual(f.wins[3]!.w.frame, was)
    }

    func testItLastsThroughOtherWindowsWorkspacesTheDockAndAFocusElsewhere() {
        var f = three()
        run(&f, .zoom(.screen), 2)
        XCTAssertEqual(f.engine.run(.focus(.left), on: 1, focused: 2), .focus(1), "by its place in the layout")
        f.focused = 1
        f.open(4)
        f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame, area)
        let here = f.shown[1]!
        f.shown = [2: here]
        f.rest()
        f.shown = [1: here]
        f.wins[2]!.w.away = true
        f.rest()
        f.wins[2]!.w.away = false
        f.rest()
        XCTAssertEqual(f.wins[2]!.w.frame, area)
    }

    func testItMovesInTheLayoutWhileZoomed() {
        var f = three()
        run(&f, .zoom(.screen), 2)
        run(&f, .move(.left), 2)
        XCTAssertEqual(f.tiled(1), [2, 1, 3])
        XCTAssertEqual(f.wins[2]!.w.frame, area)
        run(&f, .grow(.left), 2, .nothing("the window is at full size"))
        run(&f, .zoom(.screen), 9, .nothing("the window in front isn't tiled"))
    }

    func testDraggedItIsATileAgain() {
        var f = three()
        run(&f, .zoom(.screen), 2)
        XCTAssertTrue(f.engine.drop(2, on: CGPoint(x: 200, y: 500)))
        f.rest()
        XCTAssertLessThan(f.wins[2]!.w.frame.width, 600)
        XCTAssertEqual(f.tiled(1), [2, 1, 3])
    }

    func testItsEdgePulledItGoesBack() {
        var f = three()
        run(&f, .zoom(.width), 2)
        let was = f.engine.frames(1)
        f.wins[2]!.w.frame.size.width = 900
        XCTAssertFalse(f.engine.resized(2, to: f.wins[2]!.w.frame))
        f.rest()
        XCTAssertEqual(f.engine.frames(1), was)
        XCTAssertEqual(f.wins[2]!.w.frame, was[2])
    }

    func testFloatedItIsNoLongerZoomed() {
        var f = three()
        let was = f.engine.frames(1)
        run(&f, .zoom(.screen), 2)
        run(&f, .float, 2)
        run(&f, .float, 2)
        XCTAssertEqual(f.engine.frames(1), was)
    }

    func testSentToAnotherWorkspaceItIsAPlainTileThereAndWhenItComesBack() {
        var f = three()
        run(&f, .zoom(.screen), 2)
        let here = f.shown[1]!
        f.wins[2]!.w.workspace = 2
        f.shown = [2: here]
        f.rest()
        f.wins[2]!.w.workspace = 1
        f.shown = [1: here]
        f.rest()
        XCTAssertNotEqual(f.wins[2]!.w.frame, area)
    }

    func testAnotherTabIsZoomedAsTheOneBefore() {
        var f = three()
        run(&f, .zoom(.screen), 2)
        var tab = f.wins.removeValue(forKey: 2)!
        tab.w.id = 20
        f.wins[20] = tab
        f.focused = 20
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0)
        XCTAssertEqual(f.engine.frames(1)[20], area)
    }

    func testAGroupIsZoomedAsOne() {
        var f = three()
        run(&f, .group, 2)
        run(&f, .join(.left), 3)
        run(&f, .zoom(.screen), 3)
        XCTAssertEqual(f.wins[3]!.w.frame, area)
        XCTAssertEqual(f.engine.frames(1)[2], area, "the one behind it")
        XCTAssertEqual(f.engine.tabs(1), [], "no strip over it")
        f.engine.focused(2)
        run(&f, .zoom(.width), 2)
        XCTAssertEqual(f.engine.slots.values.first!.zoomed, [2: .width], "one zoom a group")
        XCTAssertEqual(f.engine.tabs(1).map(\.front), [2], "full width has its strip")
        run(&f, .zoom(.width), 2)
        XCTAssertEqual(f.engine.slots.values.first!.zoomed, [:])
        XCTAssertEqual(f.engine.frames(1)[3], f.engine.frames(1)[2])
    }

    /// Two zoomed windows that come together in a group: the group is in full screen.
    func testAGroupOfTwoZoomedWindowsIsInFullScreen() {
        // Full screen wins whichever of the two has it: the one joined to, or the one that joins.
        for (a, b, first) in [(WindowID(2), WindowID(3), TilingZoom.screen), (3, 2, .screen), (2, 3, .width), (3, 2, .width)] {
            var f = three()
            run(&f, .zoom(first), a)
            run(&f, .zoom(first == .screen ? .width : .screen), b)
            run(&f, .join(b == 3 ? .left : .right), b)
            XCTAssertEqual(f.engine.frames(1)[2], area)
            XCTAssertEqual(f.engine.frames(1)[3], area)
            run(&f, .zoom(.screen), b)
            XCTAssertEqual(f.engine.slots.values.first!.zoomed, [:], "and goes back as one")
        }
    }

    func testTheOneBehindInAZoomedGroupSaysSo() {
        var f = three()
        run(&f, .group, 2)
        run(&f, .join(.left), 3)
        run(&f, .zoom(.screen), 3)
        f.engine.focused(2)
        run(&f, .grow(.left), 2, .nothing("the window is at full size"))
    }

    func testAStripUnderAnotherZoomedWindowIsNotDrawn() {
        var f = three(.main)
        run(&f, .group, 2)
        XCTAssertEqual(f.engine.tabs(1).count, 1)
        run(&f, .zoom(.width), 1)
        XCTAssertEqual(f.engine.tabs(1), [])
        run(&f, .zoom(.width), 1)
        run(&f, .zoom(.width), 3)
        XCTAssertEqual(f.engine.tabs(1).count, 1, "it lies below")
    }

    func testDroppedOnAStripItIsATabAndNoLongerZoomed() {
        var f = three(.main)
        run(&f, .group, 2)
        run(&f, .zoom(.width), 3)
        let strip = f.engine.tabs(1)[0].frame
        XCTAssertTrue(f.engine.drop(3, on: CGPoint(x: strip.midX, y: strip.midY)))
        XCTAssertEqual(f.engine.slots.values.first!.zoomed, [:])
        XCTAssertEqual(f.engine.slots.values.first!.groups.map(\.members), [[2, 3]])
    }

    func testInAScrolledStripAZoomedWindowIsInView() {
        var f = three(.scrolling)
        f.displays = [CGRect(x: 0, y: 0, width: 1728, height: 1117)]
        f.corner = CGPoint(x: 1727, y: 1116)
        run(&f, .zoom(.screen), 1)
        f.focused = 3
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame, area)
    }

    func testItIsKeptAcrossRestarts() throws {
        var f = three()
        run(&f, .zoom(.screen), 2)
        func record(_ id: WindowID) -> WindowRecord {
            WindowRecord(bundle: "app", title: "t\(id)", order: 0, workspace: 1, frame: nil, displays: [], window: id, pid: 100, at: 1)
        }
        let saved = try XCTUnwrap(TilingSaved.read(f.engine.saved(record).data(), now: 2))
        var g = FakeWindows()
        g.engine.apply(FakeWindows.options { $0.style = .columns })
        g.engine.restore(saved)
        for id in WindowID(1)...3 { g.open(id) }
        g.engine.claim((1...3).map { (LiveWindow(id: $0, bundle: "app", title: "t\($0)", order: 0, pid: 100, key: Data()), 1) })
        g.rest()
        XCTAssertEqual(g.wins[2]!.w.frame, area)
        XCTAssertNil(f.engine.saved { $0 == 2 ? nil : record($0) }.slots.first?.zoomed, "a window that isn't kept")
        run(&f, .zoom(.screen), 2)
        XCTAssertNil(f.engine.saved(record).slots.first?.zoomed)
    }
}
