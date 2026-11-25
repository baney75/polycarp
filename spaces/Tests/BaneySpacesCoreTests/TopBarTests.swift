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

    /// Omarchy's clock: the day's name, then the time, on the same 12 and 24 hour rules. The 12 hour form says AM or PM.
    func testTheClockWithTheDay() {
        XCTAssertEqual(BarText.clock(at(21, 22, 4), calendar: cal, format: .dayTwelveHour), "Saturday 10:04 PM")
        XCTAssertEqual(BarText.clock(at(21, 22, 4), calendar: cal, format: .dayTwentyFourHour), "Saturday 22:04")
        XCTAssertEqual(BarText.clock(at(21, 0, 7), calendar: cal, format: .dayTwelveHour), "Saturday 12:07 AM")
        XCTAssertEqual(BarText.clock(at(21, 12, 0), calendar: cal, format: .dayTwelveHour), "Saturday 12:00 PM")
        XCTAssertEqual(BarText.clock(at(21, 11, 59), calendar: cal, format: .dayTwelveHour), "Saturday 11:59 AM")
        XCTAssertEqual(BarText.clock(at(21, 9, 5), calendar: cal, format: .dayTwentyFourHour), "Saturday 9:05")
        XCTAssertEqual(BarText.clock(at(22, 0, 7), calendar: cal, format: .dayTwentyFourHour), "Sunday 0:07")
        XCTAssertEqual(Surfaces.ClockFormat.allCases.map(\.rawValue), ["12h", "24h", "day-12h", "day-24h"])
        XCTAssertEqual(Surfaces.ClockFormat.allCases.filter(\.twentyFour), [.twentyFourHour, .dayTwentyFourHour])
        XCTAssertEqual(Surfaces.ClockFormat.allCases.filter(\.withDay), [.dayTwelveHour, .dayTwentyFourHour])
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
        XCTAssertEqual(notched.left, bar.left + [.split] + bar.center, "the middle keeps its own island")
        XCTAssertEqual(BarLayout.islands(notched.left).last, bar.center)
        XCTAssertTrue(notched.center.isEmpty)
        var empty = bar; empty.center = []
        XCTAssertEqual(BarLayout.places(empty, notch: true).left, bar.left)
        XCTAssertEqual(notched.right, bar.right)
    }

    func testTheLedgerDefaults() {
        let bar = Surfaces.defaults.bar
        XCTAssertEqual(bar.left, [.mark, .workspaces, .split, .appMenus])
        XCTAssertEqual(bar.center, [.clock])
        XCTAssertEqual(bar.right, [.status, .split, .notifications])
        XCTAssertEqual(bar.height, 26)
        XCTAssertEqual(bar.clockFormat, .dayTwelveHour)
        XCTAssertTrue((bar.left + bar.center + bar.right).filter { $0 != .split }.allSatisfy(BarLayout.drawn))
        XCTAssertTrue(BarLayout.drawn(.appMenus))
        XCTAssertTrue(BarLayout.drawn(.status))
        XCTAssertFalse(BarLayout.drawn(.custom("x")))
    }

    func testTheNumbersAreOccupiedWorkspacesAndTheCurrentOne() {
        XCTAssertEqual(BarWorkspaces.shown(occupied: [3, 1], current: 5), [1, 3, 5])
        XCTAssertEqual(BarWorkspaces.shown(occupied: [], current: 2), [2])
        XCTAssertEqual(BarWorkspaces.shown(occupied: [2, 7], current: 2), [2, 7], "the current one once")
        XCTAssertEqual(BarWorkspaces.shown(occupied: [0, 12, 4], current: 4), [4], "only workspaces 1 to 9")
    }

    /// The built-in themes (dot, bar) underline the workspace you're on; a number-block theme draws it on a block.
    func testTheCurrentNumbersMarkerFollowsTheTheme() {
        XCTAssertEqual(BarWorkspaces.marker(.dot), .underline)
        XCTAssertEqual(BarWorkspaces.marker(.bar), .underline)
        XCTAssertEqual(BarWorkspaces.marker(.numberBlock), .block)
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

    /// 2026-11-22: the bar never opens System Settings or any other window to ask for something.
    func testTheBarOpensNothing() throws {
        let code = try app("TopBar.swift")
        XCTAssertFalse(code.contains("x-apple.systempreferences"), "no System Settings pane")
        XCTAssertFalse(code.contains("NSWorkspace.shared.open("), "it opens no URL or app")
        XCTAssertFalse(code.contains("NSAlert"), "no alert")
    }

    func testTheMiddleLeavesRoomForTheSides() {
        let width = 1280.0, gap = 12.0
        let side = (width - width * BarLayout.middleShare) / 2 - gap
        XCTAssertGreaterThan(side, 300, "the mark, the dots and the app menus fit beside the middle on a 1280-point screen")
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

    /// A click reads the menus again and presses the one drawn, wherever it is now.
    func testAClickFindsItsMenuAfterTheAppRebuiltThem() {
        let drawn = ["Apple", "Code", "File", "Edit", "View"]
        XCTAssertEqual(BarMenus.place(of: 3, titles: drawn, in: drawn), 3)
        XCTAssertEqual(BarMenus.place(of: 3, titles: drawn, in: ["Apple", "Code", "File", "Selection", "Edit"]), 4)
        XCTAssertNil(BarMenus.place(of: 4, titles: drawn, in: ["Apple", "Code", "File"]), "a menu that's gone presses nothing")
        XCTAssertEqual(BarMenus.place(of: 0, titles: drawn, in: ["Apple"]), 0)
        XCTAssertNil(BarMenus.place(of: 9, titles: drawn, in: drawn))
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
        XCTAssertEqual(BarStatus.Item(owner: "").name, "Status item", "VoiceOver never meets an unnamed button")
    }

    func testTheBatterySymbolShowsTheChargeInQuarters() {
        let battery = BarStatus.Item(owner: "com.apple.controlcenter", identifier: "com.apple.menuextra.battery")
        XCTAssertEqual(BarStatus.symbol(battery, percent: 62, charging: false), "battery.50percent")
        XCTAssertEqual(BarStatus.symbol(battery, percent: 63, charging: false), "battery.75percent")
        XCTAssertEqual(BarStatus.battery(percent: 4, charging: false), "battery.0percent")
        XCTAssertEqual(BarStatus.battery(percent: 100, charging: false), "battery.100percent")
        XCTAssertEqual(BarStatus.battery(percent: 15, charging: true), "battery.25percent", "low and charging reads as low")
        XCTAssertEqual(BarStatus.battery(percent: 95, charging: true), "battery.100percent.bolt")
        XCTAssertEqual(BarStatus.battery(percent: nil, charging: true), "battery.100percent.bolt")
        XCTAssertEqual(BarStatus.battery(percent: nil, charging: false), "battery.100percent")
    }

    /// Islands: "|" splits a place into islands, may repeat, and is checked like any other id.
    func testIslandsSplitAtBarsAndDropWhatIsNotDrawn() {
        let m: [Surfaces.BarModule] = [.mark, .workspaces, .split, .appMenus, .split, .split, .custom("x"), .split]
        XCTAssertEqual(BarLayout.islands(m), [[.mark, .workspaces], [.appMenus]])
        XCTAssertEqual(BarLayout.islands([]), [])
        XCTAssertEqual(BarLayout.islands([.clock]), [[.clock]])
        XCTAssertFalse(BarLayout.drawn(.split))
        XCTAssertEqual(Surfaces.BarModule(id: "|"), .split)
        XCTAssertEqual(Surfaces.BarModule.split.id, "|")
        XCTAssertEqual(Surfaces.defaults.bar.style, .islands, "islands is the bar's look unless a file says otherwise")
        XCTAssertEqual(Surfaces.defaults.bar.left, [.mark, .workspaces, .split, .appMenus])
    }

    /// The battery reads as macOS's: yellow in Low Power Mode whatever the charge, red nearly empty on battery only,
    /// a bolt charging and a plug on power when not charging.
    func testTheBatteryLooksAsMacOSDrawsIt() {
        let low = BarStatus.batteryLook(percent: 72, charging: false, onPower: false, lowPower: true)
        XCTAssertEqual(low, .init(fill: 0.72, tint: .lowPower, badge: .none))
        XCTAssertEqual(BarStatus.batteryLook(percent: 8, charging: false, onPower: false, lowPower: false).tint, .critical)
        XCTAssertEqual(BarStatus.batteryLook(percent: 8, charging: true, onPower: true, lowPower: false),
                       .init(fill: 0.08, tint: .normal, badge: .bolt))
        XCTAssertEqual(BarStatus.batteryLook(percent: 8, charging: false, onPower: false, lowPower: true).tint, .lowPower)
        XCTAssertEqual(BarStatus.batteryLook(percent: 100, charging: false, onPower: true, lowPower: false).badge, .plug)
        XCTAssertEqual(BarStatus.batteryLook(percent: nil, charging: false, onPower: false, lowPower: false).fill, 1)
        XCTAssertEqual(BarStatus.batteryLook(percent: 140, charging: false, onPower: false, lowPower: false).fill, 1)
        XCTAssertTrue(BarStatus.isBattery(BarStatus.Item(owner: "com.apple.MenuBarAgent", identifier: "com.apple.menuextra.battery")))
        XCTAssertFalse(BarStatus.isBattery(BarStatus.Item(owner: "com.coconut.battery", label: "Battery")))
    }

    /// macOS 27 wraps each of its own items in a nameless AXGroup: read the item inside, or the row is all dots.
    func testMacOS27WrappedItemsAreReadThroughTheirChild() {
        XCTAssertEqual(BarStatus.pick(role: "AXMenuBarItem"), .itself)
        XCTAssertEqual(BarStatus.pick(role: nil), .itself, "an item whose role didn't answer is still drawn")
        XCTAssertEqual(BarStatus.pick(role: "AXGroup", childRoles: ["AXMenuBarItem"]), .child(0))
        XCTAssertEqual(BarStatus.pick(role: "AXGroup", childRoles: [nil, "AXMenuBarItem"]), .child(1))
        XCTAssertEqual(BarStatus.pick(role: "AXGroup", childRoles: ["AXImage"]), .skip)
        XCTAssertEqual(BarStatus.pick(role: "AXButton"), .skip, "Show Hidden Menu Bar Items is not a status item")
        let focus = BarStatus.Item(owner: "com.apple.MenuBarAgent", identifier: "com.apple.menuextra.focusmode")
        XCTAssertEqual(BarStatus.symbol(focus), "moon")
        XCTAssertEqual(BarStatus.symbol(BarStatus.Item(owner: "com.apple.MenuBarAgent", identifier: "com.apple.menuextra.wifi")), "wifi")
    }

    /// An item macOS hid for want of room is parked off the bar (y 970 on a 982-point display) and isn't drawn.
    func testItemsMacOSHidOffItsBarAreLeftOut() {
        let wifi = BarStatus.Item(owner: "com.apple.MenuBarAgent", identifier: "com.apple.menuextra.wifi", x: 1261, y: 0)
        let drive = BarStatus.Item(owner: "ch.protonmail.drive", x: 1184, y: 4.5)
        let teams = BarStatus.Item(owner: "com.microsoft.teams2", x: -1, y: 970)
        let codex = BarStatus.Item(owner: "com.openai.codex", label: "ChatGPT", x: 7, y: 970)
        XCTAssertEqual(BarStatus.shown([wifi, teams, drive, codex], modules: []), [drive, wifi])
        XCTAssertFalse(BarStatus.parked(BarStatus.Item(owner: "a"), barTops: [0]), "no place read: kept")
        let above = BarStatus.Item(owner: "a", x: 100, y: -1080)
        XCTAssertTrue(BarStatus.parked(above, barTops: [0]))
        XCTAssertFalse(BarStatus.parked(above, barTops: [0, -1080]), "on the bar of a display above the main one")
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
