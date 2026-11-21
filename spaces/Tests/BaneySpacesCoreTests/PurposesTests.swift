import XCTest
@testable import BaneySpacesCore

/// Each workspace says what it is for, and one thing stays in front until the day ends.
final class PurposesTests: XCTestCase {
    private let day = PurposeFixture.day("2026-11-21")

    func testPurposesAreOneTrimmedLine() throws {
        var p = Purposes()
        try p.setPurpose("  Write\n the\tbook  ", for: 2)
        XCTAssertEqual(p.purpose(of: 2), "Write the book")
        try p.setPurpose("   \n ", for: 2)
        XCTAssertNil(p.purpose(of: 2), "empty means unnamed")
        try p.setPurpose("x", for: 3)
        try p.setPurpose(nil, for: 3)
        XCTAssertNil(p.purpose(of: 3))
    }

    func testTheLimitsAreRefusedNotCut() throws {
        var p = Purposes()
        try p.setPurpose(String(repeating: "a", count: 60), for: 1)
        XCTAssertEqual(p.purpose(of: 1)?.count, 60)
        XCTAssertThrowsError(try p.setPurpose(String(repeating: "a", count: 61), for: 1)) {
            XCTAssertEqual($0 as? Purposes.Problem, .tooLong(61, limit: 60))
        }
        XCTAssertEqual(p.purpose(of: 1)?.count, 60, "a refused set changes nothing")
        // Characters as a person counts them: a flag is one.
        try p.setPurpose(String(repeating: "🇺🇸", count: 60), for: 4)
        try p.setOneThing(String(repeating: "b", count: 80), workspace: 1, day: day)
        XCTAssertThrowsError(try p.setOneThing(String(repeating: "b", count: 81), workspace: 1, day: day))
    }

    func testOnlyRealWorkspacesHavePurposes() {
        var p = Purposes()
        XCTAssertThrowsError(try p.setPurpose("x", for: 0)) { XCTAssertEqual($0 as? Purposes.Problem, .noSuchWorkspace(0)) }
        XCTAssertThrowsError(try p.setPurpose("x", for: 10))
    }

    func testTheOneThingBelongsToItsDay() throws {
        var p = Purposes()
        try p.setOneThing("Finish the core", workspace: 3, day: day)
        XCTAssertEqual(p.oneThing(on: day)?.text, "Finish the core")
        XCTAssertEqual(p.oneThing(on: day)?.workspace, 3)
        XCTAssertNil(p.oneThing(on: PurposeFixture.day("2026-11-22")))
    }

    func testAHandEditedFileIsHeldToTheSameRules() throws {
        let json = """
        {"version":1,"purposes":{"1":"  Pray  ","2":"\(String(repeating: "x", count: 70))","12":"no such","x":"bad","3":"   "},
         "one":{"text":"Rest","workspace":40,"day":"2026-11-21"}}
        """
        let p = try JSONDecoder().decode(Purposes.self, from: Data(json.utf8))
        XCTAssertEqual(p.all, [1: "Pray", 2: String(repeating: "x", count: 60)])
        XCTAssertEqual(p.oneThing?.text, "Rest")
        XCTAssertNil(p.oneThing?.workspace)
    }
}

final class PurposeStoreTests: XCTestCase {
    private var folder: URL!
    override func setUp() { folder = PurposeFixture.folder() }
    override func tearDown() { try? FileManager.default.removeItem(at: folder) }

    private func store(_ now: PurposeFixture.Now, log: @escaping (String) -> Void = { _ in }, center: NotificationCenter = .init()) -> PurposeStore {
        PurposeStore(folder: folder, clock: PurposeFixture.chicago, now: { now.date }, log: log, center: center)
    }

    func testPurposesCarryOverAndTheOneThingClearsAtFourAM() throws {
        let now = PurposeFixture.Now(PurposeFixture.at(2026, 11, 21, 23))
        let s = store(now)
        try s.setPurpose("Write", for: 1)
        try s.setOneThing("Finish the core", workspace: 1)
        now.date = PurposeFixture.at(2026, 11, 22, 3, 59)
        XCTAssertEqual(s.oneThing?.text, "Finish the core", "a late night is the same day")
        XCTAssertEqual(s.day.description, "2026-11-21")
        now.date = PurposeFixture.at(2026, 11, 22, 4, 0)
        XCTAssertNil(s.oneThing, "gone at the day's start, even before rollover writes it")
        XCTAssertNil(s.snapshot.oneThing)
        XCTAssertEqual(s.purpose(of: 1), "Write", "purposes carry over")
        XCTAssertTrue(s.rollover())
        XCTAssertFalse(s.rollover(), "only once")
        s.flush()
        let text = try String(contentsOf: s.url, encoding: .utf8)
        XCTAssertFalse(text.contains("Finish the core"), text)
        XCTAssertTrue(text.contains("\"day\" : \"2026-11-22\""), text)
    }

    func testTheNextRolloverIsTheNextDayStart() {
        let now = PurposeFixture.Now(PurposeFixture.at(2026, 10, 31, 22))
        XCTAssertEqual(store(now).nextRollover, PurposeFixture.at(2026, 11, 1, 4), "4 am CST, after the clocks went back")
    }

    func testAChangeIsWrittenAndReadBack() throws {
        let now = PurposeFixture.Now(PurposeFixture.at(2026, 11, 21, 9))
        let s = store(now)
        try s.setPurpose("Pray", for: 1)
        try s.setPurpose("Build", for: 6)
        try s.setOneThing("Ship the core", workspace: 6)
        s.flush()
        let again = store(now)
        XCTAssertEqual(again.snapshot.all, [1: "Pray", 6: "Build"])
        XCTAssertEqual(again.oneThing, Purposes.OneThing(text: "Ship the core", workspace: 6, day: PurposeFixture.day("2026-11-21")))
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: s.url)) as? [String: Any]
        XCTAssertEqual(json?["version"] as? Int, Purposes.schema)
    }

    func testABadFileIsMovedAsideAndLoggedNeverACrash() throws {
        try Data("{\"purposes\": [not json".utf8).write(to: folder.appendingPathComponent("purposes.json"))
        var lines: [String] = []
        let now = PurposeFixture.Now(PurposeFixture.at(2026, 11, 21, 9))
        let s = store(now, log: { lines.append($0) })
        XCTAssertEqual(s.snapshot.all, [:])
        XCTAssertEqual(lines.count, 1)
        XCTAssertTrue(lines[0].hasPrefix("purpose: purposes.json not readable JSON"), lines[0])
        XCTAssertTrue(lines[0].contains("moved aside to purposes.json.bad-"), lines[0])
        XCTAssertFalse(lines[0].contains(NSHomeDirectory()), "no home folder in the trace")
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        XCTAssertEqual(names.filter { $0.hasPrefix("purposes.json.bad-") }.count, 1, "\(names)")
        XCTAssertFalse(names.contains("purposes.json"))
        // And it still works.
        try s.setPurpose("Again", for: 2)
        s.flush()
        XCTAssertEqual(store(now).purpose(of: 2), "Again")
    }

    func testAFileFromANewerBuildIsMovedAsideNotOverwritten() throws {
        let url = folder.appendingPathComponent("purposes.json")
        try Data("{\"version\": 99, \"purposes\": {\"1\": \"Future\"}}".utf8).write(to: url)
        var lines: [String] = []
        _ = store(PurposeFixture.Now(Date()), log: { lines.append($0) })
        XCTAssertTrue(lines.first?.contains("schema 99 is newer") == true, "\(lines)")
        let aside = try FileManager.default.contentsOfDirectory(atPath: folder.path).first { $0.hasPrefix("purposes.json.bad-") }
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent(try XCTUnwrap(aside)), encoding: .utf8).contains("Future"), true)
    }

    func testEveryChangeIsAnnouncedOnTheMainThreadAtOnce() throws {
        let center = NotificationCenter()
        let s = store(PurposeFixture.Now(Date()), center: center)
        var seen: [[AnyHashable: Any]] = []
        var lag: Double = .infinity
        var started = 0.0
        let token = center.addObserver(forName: PurposeStore.didChange, object: s, queue: nil) { note in
            XCTAssertTrue(Thread.isMainThread)
            lag = (CFAbsoluteTimeGetCurrent() - started) * 1000
            seen.append(note.userInfo ?? [:])
        }
        defer { center.removeObserver(token) }
        started = CFAbsoluteTimeGetCurrent()
        try s.setPurpose("Pray", for: 1)
        XCTAssertEqual(seen.count, 1, "posted before the set returns")
        XCTAssertLessThan(lag, ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" ? 5 : 1, "published within 1 ms")
        XCTAssertEqual(seen[0]["what"] as? String, "purpose")
        XCTAssertEqual(seen[0]["workspace"] as? Int, 1)
        try s.setPurpose("Pray", for: 1)
        XCTAssertEqual(seen.count, 1, "no change, no notice")
        try s.setOneThing("Rest", workspace: 1)
        XCTAssertEqual(seen.last?["what"] as? String, "oneThing")
        XCTAssertThrowsError(try s.setPurpose(String(repeating: "a", count: 61), for: 1))
        XCTAssertEqual(seen.count, 2, "a refused set announces nothing")
    }

    func testAChangeFromAnotherThreadIsAnnouncedOnMain() throws {
        let center = NotificationCenter()
        let s = store(PurposeFixture.Now(Date()), center: center)
        let posted = expectation(description: "posted on main")
        let token = center.addObserver(forName: PurposeStore.didChange, object: s, queue: nil) { _ in
            XCTAssertTrue(Thread.isMainThread)
            posted.fulfill()
        }
        defer { center.removeObserver(token) }
        DispatchQueue.global().async { try? s.setPurpose("Off main", for: 5) }
        wait(for: [posted], timeout: 2)
    }
}

/// Every surface reads the purposes while it draws, so a read must cost next to nothing.
final class PurposeSpeedTests: XCTestCase {
    /// A Mac does a set and 1,000 reads in well under 1 ms; GitHub's shared runners are slower and noisier. The best of
    /// five rounds is measured, so one round that the scheduler interrupts doesn't fail it.
    static let budgetMs = ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" ? 25.0 : 5.0

    func testASetAndAThousandReadsStayUnderBudget() throws {
        let folder = PurposeFixture.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let s = PurposeStore(folder: folder, center: NotificationCenter())
        try s.setPurpose("Warm up", for: 9)
        _ = s.oneThing
        var best = Double.infinity
        for round in 0..<5 {
            let start = CFAbsoluteTimeGetCurrent()
            try s.setPurpose("Round \(round)", for: 1)
            var found = 0
            for i in 0..<1000 {
                if i % 2 == 0 { found += s.purpose(of: 1 + i % 9) == nil ? 0 : 1 } else { found += s.oneThing == nil ? 0 : 1 }
            }
            best = min(best, (CFAbsoluteTimeGetCurrent() - start) * 1000)
            XCTAssertGreaterThan(found, 0)
        }
        s.flush()
        XCTAssertLessThan(best, Self.budgetMs, "a set and 1,000 reads took \(best) ms")
    }
}
