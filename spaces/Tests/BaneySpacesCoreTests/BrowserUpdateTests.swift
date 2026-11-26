import XCTest
@testable import BaneySpacesCore

final class BrowserUpdateTests: XCTestCase {
    func testOnceADayAndOnlyWithAutomaticChecksOn() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let hours = { (h: Double) in now.addingTimeInterval(-h * 3600) }
        XCTAssertTrue(BrowserUpdate.due(last: nil, now: now, automatic: true))
        XCTAssertFalse(BrowserUpdate.due(last: hours(22), now: now, automatic: true))
        XCTAssertTrue(BrowserUpdate.due(last: hours(23), now: now, automatic: true))
        XCTAssertTrue(BrowserUpdate.due(last: hours(-5), now: now, automatic: true), "a clock set back must not stop it")
        XCTAssertFalse(BrowserUpdate.due(last: nil, now: now, automatic: false))
        XCTAssertFalse(BrowserUpdate.due(last: hours(90), now: now, automatic: false))
    }

    /// It never replaces the browser under the person, and it runs the app's own copy of the command.
    func testItWaitsForTheBrowserToQuit() {
        XCTAssertEqual(BrowserUpdate.arguments, ["browser", "update", "--when-quit"])
        let resources = URL(fileURLWithPath: "/Applications/Polycarp.app/Contents/Resources")
        XCTAssertEqual(BrowserUpdate.command(resources: resources).path, "/Applications/Polycarp.app/Contents/Resources/bin/polycarp")
    }
}
