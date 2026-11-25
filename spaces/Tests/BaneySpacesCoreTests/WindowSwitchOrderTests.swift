@testable import BaneySpacesCore
import XCTest

final class CmdTabModeTests: XCTestCase {
    func testWindowsIsTheDefaultAndStoredChoicesKeepWorking() {
        XCTAssertEqual(CmdTabMode.resolve(stored: nil, legacy: nil), .windows)
        XCTAssertEqual(CmdTabMode.resolve(stored: "apps", legacy: nil), .apps)
        XCTAssertEqual(CmdTabMode.resolve(stored: "workspaces", legacy: false), .workspaces)
        XCTAssertEqual(CmdTabMode.resolve(stored: "off", legacy: true), .off)
        // 0.2's one switch, on or off.
        XCTAssertEqual(CmdTabMode.resolve(stored: nil, legacy: true), .workspaces)
        XCTAssertEqual(CmdTabMode.resolve(stored: nil, legacy: false), .off)
    }

    func testSettingsOffersWindowsFirst() {
        XCTAssertEqual(CmdTabMode.allCases, [.windows, .apps, .workspaces, .off])
        XCTAssertEqual(CmdTabMode.windows.title, "Windows")
    }
}

final class WindowSwitchOrderTests: XCTestCase {
    private func on(_ workspace: Int, _ ids: WindowID..., minimized: Bool = false) -> [WindowSwitchOrder.Window] {
        ids.map { .init(id: $0, workspace: workspace, minimized: minimized) }
    }

    private func list(_ order: WindowSwitchOrder, _ stacking: [WindowID], _ windows: [WindowSwitchOrder.Window],
                      current: Int = 1, recent: [Int] = [1], at time: Double = 100) -> [WindowID] {
        order.list(stacking: stacking, windows: windows, current: current, recent: recent, at: time).ids
    }

    private func noted(_ ids: WindowID...) -> WindowSwitchOrder {
        ids.reduce(into: WindowSwitchOrder()) { $0.note($1) }
    }

    func testOneTapGoesToTheWindowUsedLastWhateverItsAppOrWorkspace() {
        let windows = on(1, 10, 11) + on(3, 30) + on(7, 70)
        XCTAssertEqual(list(noted(70, 30, 11, 10), [10, 11], windows), [10, 11, 30, 70])
        // Used in another order, another list: focus decides, not the workspace.
        XCTAssertEqual(list(noted(11, 30, 70, 10), [10, 11], windows), [10, 70, 30, 11])
    }

    func testTheWindowInFrontIsFirstWithNoFocusEvent() {
        XCTAssertEqual(list(noted(11, 10), [12, 10, 11], on(1, 10, 11, 12)), [12, 10, 11])
        // One the model doesn't hold (a panel of Polycarp's own) is passed over.
        XCTAssertEqual(list(noted(11, 10), [99, 11, 10], on(1, 10, 11)), [11, 10])
    }

    func testNeverFocusedWindowsGoByStackingThenRecentWorkspaceThenId() {
        let windows = on(5, 52, 51) + on(1, 10, 11, 12, 13) + on(2, 20) + on(4, 40) + on(3, 30)
        let order = list(noted(40, 13), [13, 12, 10, 11], windows, recent: [1, 5, 2])
        XCTAssertEqual(order, [13, 40, 12, 10, 11, 51, 52, 20, 30])
    }

    func testMinimizedWindowsComeLastEvenWhenUsedLately() {
        let windows = on(1, 10) + on(1, 11, minimized: true) + on(2, 20) + on(2, 21, minimized: true)
        XCTAssertEqual(list(noted(21, 11, 10), [10], windows), [10, 20, 11, 21])
        // The one in front is on screen, whatever the last scan said.
        XCTAssertEqual(list(noted(10), [11, 10], windows).first, 11)
    }

    func testNothingTwiceAndTheSameInputGivesTheSameList() {
        let windows = on(1, 10, 11, 10) + on(2, 20, 21, 22, 23, 24, 25) + on(1, 10)
        let order = list(noted(20, 10, 20, 11), [10, 11, 10], windows, recent: [1, 2])
        XCTAssertEqual(order, [10, 11, 20, 21, 22, 23, 24, 25])
        for _ in 0..<20 { XCTAssertEqual(list(noted(20, 10, 20, 11), [10, 11, 10], windows.shuffled(), recent: [1, 2]), order) }
    }

    func testAClosedWindowIsDropped() {
        var order = noted(12, 11, 10)
        XCTAssertEqual(list(order, [10], on(1, 10, 12)), [10, 12])
        order.forget(except: [10, 12])
        // Its number back as another window, that one was never focused.
        XCTAssertEqual(list(order, [10], on(1, 10, 11, 12)), [10, 12, 11])
    }

    func testASecondTapGoesBackWhileTheFirstPickIsStillComingForward() {
        var order = noted(20, 10)
        order.pick(20, at: 100)
        XCTAssertEqual(list(order, [10], on(1, 10) + on(2, 20), at: 100.2), [20, 10])
        XCTAssertEqual(list(order, [10], on(1, 10) + on(2, 20), at: 100.6), [10, 20], "it never came forward")
        order.forget(except: [10])
        XCTAssertEqual(list(order, [10], on(1, 10), at: 100.2), [10])
    }

    func testWithNothingInFrontTheFirstCardIsTheOneUsedLast() {
        let l = noted(30, 20).list(stacking: [], windows: on(2, 20) + on(3, 30), current: 1, recent: [1, 2], at: 0)
        XCTAssertEqual(l, .init(ids: [20, 30], front: nil))
        XCTAssertEqual(SwitcherSelection.first(count: 2, forward: true, inFront: false), 0)
        XCTAssertEqual(SwitcherSelection.first(count: 2, forward: false, inFront: false), 1)
        XCTAssertEqual(SwitcherSelection.first(count: 2, forward: true, inFront: true), 1)
    }
}

final class SwitcherRevealTests: XCTestCase {
    func testAQuickTapNeverShowsThePanel() {
        var r = SwitcherReveal()
        r.begin(at: 10)
        XCTAssertTrue(r.active)
        XCTAssertFalse(r.lasted(at: 10.119))
        XCTAssertFalse(r.isUp)
        r.end()
        XCTAssertFalse(r.active)
        XCTAssertFalse(r.lasted(at: 11), "a timer from a gesture that ended shows nothing")
        XCTAssertFalse(r.stepped())
    }

    func testItShowsOnceAfterTheDelay() {
        var r = SwitcherReveal()
        r.begin(at: 10)
        XCTAssertEqual(r.wait(at: 10.05), 0.07, accuracy: 1e-9)
        XCTAssertEqual(r.wait(at: 12), 0)
        XCTAssertTrue(r.lasted(at: 10.13))
        XCTAssertTrue(r.isUp && r.active)
        XCTAssertFalse(r.lasted(at: 10.2))
        XCTAssertFalse(r.stepped(), "already up")
    }

    func testTheSecondStepShowsItAtOnce() {
        var r = SwitcherReveal()
        r.begin(at: 10)
        XCTAssertTrue(r.stepped())
        XCTAssertFalse(r.lasted(at: 10.13))
        // The next gesture waits again.
        r.end()
        r.begin(at: 10.15)
        XCTAssertFalse(r.isUp)
        XCTAssertFalse(r.lasted(at: 10.2), "the last gesture's timer is not this one's")
    }
}

final class WindowGridTests: XCTestCase {
    private let screens: [(Double, Double)] = [(1024, 743), (1512, 918), (3440, 1415)]

    func testEveryCountFitsEveryScreen() {
        for (w, h) in screens {
            for n in [0, 1, 2, 5, 12, 30, 60, 150] {
                let g = WindowGrid.fit(count: n, maxWidth: w, maxHeight: h)
                XCTAssertLessThanOrEqual(g.size.width, w - WindowGrid.margin, "\(n) windows on \(w)")
                XCTAssertLessThanOrEqual(g.size.height, h - WindowGrid.margin, "\(n) windows on \(w)")
                XCTAssertGreaterThanOrEqual(g.columns * g.rows, max(n, 1))
                XCTAssertLessThan(g.columns * (g.rows - 1), max(n, 1), "an empty row")
                if n <= 60 { XCTAssertGreaterThanOrEqual(g.cardHeight, 40, "\(n) windows on \(w) are too thin to read") }
            }
        }
    }

    func testFewWindowsGetTheBigCardAndManyASmallerOne() {
        func shape(_ n: Int, _ s: (Double, Double)) -> [Double] {
            let g = WindowGrid.fit(count: n, maxWidth: s.0, maxHeight: s.1)
            return [Double(g.columns), Double(g.rows), g.cardWidth, g.cardHeight]
        }
        XCTAssertEqual(shape(1, screens[0]), [1, 1, 200, 100])
        XCTAssertEqual(shape(2, screens[1]), [2, 1, 200, 100])
        // Even rows, not a full one and a leftover.
        XCTAssertEqual(shape(5, screens[0]), [3, 2, 200, 100])
        XCTAssertEqual(shape(12, screens[1]), [6, 2, 200, 100])
        XCTAssertEqual(shape(30, screens[0]), [4, 8, 200, 44])
        XCTAssertEqual(shape(60, screens[0]), [5, 12, 160, 40])
        XCTAssertEqual(shape(60, screens[1]), [6, 10, 200, 44])
        XCTAssertEqual(shape(60, screens[2]), [6, 10, 200, 100])
    }

    func testUpAndDownMoveByARow() {
        func row(_ i: Int, _ n: Int, _ columns: Int, _ down: Bool) -> Int {
            SwitcherSelection.row(selected: i, count: n, columns: columns, forward: down)
        }
        XCTAssertEqual(row(1, 12, 6, true), 7)
        XCTAssertEqual(row(7, 12, 6, false), 1)
        // Both ends wrap, in the same column.
        XCTAssertEqual(row(8, 12, 6, true), 2)
        XCTAssertEqual(row(2, 12, 6, false), 8)
        // A short last row gives its last card.
        XCTAssertEqual(row(2, 5, 3, true), 4)
        XCTAssertEqual(row(2, 5, 3, false), 4)
        // One row: they step like the other arrows.
        XCTAssertEqual(row(1, 3, 3, true), 2)
        XCTAssertEqual(row(0, 3, 3, false), 2)
        XCTAssertEqual(row(0, 0, 1, true), 0)
        for key in [SwitcherSelection.upArrow, SwitcherSelection.downArrow] { XCTAssertTrue(SwitcherSelection.goesByRow(keyCode: key)) }
        for key in [SwitcherSelection.leftArrow, SwitcherSelection.rightArrow] { XCTAssertFalse(SwitcherSelection.goesByRow(keyCode: key)) }
    }
}
