import XCTest
@testable import LauncherMatch

/// What you pick lifts it next time (spec/launcher.md R-L10), over the ranking table's index.
final class FrecencyTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let day: TimeInterval = 86_400

    func top(_ q: String, _ f: Frecency) -> String? {
        RankingTable.index().search(q, limit: 1, boost: f.boost(for: q, at: now)).first?.id
    }

    func testPickingAfterTypingPutsThatEntryFirstForTheSameQuery() {
        var f = Frecency()
        XCTAssertEqual(top("cal", f), "app:Calendar")
        f.picked("app:Calculator", query: "cal", at: now)
        XCTAssertEqual(top("cal", f), "app:Calculator")
        // Case and spacing don't make a different query.
        XCTAssertEqual(top("  CAL ", f), "app:Calculator")
        // A clearly better name still wins for another query.
        XCTAssertEqual(top("calen", f), "app:Calendar")
    }

    func testUseAloneLiftsANearTieButNotAMuchBetterMatch() {
        var f = Frecency()
        for _ in 0..<20 { f.picked("app:Messages", query: "", at: now) }
        XCTAssertEqual(f.boost(for: "x", at: now)("app:Messages"), Frecency.usedMax)
        // "m" starts both Mail and Messages; use breaks the tie.
        XCTAssertEqual(top("m", Frecency()), "app:Mail")
        XCTAssertEqual(top("m", f), "app:Messages")
        // "mail" is Mail's whole name.
        XCTAssertEqual(top("mail", f), "app:Mail")
    }

    func testPicksFadeByHalfEveryFourteenDays() {
        var f = Frecency()
        f.picked("app:Slack", query: "s", at: now - 14 * day)
        f.picked("app:Slack", query: "s", at: now - 14 * day)
        // Two picks two weeks ago weigh one: 8 for use, 25 for the query.
        XCTAssertEqual(f.boost(for: "s", at: now)("app:Slack"), 8 + 25)
        XCTAssertEqual(f.boost(for: "s", at: now + 200 * day)("app:Slack"), 0)
        f.prune(at: now + 200 * day)
        XCTAssertTrue(f.isEmpty)
    }

    func testLiftsAreCapped() {
        var f = Frecency()
        for _ in 0..<50 { f.picked("cmd:Lock Screen", query: "l", at: now) }
        XCTAssertEqual(f.boost(for: "l", at: now)("cmd:Lock Screen"), Frecency.usedMax + Frecency.typedMax)
    }

    func testNothingTypedLiftsNothing() {
        var f = Frecency()
        f.picked("app:Zoom", query: "", at: now)
        XCTAssertEqual(f.boost(for: "  ", at: now)("app:Zoom"), 0)
    }

    func testTheStoreNamesNoEntryAndNoQuery() throws {
        var f = Frecency()
        f.picked("app:/Applications/Proton Mail.app", query: "proton inbox", at: now)
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(f), encoding: .utf8))
        for word in ["Proton", "proton", "inbox", "Applications", "Mail"] { XCTAssertFalse(json.contains(word), word) }
        XCTAssertEqual(try JSONDecoder().decode(Frecency.self, from: Data(json.utf8)), f)
    }

    func testTheHashIsFixedAcrossRunsAndPlatforms() {
        // FNV-1a 64 of "a": a port must store the same keys.
        XCTAssertEqual(Frecency.key("a"), "af63dc4c8601ec8c")
    }
}
