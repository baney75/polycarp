import XCTest
@testable import BaneySpacesCore

final class PinnedTests: XCTestCase {
    /// Windows 1 and 2 on workspace 1, 4 on workspace 2, with 1 in focus.
    private func model() -> Workspaces {
        var m = Workspaces()
        m.sync(seen: [1, 2], alive: [1, 2, 4])
        _ = m.switchTo(2)
        m.sync(seen: [4], alive: [1, 2, 4])
        _ = m.switchTo(1)
        m.noteFocus(1)
        return m
    }

    func testAPinnedWindowIsOnEveryWorkspaceYouGoTo() {
        var m = model()
        m.pin(1, true)
        let p = m.switchTo(2)
        XCTAssertEqual(p.show, [1, 4])
        XCTAssertEqual(p.hide, [2])
        XCTAssertEqual(p.focus, 4, "the workspace's own window")
        XCTAssertEqual(m.workspace(of: 1), 2)
        m.noteFocus(1)
        XCTAssertEqual(m.switchTo(3).focus, 1, "there is no other")
        XCTAssertEqual(m.switchTo(2).focus, 4)
        XCTAssertEqual(m.switchTo(1).focus, 2)
    }

    func testOneInFocusOnItsWorkspaceIsStillTheOneThere() {
        var m = model()
        m.pin(1, true)
        m.noteFocus(1)
        XCTAssertEqual(m.switchTo(1).focus, 1)
    }

    func testWhatHadTheFocusBeforeItHasItAgain() {
        var m = model()
        m.sync(seen: [1, 2, 3], alive: [1, 2, 3, 4])
        m.pin(1, true)
        m.noteFocus(3)
        m.noteFocus(1)
        _ = m.switchTo(2)
        XCTAssertEqual(m.switchTo(1).focus, 3)
    }

    func testLetGoItStaysOnTheWorkspaceItIsOn() {
        var m = model()
        m.pin(1, true)
        _ = m.switchTo(2)
        m.pin(1, false)
        XCTAssertEqual(m.switchTo(1).hide, [1, 4])
    }

    func testItNeverShowsOnTheAgentWorkspace() {
        var m = model()
        m.reserved = [9]
        m.pin(1, true)
        XCTAssertEqual(m.switchTo(9).show, [])
        XCTAssertEqual(m.switchTo(2).show, [1, 4], "and is back on the next")
        m.assign(4, to: 9)
        _ = m.switchTo(9)
        m.pin(4, true)
        XCTAssertFalse(m.pinned.contains(4))
    }

    func testItStaysOnItsDisplay() {
        var m = model()
        m.displays(["A", "B"])
        XCTAssertEqual(m.shown, ["A": 1, "B": 3])
        m.pin(1, true)
        m.focus(display: "B")
        _ = m.switchTo(2)
        XCTAssertEqual(m.workspace(of: 1), 1, "the other display's workspace changed")
        m.focus(display: "A")
        _ = m.switchTo(5)
        XCTAssertEqual(m.workspace(of: 1), 5)
        XCTAssertTrue(m.moved(1, to: "B"))
        XCTAssertTrue(m.pinned.contains(1), "carried over it is pinned there")
        m.focus(display: "B")
        _ = m.switchTo(6)
        XCTAssertEqual(m.workspace(of: 1), 6)
    }

    /// A display that goes away takes no pinned window with it, and those of the other stay where they are.
    func testADisplayThatGoesAwayLeavesItsPinnedWindowsToTheNextSwitch() {
        var m = model()
        m.displays(["A", "B"])
        m.assign(2, to: 3)
        m.pin(1, true)
        m.pin(2, true)
        m.displays(["A"])
        XCTAssertEqual(m.switchTo(1).show, [1, 2])
        XCTAssertEqual(m.workspace(of: 2), 1)
    }

    func testSentToAWorkspaceItIsThatOnes() {
        var m = model()
        m.pin(1, true)
        m.assign(1, to: 2)
        XCTAssertFalse(m.pinned.contains(1))
    }

    func testTheScratchpadAndPinsAreOneOrTheOther() {
        var m = model()
        m.pin(1, true)
        m.toScratchpad(1)
        XCTAssertFalse(m.pinned.contains(1))
        XCTAssertTrue(m.isScratch(1))
        _ = m.showScratchpad()
        m.pin(1, true)
        XCTAssertFalse(m.isScratch(1))
        XCTAssertTrue(m.pinned.contains(1))
        XCTAssertEqual(m.switchTo(2).show, [1, 4])
    }

    func testClosedItIsForgotten() {
        var m = model()
        m.pin(1, true)
        m.sync(seen: [2], alive: [2, 4])
        m.sync(seen: [1, 2], alive: [1, 2, 4])
        XCTAssertFalse(m.pinned.contains(1), "another window with the same number")
    }

    func testAnotherTabIsPinnedInItsPlace() {
        var m = model()
        m.pin(1, true)
        m.noteFocus(1)
        m.sync(seen: [2, 5], alive: [1, 2, 4, 5])
        m.tab(1, became: 5)
        XCTAssertEqual(m.pinned, [5])
        XCTAssertEqual(m.lastFocused[1], 5)
        m.tab(2, became: 5)
        XCTAssertEqual(m.pinned, [5], "2 is not pinned")
        m.tab(5, became: 77)
        XCTAssertEqual(m.pinned, [5], "no such window")
    }

    func testAnotherTabOfAScratchpadWindowGoesAwayWithIt() {
        var m = model()
        m.toScratchpad(2)
        _ = m.showScratchpad()
        m.sync(seen: [1, 5], alive: [1, 2, 4, 5])
        m.assign(5, to: 2)
        m.tab(2, became: 5)
        XCTAssertEqual(m.workspace(of: 5), 1)
        m.hideScratchpad()
        XCTAssertEqual(m.workspace(of: 5), Workspaces.scratchpad)
    }

    func testPinsAreKeptAcrossRestarts() throws {
        var m = Workspaces()
        m.sync(seen: [1, 2, 4], alive: [1, 2, 4])
        let layout = SavedLayout(entries: [.init(window: 1, pid: 10, workspace: 1, pinned: true), .init(window: 2, pid: 20, workspace: 1, pinned: true),
                                           .init(window: 4, pid: 40, workspace: 2)])
        let read = try JSONDecoder().decode(SavedLayout.self, from: JSONEncoder().encode(layout))
        XCTAssertEqual(read, layout)
        XCTAssertEqual(read.pins(livePids: [1: 10, 2: 21, 4: 40]), [1], "2 is another app's now")
        m.restore(current: 1, home: [1: 1, 2: 1, 4: 2], lastFocused: [:], pinned: [1, 77])
        XCTAssertEqual(m.pinned, [1])
        let old = try JSONDecoder().decode(SavedLayout.self, from: Data(#"{"current":1,"entries":[{"window":1,"pid":10,"workspace":3}],"lastFocused":{}}"#.utf8))
        XCTAssertEqual(old.pins(livePids: [1: 10]), [])
    }
}
