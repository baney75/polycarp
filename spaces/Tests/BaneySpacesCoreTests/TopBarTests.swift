import XCTest
@testable import BaneySpacesCore

/// The top bar's words and layout (`BarText`, `BarLayout`).
final class TopBarTests: XCTestCase {
    private var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        c.locale = Locale(identifier: "en_US")
        return c
    }()

    /// 2026-11-21 is a Saturday; 11-22 a Sunday.
    private func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        cal.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!
    }

    func testEveryHourHasItsPrayerHour() {
        let expect = ["Vigils", "Vigils", "Vigils", "Vigils", "Vigils", "Lauds", "Lauds", "Lauds", "Lauds", "Terce", "Terce", "Terce",
                      "Sext", "Sext", "Sext", "None", "None", "None", "Vespers", "Vespers", "Vespers", "Compline", "Compline", "Compline"]
        XCTAssertEqual((0..<24).map(BarText.prayerHour), expect)
    }

    func testTheHourInWords() {
        XCTAssertEqual(BarText.hour(at(21, 9, 12), calendar: cal, names: true), "Saturday, Terce")
        XCTAssertEqual(BarText.hour(at(21, 9, 12), calendar: cal, names: false), "Saturday morning")
        XCTAssertEqual(BarText.hour(at(21, 19), calendar: cal, names: false), "Saturday evening")
        XCTAssertEqual(BarText.hour(at(21, 23), calendar: cal, names: false), "Saturday night")
    }

    func testSundayIsTheLordsDay() {
        XCTAssertEqual(BarText.hour(at(22, 12, 30), calendar: cal, names: true), "The Lord's Day, Sext")
        XCTAssertEqual(BarText.hour(at(22, 15), calendar: cal, names: false), "The Lord's Day, afternoon")
    }

    func testClockHasNoAMOrPM() {
        XCTAssertEqual(BarText.clock(at(21, 15, 5), calendar: cal, format: .twelveHour), "3:05")
        XCTAssertEqual(BarText.clock(at(21, 15, 5), calendar: cal, format: .twentyFourHour), "15:05")
        XCTAssertEqual(BarText.clock(at(21, 0, 7), calendar: cal, format: .twelveHour), "12:07")
        XCTAssertEqual(BarText.clock(at(21, 12, 0), calendar: cal, format: .twelveHour), "12:00")
        XCTAssertEqual(BarText.clock(at(21, 0, 7), calendar: cal, format: .twentyFourHour), "0:07")
    }

    func testDateAndNextMinute() {
        XCTAssertEqual(BarText.date(at(21, 9), calendar: cal), "November 21")
        let next = BarText.nextMinute(after: at(21, 9, 12).addingTimeInterval(30), calendar: cal)
        XCTAssertEqual(next, at(21, 9, 13))
    }

    func testBatteryShowsOnlyWhenItMatters() {
        XCTAssertNil(BarText.battery(percent: nil, charging: false, onPower: true), "no battery")
        XCTAssertNil(BarText.battery(percent: 100, charging: false, onPower: true), "full and on power")
        XCTAssertEqual(BarText.battery(percent: 82, charging: false, onPower: false), "82%")
        XCTAssertEqual(BarText.battery(percent: 40, charging: true, onPower: true), "40% charging")
    }

    func testANotchFoldsTheMiddleIntoTheLeft() {
        let bar = Surfaces.defaults.bar
        let flat = BarLayout.places(bar, notch: false)
        XCTAssertEqual(flat.center, bar.center)
        let notched = BarLayout.places(bar, notch: true)
        XCTAssertEqual(notched.left, bar.left + bar.center)
        XCTAssertTrue(notched.center.isEmpty)
        XCTAssertEqual(notched.right, bar.right)
    }

    func testTheLedgerDefaults() {
        let bar = Surfaces.defaults.bar
        XCTAssertEqual(bar.left, [.mark, .workspaces, .purpose])
        XCTAssertEqual(bar.center, [.oneThing])
        XCTAssertEqual(bar.right, [.hour, .clock])
        XCTAssertTrue((bar.left + bar.center + bar.right).allSatisfy(BarLayout.drawn))
        XCTAssertFalse(BarLayout.drawn(.appMenus))
        XCTAssertFalse(BarLayout.drawn(.custom("x")))
    }

    func testDotsAreOccupiedWorkspacesAndTheCurrentOne() {
        XCTAssertEqual(BarLayout.dots(occupied: [3, 1], current: 5), [1, 3, 5])
        XCTAssertEqual(BarLayout.dots(occupied: [], current: 2), [2])
        XCTAssertEqual(BarLayout.dots(occupied: [0, 12, 4], current: 4), [4], "only workspaces 1 to 9")
    }

    func testTheSystemBarCoversOursUnlessHidden() {
        XCTAssertTrue(BarLayout.systemBarShown(frameMaxY: 1117, visibleMaxY: 1093, notch: false, hideMenuBar: false))
        XCTAssertFalse(BarLayout.systemBarShown(frameMaxY: 1117, visibleMaxY: 1117, notch: false, hideMenuBar: false))
        XCTAssertTrue(BarLayout.systemBarShown(frameMaxY: 1117, visibleMaxY: 1080, notch: true, hideMenuBar: false))
        XCTAssertFalse(BarLayout.systemBarShown(frameMaxY: 1117, visibleMaxY: 1080, notch: true, hideMenuBar: true))
    }
}
