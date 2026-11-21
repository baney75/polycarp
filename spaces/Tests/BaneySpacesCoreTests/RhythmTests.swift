import XCTest
@testable import BaneySpacesCore

/// The morning question once a day from 4 am, the evening examen once a day from 6 pm, and rest on the Lord's Day.
final class RhythmTests: XCTestCase {
    private let c = PurposeFixture.chicago
    private let on = RhythmSettings()
    private func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0, first: Bool = true) -> Date {
        PurposeFixture.at(y, m, d, h, min, first: first)
    }
    private func due(_ now: Date, _ s: RhythmState = RhythmState(), _ settings: RhythmSettings? = nil, clock: DayClock? = nil) -> Rhythm.Prompt? {
        Rhythm.due(now: now, state: s, settings: settings ?? on, clock: clock ?? c)
    }

    func testTheMorningQuestionComesWithTheFirstInputAfterFour() {
        let asked = Rhythm.given(.eveningExamen, now: at(2026, 11, 20, 20), state: RhythmState(), clock: c)
        XCTAssertNil(due(at(2026, 11, 21, 3, 59), asked), "still yesterday, both already given")
        XCTAssertEqual(due(at(2026, 11, 21, 4), asked), .morningQuestion)
        XCTAssertEqual(due(at(2026, 11, 21, 11), asked), .morningQuestion, "the first input may come late in the morning")
    }

    func testEachPromptComesOnceADay() {
        var s = Rhythm.given(.morningQuestion, now: at(2026, 11, 21, 7), state: RhythmState(), clock: c)
        XCTAssertNil(due(at(2026, 11, 21, 12), s))
        XCTAssertEqual(due(at(2026, 11, 21, 18), s), .eveningExamen)
        s = Rhythm.given(.eveningExamen, now: at(2026, 11, 21, 18, 5), state: s, clock: c)
        XCTAssertNil(due(at(2026, 11, 21, 22), s))
        XCTAssertNil(due(at(2026, 11, 22, 1), s), "after midnight is still the same evening")
        XCTAssertEqual(due(at(2026, 11, 22, 4), s), .morningQuestion)
    }

    func testTheExamenStartsAtTheExamenHour() {
        let s = Rhythm.given(.morningQuestion, now: at(2026, 11, 21, 7), state: RhythmState(), clock: c)
        XCTAssertNil(due(at(2026, 11, 21, 17, 59), s))
        XCTAssertEqual(due(at(2026, 11, 21, 18), s), .eveningExamen)
        XCTAssertEqual(due(at(2026, 11, 22, 2), s), .eveningExamen, "a late first input still gets the examen")
        let later = RhythmSettings(examenHour: 20)
        XCTAssertNil(due(at(2026, 11, 21, 19, 59), s, later))
        XCTAssertEqual(due(at(2026, 11, 21, 20), s, later), .eveningExamen)
    }

    func testAnEveningFirstInputGetsOnlyTheExamen() {
        XCTAssertEqual(due(at(2026, 11, 21, 19)), .eveningExamen)
        let s = Rhythm.given(.eveningExamen, now: at(2026, 11, 21, 19), state: RhythmState(), clock: c)
        XCTAssertNil(due(at(2026, 11, 21, 19, 1), s), "no morning question after the examen")
    }

    func testEachSettingTurnsItsPromptOff() {
        XCTAssertNil(due(at(2026, 11, 21, 9), RhythmState(), RhythmSettings(morningQuestion: false)))
        XCTAssertNil(due(at(2026, 11, 21, 19), RhythmState(), RhythmSettings(morningQuestion: false, eveningExamen: false)))
        XCTAssertEqual(due(at(2026, 11, 21, 19), RhythmState(), RhythmSettings(eveningExamen: false)), .morningQuestion,
                       "with no examen the morning question waits all day")
    }

    func testTheExamenHourStaysInTheDay() {
        XCTAssertEqual(RhythmSettings(examenHour: 2).examenHour, 5)
        XCTAssertEqual(RhythmSettings(examenHour: 30).examenHour, 23)
        var s = RhythmSettings()
        s.examenHour = -1
        XCTAssertEqual(s.examenHour, 5)
    }

    func testSettingsReadFromDefaultsWithTheirDefaults() throws {
        let name = "purpose-rhythm-\(UUID().uuidString)"
        let d = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { d.removePersistentDomain(forName: name) }
        XCTAssertEqual(RhythmSettings(defaults: d), RhythmSettings(morningQuestion: true, eveningExamen: true, examenHour: 18, restOnSunday: true))
        d.set(false, forKey: RhythmSettings.Key.morningQuestion)
        d.set(false, forKey: RhythmSettings.Key.restOnSunday)
        d.set(21, forKey: RhythmSettings.Key.examenHour)
        XCTAssertEqual(RhythmSettings(defaults: d), RhythmSettings(morningQuestion: false, eveningExamen: true, examenHour: 21, restOnSunday: false))
        XCTAssertEqual(Set(RhythmSettings.registered.keys), ["morningQuestion", "eveningExamen", "examenHour", "restOnSunday"])
    }

    func testTheLordsDayRunsFromFourOnSundayToFourOnMonday() {
        XCTAssertFalse(Rhythm.isLordsDay(now: at(2026, 11, 22, 3, 59), clock: c), "still Saturday night")
        XCTAssertTrue(Rhythm.isLordsDay(now: at(2026, 11, 22, 4), clock: c))
        XCTAssertTrue(Rhythm.isLordsDay(now: at(2026, 11, 23, 3), clock: c), "Sunday night runs late")
        XCTAssertFalse(Rhythm.isLordsDay(now: at(2026, 11, 23, 4), clock: c))
        XCTAssertTrue(Rhythm.rests(now: at(2026, 11, 22, 10), settings: on, clock: c))
        XCTAssertFalse(Rhythm.rests(now: at(2026, 11, 22, 10), settings: RhythmSettings(restOnSunday: false), clock: c))
        XCTAssertFalse(Rhythm.rests(now: at(2026, 11, 21, 10), settings: on, clock: c))
    }

    func testTheDayDSTStartsKeepsFourAMAndSixPM() {
        // March 8, 2026 is a Sunday; clocks jump from 2 to 3 am.
        let s = Rhythm.given(.eveningExamen, now: at(2026, 3, 7, 19), state: RhythmState(), clock: c)
        XCTAssertNil(due(at(2026, 3, 8, 3, 30), s))
        XCTAssertEqual(due(at(2026, 3, 8, 4), s), .morningQuestion)
        XCTAssertEqual(Rhythm.eveningStart(of: PurposeFixture.day("2026-03-08"), settings: on, clock: c), at(2026, 3, 8, 18))
        XCTAssertTrue(Rhythm.isLordsDay(now: at(2026, 3, 8, 4), clock: c))
    }

    func testTheRepeatedHourWhenDSTEndsIsStillTheNightBefore() {
        let s = Rhythm.given(.eveningExamen, now: at(2026, 10, 31, 20), state: RhythmState(), clock: c)
        XCTAssertNil(due(at(2026, 11, 1, 1, 30, first: true), s))
        XCTAssertNil(due(at(2026, 11, 1, 1, 30, first: false), s), "the second 1:30 too")
        XCTAssertEqual(due(at(2026, 11, 1, 4), s), .morningQuestion)
    }

    func testFlyingEastAsksTheNewDaysQuestion() {
        // Asked in Chicago at 9 am on the 21st; at 2 pm Chicago time it is 5 am on the 22nd in Tokyo.
        let s = Rhythm.given(.morningQuestion, now: at(2026, 11, 21, 9), state: RhythmState(), clock: c)
        let instant = at(2026, 11, 21, 14)
        XCTAssertNil(due(instant, s))
        XCTAssertEqual(due(instant, s, clock: PurposeFixture.tokyo), .morningQuestion)
    }

    func testFlyingWestNeverAsksAgain() {
        // Asked in Tokyo at 9 am on the 22nd; that moment is 6 pm on the 21st in Chicago, an earlier day.
        let tokyoMorning = PurposeFixture.at(2026, 11, 22, 9, 0, PurposeFixture.tokyo)
        var s = Rhythm.given(.morningQuestion, now: tokyoMorning, state: RhythmState(), clock: PurposeFixture.tokyo)
        XCTAssertEqual(s.morningAsked?.description, "2026-11-22")
        XCTAssertEqual(due(tokyoMorning.addingTimeInterval(60), s, RhythmSettings(eveningExamen: false)), nil, "the morning is not asked twice")
        // Giving a prompt on the earlier day never moves the record back.
        s = Rhythm.given(.morningQuestion, now: tokyoMorning, state: s, clock: c)
        XCTAssertEqual(s.morningAsked?.description, "2026-11-22")
    }
}
