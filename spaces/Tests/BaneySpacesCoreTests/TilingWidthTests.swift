import XCTest
@testable import BaneySpacesCore

final class TilingWidthTests: XCTestCase {
    private func one(_ lone: TilingLone = .fill) -> FakeWindows {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.lone = lone })
        f.open(1, bundle: "notes")
        f.focused = 1
        f.rest()
        return f
    }

    private func two() -> FakeWindows {
        var f = one()
        f.open(2, bundle: "web")
        f.rest()
        return f
    }

    private func run(_ f: inout FakeWindows, _ c: TilingCommand, _ id: WindowID = 1, _ out: TilingOutcome = .changed) {
        XCTAssertEqual(f.engine.run(c, on: 1, focused: id), out, "\(c)")
        f.focused = id
        f.rest()
    }

    private let nothing = TilingOutcome.nothing("there is nothing to change")
    private let none = TilingOutcome.nothing("no width is kept for this app")

    // MARK: The only window

    func testTheOnlyWindowGrowsAndShrinksInTheMiddle() {
        var f = one()
        run(&f, .grow(.left))
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 32, y: 33, width: 1664, height: 1034))
        run(&f, .grow(.right))
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1712)
        run(&f, .grow(.right), 1, nothing)
        run(&f, .grow(.up), 1, nothing)
    }

    func testItStaysWiderThanItsMinimumAndAPersonCanRead() {
        var f = one()
        for _ in 0..<60 { _ = f.engine.run(.grow(.left), on: 1, focused: 1) }
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, TilingEngine.narrowest)
        f = one()
        f.wins[1]!.least.width = 700
        f.engine.minimums[1] = CGSize(width: 700, height: 100)
        for _ in 0..<60 { _ = f.engine.run(.grow(.left), on: 1, focused: 1) }
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, 700)
        run(&f, .grow(.right))
        XCTAssertEqual(f.wins[1]!.w.frame.width, 748, "the next step shows at once")
    }

    func testAPulledEdgeSetsItAndBalanceLetsItGo() {
        var f = one(.points(1000))
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1000)
        XCTAssertTrue(f.engine.resized(1, to: CGRect(x: 364, y: 33, width: 1200, height: 1034), from: f.wins[1]!.w.frame))
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 264, y: 33, width: 1200, height: 1034))
        XCTAssertFalse(f.engine.resized(1, to: CGRect(x: 264, y: 53, width: 1200, height: 900)), "its height is the layout's")
        var g = one(.points(1000))
        XCTAssertFalse(g.engine.resized(1, to: CGRect(x: 364, y: 53, width: 1000, height: 900)))
        XCTAssertFalse(g.engine.slots.values.contains { $0.width != nil })
        g.open(2); g.rest()
        g.engine.resized(1, to: CGRect(x: 8, y: 33, width: 1000, height: 1034))
        XCTAssertFalse(g.engine.slots.values.contains { $0.width != nil }, "a split's edge is the split's")
        run(&f, .balance)
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1000)
        run(&f, .balance, 1, nothing)
    }

    func testItWaitsWhileThereAreMoreWindowsAndTheSettingOverrulesIt() {
        var f = one(.points(1000))
        run(&f, .grow(.right))
        f.open(2)
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, 852)
        run(&f, .balance, 1, nothing)
        f.wins[2] = nil
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1048)
        f.engine.apply(FakeWindows.options { $0.lone = .points(1000); $0.gaps = TileGaps(inner: 8, outer: 12) })
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1048, "another setting is none of its business")
        f.engine.apply(FakeWindows.options { $0.lone = .points(900) })
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, 900)
    }

    func testAtFullSizeThereIsNoWidthOfItsOwn() {
        var f = one()
        run(&f, .zoom(.screen))
        let no = TilingOutcome.nothing("the window is at full size")
        run(&f, .grow(.left), 1, no)
        run(&f, .keepWidth, 1, no)
        run(&f, .restoreWidth, 1, no)
        run(&f, .zoom(.screen))
        run(&f, .full)
        run(&f, .grow(.left), 1, nothing)
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1712)
        XCTAssertFalse(f.engine.slots.values.contains { $0.width != nil })
    }

    // MARK: Kept and given back

    func testAKeptWidthComesBack() {
        var f = two()
        run(&f, .grow(.right))
        XCTAssertEqual(f.wins[1]!.w.frame.width, 900)
        run(&f, .keepWidth)
        run(&f, .balance)
        XCTAssertEqual(f.wins[1]!.w.frame.width, 852)
        run(&f, .restoreWidth, 2, none)
        run(&f, .restoreWidth)
        XCTAssertEqual(f.wins[1]!.w.frame.width, 900)
        XCTAssertEqual(f.wins[2]!.w.frame.width, 804)
        run(&f, .restoreWidth, 1, nothing)
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0)
    }

    func testTheOnlyWindowTakesItToo() {
        var f = two()
        run(&f, .grow(.right))
        run(&f, .keepWidth)
        f.wins[2] = nil
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, 1712)
        run(&f, .restoreWidth)
        XCTAssertEqual(f.wins[1]!.w.frame, CGRect(x: 414, y: 33, width: 900, height: 1034))
        run(&f, .grow(.left))
        run(&f, .keepWidth)
        XCTAssertEqual(f.engine.width(for: "notes", on: 1), 852, "the one kept last replaces it")
        XCTAssertEqual(f.engine.widths.count, 1)
    }

    func testAnotherWorkspaceHasItsOwnOrTheLastOne() {
        var f = two()
        run(&f, .keepWidth)
        f.engine.widths.append(TilingWidth(bundle: "notes", workspace: 2, width: 500))
        f.engine.widths.append(TilingWidth(bundle: "web", workspace: 1, width: 600))
        XCTAssertEqual(f.engine.width(for: "notes", on: 1), 852)
        XCTAssertEqual(f.engine.width(for: "notes", on: 2), 500)
        XCTAssertEqual(f.engine.width(for: "notes", on: 3), 500)
        XCTAssertNil(f.engine.width(for: "mail", on: 1))
        run(&f, .keepWidth)
        XCTAssertEqual(f.engine.width(for: "notes", on: 2), 500, "only its own place changes")
        XCTAssertEqual(f.engine.width(for: "web", on: 1), 600)
    }

    func testAWindowThatFloatsHasNoTileToKeep() {
        var f = two()
        f.engine.setFloating(1, true)
        f.rest()
        let no = TilingOutcome.nothing("the window in front isn't tiled")
        run(&f, .keepWidth, 1, no)
        run(&f, .restoreWidth, 1, no)
        f.wins[2]!.w.bundle = ""
        f.rest()
        run(&f, .keepWidth, 2, .nothing("no window is in front"))
    }

    func testOnlySoManyAreKept() {
        var f = two()
        f.engine.widths = (0..<TilingEngine.mostWidths).map { TilingWidth(bundle: "app\($0)", workspace: 1, width: 500) }
        run(&f, .keepWidth)
        XCTAssertEqual(f.engine.widths.count, TilingEngine.mostWidths)
        XCTAssertNil(f.engine.width(for: "app0", on: 1))
        XCTAssertNotNil(f.engine.width(for: "notes", on: 1))
    }

    func testInScrollingItIsTheColumnsWidth() {
        var f = two()
        run(&f, .style(.scrolling))
        run(&f, .grow(.right))
        let wide = f.wins[1]!.w.frame.width
        run(&f, .keepWidth)
        run(&f, .grow(.left))
        XCTAssertNotEqual(f.wins[1]!.w.frame.width, wide)
        run(&f, .restoreWidth)
        XCTAssertEqual(f.wins[1]!.w.frame.width, wide, accuracy: 1)
    }

    // MARK: Across restarts

    func testBothAreThereAfterARestart() throws {
        var f = one()
        run(&f, .grow(.left))
        run(&f, .keepWidth)
        let saved = f.engine.saved { WindowRecord(bundle: "notes", title: "n", order: 0, workspace: 1, frame: nil, displays: [], window: $0, pid: 1, at: 0, key: Data([1])) }
        let back = try XCTUnwrap(TilingSaved.read(saved.data(), now: 0))
        XCTAssertEqual(back, saved)
        var e = TilingEngine()
        e.restore(back)
        XCTAssertEqual(e.slots.values.first?.width, 1664)
        XCTAssertEqual(e.width(for: "notes", on: 1), 1664)
        XCTAssertNil(TilingEngine().saved { _ in nil }.widths)
        // The engine's own outlast a file read again.
        e.widths = [TilingWidth(bundle: "web", workspace: 1, width: 700)]
        e.restore(back)
        XCTAssertNil(e.width(for: "notes", on: 1))
    }

    func testAWidthThatIsNoWidthIsDropped() throws {
        var saved = TilingSaved()
        saved.widths = [0.5, 100_000, 800].map { TilingWidth(bundle: "a\($0)", workspace: 1, width: $0) }
        saved.widths! += (0..<300).map { TilingWidth(bundle: "b\($0)", workspace: 1, width: 900) }
        for w in [0.5, 100_000, 800] { saved.slots.append(.init(key: TilingKey(Int(w), "D"), layout: TileLayout(style: .columns), focused: nil, width: w)) }
        let back = try XCTUnwrap(TilingSaved.read(saved.data(), now: 0))
        XCTAssertEqual(back.slots.map(\.width), [nil, nil, 800])
        XCTAssertEqual(back.widths?.count, TilingEngine.mostWidths)
        XCTAssertEqual(back.widths?.last?.bundle, "b299")
        saved.widths = Array(saved.widths!.prefix(3))
        XCTAssertEqual(TilingSaved.read(saved.data(), now: 0)?.widths?.map(\.width), [800])
    }
}
