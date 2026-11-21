import XCTest
@testable import BaneySpacesCore

/// `polycarp-spaces purpose|one|day` on the session socket.
final class PurposeAPITests: XCTestCase {
    private var folder: URL!
    private var purposes: PurposeStore!
    private var ledger: DayLedgerStore!
    private let now = PurposeFixture.Now(PurposeFixture.at(2026, 11, 21, 9))

    override func setUp() {
        folder = PurposeFixture.folder()
        purposes = PurposeStore(folder: folder, clock: PurposeFixture.chicago, now: { [now] in now.date }, center: NotificationCenter())
        ledger = DayLedgerStore(folder: folder, clock: PurposeFixture.chicago, center: NotificationCenter())
    }

    override func tearDown() {
        purposes.flush()
        ledger.flush()
        try? FileManager.default.removeItem(at: folder)
    }

    func testAsks() {
        XCTAssertEqual(PurposeAPI.ask(text: nil, args: []), .list)
        XCTAssertEqual(PurposeAPI.ask(text: "list", args: ["--json"]), .list)
        XCTAssertEqual(PurposeAPI.ask(text: "set", args: ["3", "Write", "the", "book"]), .set(3, "Write the book"))
        XCTAssertEqual(PurposeAPI.ask(text: "set", args: ["3", "  "]), .clear(3))
        XCTAssertEqual(PurposeAPI.ask(text: "clear", args: ["3"]), .clear(3))
        XCTAssertEqual(PurposeAPI.ask(text: "one", args: ["Finish", "it"]), .one("Finish it"))
        XCTAssertEqual(PurposeAPI.ask(text: "one", args: ["--clear"]), .clearOne)
        XCTAssertEqual(PurposeAPI.ask(text: "day", args: ["--json"]), .day)
        for (text, args) in [("set", ["3"]), ("set", ["three", "x"]), ("clear", []), ("one", []), ("one", ["x", "--clear"]),
                             ("day", ["today"]), ("list", ["x"]), ("rename", [])] {
            guard case .refused = PurposeAPI.ask(text: text, args: args) else { return XCTFail("\(text) \(args) should be refused") }
        }
    }

    func testSetListAndClear() throws {
        let set = PurposeAPI.answer(.set(2, "Pray"), purposes: purposes, ledger: ledger, current: 2)
        var l = try XCTUnwrap(PurposeAPI.decodeListing(set))
        XCTAssertEqual(l.workspaces.count, Workspaces.range.count)
        XCTAssertEqual(l.workspaces[1], PurposeAPI.Row(workspace: 2, purpose: "Pray"))
        XCTAssertNil(l.workspaces[0].purpose)
        XCTAssertEqual(l.day.description, "2026-11-21")
        XCTAssertEqual(PurposeAPI.lines(l), ["2* Pray", "one thing: none today (polycarp-spaces one <text>)"])
        l = try XCTUnwrap(PurposeAPI.decodeListing(PurposeAPI.answer(.clear(2), purposes: purposes, ledger: ledger, current: 1)))
        XCTAssertTrue(l.workspaces.allSatisfy { $0.purpose == nil })
    }

    func testTheOneThingIsSetOnTheCurrentWorkspace() throws {
        let r = PurposeAPI.answer(.one("Ship the core"), purposes: purposes, ledger: ledger, current: 6)
        let l = try XCTUnwrap(PurposeAPI.decodeListing(r))
        XCTAssertEqual(l.one, Purposes.OneThing(text: "Ship the core", workspace: 6, day: PurposeFixture.day("2026-11-21")))
        XCTAssertEqual(PurposeAPI.lines(l).last, "one thing: Ship the core (set on workspace 6)")
        _ = PurposeAPI.answer(.clearOne, purposes: purposes, ledger: ledger, current: 6)
        XCTAssertNil(purposes.oneThing)
    }

    func testMistakesComeBackAsErrors() {
        let long = PurposeAPI.answer(.set(1, String(repeating: "a", count: 61)), purposes: purposes, ledger: ledger, current: 1)
        XCTAssertFalse(long.ok)
        XCTAssertEqual(long.error, "that is 61 characters; keep it to 60")
        let range = PurposeAPI.answer(.set(12, "x"), purposes: purposes, ledger: ledger, current: 1)
        XCTAssertEqual(range.error, "no workspace 12; pick one from 1 to 9")
        XCTAssertEqual(PurposeAPI.answer(.refused("nope"), purposes: purposes, ledger: ledger, current: 1).error, "nope")
    }

    func testTheDayListsTimeMostFirst() throws {
        let t0 = PurposeFixture.at(2026, 11, 21, 9)
        ledger.switched(to: 1, at: t0)
        ledger.tick(at: t0.addingTimeInterval(60), idle: 0)
        ledger.switched(to: 3, at: t0.addingTimeInterval(60))
        ledger.tick(at: t0.addingTimeInterval(240), idle: 0)
        try purposes.setPurpose("Mail", for: 3)
        let d = try XCTUnwrap(PurposeAPI.decodeDay(PurposeAPI.answer(.day, purposes: purposes, ledger: ledger, current: 3)))
        XCTAssertEqual(d.total, 240)
        XCTAssertEqual(d.workspaces.map(\.workspace), [3, 1])
        XCTAssertEqual(d.workspaces.first?.purpose, "Mail")
        XCTAssertEqual(PurposeAPI.lines(d), ["2026-11-21: 4 min", "  3  3 min  Mail", "  1  1 min"])
    }

    func testTimerAsks() {
        XCTAssertEqual(PurposeAPI.ask(text: "timer", args: []), .startTimer(nil))
        XCTAssertEqual(PurposeAPI.ask(text: "timer", args: ["50"]), .startTimer(50))
        XCTAssertEqual(PurposeAPI.ask(text: "timer", args: ["stop"]), .stopTimer)
        XCTAssertEqual(PurposeAPI.ask(text: "timer", args: ["status", "--json"]), .timerStatus)
        for args in [["0"], ["241"], ["ten"], ["stop", "now"], ["25", "50"], ["-5"]] {
            XCTAssertEqual(PurposeAPI.ask(text: "timer", args: args), .refused(PurposeAPI.timerUsage), "\(args)")
        }
    }

    func testTheTimerStartsStopsAndSaysWhatIsLeft() throws {
        let suite = "polycarp-purposeapi-timer-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let timer = OneThingTimerStore(defaults: defaults, center: NotificationCenter())
        let t0 = now.date
        func ask(_ a: PurposeAPI.Ask, at: Date = t0, minutes: Int = 25) -> Wire.Reply {
            PurposeAPI.answer(a, purposes: purposes, ledger: ledger, current: 2, now: at, timer: timer, timerMinutes: minutes)
        }
        var t = try XCTUnwrap(PurposeAPI.decodeTimer(ask(.timerStatus)))
        XCTAssertFalse(t.running)
        XCTAssertEqual(PurposeAPI.lines(t), ["no timer running (polycarp-spaces timer [minutes]; 25 min by default)"])

        // A bare start takes alarm.timerMinutes and keeps the one thing's words; it runs without one too.
        try purposes.setOneThing("Ship the core", workspace: 2)
        t = try XCTUnwrap(PurposeAPI.decodeTimer(ask(.startTimer(nil), minutes: 30)))
        XCTAssertTrue(t.running)
        XCTAssertEqual(t.minutes, 30)
        XCTAssertEqual(t.remaining, 1800)
        XCTAssertEqual(t.oneThing, "Ship the core")
        XCTAssertEqual(t.defaultMinutes, 30)
        XCTAssertEqual(t.startedAt, ISO8601DateFormatter().string(from: t0))
        XCTAssertEqual(t.endsAt, ISO8601DateFormatter().string(from: t0.addingTimeInterval(1800)))
        t = try XCTUnwrap(PurposeAPI.decodeTimer(ask(.timerStatus, at: t0.addingTimeInterval(18 * 60 + 20))))
        XCTAssertEqual(t.remaining, 700)
        XCTAssertEqual(PurposeAPI.lines(t), ["timer: 11 min left of 30 min, on: Ship the core"])
        XCTAssertEqual(PurposeAPI.lines(try XCTUnwrap(PurposeAPI.decodeTimer(ask(.timerStatus, at: t0.addingTimeInterval(1758))))),
                       ["timer: 0:42 left of 30 min, on: Ship the core"])
        XCTAssertFalse(try XCTUnwrap(PurposeAPI.decodeTimer(ask(.timerStatus, at: t0.addingTimeInterval(1800)))).running, "done is not running")

        t = try XCTUnwrap(PurposeAPI.decodeTimer(ask(.stopTimer)))
        XCTAssertFalse(t.running)
        XCTAssertNil(timer.timer)
        try purposes.setOneThing(nil, workspace: nil)
        t = try XCTUnwrap(PurposeAPI.decodeTimer(ask(.startTimer(5))))
        XCTAssertEqual(t.minutes, 5)
        XCTAssertNil(t.oneThing)
        XCTAssertEqual(PurposeAPI.lines(t), ["timer: 5 min left of 5 min"])
    }

    func testTimerMistakesComeBackAsErrors() {
        let noStore = PurposeAPI.answer(.startTimer(nil), purposes: purposes, ledger: ledger, current: 1)
        XCTAssertFalse(noStore.ok)
        XCTAssertEqual(noStore.error, "the timer isn't ready yet; try again in a moment")
        let suite = "polycarp-purposeapi-timer-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let timer = OneThingTimerStore(defaults: defaults, center: NotificationCenter())
        let r = PurposeAPI.answer(.startTimer(500), purposes: purposes, ledger: ledger, current: 1, timer: timer)
        XCTAssertEqual(r.error, "a timer runs 1 to 240 minutes, not 500")
        XCTAssertNil(timer.timer)
    }

    func testAnotherMachineIsNeverLetIn() {
        for sub in ["list", "set", "one", "day", "timer"] { XCTAssertFalse(Remote.allows(Wire.Request(op: .purpose, text: sub))) }
    }

    func testTheCommandAndTheAppCarryIt() throws {
        let cli = try SourceText.code("Sources/baneyspaces-cli/main.swift")
        XCTAssertTrue(cli.contains("case \"purpose\", \"purposes\", \"one\", \"day\":"))
        XCTAssertTrue(cli.contains("op: .purpose"))
        XCTAssertTrue(cli.contains("case \"timer\":"))
        XCTAssertTrue(cli.contains("Wire.Request(op: .purpose, text: \"timer\", args: words)"))
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/PurposeKeeper.swift").contains("timer: timers,"), "the app answers with its one store")
        let session = try SourceText.code("Sources/BaneySpaces/Session/SessionController.swift")
        // Answered before the Accessibility check: none of it needs Accessibility.
        let early = try XCTUnwrap(SourceText.between("func handle(_ r: Wire.Request)", "guard started else", in: session))
        XCTAssertTrue(early.contains("r.op == .purpose"))
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("PurposeKeeper.shared.noteWorkspace(self.spaces.model.current)"), "the ledger hears every switch")
    }
}
