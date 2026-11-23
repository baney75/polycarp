import XCTest

/// Donovan, 2026-11-23: "block the bar from coming in any form." macOS's own menu bar slid in over Polycarp's at the
/// top edge, and holding the pointer off the edge didn't stop it (live check of #619: it came in with the pointer held
/// at 1 and at 4 points down). What holds is the window server drawing that bar transparent while Polycarp's bar is up.
final class SystemMenuBarTests: XCTestCase {
    func testTheMacOSBarIsHiddenWhileTheBarIsUpAndGivenBackWhenItIsOff() throws {
        let bar = try Repo.text("Sources/BaneySpaces/TopBar.swift")
        let reload = try XCTUnwrap(bar.range(of: "func reload()"))
        let place = try XCTUnwrap(bar.range(of: "private func place("))
        XCTAssertTrue(bar[reload.upperBound..<place.lowerBound].contains("SystemMenuBar.hide(!keep.isEmpty)"),
                      "every reload hides the macOS bar where Polycarp's is up")
        let remove = try XCTUnwrap(bar.range(of: "private func removeAll()"))
        XCTAssertTrue(bar[remove.upperBound...].prefix(200).contains("SystemMenuBar.hide(false)"), "turning the bar off gives it back")
        XCTAssertTrue(bar.contains("activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in\n            guard let self else { return }\n            SystemMenuBar.hide(!self.panels.isEmpty)"),
                      "a Space change hides it again (review of #621)")
    }

    func testItIsTheWindowServersMenuBarAlphaNotAPointerClamp() throws {
        let s = try Repo.text("Sources/BaneySpaces/SystemMenuBar.swift")
        XCTAssertTrue(s.contains("\"SLSSetMenuBarInsetAndAlpha\""))
        XCTAssertTrue(s.contains("on ? 0 : 1"), "transparent while hidden, opaque when given back")
        XCTAssertThrowsError(try Repo.text("Sources/BaneySpaces/MenuBarEdgeGuard.swift"), "the pointer clamp failed live and is gone")
    }
}
