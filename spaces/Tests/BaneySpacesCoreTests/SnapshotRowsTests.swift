import XCTest
@testable import BaneySpacesCore

/// Rows for `snapshot` (build list item 1): what a model pays per look, over trees recorded from real windows on the agent
/// workspace (2026-11-12; System Information's detail text and host name replaced by same-length filler).
final class SnapshotRowsTests: XCTestCase {
    struct Recorded { var file: String; var app: String; var query: String }
    static let recorded = [
        Recorded(file: "system-information", app: "System Information", query: "Bluetooth"),
        Recorded(file: "textedit", app: "TextEdit", query: "close"),
        Recorded(file: "calculator", app: "Calculator", query: "7"),
        Recorded(file: "preview", app: "Preview", query: "zoom in"),
    ]

    func load(_ name: String) throws -> JSONValue {
        let url = Repo.root.appendingPathComponent("Tests/BaneySpacesCoreTests/Fixtures/snapshots/\(name).json")
        return try XCTUnwrap(JSONValue.parse(try Data(contentsOf: url)), name)
    }

    func full(_ data: JSONValue, app: String, query: String? = nil, max: Int? = nil) -> String {
        let rows = SnapshotRows.rows(of: data["tree"] ?? .null)
        return SnapshotRows.render(rows, snapshot: data["snapshot_id"]?.string ?? "", window: 54978, title: data["window"]?["title"]?.string ?? "",
                                   app: app, refs: data["ref_count"]?.int ?? 0, query: query, max: max)
    }

    /// The ratchet: rows at most 30% of the JSON a model got before, a query at most 10%, a read with no change under 100 chars.
    func testRowsCostAFractionOfTheJSONOnEveryRecordedWindow() throws {
        for r in Self.recorded {
            let data = try load(r.file)
            let json = HandsEnvelope.success(data).line.count
            let rows = full(data, app: r.app).count
            let query = full(data, app: r.app, query: r.query)
            let tree = SnapshotRows.rows(of: data["tree"] ?? .null)
            let same = SnapshotRows.renderSince(SnapshotRows.changes(from: tree, to: tree), new: tree, snapshot: "s1a2b3c4d5e6f7", previous: "s7f6e5d4c3b2a1",
                                                window: 54978, query: nil)
            print("ratchet \(r.file): json \(json), rows \(rows), query \(query.count), since \(same.count)")
            XCTAssertLessThanOrEqual(Double(rows), 0.30 * Double(json), "\(r.file): rows \(rows) of json \(json)")
            XCTAssertLessThanOrEqual(Double(query.count), 0.10 * Double(json), "\(r.file): query \(query.count) of json \(json):\n\(query)")
            XCTAssertTrue(query.contains(r.query.split(separator: " ").first.map(String.init) ?? ""), "\(r.file): the query found its row:\n\(query)")
            XCTAssertLessThan(same.count, 100, same)
        }
    }

    func testEachRowIsNumberRoleNameValueAndStatesUnderItsParent() throws {
        let text = full(try load("system-information"), app: "System Information")
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertTrue(lines[0].hasPrefix("snapshot sghmx6egqu5lo · window 54978 \"MacBook Pro\" (System Information) · 119 refs"), lines[0])
        XCTAssertTrue(lines[1].contains("{\"ref\":\"5\"}") && lines[1].contains("@sghmx6egqu5lo:e5"), lines[1])
        XCTAssertTrue(lines.contains("[1] scrollarea \"Contents\""), text)
        XCTAssertTrue(lines.contains("    [3] treeitem (expanded,selected)"), text)
        XCTAssertTrue(lines.contains("      [4] disclosure =1 (expanded)"), "a numeric value prints bare:\n\(text)")
        XCTAssertTrue(lines.contains("      [5] textfield =\"Hardware\" (readonly)"), text)
        // The engine's numbers, each once: row N is ref eN.
        let numbers = lines.compactMap { $0.split(separator: "]").first.flatMap { Int($0.drop { $0 == " " || $0 == "[" }) } }
        XCTAssertEqual(numbers.count, 119)
        XCTAssertEqual(Set(numbers).count, 119)
    }

    func testALongValueIsCutWithTheWayToReadAllOfIt() throws {
        let text = full(try load("system-information"), app: "System Information")
        let line = try XCTUnwrap(text.split(separator: "\n").first { $0.contains("xxxxxxxx Overview") || $0.contains("chars; get value for all") })
        XCTAssertTrue(line.contains("…(+"), String(line))
        XCTAssertLessThan(line.count, SnapshotRows.valueLimit + 80)
        XCTAssertFalse(text.contains("0.18518517911434174"))
    }

    func testAQueryKeepsMatchesTheirParentsAndTheirNumbers() throws {
        let text = full(try load("system-information"), app: "System Information", query: "bluetooth|wi-fi")
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertTrue(lines[0].contains("query \"bluetooth|wi-fi\": "), lines[0])
        XCTAssertTrue(lines.contains("      [13] textfield =\"Bluetooth\" (readonly)"), text)
        XCTAssertTrue(lines.contains("    [12] treeitem"), "the row to click is the match's parent:\n\(text)")
        XCTAssertTrue(lines.contains("  [2] outline (focused)"), text)
        XCTAssertFalse(text.contains("\"Audio\""), text)
        let none = full(try load("system-information"), app: "System Information", query: "no such thing")
        XCTAssertTrue(none.contains("no row matches \"no such thing\""), none)
    }

    func testMaxElementsEndsWithATruncatedLineThatSaysHowToGetTheRest() throws {
        let text = full(try load("calculator"), app: "Calculator", max: 10)
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 2 + 10 + 1)
        let last = try XCTUnwrap(lines.last)
        XCTAssertTrue(last.hasPrefix("truncated: 10 of "), last)
        XCTAssertTrue(last.contains("\"query\"") && last.contains("\"max_elements\""), last)
        XCTAssertFalse(full(try load("calculator"), app: "Calculator").contains("truncated:"))
    }

    func testSinceListsOnlyWhatChangedAndIgnoresRenumbering() {
        func tree(_ items: [(String, [String])], first: Int) -> JSONValue {
            .object(["role": "window", "name": "W", "children": .array(items.enumerated().map { i, it in
                .object(["role": "treeitem", "name": .string(it.0), "ref_id": .string("@sB:e\(first + i)"), "states": .array(it.1.map(JSONValue.string))])
            })])
        }
        let old = SnapshotRows.rows(of: tree([("Audio", []), ("Bluetooth", ["selected"]), ("Camera", [])], first: 1))
        let new = SnapshotRows.rows(of: tree([("Audio", ["selected"]), ("Bluetooth", []), ("Disc", [])], first: 7))
        let text = SnapshotRows.renderSince(SnapshotRows.changes(from: old, to: new), new: new, snapshot: "sB", previous: "sA", window: 9, query: nil)
        XCTAssertEqual(text, """
        snapshot sB · window 9 · since sA: 1 added, 2 changed, 1 removed · act by full ref @sB:eN
        ~ [7] treeitem "Audio" (selected)
        ~ [8] treeitem "Bluetooth"
        + [9] treeitem "Disc"
        - treeitem "Camera"
        """)
        let renumbered = SnapshotRows.rows(of: tree([("Audio", []), ("Bluetooth", ["selected"]), ("Camera", [])], first: 40))
        XCTAssertTrue(SnapshotRows.changes(from: old, to: renumbered).isEmpty, "new numbers alone are not a change")
    }

    func testBareRowNumbers() {
        XCTAssertEqual(SnapshotRows.bareNumber("5"), 5)
        XCTAssertNil(SnapshotRows.bareNumber("e12"), "e12 is a browser ref, not native row 12")
        XCTAssertEqual(SnapshotRows.bareNumber("[3]"), 3)
        XCTAssertNil(SnapshotRows.bareNumber("@s1:e5"))
        XCTAssertNil(SnapshotRows.bareNumber("0"))
        XCTAssertNil(SnapshotRows.bareNumber("five"))
        XCTAssertNil(SnapshotRows.bareNumber("٣"), "only ASCII digits")
    }

    // Weak-model item 3: Haiku passed read_page refs to computer_select. A browser ref is named as one, with the right tool.
    func testBrowserRefsAreNamedAndPointToTheBrowserTools() throws {
        let e = try XCTUnwrap(SnapshotRows.browserRefError("e12"))
        XCTAssertEqual(e.code, .badArguments)
        XCTAssertTrue(e.message.contains("browser ref"), e.message)
        XCTAssertTrue(e.suggestion.contains("click, fill, select") && e.suggestion.contains("computer_snapshot"), e.suggestion)
        for r in ["5", "[5]", "@s1:e5", "e", "eleven", "e1x"] { XCTAssertNil(SnapshotRows.browserRefError(r), r) }
    }

    func testTheRouterRefusesABrowserRefBeforeReadingARowNumber() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let refusal = try XCTUnwrap(src.range(of: "SnapshotRows.browserRefError(r)"))
        let bare = try XCTUnwrap(src.range(of: "SnapshotRows.bareNumber(r)"))
        XCTAssertLessThan(refusal.lowerBound, bare.lowerBound)
    }

    func rows(_ names: [String]) -> [SnapshotRows.Row] {
        SnapshotRows.rows(of: .object(["role": "window", "children": .array(names.enumerated().map { i, n in
            .object(["role": "button", "name": .string(n), "ref_id": .string("@s:e\(i + 1)")])
        })]))
    }

    func testABareRowMeansTheLatestSnapshotsRowWhileNoEarlierOneDisagrees() {
        var m = SnapshotRowsMemory()
        let t = Date()
        XCTAssertEqual(m.resolve(bare: 1, session: "a", now: t).code, .unknownRef, "no snapshot yet")
        m.remember(session: "a", window: 9, view: "v", snapshot: "sOne", rows: rows(["OK", "Cancel"]), now: t)
        XCTAssertEqual(m.resolve(bare: 2, session: "a", now: t), .ref("@sOne:e2"))
        XCTAssertEqual(m.resolve(bare: 2, session: "b", now: t).code, .unknownRef, "another session's snapshot is not this one's")
        XCTAssertEqual(m.resolve(bare: 3, session: "a", now: t).code, .unknownRef, "no row 3")
        // A new read with the same row 2: the number means one element, so it holds.
        m.remember(session: "a", window: 9, view: "v", snapshot: "sTwo", rows: rows(["OK", "Cancel"]), now: t)
        XCTAssertEqual(m.resolve(bare: 2, session: "a", now: t), .ref("@sTwo:e2"))
    }

    func testABareRowFromAnOlderSnapshotIsRefused() {
        var m = SnapshotRowsMemory()
        let t = Date()
        m.remember(session: "a", window: 9, view: "v", snapshot: "sOld", rows: rows(["OK", "Cancel"]), now: t)
        // A row was added in front: row 2 is another element now.
        m.remember(session: "a", window: 9, view: "v", snapshot: "sNew", rows: rows(["Delete", "OK", "Cancel"]), now: t)
        guard case .refused(let code, let message, let latest) = m.resolve(bare: 2, session: "a", now: t) else { return XCTFail("a bare 2 must be refused") }
        XCTAssertEqual(code, .staleBareRow)
        XCTAssertTrue(message.contains("button \"OK\"") && message.contains("button \"Cancel\""), message)
        XCTAssertEqual(latest?.snapshot, "sNew")
        // Another window's row 1 counts too.
        m.remember(session: "c", window: 1, view: "v", snapshot: "sA", rows: rows(["Open"]), now: t)
        m.remember(session: "c", window: 2, view: "v", snapshot: "sB", rows: rows(["Open"]), now: t)
        XCTAssertEqual(m.resolve(bare: 1, session: "c", now: t).code, .staleBareRow)
        // After the horizon the older snapshot no longer counts.
        XCTAssertEqual(m.resolve(bare: 1, session: "c", now: t.addingTimeInterval(SnapshotRowsMemory.horizon + 1)), .ref("@sB:e1"))
    }

    func testSnapshotArgumentsAreChecked() {
        func parse(_ args: [String: JSONValue]) -> Result<HandsRequest, HandsError> { HandsParse.call(name: "snapshot", arguments: args) }
        XCTAssertEqual(try? parse(["window": 5, "format": "xml"]).get(), nil)
        XCTAssertEqual(try? parse(["window": 5, "since": "yesterday"]).get(), nil)
        XCTAssertEqual(try? parse(["window": 5, "max_elements": 0]).get(), nil)
        XCTAssertEqual(try? parse(["window": 5, "format": "json", "query": "x"]).get(), nil)
        XCTAssertEqual((try? parse(["window": 5, "query": "Save"]).get())?.snapshotFormat, "rows")
        XCTAssertEqual((try? parse(["window": 5]).get())?.snapshotFormat, "json", "the command line keeps json")
        if case .success(let r) = HandsParse.command(["snapshot", "--window", "5", "--since", "latest", "--max_elements", "20"]) {
            XCTAssertEqual(r.snapshotFormat, "rows")
            XCTAssertEqual(r.int("max_elements"), 20)
        } else { XCTFail("the CLI takes since and max_elements") }
    }

    func testMCPAsksForRowsAndSendsThemAsPlainText() throws {
        var seen: HandsRequest?
        let rowsText = "snapshot s1 · window 5 \"W\" (App) · 1 refs\n  [1] button \"OK\""
        let s = HandsMCP(version: "1", session: "mcp:1") { r in
            seen = r
            return r.string("format") == "rows" ? .success(.object(["format": "rows", "text": .string(rowsText)])) : .success(.object(["tree": .null]))
        }
        let r = s.handle(#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"snapshot","arguments":{"window":5}}}"#).flatMap(JSONValue.parse)
        XCTAssertEqual(seen?.string("format"), "rows")
        XCTAssertEqual(r?["result"]?["content"]?.array?.first?["text"]?.string, rowsText)
        let j = s.handle(#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"snapshot","arguments":{"window":5,"format":"json"}}}"#).flatMap(JSONValue.parse)
        let text = try XCTUnwrap(j?["result"]?["content"]?.array?.first?["text"]?.string)
        XCTAssertNotNil(HandsEnvelope.decode(text)?.data?["tree"], "json stays the envelope")
    }

    func testAnErrorCarriesItsNextCallInTheEnvelope() throws {
        let e = HandsError(.staleBareRow, "row 2 means two things", suggestion: "use next_call", nextCall: HandsError.call("click", ["ref": "@sNew:e2"]))
        let line = HandsEnvelope.failure(e).line
        XCTAssertTrue(line.contains(#""next_call":{"arguments":{"ref":"@sNew:e2"},"tool":"click"}"#), line)
        XCTAssertEqual(HandsEnvelope.decode(line)?.error?.nextCall?["tool"]?.string, "click")
        XCTAssertFalse(HandsEnvelope.failure(HandsError(.timeout, "slow", suggestion: "wait")).line.contains("next_call"), "absent when there is none")
    }

    // Review r1 first-F1: a since read renumbers rows (old [1] OK, new [1] Delete); a bare number after it must not act.
    func testAfterASinceReadABareNumberIsRefusedAndTheNextCallIsARead() throws {
        var m = SnapshotRowsMemory()
        let t = Date()
        m.remember(session: "a", window: 9, view: "v", snapshot: "sOld", rows: rows(["OK", "Cancel"]), now: t.addingTimeInterval(-SnapshotRowsMemory.horizon - 5))
        m.remember(session: "a", window: 9, view: "v", snapshot: "sNew", rows: rows(["Delete", "OK", "Cancel"]), now: t, listed: false)
        guard case .refused(let code, let message, let latest) = m.resolve(bare: 2, session: "a", now: t) else { return XCTFail("click 2 after a since read must not act") }
        XCTAssertEqual(code, .staleBareRow)
        let e = SnapshotRowsMemory.error(code, message, latest: latest)
        XCTAssertEqual(e.retry, .afterSnapshot)
        XCTAssertEqual(e.nextCall, HandsError.call("snapshot", ["window": 9]), "a read, never the click on a guessed row")
        // The disagreeing-snapshots refusal reads too.
        var n = SnapshotRowsMemory()
        n.remember(session: "a", window: 9, view: "v", snapshot: "sOld", rows: rows(["OK", "Cancel"]), now: t)
        n.remember(session: "a", window: 9, view: "v", snapshot: "sNew", rows: rows(["Delete", "OK", "Cancel"]), now: t)
        guard case .refused(let c2, let m2, let l2) = n.resolve(bare: 2, session: "a", now: t) else { return XCTFail("stale") }
        XCTAssertEqual(SnapshotRowsMemory.error(c2, m2, latest: l2).nextCall?["tool"]?.string, "snapshot")
        // A full read afterwards makes its numbers good again.
        m.remember(session: "a", window: 9, view: "v", snapshot: "sFull", rows: rows(["Delete", "OK", "Cancel"]), now: t)
        XCTAssertEqual(m.resolve(bare: 2, session: "a", now: t), .ref("@sFull:e2"))
    }

    // Review r1 second-F5: huge or infinite decimal strings print as read instead of trapping.
    func testHugeAndInfiniteDecimalValuesPrintAsRead() {
        for v in ["1.180591620717e21", "99999999999999999999.5", "1.0e999", "-1.5e20", "9223372036854775808.0"] {
            XCTAssertEqual(SnapshotRows.shownValue(v), v)
        }
        XCTAssertEqual(SnapshotRows.shownValue("0.18518517911434174"), "0.19")
        XCTAssertEqual(SnapshotRows.shownValue("1.0"), "1")
        XCTAssertEqual(SnapshotRows.shownValue("-0.001"), "0")
        let tree: JSONValue = .object(["role": "window", "children": .array([.object(["role": "statictext", "name": "Result", "value": "1.0e999", "ref_id": "@s:e1"])])])
        XCTAssertEqual(SnapshotRows.rows(of: tree).first?.line, "[1] statictext \"Result\" =1.0e999")
    }

    // Review r1 first-F2: a since read keeps the notes.
    func testASinceReadPrintsItsNotes() {
        let r = rows(["OK"])
        let none = SnapshotRows.renderSince([], new: r, snapshot: "sB", previous: "sA", window: 9, notes: ["a sheet is up on this window and blocks it"], query: nil)
        XCTAssertTrue(none.hasSuffix("\nnote: a sheet is up on this window and blocks it"), none)
        let some = SnapshotRows.renderSince([.added(r[0])], new: r, snapshot: "sB", previous: "sA", window: 9, notes: ["the read stopped before the end of the tree"], query: nil)
        XCTAssertTrue(some.contains("\nnote: the read stopped before the end of the tree\n+ [1] button \"OK\""), some)
    }

    // Review r1 second-F6: the truncated line's call keeps the query.
    func testTheTruncatedCallKeepsTheQuery() throws {
        let text = full(try load("system-information"), app: "System Information", query: "textfield", max: 20)
        let last = try XCTUnwrap(text.split(separator: "\n").last)
        XCTAssertTrue(last.contains(#"{"window":54978,"query":"textfield","max_elements":"#), String(last))
        XCTAssertFalse(last.contains("<a word"), String(last))
    }

    // Review r1 first-F3: Calculator's display is named by its content; a new number is a change, not a remove and an add.
    func testAnElementNamedByItsContentChangesInPlace() {
        func tree(_ shown: String) -> JSONValue {
            .object(["role": "window", "children": .array([.object(["role": "scrollarea", "ref_id": "@s:e1", "children": .array([
                .object(["role": "statictext", "name": .string(shown), "value": .string(shown)])])])])])
        }
        let a = SnapshotRows.rows(of: tree("0")), b = SnapshotRows.rows(of: tree("1.180591620717e21"))
        let c = SnapshotRows.changes(from: a, to: b)
        XCTAssertEqual(c.count, 1, "\(c)")
        guard case .changed(let r) = c.first else { return XCTFail("\(c)") }
        XCTAssertEqual(r.name, "1.180591620717e21")
    }

    // Review r2 first-F1: the full re-read that next_call asks for clears the refusal, even with the older read in the horizon.
    func testTheReReadNextCallAsksForClearsTheRefusal() {
        var m = SnapshotRowsMemory()
        let t = Date()
        m.remember(session: "a", window: 9, view: "v", snapshot: "sOld", rows: rows(["OK", "Cancel"]), now: t)
        m.remember(session: "a", window: 9, view: "v", snapshot: "sNew", rows: rows(["Delete", "OK", "Cancel"]), now: t)
        XCTAssertEqual(m.resolve(bare: 2, session: "a", now: t).code, .staleBareRow)
        m.remember(session: "a", window: 9, view: "v", snapshot: "sFull", rows: rows(["Delete", "OK", "Cancel"]), now: t)
        XCTAssertEqual(m.resolve(bare: 2, session: "a", now: t), .ref("@sFull:e2"))
        // A since read is not that re-read.
        XCTAssertEqual(m.resolve(bare: 9, session: "a", now: t).code, .unknownRef)
        m.remember(session: "a", window: 9, view: "v", snapshot: "sSince", rows: rows(["Delete", "OK"]), now: t, listed: false)
        XCTAssertEqual(m.resolve(bare: 2, session: "a", now: t).code, .staleBareRow)
    }

    // Review r2 second-S1 and first-F2: a since read with a query keeps the baseline, and a cut read's numbers aren't bare numbers.
    func testWhatAReadCountsAs() {
        XCTAssertEqual(SnapshotRowsMemory.kind(since: true, query: "Save", rows: 3, max: nil).baseline, false)
        XCTAssertEqual(SnapshotRowsMemory.kind(since: true, query: nil, rows: 3, max: nil).baseline, true)
        XCTAssertEqual(SnapshotRowsMemory.kind(since: false, query: nil, rows: 401, max: nil).listed, false)
        XCTAssertEqual(SnapshotRowsMemory.kind(since: false, query: nil, rows: 11, max: 10).listed, false)
        XCTAssertEqual(SnapshotRowsMemory.kind(since: false, query: nil, rows: 10, max: 10).listed, true)
        XCTAssertEqual(SnapshotRowsMemory.kind(since: false, query: " ", rows: 10, max: nil).listed, true)
        var m = SnapshotRowsMemory()
        let t = Date()
        m.remember(session: "a", window: 9, view: "v", snapshot: "s1", rows: rows(["OK"]), now: t)
        m.remember(session: "a", window: 9, view: "v", snapshot: "s2", rows: rows(["OK", "Replace"]), now: t, listed: false, baseline: false)
        let base = m.previous(session: "a", window: 9, view: "v")
        XCTAssertEqual(base?.snapshot, "s1", "the query hid Replace, so the next since read still compares with s1")
        XCTAssertEqual(SnapshotRows.changes(from: base?.rows ?? [], to: rows(["OK", "Replace"])).map(\.row.name), ["Replace"])
    }

    // Review r2 second-S2: the truncated call reads the same view.
    func testTheTruncatedCallRepeatsTheView() throws {
        let d = try load("calculator")
        let text = SnapshotRows.render(SnapshotRows.rows(of: d["tree"] ?? .null), snapshot: "s", window: 5, title: "", app: "", refs: 0,
                                       query: nil, max: 3, also: #","interactive":true,"depth":4"#)
        XCTAssertTrue(text.hasSuffix(#"{"window":5,"interactive":true,"depth":4,"query":"<a word from the row you want>"}"#), text)
        XCTAssertTrue(text.contains(#"{"window":5,"interactive":true,"depth":4,"max_elements":"#), text)
    }
}

private extension SnapshotRowsMemory.Bare {
    var code: HandsErrorCode? { if case .refused(let c, _, _) = self { return c }; return nil }
}
