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

    /// Two themes a minute apart while the first build runs: the second icon still gets its own build.
    func testANewIconDuringARunGetsOneMoreRun() {
        var r = BrowserUpdate.Rebuild()
        XCTAssertTrue(r.ask(free: true), "plum: a run starts")
        r.started()
        XCTAssertFalse(r.ask(free: true), "teal: never two runs at once")
        XCTAssertFalse(r.ask(free: true), "and a third ask is the same one")
        XCTAssertTrue(r.ended(free: true), "the plum run ends: one more, for teal")
        r.started()
        XCTAssertFalse(r.ended(free: true), "that run read teal: nothing more")
        XCTAssertFalse(r.wanted)
    }

    /// An ask while the app installs its own update, or with updates off, waits and is not lost.
    func testAnAskThatCantStartIsKeptUntilItCan() {
        var r = BrowserUpdate.Rebuild()
        XCTAssertFalse(r.ask(free: false))
        XCTAssertTrue(r.wanted)
        XCTAssertFalse(r.look(free: false))
        XCTAssertTrue(r.look(free: true), "the update is over: it starts")
        // Kept across a launch: the app reads `wanted` back.
        XCTAssertTrue(BrowserUpdate.Rebuild(wanted: true).look(free: true))
        XCTAssertFalse(BrowserUpdate.Rebuild().look(free: true))
    }

    /// The daily run reads the icon too: an ask before it is answered by it, and one during it is not.
    func testTheDailyRunAnswersTheAsksBeforeIt() {
        var r = BrowserUpdate.Rebuild(wanted: true)
        r.started()
        XCTAssertFalse(r.ended(free: true))
        XCTAssertFalse(r.wanted)
        r.started()
        XCTAssertFalse(r.ask(free: true))
        XCTAssertTrue(r.ended(free: true))
    }
}

