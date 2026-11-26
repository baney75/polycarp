import XCTest
@testable import BaneySpacesCore

final class TilingCommandTests: XCTestCase {
    private func three(_ style: TileStyle = .dwindle) -> FakeWindows {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = style })
        for id in WindowID(1)...3 { f.open(id); f.focused = id; f.rest() }
        return f
    }

    @discardableResult
    private func run(_ f: inout FakeWindows, _ c: TilingCommand, focused: WindowID? = nil) -> TilingOutcome {
        if let focused { f.focused = focused; f.look() }
        let out = f.engine.run(c, on: 1, focused: f.focused)
        f.rest()
        return out
    }

    func testEveryCommandHasANameOfItsOwnAndWordsForIt() {
        XCTAssertEqual(Set(TilingCommand.named.map(\.name)).count, TilingCommand.named.count)
        for n in TilingCommand.named { XCTAssertEqual(TilingCommand(words: n.name.split(separator: "-").map(String.init)), n.command) }
        XCTAssertNil(TilingCommand(words: ["focus"]))
    }

    func testFocusGoesAcrossTheEdgeAndAtTheEndCrossesToTheDisplay() {
        var f = three()
        XCTAssertEqual(run(&f, .focus(.left), focused: 2), .focus(1))
        XCTAssertEqual(run(&f, .focus(.right), focused: 1), .focus(2), "back where it was")
        XCTAssertEqual(run(&f, .focus(.down), focused: 2), .focus(3))
        XCTAssertEqual(run(&f, .focus(.right), focused: 3), .cross(.right, carrying: nil))
        f.open(9); f.wins[9]!.w.fixed = true
        XCTAssertEqual(run(&f, .focus(.left), focused: 9), .focus(3), "from a floating window, the tiled one used last")
        XCTAssertEqual(run(&f, .cycle(backward: false), focused: 3), .focus(1))
        XCTAssertEqual(run(&f, .cycle(backward: true), focused: 1), .focus(3))
    }

    func testFocusGoesBackToTheNeighborUsedLast() {
        var f = three(.main)
        for last in [WindowID(2), 3, 2] {
            f.focused = last; f.look()
            XCTAssertEqual(run(&f, .focus(.right), focused: 1), .focus(last))
        }
    }

    func testMoveStepsAndAtTheEdgeCarriesTheWindowOver() {
        var f = three()
        XCTAssertEqual(run(&f, .move(.left), focused: 3), .changed)
        for _ in 0..<4 where f.engine.run(.move(.left), on: 1, focused: 3) == .changed { f.rest() }
        XCTAssertEqual(run(&f, .move(.left), focused: 3), .cross(.left, carrying: 3))
        XCTAssertLessThan(f.wins[3]!.w.frame.minX, 20)
    }

    func testGrowMovesTheEdgeThatWay() {
        var f = three(.columns)
        let was = f.wins[2]!.w.frame
        XCTAssertEqual(run(&f, .grow(.right), focused: 2), .changed)
        XCTAssertEqual(f.wins[2]!.w.frame.maxX, was.maxX + 48, accuracy: 2)
        XCTAssertEqual(f.wins[2]!.w.frame.minX, was.minX, accuracy: 1)
        XCTAssertEqual(run(&f, .grow(.left), focused: 2), .changed)
        XCTAssertEqual(f.wins[2]!.w.frame.minX, was.minX - 48, accuracy: 2)
        let last = f.wins[3]!.w.frame
        XCTAssertEqual(run(&f, .grow(.right), focused: 3), .changed)
        XCTAssertEqual(f.wins[3]!.w.frame.minX, last.minX + 48, accuracy: 2, "at the area's edge the other edge follows")
        XCTAssertEqual(run(&f, .grow(.up), focused: 3), .nothing("there is nothing to change"))
        XCTAssertEqual(run(&f, .balance, focused: 3), .changed)
        XCTAssertEqual(f.wins[1]!.w.frame.width, f.wins[3]!.w.frame.width, accuracy: 1)
    }

    func testPromoteFlipAndFull() {
        var f = three()
        XCTAssertEqual(run(&f, .promote, focused: 3), .changed)
        XCTAssertEqual(f.tiled(1).first, 3)
        XCTAssertEqual(run(&f, .promote, focused: 3), .nothing("there is nothing to change"))
        let before = f.wins.mapValues(\.w.frame)
        XCTAssertEqual(run(&f, .flip, focused: 1), .changed)
        XCTAssertNotEqual(f.wins.mapValues(\.w.frame), before)
        XCTAssertEqual(run(&f, .flip, focused: 1), .changed)
        XCTAssertEqual(f.wins.mapValues(\.w.frame), before)
        XCTAssertEqual(run(&f, .full, focused: 1), .changed)
        XCTAssertEqual(f.wins[1]!.w.frame, f.wins[2]!.w.frame)
        XCTAssertTrue(f.engine.isFull(1))
        XCTAssertEqual(run(&f, .move(.right), focused: 1), .nothing("a window is at full size"), "and not to the next display")
        run(&f, .full, focused: 1)
        XCTAssertEqual(f.wins.mapValues(\.w.frame), before)
        f = three(.main)
        XCTAssertEqual(run(&f, .promote, focused: 3), .changed)
        XCTAssertEqual(f.tiled(1).first, 3)
    }

    func testTheStyleGoesAroundAndKeepsTheOrder() {
        var f = three()
        let order = f.tiled(1)
        for s in [TileStyle.columns, .main, .scrolling, .floating, .dwindle] {
            XCTAssertEqual(run(&f, .style(nil)), .changed)
            XCTAssertEqual(f.engine.style(of: 1), s)
            XCTAssertEqual(f.tiled(1), order)
        }
        XCTAssertEqual(run(&f, .style(.dwindle)), .nothing("it is in that style already"))
    }

    func testAWindowBackFromTheDockKeepsTheNewStyle() {
        var f = three()
        f.wins[2]!.w.away = true; f.rest()
        run(&f, .style(.columns), focused: 1)
        f.wins[2]!.w.away = false; f.rest()
        XCTAssertEqual(f.engine.style(of: 1), .columns)
        XCTAssertEqual(Set(f.tiled(1)), [1, 2, 3])
    }

    func testFloatAndTileAgainOverARuleToo() {
        var f = three()
        XCTAssertEqual(run(&f, .float, focused: 2), .changed)
        XCTAssertFalse(f.tiled(1).contains(2))
        XCTAssertEqual(run(&f, .float, focused: 2), .changed)
        XCTAssertTrue(f.tiled(1).contains(2))
        XCTAssertTrue(f.engine.choice.isEmpty, "back to what the rules say")
        f.open(9, bundle: "calc")
        f.engine.apply(FakeWindows.options { $0.floatApps = ["calc"] })
        f.focused = 9; f.rest()
        XCTAssertFalse(f.tiled(1).contains(9))
        XCTAssertEqual(run(&f, .float, focused: 9), .changed)
        XCTAssertTrue(f.tiled(1).contains(9))
        f.open(10); f.wins[10]!.w.fixed = true; f.focused = 10; f.rest()
        XCTAssertEqual(run(&f, .float, focused: 10), .nothing("a window that can't be resized always floats"))
    }

    func testNothingHappensOnAWorkspaceThatIsNotTiled() {
        var f = three()
        f.engine.apply(FakeWindows.options { $0.off = [1]; $0.agentWorkspace = 3 })
        XCTAssertEqual(f.engine.run(.balance, on: 1, focused: 1), .nothing("this workspace isn't tiled"))
        XCTAssertEqual(f.engine.run(.toggle, on: 1, focused: 1), .toggle)
        XCTAssertEqual(f.engine.run(.toggle, on: 3, focused: 1), .nothing("the agent workspace never tiles"))
        XCTAssertEqual(f.engine.run(.balance, on: 2, focused: nil), .nothing("no window is tiled here"))
    }

    func testADragShowsTheFrameItDropsOn() {
        var f = three()
        let target = f.wins[1]!.w.frame
        let outline = f.engine.dropFrame(3, at: CGPoint(x: target.midX, y: target.midY))
        XCTAssertEqual(outline, target, "the middle is a swap")
        f.wins[3]!.w.frame.origin = CGPoint(x: 100, y: 100)
        XCTAssertTrue(f.engine.drop(3, on: CGPoint(x: target.midX, y: target.midY)))
        f.rest()
        XCTAssertEqual(f.wins[3]!.w.frame, outline)
        XCTAssertNil(f.engine.dropFrame(3, at: CGPoint(x: -500, y: 10)))
        XCTAssertFalse(f.engine.drop(3, on: CGPoint(x: -500, y: 10)))
        f.wins[3]!.w.frame.origin.x += 333
        f.rest()
        XCTAssertEqual(f.wins[3]!.w.frame, outline, "let go nowhere, it goes back")
    }

    func testAnEdgePulledMovesTheSplit() {
        var f = three(.columns)
        var pulled = f.wins[1]!.w.frame
        pulled.size.width += 120
        f.wins[1]!.w.frame = pulled
        XCTAssertTrue(f.engine.resized(1, to: pulled))
        f.rest()
        XCTAssertEqual(f.wins[1]!.w.frame.width, pulled.width, accuracy: 1)
        XCTAssertEqual(f.wins[2]!.w.frame.minX, pulled.maxX + 8, accuracy: 1)
        XCTAssertFalse(f.engine.resized(99, to: pulled))
        // A terminal a few points short of its tile, only moved: nothing to resize.
        let short = f.wins[2]!.w.frame.insetBy(dx: 5, dy: 0)
        XCTAssertFalse(f.engine.resized(2, to: short.offsetBy(dx: 200, dy: 0), from: short))
    }

    // MARK: The scratchpad

    func testTheScratchpadWorksWhetherTheWorkspaceTilesOrNot() {
        var f = three()
        XCTAssertEqual(f.engine.run(.scratchpad, on: 1, focused: nil), .scratchpad)
        XCTAssertEqual(f.engine.run(.toScratchpad, on: 1, focused: 2), .toScratchpad(2))
        XCTAssertEqual(f.engine.run(.toScratchpad, on: 1, focused: nil), .nothing("no window is in front"))
        f.engine.apply(FakeWindows.options { $0.everywhere = false; $0.agentWorkspace = 9 })
        XCTAssertEqual(f.engine.run(.scratchpad, on: 1, focused: nil), .scratchpad)
        XCTAssertEqual(f.engine.run(.toScratchpad, on: 1, focused: 77), .toScratchpad(77))
        XCTAssertEqual(f.engine.run(.toScratchpad, on: 9, focused: 77), .nothing("the agent workspace has no scratchpad"))
    }

    func testAWindowSentAwayLeavesItsTileAndComesBackAtItsOwnSize() {
        var f = three(.columns)
        let was = CGRect(x: 40 + 2 * 12, y: 60 + 2 * 9, width: 700, height: 500)
        XCTAssertEqual(f.engine.release(2), was)
        XCTAssertNil(f.engine.release(2))
        XCTAssertEqual(f.tiled(1), [1, 3])
        f.wins[2]!.w.workspace = Workspaces.scratchpad
        f.wins[2]!.w.over = .scratchpad
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 3])
        f.wins[2]!.w.workspace = 1
        f.wins[2]!.w.frame = was
        f.writes = 0
        f.rest()
        XCTAssertEqual(f.writes, 0, "it floats over the tiles")
        XCTAssertEqual(f.engine.run(.float, on: 1, focused: 2), .nothing("it is on the scratchpad"))
        f.wins[2]!.w.over = nil
        f.rest()
        XCTAssertEqual(f.tiled(1).sorted(), [1, 2, 3], "taken out of the scratchpad it has a tile again")
    }

    func testOneReleasedInTheDockHasNoPlaceToComeBackTo() {
        var f = three(.columns)
        f.wins[2]!.w.away = true
        f.rest()
        XCTAssertNotNil(f.engine.release(2))
        f.wins[2]!.w.away = false
        f.wins[1]!.w.away = true
        f.rest()
        XCTAssertEqual(f.tiled(1).sorted(), [2, 3])
    }

    func testAWindowCarriedToAnotherDisplayLandsWhereItWasLetGo() {
        var f = three(.columns)
        f.shown[2] = .init(display: "D2", area: CGRect(x: 1728, y: 0, width: 1600, height: 1000))
        f.open(11, workspace: 2); f.open(12, workspace: 2); f.rest()
        let point = CGPoint(x: 1728 + 20, y: 500), before = f.engine
        let outline = f.engine.dropFrame(3, at: point)
        XCTAssertNotNil(outline)
        XCTAssertEqual(f.engine, before, "only a promise")
        f.engine.lands(3, at: point)
        f.wins[3]!.w.workspace = 2
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2])
        XCTAssertEqual(f.tiled(2).first, 3)
        XCTAssertEqual(f.wins[3]!.w.frame, outline, "where the outline said")
    }

    func testTheOutlineOffersNoPlaceOnAWorkspaceOutOfSight() {
        func mid(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }
        var f = three(.columns)
        f.shown = [2: .init(display: "D1", area: f.shown[1]!.area)]
        f.open(11, workspace: 2); f.rest()
        XCTAssertNil(f.engine.dropFrame(11, at: mid(f.engine.frames(2)[11]!)), "its own tile")
        XCTAssertNil(f.engine.dropFrame(1, at: mid(f.engine.frames(1)[1]!)))
        f.shown[3] = .init(display: "D2", area: CGRect(x: 1728, y: 0, width: 1600, height: 1000))
        f.rest()
        XCTAssertNotNil(f.engine.dropFrame(11, at: CGPoint(x: 1800, y: 500)), "an empty workspace takes it whole")
    }

    func testDisplaysByDirectionAndInTurn() {
        let d: [DisplayKey: CGRect] = ["a": CGRect(x: 0, y: 0, width: 1000, height: 800), "b": CGRect(x: 1000, y: 100, width: 800, height: 600),
                                       "c": CGRect(x: 0, y: 800, width: 1000, height: 500)]
        XCTAssertEqual(TilingEngine.display(.right, of: "a", in: d), "b")
        XCTAssertEqual(TilingEngine.display(.left, of: "b", in: d), "a")
        XCTAssertEqual(TilingEngine.display(.down, of: "a", in: d), "c")
        XCTAssertNil(TilingEngine.display(.up, of: "a", in: d))
        XCTAssertNil(TilingEngine.display(.left, of: "a", in: d))
        XCTAssertNil(TilingEngine.display(.right, of: "b", in: d), "the one beside it is on the other side")
        XCTAssertEqual(TilingEngine.display(after: "a", in: d), "c")
        XCTAssertEqual(TilingEngine.display(after: "b", in: d), "a")
        XCTAssertNil(TilingEngine.display(after: "a", in: ["a": .zero]))
    }

    func testTheNextWindowOpensBesideTheOneFocusedLast() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.style = .columns })
        f.open(1); f.open(2); f.open(3); f.focused = 3; f.rest()
        f.engine.focused(1)
        f.focused = 4; f.open(4); f.rest()
        XCTAssertEqual(f.tiled(1), [1, 4, 2, 3])
        f.engine.focused(99)
        XCTAssertFalse(f.engine.recent.contains(99))
    }

    func testAWindowLetGoToFloatStaysWhereItIs() {
        var f = FakeWindows()
        f.open(1); f.open(2); f.rest()
        f.engine.setFloating(2, true)
        f.rest()
        XCTAssertEqual(f.tiled(1), [1])
        f.engine.setFloating(2, true)
        f.rest()
        XCTAssertEqual(f.tiled(1), [1], "floating it again changes nothing")
        f.engine.setFloating(2, false)
        f.rest()
        XCTAssertEqual(f.tiled(1), [1, 2])
    }
}
