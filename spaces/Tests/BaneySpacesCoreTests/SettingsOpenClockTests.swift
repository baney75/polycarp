import Foundation
import XCTest

/// #350: timing.log timed the launcher, overview and dock (`OpenClock`) but never the Settings window, so its live open and
/// pane switch times couldn't be read.
final class SettingsOpenClockTests: XCTestCase {
    func testEveryOpenOfSettingsIsTimed() throws {
        let app = try HandsSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        let show = try XCTUnwrap(HandsSourceTests.block(after: "private func showSettings() ", in: app))
        XCTAssertTrue(show.contains(#"let clock = OpenClock(setupBuilt ? "settings" : "settings-first")"#))
        XCTAssertTrue(show.contains("defer { clock.shown() }"))
        XCTAssertTrue(show.contains("setup.show()"))
        XCTAssertEqual(app.components(separatedBy: "setup.show()").count, 2, "Settings opens only through showSettings")
        let lazy = try XCTUnwrap(HandsSourceTests.block(after: "private lazy var setup: SetupWindowController = ", in: app))
        XCTAssertTrue(lazy.contains("setupBuilt = true"), "the first open is told apart")
    }

    func testAPaneSwitchInTheOpenWindowIsTimed() throws {
        let setup = try HandsSourceTests.code("Sources/BaneySpaces/Setup.swift")
        let tab = try XCTUnwrap(HandsSourceTests.block(after: "@Published var tab: SettingsTab = .general ", in: setup))
        XCTAssertTrue(tab.contains(#"let clock = windowVisible() && tab != oldValue ? OpenClock("settings-" + tab.rawValue.lowercased()) : nil"#),
                      "only in the open window, never in the offscreen harness or before show")
        XCTAssertTrue(tab.contains("defer { clock?.shown() }"))
    }
}
