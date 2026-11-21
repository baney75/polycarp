import XCTest
@testable import BaneySpacesCore

/// The day starts at 4 am local, so a late night counts for the day it began in.
final class PurposeDayTests: XCTestCase {
    private let c = PurposeFixture.chicago
    private func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0, first: Bool = true) -> Date {
        PurposeFixture.at(y, m, d, h, min, first: first)
    }

    func testTheDayStartsAtFourInTheMorning() {
        XCTAssertEqual(c.day(of: at(2026, 11, 21, 3, 59)).description, "2026-11-20")
        XCTAssertEqual(c.day(of: at(2026, 11, 21, 4, 0)).description, "2026-11-21")
        XCTAssertEqual(c.day(of: at(2026, 11, 21, 23, 59)).description, "2026-11-21")
        XCTAssertEqual(c.day(of: at(2027, 1, 1, 2, 0)).description, "2026-12-31", "a late New Year's Eve is still the old year")
    }

    func testDaysReadAndWriteAsText() throws {
        let d = PurposeDay(year: 2026, month: 3, day: 8)
        XCTAssertEqual(d.description, "2026-03-08")
        XCTAssertEqual(PurposeDay("2026-03-08"), d)
        for bad in ["", "2026-3-8", "2026-13-01", "2026-00-10", "yesterday", "2026-11-21T04"] { XCTAssertNil(PurposeDay(bad), bad) }
        let json = try JSONEncoder().encode([d])
        XCTAssertEqual(String(data: json, encoding: .utf8), "[\"2026-03-08\"]")
        XCTAssertEqual(try JSONDecoder().decode([PurposeDay].self, from: json), [d])
        XCTAssertLessThan(PurposeDay("2026-02-28")!, PurposeDay("2026-03-01")!)
    }

    func testDaysMoveAcrossMonthsAndYears() {
        XCTAssertEqual(c.adding(1, to: PurposeFixture.day("2026-12-31")).description, "2027-01-01")
        XCTAssertEqual(c.adding(-1, to: PurposeFixture.day("2026-03-01")).description, "2026-02-28")
        XCTAssertEqual(c.adding(-89, to: PurposeFixture.day("2026-11-21")).description, "2026-08-24")
    }

    func testDSTDaysAreTwentyThreeOrTwentyFiveHoursLong() {
        // Spring forward, 2 am on March 8: the day that spans it (from 4 am on the 7th) is 23 hours.
        let spring = PurposeFixture.day("2026-03-07")
        XCTAssertEqual(c.end(of: spring).timeIntervalSince(c.start(of: spring)), 23 * 3600)
        // Fall back, 2 am on November 1: the day from 4 am on October 31 is 25 hours.
        let fall = PurposeFixture.day("2026-10-31")
        XCTAssertEqual(c.end(of: fall).timeIntervalSince(c.start(of: fall)), 25 * 3600)
        XCTAssertEqual(c.end(of: PurposeFixture.day("2026-11-01")).timeIntervalSince(c.start(of: PurposeFixture.day("2026-11-01"))), 24 * 3600)
    }

    func testBothOneThirtiesOnTheNightDSTEndsBelongToTheDayBefore() {
        let first = at(2026, 11, 1, 1, 30, first: true)
        let second = at(2026, 11, 1, 1, 30, first: false)
        XCTAssertEqual(second.timeIntervalSince(first), 3600)
        XCTAssertEqual(c.day(of: first).description, "2026-10-31")
        XCTAssertEqual(c.day(of: second).description, "2026-10-31")
    }

    func testTheSameMomentIsADifferentDayInAnotherZone() {
        let instant = PurposeFixture.at(2026, 11, 21, 14) // 20:00 UTC, 05:00 on the 22nd in Tokyo
        XCTAssertEqual(c.day(of: instant).description, "2026-11-21")
        XCTAssertEqual(PurposeFixture.tokyo.day(of: instant).description, "2026-11-22")
    }

    func testWeekdaysComeFromTheGregorianCalendar() {
        XCTAssertEqual(c.weekday(of: PurposeFixture.day("2026-11-22")), 1, "a Sunday")
        XCTAssertEqual(c.weekday(of: PurposeFixture.day("2026-11-21")), 7, "a Saturday")
    }
}
