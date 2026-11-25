import XCTest
@testable import BaneySpacesCore

final class MonthGridTests: XCTestCase {
    private func calendar(first: Int, zone: String = "America/New_York") -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.locale = Locale(identifier: "en_US")
        c.timeZone = TimeZone(identifier: zone)!
        c.firstWeekday = first
        return c
    }

    private func day(_ y: Int, _ m: Int, _ d: Int, _ c: Calendar) -> Date {
        c.date(from: DateComponents(year: y, month: m, day: d, hour: 12))!
    }

    func testSixWeeksFromTheFirstDayOfTheWeek() {
        let c = calendar(first: 1)
        let g = MonthGrid(of: day(2026, 11, 25, c), today: day(2026, 11, 25, c), calendar: c)
        XCTAssertEqual(g.days.count, 42)
        XCTAssertEqual(g.weekdays, ["S", "M", "T", "W", "T", "F", "S"])
        // November 2026 starts on a Sunday, so nothing comes before it.
        XCTAssertEqual(g.days.prefix(3).map(\.number), [1, 2, 3])
        XCTAssertEqual(g.days.filter(\.inMonth).count, 30)
        XCTAssertEqual(g.days.filter(\.isToday).map(\.number), [25])
        XCTAssertEqual(g.days.prefix(7).map(\.isWeekend), [true, false, false, false, false, false, true])
        // With Monday first, the last six days of October come before it.
        let m = calendar(first: 2)
        let monday = MonthGrid(of: day(2026, 11, 25, m), today: day(2026, 11, 25, m), calendar: m)
        XCTAssertEqual(monday.weekdays.first, "M")
        XCTAssertEqual(monday.days.prefix(7).map(\.number), [26, 27, 28, 29, 30, 31, 1])
        XCTAssertEqual(monday.days.prefix(7).map(\.inMonth), [false, false, false, false, false, false, true])
    }

    func testTodayIsOnlyMarkedInItsOwnYear() {
        let c = calendar(first: 1)
        XCTAssertTrue(MonthGrid(of: day(2027, 11, 1, c), today: day(2026, 11, 25, c), calendar: c).days.allSatisfy { !$0.isToday })
    }

    func testMonthsStepOverTheYearAndShortMonths() {
        let c = calendar(first: 1)
        let g = MonthGrid(of: day(2026, 12, 31, c), today: day(2026, 12, 31, c), calendar: c)
        let next = MonthGrid(of: g.month(by: 1, calendar: c), today: day(2026, 12, 31, c), calendar: c)
        XCTAssertEqual(c.dateComponents([.year, .month], from: next.month), DateComponents(year: 2027, month: 1))
        let february = MonthGrid(of: next.month(by: 1, calendar: c), today: day(2026, 12, 31, c), calendar: c)
        XCTAssertEqual(february.days.filter(\.inMonth).count, 28)
        XCTAssertEqual(MonthGrid(of: day(2028, 2, 1, c), today: day(2026, 1, 1, c), calendar: c).days.filter(\.inMonth).count, 29)
    }

    /// Clocks go forward at midnight in Santiago (2026-09-06), so that day starts at 1 AM; it is drawn once.
    func testADayThatStartsAtOneIsDrawnOnce() {
        let c = calendar(first: 1, zone: "America/Santiago")
        let g = MonthGrid(of: day(2026, 9, 20, c), today: day(2026, 9, 6, c), calendar: c)
        XCTAssertEqual(g.days.filter(\.inMonth).map(\.number), Array(1 ... 30))
        XCTAssertEqual(g.days.filter(\.isToday).map(\.number), [6])
    }
}
