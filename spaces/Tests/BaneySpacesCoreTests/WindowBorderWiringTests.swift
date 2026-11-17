import XCTest

/// T5, the app side of window borders: off holds nothing, Polycarp never reaches into another app to draw one, a border
/// never counts as covering the window it surrounds, and the Settings switch and workspace switches reach it.
final class WindowBorderWiringTests: XCTestCase {
    func testOffHoldsNothingAndTheBorderNeverCountsAsCoveringItsWindow() throws {
        let borders = try Repo.code("Sources/BaneySpaces/WindowBorders.swift")
        // Off: every observer, monitor, timer and display link goes, and each border window closes.
        for teardown in ["removeObserver(o)", "NSEvent.removeMonitor(mouse)", "idle?.invalidate()", "list?.invalidate()",
                         "goFast(false)", "p.close()"] {
            XCTAssertTrue(borders.contains(teardown), teardown)
        }
        XCTAssertTrue(borders.contains("guard want else { if on { stop() }; return }"), "off never starts anything")
        // Never into another app: no Accessibility call, no event posted.
        for banned in ["AXUIElement", "CGEvent(", ".post(tap"] { XCTAssertFalse(borders.contains(banned), banned) }
        XCTAssertTrue(borders.contains("ignoresMouseEvents = true"))
        let windows = try Repo.code("Sources/BaneySpaces/Windows.swift")
        XCTAssertTrue(windows.contains("!BorderOverlayWindows.contains(n)"))
        let app = try Repo.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("WindowBorders.shared.sync()"), "the switch in Settings takes effect")
        XCTAssertTrue(app.contains("WindowBorders.shared.refresh()"), "a workspace switch moves the borders with it")
    }
}
