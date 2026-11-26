import XCTest
@testable import BaneySpacesCore

final class TilingReadTests: XCTestCase {
    private let frame = CGRect(x: 0, y: 0, width: 800, height: 600)
    private let shown = [1: TilingShot.Place(display: "main", area: CGRect(x: 0, y: 25, width: 1000, height: 700))]
    private var options: TilingOptions = {
        var o = TilingOptions()
        o.everywhere = true
        return o
    }()

    private func window(_ id: WindowID, on workspace: Int = 1, _ change: (inout TilingFacts) -> Void = { _ in }) -> TilingFacts {
        var f = TilingFacts(id: id, pid: 9, bundle: "com.example.editor", workspace: workspace, frame: frame)
        f.onScreen = true
        f.answer = TilingAnswer(resizable: true, fullScreen: false, screenSized: false)
        change(&f)
        return f
    }

    func testTheAreaEndsAtTheMenuBarTheDockAndPolycarpsBar() {
        let display = CGRect(x: 100, y: 50, width: 1000, height: 800), visible = CGRect(x: 160, y: 75, width: 940, height: 775)
        XCTAssertEqual(TilingRead.area(frame: display, visible: visible, bar: 0), visible)
        XCTAssertEqual(TilingRead.area(frame: display, visible: visible, bar: 20), visible, "a bar inside the menu bar takes nothing")
        XCTAssertEqual(TilingRead.area(frame: display, visible: visible, bar: 40), CGRect(x: 160, y: 90, width: 940, height: 760))
        XCTAssertEqual(TilingRead.area(frame: display, visible: visible, bar: 5000).height, 0)
    }

    func testABarOfAnyShapeAtTheTopIsKeptClearOf() {
        let screen = CGRect(x: 0, y: 100, width: 1000, height: 800)
        XCTAssertEqual(TilingRead.reach(of: [], into: screen), 0)
        XCTAssertEqual(TilingRead.reach(of: [CGRect(x: 0, y: 870, width: 1000, height: 30)], into: screen), 30)
        let islands = [CGRect(x: 10, y: 860, width: 200, height: 30), CGRect(x: 790, y: 856, width: 200, height: 34)]
        XCTAssertEqual(TilingRead.reach(of: islands, into: screen), 44, "islands under a margin")
        XCTAssertEqual(TilingRead.reach(of: [CGRect(x: 0, y: 100, width: 1000, height: 30)], into: screen), 0, "one at the bottom")
        XCTAssertEqual(TilingRead.reach(of: [CGRect(x: 1000, y: 870, width: 1000, height: 30)], into: screen), 0, "another screen's")
    }

    func testOnlyAWindowThatCouldTileNowIsAsked() {
        let asked = { (f: TilingFacts) in !TilingRead.toAsk([f], shown: [1], options: self.options).isEmpty }
        XCTAssertFalse(asked(window(1)), "answered already")
        XCTAssertTrue(asked(window(1) { $0.answer = nil }))
        XCTAssertFalse(asked(window(1, on: 2) { $0.answer = nil }), "its workspace isn't in sight")
        XCTAssertFalse(asked(window(1) { $0.answer = nil; $0.onScreen = false }))
        XCTAssertFalse(asked(window(1) { $0.answer = nil; $0.minimized = true }))
        XCTAssertFalse(asked(window(1) { $0.answer = nil; $0.parked = true }))
        XCTAssertTrue(asked(window(1) { $0.screenSized = true }), "full screen may have begun")
        options.agentWorkspace = 1
        XCTAssertFalse(asked(window(1) { $0.answer = nil }), "the agent workspace is never asked")
        options.agentWorkspace = nil
        options.off = [1]
        XCTAssertFalse(asked(window(1) { $0.answer = nil }), "off")
    }

    func testAWindowOutOfReachKeepsItsPlaceAndIsLeftAlone() {
        let away = { (f: TilingFacts) in TilingRead.shot([f], shown: self.shown, focused: nil).windows[0].away }
        XCTAssertFalse(away(window(1)))
        XCTAssertTrue(away(window(1) { $0.answer = nil }), "not until its app answered")
        XCTAssertTrue(away(window(1) { $0.frame = nil }))
        XCTAssertTrue(away(window(1) { $0.onScreen = false }))
        XCTAssertTrue(away(window(1) { $0.minimized = true }))
        XCTAssertTrue(away(window(1) { $0.parked = true }))
        XCTAssertTrue(away(window(1) { $0.filled = true }))
        XCTAssertTrue(away(window(1) { $0.answer?.fullScreen = true }))
    }

    func testAWindowThatCannotBeResizedIsFixed() {
        let shot = TilingRead.shot([window(1), window(2) { $0.answer?.resizable = false }], shown: shown, focused: 2)
        XCTAssertEqual(shot.windows.map(\.fixed), [false, true])
        XCTAssertEqual(shot.focused, 2)
    }

    func testAWorkspaceBehindAFullScreenAppWaits() {
        let sees = { (list: [TilingFacts]) in TilingRead.shot(list, shown: self.shown, focused: nil).shown.keys.contains(1) }
        XCTAssertTrue(sees([]), "an empty workspace is in sight")
        XCTAssertTrue(sees([window(1)]))
        XCTAssertTrue(sees([window(1) { $0.minimized = true; $0.onScreen = false }]), "all in the Dock: nothing hides it")
        XCTAssertFalse(sees([window(1) { $0.onScreen = false }, window(2) { $0.onScreen = false }]))
        XCTAssertFalse(sees([window(1) { $0.onScreen = false }, window(2) { $0.answer?.fullScreen = true }]))
        XCTAssertTrue(sees([window(1) { $0.onScreen = false }, window(2)]))
    }

    func testAWindowNotDrawnYetIsWaitedFor() {
        let late = { (f: TilingFacts) in TilingRead.late([f], shown: [1], known: { $0 == 7 }) }
        XCTAssertEqual(late(window(1) { $0.onScreen = false }), [1])
        XCTAssertEqual(late(window(1)), [])
        XCTAssertEqual(late(window(7) { $0.onScreen = false }), [], "waited for long enough")
        XCTAssertEqual(late(window(1, on: 2) { $0.onScreen = false }), [])
        XCTAssertEqual(late(window(1) { $0.onScreen = false; $0.minimized = true }), [])
        XCTAssertEqual(late(window(1) { $0.onScreen = false; $0.parked = true }), [])
    }
}

final class WriteGateTests: XCTestCase {
    func testAPassEndsWhenSomethingElseMovesWindows() {
        let gate = WriteGate()
        let first = gate.pass
        XCTAssertTrue(gate.open(first))
        gate.cut()
        XCTAssertFalse(gate.open(first), "one write by another hand ends it")
        let second = gate.pass
        XCTAssertTrue(gate.open(second))
        gate.set(shut: true)
        XCTAssertFalse(gate.open(second))
        XCTAssertFalse(gate.open(gate.pass), "none starts while it is shut")
        gate.set(shut: false)
        XCTAssertFalse(gate.open(second), "a switch in between ended it for good")
        XCTAssertTrue(gate.open(gate.pass))
    }

    func testOpeningAnOpenGateEndsNothing() {
        let gate = WriteGate(), pass = gate.pass
        gate.set(shut: false)
        XCTAssertTrue(gate.open(pass))
    }
}
