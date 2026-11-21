import XCTest
@testable import BaneySpacesCore

/// Time on each workspace, only while you were there, split at each day's 4 am start.
final class DayLedgerTests: XCTestCase {
    private let c = PurposeFixture.chicago
    private func d(_ s: String) -> PurposeDay { PurposeFixture.day(s) }

    func testTimeIsSplitAtFourAM() {
        var l = DayLedger()
        l.add(2, from: PurposeFixture.at(2026, 11, 21, 3), to: PurposeFixture.at(2026, 11, 21, 5), clock: c)
        XCTAssertEqual(l.seconds(on: d("2026-11-20")), [2: 3600])
        XCTAssertEqual(l.seconds(on: d("2026-11-21")), [2: 3600])
        XCTAssertEqual(l.total(on: d("2026-11-21")), 3600)
    }

    func testTheNightDSTEndsCountsItsExtraHour() {
        // 1:00 CDT to 4:30 CST on November 1 is four and a half real hours: four before the day starts at 4 am CST.
        var l = DayLedger()
        l.add(1, from: PurposeFixture.at(2026, 11, 1, 1, first: true), to: PurposeFixture.at(2026, 11, 1, 4, 30), clock: c)
        XCTAssertEqual(l.seconds(on: d("2026-10-31")), [1: 4 * 3600])
        XCTAssertEqual(l.seconds(on: d("2026-11-01")), [1: 1800])
    }

    func testTheNightDSTStartsLosesAnHour() {
        // 1:00 CST to 5:00 CDT on March 8 is three real hours: two before 4 am CDT.
        var l = DayLedger()
        l.add(1, from: PurposeFixture.at(2026, 3, 8, 1), to: PurposeFixture.at(2026, 3, 8, 5), clock: c)
        XCTAssertEqual(l.seconds(on: d("2026-03-07")), [1: 2 * 3600])
        XCTAssertEqual(l.seconds(on: d("2026-03-08")), [1: 3600])
    }

    func testNinetyDaysAreKept() {
        var l = DayLedger()
        let today = d("2026-11-21")
        for back in 0..<100 {
            let day = c.adding(-back, to: today)
            l.add(1, from: c.time(on: day, hour: 9), to: c.time(on: day, hour: 10), clock: c)
        }
        l.prune(today: today, clock: c)
        XCTAssertEqual(l.recorded.count, 90)
        XCTAssertEqual(l.recorded.first, c.adding(-89, to: today))
        XCTAssertEqual(l.recorded.last, today)
    }

    func testTheFileIsCompactAndForgivesBadEntries() throws {
        var l = DayLedger()
        l.add(3, from: PurposeFixture.at(2026, 11, 21, 9), to: PurposeFixture.at(2026, 11, 21, 9, 2), clock: c)
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        XCTAssertEqual(String(data: try enc.encode(l), encoding: .utf8), "{\"days\":{\"2026-11-21\":{\"3\":120}},\"version\":1}")
        let messy = "{\"version\":1,\"days\":{\"2026-11-21\":{\"3\":120,\"12\":5,\"x\":1,\"4\":-3},\"someday\":{\"1\":9}}}"
        XCTAssertEqual(try JSONDecoder().decode(DayLedger.self, from: Data(messy.utf8)), l)
    }
}

final class LedgerTrackerTests: XCTestCase {
    private let c = PurposeFixture.chicago
    private let t0 = PurposeFixture.at(2026, 11, 21, 9)
    private var ledger = DayLedger()
    private var tracker = LedgerTracker()
    private var today: [Int: Int] { ledger.seconds(on: PurposeFixture.day("2026-11-21")) }

    private func t(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
    private func switched(_ n: Int, _ s: TimeInterval) { tracker.switched(to: n, at: t(s), ledger: &ledger, clock: c) }
    private func tick(_ s: TimeInterval, idle: TimeInterval) { tracker.tick(at: t(s), idle: idle, ledger: &ledger, clock: c) }

    func testEachSwitchCountsTheTimeOnTheWorkspaceLeft() {
        switched(1, 0)
        tick(60, idle: 0)
        switched(2, 90)
        tick(150, idle: 0)
        XCTAssertEqual(today, [1: 90, 2: 60])
    }

    func testAPauseUnderFiveMinutesCountsOnceInputComesBack() {
        switched(1, 0)
        tick(60, idle: 60)
        tick(240, idle: 240)
        XCTAssertEqual(today, [:], "nothing yet: the pause may still run over")
        tick(270, idle: 0)
        XCTAssertEqual(today, [1: 270])
    }

    func testAPauseOfFiveMinutesOrMoreCountsNothingFromTheLastInput() {
        switched(1, 0)
        tick(400, idle: 300) // last input at 100
        XCTAssertEqual(today, [1: 100])
        tick(700, idle: 600)
        tick(1000, idle: 10) // back at 990 at the latest
        tick(1060, idle: 0)
        XCTAssertEqual(today, [1: 170])
    }

    func testSleepAndTheLockCountNothing() {
        switched(1, 0)
        tick(60, idle: 0)
        tracker.wentAway(at: t(90), idle: 0, ledger: &ledger, clock: c)
        XCTAssertEqual(today, [1: 90])
        tick(500, idle: 0)
        switched(3, 550) // a switch made while away (the model can change) counts nothing either
        XCTAssertEqual(today, [1: 90])
        tracker.cameBack(at: t(600))
        tick(660, idle: 5)
        tick(720, idle: 0)
        XCTAssertEqual(today, [1: 90, 3: 65])
    }

    func testGoingAwayAfterAnIdleStretchDropsTheStretch() {
        switched(1, 0)
        tracker.wentAway(at: t(1000), idle: 900, ledger: &ledger, clock: c)
        XCTAssertEqual(today, [:])
    }

    func testAStretchWithNoTickIsNotCounted() {
        // The timer never fired for an hour: the Mac slept without saying so.
        switched(1, 0)
        tick(3600, idle: 0)
        XCTAssertEqual(today, [:])
        tick(3660, idle: 0)
        XCTAssertEqual(today, [1: 60], "counting goes on from there")
    }

    func testNothingCountsBeforeAWorkspaceIsKnown() {
        tick(60, idle: 0)
        XCTAssertEqual(today, [:])
    }
}

final class DayLedgerStoreTests: XCTestCase {
    private var folder: URL!
    override func setUp() { folder = PurposeFixture.folder() }
    override func tearDown() { try? FileManager.default.removeItem(at: folder) }

    func testTimeIsWrittenAndReadBack() throws {
        let t0 = PurposeFixture.at(2026, 11, 21, 9)
        let center = NotificationCenter()
        var posts = 0
        let token = center.addObserver(forName: DayLedgerStore.didChange, object: nil, queue: nil) { _ in posts += 1 }
        defer { center.removeObserver(token) }
        let s = DayLedgerStore(folder: folder, clock: PurposeFixture.chicago, now: t0, center: center)
        s.switched(to: 4, at: t0)
        s.tick(at: t0.addingTimeInterval(60), idle: 1)
        XCTAssertEqual(posts, 1)
        XCTAssertEqual(s.today(at: t0), [4: 59])
        s.flush()
        let again = DayLedgerStore(folder: folder, clock: PurposeFixture.chicago, now: t0)
        XCTAssertEqual(again.seconds(on: PurposeFixture.day("2026-11-21")), [4: 59])
        XCTAssertFalse(try String(contentsOf: s.url, encoding: .utf8).contains("\n"), "compact")
    }

    func testABadLedgerIsMovedAsideAndLogged() throws {
        try Data("not json at all".utf8).write(to: folder.appendingPathComponent("ledger.json"))
        var lines: [String] = []
        let s = DayLedgerStore(folder: folder, clock: PurposeFixture.chicago, log: { lines.append($0) })
        XCTAssertEqual(s.snapshot, DayLedger())
        XCTAssertTrue(lines.first?.hasPrefix("purpose: ledger.json not readable JSON") == true, "\(lines)")
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: folder.path).contains { $0.hasPrefix("ledger.json.bad-") })
    }
}

/// Review of #582 (first-F2): the screen waking under the lock screen counted as being back, so typing the password
/// started the ledger before the Mac was unlocked.
final class PresenceGateTests: XCTestCase {
    func testWakingUnderTheLockScreenIsNotBeingBack() {
        var g = PresenceGate()
        XCTAssertFalse(g.back(after: .locked))
        XCTAssertFalse(g.back(after: .wentAway))
        XCTAssertFalse(g.back(after: .woke), "the lock screen is still up")
        XCTAssertTrue(g.back(after: .unlocked))
        XCTAssertFalse(g.locked)
    }

    func testWakingWithNoLockIsBeingBack() {
        var g = PresenceGate()
        XCTAssertFalse(g.back(after: .wentAway))
        XCTAssertTrue(g.back(after: .woke))
    }

    func testASessionComingBackClearsTheLock() {
        var g = PresenceGate()
        _ = g.back(after: .locked)
        XCTAssertTrue(g.back(after: .sessionActive))
        XCTAssertTrue(g.back(after: .woke))
    }

    func testTheKeeperFeedsTheLedgerThroughTheGate() throws {
        let keeper = try SourceText.code("Sources/BaneySpaces/PurposeKeeper.swift")
        XCTAssertTrue(keeper.contains("if gate.back(after: event) { ledger.cameBack() }"))
        XCTAssertEqual(keeper.components(separatedBy: "ledger.cameBack(").count, 2, "no other way back")
        XCTAssertTrue(keeper.contains("(\"com.apple.screenIsUnlocked\", .unlocked)"))
        XCTAssertTrue(keeper.contains("(NSWorkspace.screensDidWakeNotification, .woke)"))
    }
}
