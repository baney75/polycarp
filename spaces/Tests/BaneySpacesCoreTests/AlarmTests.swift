import XCTest
@testable import BaneySpacesCore

/// The wake alarm and the one-thing timer (`Alarm`, `OneThingTimer`): when it rings, when the Mac is held awake, how a
/// ring stops, and what the timer says. Chicago has DST (2026: March 8 and November 1, both at 2 am).
final class AlarmTests: XCTestCase {
    private let chicago = PurposeFixture.chicago
    private func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0) -> Date { PurposeFixture.at(y, m, d, h, min) }

    private func alarm(_ wakeAt: String = "06:30", days: Surfaces.AlarmDays = .every, wake: Bool = true, keepAwake: Bool = true) -> Surfaces.Alarm {
        Surfaces.Alarm(wake: wake, wakeAt: wakeAt, days: days, keepAwake: keepAwake, timerMinutes: 25)
    }

    private func next(after d: Date, _ a: Surfaces.Alarm) -> Date? { Alarm.nextRing(after: d, settings: a, clock: chicago) }

    // MARK: nextRing

    func testTheNextRingCrossesMidnightAndIsStrictlyAfter() {
        XCTAssertEqual(next(after: at(2026, 11, 21, 23), alarm()), at(2026, 11, 22, 6, 30), "late at night: tomorrow morning")
        XCTAssertEqual(next(after: at(2026, 11, 22, 0, 10), alarm()), at(2026, 11, 22, 6, 30), "after midnight: this morning")
        XCTAssertEqual(next(after: at(2026, 11, 22, 6, 29), alarm()), at(2026, 11, 22, 6, 30))
        XCTAssertEqual(next(after: at(2026, 11, 22, 6, 30), alarm()), at(2026, 11, 23, 6, 30), "the ring itself is past: the next day's")
        XCTAssertEqual(next(after: at(2026, 11, 21, 12), alarm("00:00")), at(2026, 11, 22, 0, 0))
        XCTAssertEqual(next(after: at(2026, 11, 21, 12), alarm("23:59")), at(2026, 11, 21, 23, 59))
    }

    func testWeekdaysSkipFromFridayEveningToMonday() {
        // 2026-11-20 is a Friday.
        XCTAssertEqual(next(after: at(2026, 11, 20, 19), alarm(days: .weekdays)), at(2026, 11, 23, 6, 30))
        XCTAssertEqual(next(after: at(2026, 11, 20, 5), alarm(days: .weekdays)), at(2026, 11, 20, 6, 30), "Friday morning still rings")
        XCTAssertEqual(next(after: at(2026, 11, 22, 6, 31), alarm(days: .every)), at(2026, 11, 23, 6, 30))
    }

    func testNotSundaySkipsTheLordsDayOnly() {
        // 2026-11-21 is a Saturday.
        XCTAssertEqual(next(after: at(2026, 11, 21, 7), alarm(days: .notSunday)), at(2026, 11, 23, 6, 30))
        XCTAssertEqual(next(after: at(2026, 11, 21, 5), alarm(days: .notSunday)), at(2026, 11, 21, 6, 30), "Saturday rings")
        XCTAssertEqual(next(after: at(2026, 11, 21, 7), alarm(days: .every)), at(2026, 11, 22, 6, 30))
        for (weekday, every, weekdays, notSunday) in [(1, true, false, false), (2, true, true, true), (6, true, true, true), (7, true, false, true)] {
            XCTAssertEqual(Surfaces.AlarmDays.every.allows(weekday: weekday), every)
            XCTAssertEqual(Surfaces.AlarmDays.weekdays.allows(weekday: weekday), weekdays)
            XCTAssertEqual(Surfaces.AlarmDays.notSunday.allows(weekday: weekday), notSunday)
        }
    }

    func testTheSpringForwardDayStillRingsAtSixThirtyOnce() throws {
        // 2026-03-08, America/Chicago: 2 am becomes 3 am. The day is 23 hours long.
        let first = try XCTUnwrap(next(after: at(2026, 3, 7, 22), alarm()))
        let c = chicago.calendar.dateComponents([.year, .month, .day, .hour, .minute], from: first)
        XCTAssertEqual([c.year, c.month, c.day, c.hour, c.minute], [2026, 3, 8, 6, 30])
        let second = try XCTUnwrap(next(after: first, alarm()))
        let d = chicago.calendar.dateComponents([.month, .day, .hour, .minute], from: second)
        XCTAssertEqual([d.month, d.day, d.hour, d.minute], [3, 9, 6, 30], "one ring on the 8th, then the 9th")
        XCTAssertEqual(first.timeIntervalSince(at(2026, 3, 7, 6, 30)), 23 * 3600, "the short night is an hour shorter")
        // A time in the skipped hour rings at the first minute after it that exists.
        let skipped = try XCTUnwrap(next(after: at(2026, 3, 7, 22), alarm("02:30")))
        XCTAssertGreaterThan(skipped, at(2026, 3, 8, 1, 59))
        XCTAssertLessThanOrEqual(skipped, at(2026, 3, 8, 3, 30))
    }

    func testTheFallBackDayRingsTheDoubledHourOnce() throws {
        // 2026-11-01, America/Chicago: 1:00 to 1:59 comes twice.
        let first = try XCTUnwrap(next(after: at(2026, 10, 31, 22), alarm("01:30")))
        XCTAssertEqual(chicago.calendar.component(.day, from: first), 1)
        let second = try XCTUnwrap(next(after: first, alarm("01:30")))
        XCTAssertEqual(chicago.calendar.component(.day, from: second), 2, "never the second 1:30")
    }

    func testOffNeverRings() {
        XCTAssertNil(next(after: at(2026, 11, 21, 9), alarm(wake: false)))
        XCTAssertNil(next(after: at(2026, 11, 21, 9), Surfaces.defaults.alarm), "off by default")
    }

    // MARK: Holding the Mac awake

    func testTheHoldCoversTheLastHourOnPowerOnly() {
        let ring = at(2026, 11, 22, 6, 30)
        let a = alarm()
        func hold(_ before: TimeInterval, power: Bool = true, settings: Surfaces.Alarm? = nil) -> Bool {
            Alarm.shouldHoldAwake(now: ring.addingTimeInterval(-before), next: ring, onPower: power, settings: settings ?? a)
        }
        XCTAssertTrue(hold(3600), "exactly an hour before")
        XCTAssertFalse(hold(3601))
        XCTAssertTrue(hold(1))
        XCTAssertFalse(hold(0), "at the ring the hold is the ring's own")
        XCTAssertFalse(hold(-5))
        XCTAssertFalse(hold(600, power: false), "on battery the Mac may sleep")
        XCTAssertFalse(hold(600, settings: alarm(keepAwake: false)))
        XCTAssertFalse(Alarm.shouldHoldAwake(now: ring, next: nil, onPower: true, settings: a), "no ring armed")
    }

    func testARingLongAfterItsTimeWasMissed() {
        let ring = at(2026, 11, 22, 6, 30)
        XCTAssertTrue(Alarm.ringsNow(scheduled: ring, now: ring))
        XCTAssertTrue(Alarm.ringsNow(scheduled: ring, now: ring.addingTimeInterval(60)))
        XCTAssertFalse(Alarm.ringsNow(scheduled: ring, now: ring.addingTimeInterval(61)), "the Mac slept through it")
    }

    func testTheRingOpensTheMorningCardOnlyWhenNotYetGiven() {
        let today = PurposeFixture.day("2026-11-22")
        XCTAssertTrue(Alarm.opensMorningCard(state: RhythmState(), today: today))
        XCTAssertTrue(Alarm.opensMorningCard(state: RhythmState(morningAsked: PurposeFixture.day("2026-11-21")), today: today))
        XCTAssertFalse(Alarm.opensMorningCard(state: RhythmState(morningAsked: today), today: today))
        XCTAssertFalse(Alarm.opensMorningCard(state: RhythmState(morningAsked: PurposeFixture.day("2026-11-23")), today: today))
    }

    // MARK: Ringing

    func testItRingsOnceAMinuteAndStopsAtFive() {
        let t0 = at(2026, 11, 22, 6, 30)
        var r = Alarm.Ringing(startedAt: t0)
        var rang: [Int] = []
        for s in stride(from: 0, through: 600, by: 0.5) {
            let step = r.step(now: t0.addingTimeInterval(s), inputSince: false)
            if step.ring { rang.append(Int(s)) }
            if step.done { break }
        }
        XCTAssertEqual(rang, [0, 60, 120, 180, 240], "five rings, a minute apart")
        XCTAssertEqual(r.rings, 5)
        XCTAssertFalse(r.stopped)
        let after = r.step(now: t0.addingTimeInterval(900), inputSince: false)
        XCTAssertFalse(after.ring)
        XCTAssertTrue(after.done)
    }

    func testInputStopsItAtOnce() {
        let t0 = at(2026, 11, 22, 6, 30)
        var r = Alarm.Ringing(startedAt: t0)
        XCTAssertTrue(r.step(now: t0, inputSince: false) == (true, false))
        XCTAssertTrue(r.step(now: t0.addingTimeInterval(30), inputSince: false) == (false, false))
        XCTAssertTrue(r.step(now: t0.addingTimeInterval(61), inputSince: true) == (false, true), "input before the second ring")
        XCTAssertEqual(r.rings, 1)
        XCTAssertTrue(r.stopped)
        XCTAssertTrue(r.step(now: t0.addingTimeInterval(120), inputSince: false) == (false, true), "it stays stopped")
    }

    func testTheFirstMomentAfterTheRingIsNotInput() {
        let t0 = at(2026, 11, 22, 6, 30)
        var r = Alarm.Ringing(startedAt: t0)
        _ = r.step(now: t0, inputSince: false)
        XCTAssertTrue(r.step(now: t0.addingTimeInterval(1), inputSince: true) == (false, false), "the display lighting isn't someone there")
        XCTAssertTrue(r.step(now: t0.addingTimeInterval(Alarm.Ringing.settle), inputSince: true) == (false, true))
    }

    // MARK: The one-thing timer

    func testTheTimerCountsDownToZeroAndNoFurther() throws {
        let t0 = at(2026, 11, 21, 9)
        let t = OneThingTimer(startedAt: t0, minutes: 25, oneThing: "Write")
        XCTAssertEqual(t.endsAt, t0.addingTimeInterval(1500))
        XCTAssertEqual(t.remaining(now: t0), 1500)
        XCTAssertEqual(t.remaining(now: t0.addingTimeInterval(780)), 720)
        XCTAssertFalse(t.done(now: t0.addingTimeInterval(1499)))
        XCTAssertTrue(t.done(now: t0.addingTimeInterval(1500)))
        XCTAssertEqual(t.remaining(now: t0.addingTimeInterval(4000)), 0, "never below 0")
        let back = try JSONDecoder().decode(OneThingTimer.self, from: JSONEncoder().encode(t))
        XCTAssertEqual(back, t)
    }

    func testTheStoreKeepsTheTimerAcrossALaunchAndSaysWhatChanged() throws {
        let suite = "polycarp-alarm-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let center = NotificationCenter()
        let said = Said()
        let token = center.addObserver(forName: OneThingTimerStore.didChange, object: nil, queue: nil) { said.add($0.userInfo?["what"] as? String ?? "") }
        defer { center.removeObserver(token) }
        let t0 = at(2026, 11, 21, 9)
        let store = OneThingTimerStore(defaults: defaults, center: center)
        XCTAssertNil(store.timer)
        XCTAssertNil(store.stop(), "nothing to stop")
        try store.start(minutes: 25, oneThing: "Write", now: t0)
        XCTAssertNotNil(defaults.data(forKey: "oneThingTimer"))
        let relaunched = OneThingTimerStore(defaults: defaults, center: center)
        XCTAssertEqual(relaunched.timer, OneThingTimer(startedAt: t0, minutes: 25, oneThing: "Write"), "a relaunch keeps it")
        XCTAssertNil(relaunched.end(now: t0.addingTimeInterval(60)), "not done yet: nothing ends")
        XCTAssertEqual(relaunched.end(now: t0.addingTimeInterval(1500))?.minutes, 25)
        XCTAssertNil(relaunched.timer)
        XCTAssertNil(defaults.data(forKey: "oneThingTimer"))
        try store.start(minutes: 5, oneThing: nil, now: t0)
        XCTAssertEqual(store.stop()?.minutes, 5)
        XCTAssertEqual(said.all, ["started", "ended", "started", "stopped"])
        XCTAssertThrowsError(try store.start(minutes: 0, oneThing: nil)) { XCTAssertEqual("\($0)", "a timer runs 1 to 240 minutes, not 0") }
        XCTAssertThrowsError(try store.start(minutes: 241, oneThing: nil))
        XCTAssertEqual(said.all.count, 4, "a refused start changes nothing")
    }

    func testTheBarSaysMinutesThenSeconds() {
        XCTAssertEqual(BarText.timer(remaining: 1500), "25 min")
        XCTAssertEqual(BarText.timer(remaining: 1499), "24 min")
        XCTAssertEqual(BarText.timer(remaining: 1440), "24 min")
        XCTAssertEqual(BarText.timer(remaining: 119.9), "1 min")
        XCTAssertEqual(BarText.timer(remaining: 60), "1 min")
        XCTAssertEqual(BarText.timer(remaining: 59.9), "0:59")
        XCTAssertEqual(BarText.timer(remaining: 42), "0:42")
        XCTAssertEqual(BarText.timer(remaining: 5.5), "0:05")
        XCTAssertEqual(BarText.timer(remaining: 0), "0:00")
        XCTAssertEqual(BarText.timer(remaining: -3), "0:00")
        for r in stride(from: 0.0, through: 14_400, by: 7.3) {
            let s = BarText.timer(remaining: r)
            XCTAssertFalse(s.contains("-") || s.contains("\u{2013}") || s.contains("\u{2014}"), "no dashes: \(s)")
        }
    }

    func testTheBarRedrawsWhenTheTextChanges() {
        XCTAssertEqual(BarText.timerNextChange(remaining: 1499.5), 59.5, accuracy: 0.001)
        XCTAssertEqual(BarText.timerNextChange(remaining: 1500), 0.05, accuracy: 0.001, "at a whole minute it changes at once")
        XCTAssertEqual(BarText.timerNextChange(remaining: 42.3), 0.3, accuracy: 0.001)
        XCTAssertEqual(BarText.timerNextChange(remaining: 0), 0.05, accuracy: 0.001)
        // Just past each wait, the text is different.
        for r in [1499.5, 600.2, 61.0, 42.3, 3.9] {
            let wait = BarText.timerNextChange(remaining: r)
            XCTAssertNotEqual(BarText.timer(remaining: r), BarText.timer(remaining: r - wait - 0.001), "\(r)")
        }
    }
}

private final class Said: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [String] = []
    func add(_ s: String) { lock.lock(); list.append(s); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return list }
}
