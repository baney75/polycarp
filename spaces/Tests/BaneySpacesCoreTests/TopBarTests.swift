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
        XCTAssertNil(BarText.battery(percent: 80, charging: false, onPower: true), "held at a charge limit on power")
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
        XCTAssertEqual(bar.left, [.mark, .workspaces, .appMenus, .purpose])
        XCTAssertEqual(bar.center, [.oneThing])
        XCTAssertEqual(bar.right, [.status, .hour, .clock])
        XCTAssertTrue((bar.left + bar.center + bar.right).allSatisfy(BarLayout.drawn))
        XCTAssertTrue(BarLayout.drawn(.appMenus))
        XCTAssertTrue(BarLayout.drawn(.status))
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

    /// The app target can't be imported by tests, so these read its source.
    private func app(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BaneySpaces/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Review of #587 (high): over windows, the bar hid the traffic lights of a window zoomed to the top. It sits under
    /// every window instead.
    func testTheBarSitsUnderWindows() throws {
        XCTAssertLessThan(BarLayout.levelBelowWindows, 0)
        let code = try app("TopBar.swift")
        XCTAssertTrue(code.contains("CGWindowLevelForKey(.normalWindow)) + BarLayout.levelBelowWindows"))
        XCTAssertFalse(code.contains(".mainMenuWindow"), "never over windows")
    }

    /// Review of #587: System Settings opens once each time `hideSystemMenuBar` turns on, not on every launch.
    func testTheMenuBarPaneOpensOncePerTurnOn() throws {
        // Two launches with the setting on: each starts on the defaults, then the file arrives a moment later.
        var asked = false, opened = 0
        func reload(wants: Bool, fromFile: Bool) {
            let r = BarLayout.menuBarAsk(wantsHidden: wants, asked: asked, fromFile: fromFile)
            asked = r.asked
            if r.open { opened += 1 }
        }
        for _ in 1...2 {
            reload(wants: false, fromFile: false)
            reload(wants: true, fromFile: true)
        }
        XCTAssertEqual(opened, 1, "the late read at the second launch doesn't open the pane again")
        reload(wants: false, fromFile: true)
        reload(wants: true, fromFile: true)
        XCTAssertEqual(opened, 2, "turning it off in the file and on again asks again")
        let code = try app("TopBar.swift")
        XCTAssertTrue(code.contains("forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in self?.reload(fromFile: true) }"))
        XCTAssertEqual(code.components(separatedBy: "fromFile: true").count, 2, "only the surfaces change counts as the file")
    }

    func testTheMiddleLeavesRoomForTheSides() {
        let width = 1280.0, gap = 12.0
        let side = (width - width * BarLayout.middleShare) / 2 - gap
        XCTAssertGreaterThan(side, 300, "the mark, the dots and a purpose fit beside the middle on a 1280-point screen")
    }

    /// The front app's menu bar as the bar draws it: the Apple menu as the logo, the app's menu in bold, an icon-only
    /// menu left out, each keeping its place to press.
    func testAppMenusKeepTheirPlacesAndLeaveOutIconOnlyMenus() {
        let items = BarMenus.items(["Apple", "Helium", "File", "", "Edit", "  Help "])
        XCTAssertEqual(items.map(\.role), [.apple, .app, .menu, .menu, .menu])
        XCTAssertEqual(items.map(\.title), ["Apple", "Helium", "File", "Edit", "Help"])
        XCTAssertEqual(items.map(\.index), [0, 1, 2, 4, 5], "a click presses the menu at its own place")
        XCTAssertEqual(BarMenus.items([]), [])
        XCTAssertEqual(BarMenus.items(["Apple", ""]).map(\.role), [.apple], "no name, no app menu to draw")
    }

    /// Titles past the room are left out whole, from the end, so none is cut in half.
    func testARowKeepsTheTitlesThatFitWhole() {
        XCTAssertEqual(BarLayout.fit([40, 30, 50], spacing: 10, room: 200), 3)
        XCTAssertEqual(BarLayout.fit([40, 30, 50], spacing: 10, room: 80), 2, "40 + 10 + 30 = 80 fits")
        XCTAssertEqual(BarLayout.fit([40, 30, 50], spacing: 10, room: 79), 1)
        XCTAssertEqual(BarLayout.fit([40], spacing: 10, room: 20), 0)
        XCTAssertEqual(BarLayout.fit([], spacing: 10, room: 20), 0)
    }

    /// macOS's own status items are drawn as symbols, an app's as its icon (nil here).
    func testStatusItemsAreSymbolsForMacOSAndIconsForApps() {
        let wifi = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.wifi", label: "Wi-Fi")
        let cc = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.controlcenter")
        let notion = BarStatus.Item(owner: "notion.id", label: "Notion")
        let odd = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.somethingnew")
        XCTAssertEqual(BarStatus.symbol(wifi), "wifi")
        XCTAssertEqual(BarStatus.symbol(cc), "switch.2")
        XCTAssertNil(BarStatus.symbol(notion))
        XCTAssertEqual(BarStatus.symbol(odd), "circle.fill", "an unknown macOS item can still be clicked")
        XCTAssertEqual(BarStatus.Item(owner: "com.apple.x", label: "Wi-Fi").name, "Wi-Fi")
        XCTAssertEqual(odd.name, "somethingnew")
        XCTAssertEqual(BarStatus.Item(owner: "notion.id").name, "notion.id")
    }

    func testTheBatterySymbolShowsTheChargeInQuarters() {
        let battery = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.battery")
        XCTAssertEqual(BarStatus.symbol(battery, percent: 62, charging: false), "battery.50percent")
        XCTAssertEqual(BarStatus.symbol(battery, percent: 63, charging: false), "battery.75percent")
        XCTAssertEqual(BarStatus.battery(percent: 4, charging: false), "battery.0percent")
        XCTAssertEqual(BarStatus.battery(percent: 100, charging: false), "battery.100percent")
        XCTAssertEqual(BarStatus.battery(percent: 30, charging: true), "battery.100percent.bolt")
        XCTAssertEqual(BarStatus.battery(percent: nil, charging: false), "battery.100percent")
    }

    /// In macOS's order when every place is known, and without what a module already shows.
    func testStatusItemsFollowTheMacOSOrderAndSkipWhatAModuleShows() {
        let clock = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.clock", x: 900)
        let battery = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.battery", x: 800)
        let wifi = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.wifi", x: 700)
        let notion = BarStatus.Item(owner: "notion.id", label: "Notion", x: 500)
        let read = [clock, battery, wifi, notion]
        XCTAssertEqual(BarStatus.shown(read, modules: [.hour]), [notion, wifi, battery, clock])
        XCTAssertEqual(BarStatus.shown(read, modules: [.clock]), [notion, wifi, battery], "the clock module shows the time")
        XCTAssertEqual(BarStatus.shown(read, modules: [.date, .battery]), [notion, wifi])
        var unplaced = notion
        unplaced.x = nil
        XCTAssertEqual(BarStatus.shown([clock, unplaced, wifi], modules: []), [clock, unplaced, wifi], "as read when a place is missing")
        let clockApp = BarStatus.Item(owner: "com.example.clockapp", label: "World clock", x: 1)
        XCTAssertEqual(BarStatus.shown([clockApp], modules: [.clock]), [clockApp], "an app's own clock stays")
    }
}
