import XCTest

/// T5, the app side of window borders: off holds nothing, Polycarp never reaches into another app to draw one, a border
/// never counts as covering the window it surrounds, and the Settings switch and workspace switches reach it.
final class WindowBorderWiringTests: XCTestCase {
    func testOffHoldsNothingAndTheBorderNeverCountsAsCoveringItsWindow() throws {
        let borders = try Repo.code("Sources/BaneySpaces/WindowBorders.swift")
        // Off: every observer, monitor, timer and display link goes, and each border window closes.
        for teardown in ["removeObserver(o)", "NSEvent.removeMonitor(mouse)", "idle?.invalidate()", "list?.invalidate()",
                         "BorderMoves.stop()", "p.close()"] {
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

    /// The border moves in the window server's own move notice, never from a later read of the window list, and the
    /// fallback is said once and hides instead of trailing.
    func testBordersMoveOnTheWindowServersNoticeOrHide() throws {
        let moves = try Repo.code("Sources/BaneySpaces/BorderMoves.swift")
        for call in ["SLSRegisterNotifyProc", "SLSRequestNotificationsForWindows", "SLSGetWindowBounds", "SLSTransactionMoveWindowWithGroup",
                     "SLSTransactionCommit", "SLSRemoveNotifyProc"] {
            XCTAssertTrue(moves.contains(call), call)
        }
        XCTAssertFalse(moves.contains("CGWindowList"), "the notice path reads one window's bounds, not the list")
        let borders = try Repo.code("Sources/BaneySpaces/WindowBorders.swift")
        XCTAssertTrue(borders.contains("BorderFollowMode.choose(notices: why == nil, forced: forced)"))
        XCTAssertTrue(borders.contains("BANEYSPACES_BORDER_FALLBACK"), "the fallback can be forced")
        XCTAssertTrue(borders.contains("guard let at = shown[id] else { if p.isVisible { p.orderOut(nil) }; continue }"),
                      "the fallback draws only what the gate allows")
        XCTAssertTrue(borders.contains("!Self.toldFallback"), "the fallback is logged once")
        for gone in ["RealTime", "BorderFollower", "thread_policy_set"] { XCTAssertFalse(borders.contains(gone), gone) }
    }
}
