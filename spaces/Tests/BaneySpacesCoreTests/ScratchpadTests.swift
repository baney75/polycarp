import XCTest
@testable import BaneySpacesCore

final class ScratchpadTests: XCTestCase {
    /// Windows 1 to 3 on workspace 1, 4 on workspace 2, with 1 in focus.
    private func model() -> Workspaces {
        var m = Workspaces()
        m.sync(seen: [1, 2, 3], alive: [1, 2, 3, 4])
        _ = m.switchTo(2)
        m.sync(seen: [4], alive: [1, 2, 3, 4])
        _ = m.switchTo(1)
        m.noteFocus(1)
        return m
    }

    func testAWindowSentThereIsOutOfSightAndOnNoWorkspace() {
        var m = model()
        m.toScratchpad(1)
        let p = m.switchTo(1)
        XCTAssertEqual(p.hide, [1, 4])
        XCTAssertEqual(m.scratch, [1])
        XCTAssertFalse(m.scratchpadIsOut)
        XCTAssertEqual(p.focus, 2)
        for n in Workspaces.range { XCTAssertFalse(m.windows(on: n).contains(1)) }
    }

    func testItComesOutOverTheWorkspaceInUseAndGoesAwayAgain() {
        var m = model()
        m.toScratchpad(2); m.toScratchpad(3)
        _ = m.switchTo(2)
        m.noteFocus(4)
        XCTAssertEqual(m.showScratchpad(), 3, "the one sent last")
        XCTAssertTrue(m.scratchpadIsOut)
        XCTAssertEqual(m.switchTo(2).show, [2, 3, 4])
        m.noteFocus(2)
        m.hideScratchpad()
        let p = m.switchTo(2)
        XCTAssertEqual(p.show, [4])
        XCTAssertEqual(p.focus, 4, "what was in focus under it")
        XCTAssertEqual(m.showScratchpad(), 2, "the one used last")
    }

    func testFocusUnderneathIsNotedWhileItIsOut() {
        var m = model()
        m.toScratchpad(3)
        m.noteFocus(1)
        _ = m.showScratchpad()
        m.noteFocus(2)
        m.noteFocus(3)
        m.hideScratchpad()
        XCTAssertEqual(m.switchTo(1).focus, 2)
    }

    func testItGoesAwayWithTheWorkspaceItIsOver() {
        var m = model()
        m.toScratchpad(3)
        m.noteFocus(1)
        _ = m.showScratchpad()
        XCTAssertEqual(m.switchTo(2).show, [4])
        XCTAssertEqual(m.scratch, [3])
        XCTAssertFalse(m.scratchpadIsOut)
        XCTAssertEqual(m.switchTo(1).focus, 1)
    }

    func testItMovesToTheDisplayInUse() {
        var m = model()
        m.displays(["A", "B"])
        let there = m.shown["B"]!
        m.toScratchpad(3)
        _ = m.showScratchpad()
        m.focus(display: "B")
        XCTAssertFalse(m.scratchpadIsOut)
        _ = m.showScratchpad()
        XCTAssertEqual(m.workspace(of: 3), there)
        XCTAssertTrue(m.scratchpadIsOut)
        XCTAssertEqual(m.scratch, [3])
        // It stays out when the other display goes elsewhere, and goes when its own does.
        m.focus(display: "A")
        _ = m.switchTo(2)
        XCTAssertEqual(m.workspace(of: 3), there)
    }

    func testDraggedToAnotherDisplayItIsStillOfTheScratchpad() {
        var m = model()
        m.displays(["A", "B"])
        m.toScratchpad(3)
        _ = m.showScratchpad()
        XCTAssertTrue(m.moved(3, to: "B"))
        XCTAssertTrue(m.isScratch(3))
        XCTAssertFalse(m.moved(2, to: "A"))
        XCTAssertTrue(m.moved(2, to: "B"))
        XCTAssertFalse(m.isScratch(2))
    }

    /// A display that goes takes the workspace under the scratchpad: it is put away, not left half out.
    func testADisplayThatGoesPutsItAway() {
        var m = model()
        m.displays(["A", "B"])
        m.toScratchpad(3)
        m.focus(display: "B")
        _ = m.showScratchpad()
        m.displays(["A"])
        _ = m.switchTo(m.current)
        XCTAssertEqual(m.workspace(of: 3), Workspaces.scratchpad)
        XCTAssertEqual(m.showScratchpad(), 3)
        XCTAssertEqual(m.workspace(of: 3), m.current)
    }

    func testTakenOutItIsOfTheWorkspace() {
        var m = model()
        m.toScratchpad(3)
        _ = m.showScratchpad()
        m.takeOut(3)
        XCTAssertFalse(m.isScratch(3))
        m.hideScratchpad()
        XCTAssertEqual(m.switchTo(1).show, [1, 2, 3])
        m.toScratchpad(2)
        m.takeOut(2)
        XCTAssertEqual(m.workspace(of: 2), 1, "from out of sight to the workspace in use")
        m.takeOut(4)
        XCTAssertEqual(m.workspace(of: 4), 2, "one that isn't on the scratchpad stays")
    }

    func testSentToAWorkspaceItIsOffTheScratchpad() {
        var m = model()
        m.toScratchpad(3)
        _ = m.showScratchpad()
        m.assign(3, to: 5)
        XCTAssertFalse(m.isScratch(3))
        XCTAssertEqual(m.workspace(of: 3), 5)
        m.putBack(3, on: Workspaces.scratchpad)
        XCTAssertTrue(m.isScratch(3))
        m.putBack(3, on: 4)
        XCTAssertEqual(m.workspace(of: 3), 4)
    }

    /// Spaceman's trap: a window closed while out of sight must not count any more.
    func testAWindowClosedWhileAwayIsForgotten() {
        var m = model()
        m.toScratchpad(2); m.toScratchpad(3)
        m.sync(seen: [1], alive: [1, 2, 4])
        XCTAssertEqual(m.scratch, [2])
        XCTAssertEqual(m.showScratchpad(), 2)
        m.sync(seen: [1], alive: [1, 4])
        XCTAssertFalse(m.scratchpadIsOut)
        XCTAssertNil(m.showScratchpad())
        XCTAssertEqual(m.lastFocused[1], nil)
    }

    func testTheOneSentLastComesOutOnTop() {
        var m = model()
        m.toScratchpad(3); m.toScratchpad(2)
        XCTAssertEqual(m.showScratchpad(), 2)
    }

    func testTakenOutOnAnotherDisplayItStaysThere() {
        var m = model()
        m.displays(["A", "B"])
        m.toScratchpad(3)
        _ = m.showScratchpad()
        m.focus(display: "B")
        m.takeOut(3)
        XCTAssertEqual(m.workspace(of: 3), 1)
    }

    /// Window numbers are reused: a new window is not what the one before it was.
    func testANewWindowWithAnOldNumberIsPlain() {
        var m = model()
        m.toScratchpad(3)
        m.noteFocus(2)
        _ = m.showScratchpad()
        m.sync(seen: [1], alive: [1, 4])
        m.sync(seen: [1, 2, 3], alive: [1, 2, 3, 4])
        XCTAssertFalse(m.isScratch(3))
        m.toScratchpad(3)
        _ = m.showScratchpad()
        m.hideScratchpad()
        XCTAssertEqual(m.switchTo(1).focus, 1, "2 is another window now, not yet used")
    }

    func testAWindowBroughtHereHasTheFocusAfterTheScratchpad() {
        var m = model()
        m.toScratchpad(3)
        m.assign(4, to: 1)
        _ = m.showScratchpad()
        m.hideScratchpad()
        XCTAssertEqual(m.switchTo(1).focus, 4)
    }

    func testTheAgentWorkspaceHasNone() {
        var m = model()
        m.reserved = [6]
        m.toScratchpad(3)
        _ = m.switchTo(6)
        XCTAssertNil(m.showScratchpad())
        XCTAssertEqual(m.windows(on: 6), [])
    }

    func testItIsThereAgainAfterARestart() {
        var m = Workspaces()
        m.sync(seen: [1, 2], alive: [1, 2])
        m.restore(current: 1, home: [1: 1, 2: Workspaces.scratchpad], lastFocused: [0: 2])
        XCTAssertEqual(m.scratch, [2])
        XCTAssertEqual(m.switchTo(1).show, [1])
        m.restore(current: 1, home: [1: 12], lastFocused: [:])
        XCTAssertEqual(m.workspace(of: 1), 1)
    }

    /// Whatever happens, a window is on one workspace or away, and in sight only where its workspace is.
    func testEveryStepKeepsTheScratchpadWhole() {
        var rng = TileRandom(state: 99)
        var m = model()
        m.displays(["A", "B"])
        m.reserved = [9]
        for _ in 0..<4000 {
            let id = WindowID(Int.random(in: 1...4, using: &rng))
            switch Int.random(in: 0..<9, using: &rng) {
            case 0: m.toScratchpad(id)
            case 1: _ = m.showScratchpad()
            case 2: m.hideScratchpad()
            case 3: m.takeOut(id)
            case 4: _ = m.moved(id, to: Bool.random(using: &rng) ? "A" : "B")
            case 5: m.displays([["A"], ["A", "B"], ["B"], []].randomElement(using: &rng)!)
            case 6: m.noteFocus(id)
            case 7: m.assign(id, to: Int.random(in: 1...9, using: &rng))
            default:
                let p = m.switchTo(Int.random(in: 1...9, using: &rng))
                XCTAssertEqual(Set(p.show).union(p.hide), [1, 2, 3, 4])
                XCTAssertTrue(m.out.allSatisfy { p.show.contains($0) })
                if let f = p.focus { XCTAssertEqual(m.workspace(of: f), m.current) }
                for s in m.scratch where !m.out.contains(s) { XCTAssertTrue(p.hide.contains(s)) }
            }
            XCTAssertTrue(m.out.allSatisfy { m.home[$0] != Workspaces.scratchpad })
            XCTAssertTrue(m.windows(on: 9).allSatisfy { !m.out.contains($0) } || m.reserved.isEmpty || m.isShown(9))
            for (n, w) in m.lastFocused { XCTAssertEqual(m.home[w], n) }
        }
    }
}
