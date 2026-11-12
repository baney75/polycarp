import XCTest
@testable import BaneySpacesCore

/// Item 3 over a recorded outline: System Information's sidebar, where a press on a row never selected it (8 of 8) and a
/// select on the outline did.
final class ClickFallbackTests: XCTestCase {
    func outline() throws -> (rows: [SnapshotRows.Row], sid: String, tree: JSONValue) {
        let url = Repo.root.appendingPathComponent("Tests/BaneySpacesCoreTests/Fixtures/snapshots/system-information.json")
        let d = try XCTUnwrap(JSONValue.parse(try Data(contentsOf: url)))
        let tree = d["tree"] ?? .null
        return (SnapshotRows.rows(of: tree), d["snapshot_id"]?.string ?? "", tree)
    }

    func testARowInTheOutlineWritesTheSelectionOnTheOutlineByItsLabel() throws {
        let (rows, sid, _) = try outline()
        let want = ClickFallback.Plan(container: "@\(sid):e2", label: "Bluetooth", itemRole: "treeitem")
        XCTAssertEqual(ClickFallback.plan(rows: rows, snapshot: sid, number: 12), want, "the row")
        XCTAssertEqual(ClickFallback.plan(rows: rows, snapshot: sid, number: 13), want, "the text field in the row")
        XCTAssertNil(ClickFallback.plan(rows: rows, snapshot: sid, number: 1), "the scroll area is no item")
        XCTAssertNil(ClickFallback.plan(rows: rows, snapshot: sid, number: 2), "nor the outline itself")
        XCTAssertNil(ClickFallback.plan(rows: rows, snapshot: sid, number: 9999))
    }

    func testAButtonOrASharedLabelNeverFallsBack() throws {
        func tree(_ children: [JSONValue]) -> [SnapshotRows.Row] {
            SnapshotRows.rows(of: .object(["role": "window", "children": .array(children)]))
        }
        let button = tree([.object(["role": "button", "name": "7", "ref_id": "@s:e1"])])
        XCTAssertNil(ClickFallback.plan(rows: button, snapshot: "s", number: 1))
        let twice = tree([.object(["role": "table", "ref_id": "@s:e1", "children": .array([
            .object(["role": "row", "name": "Draft", "ref_id": "@s:e2"]), .object(["role": "row", "name": "Draft", "ref_id": "@s:e3"])])])])
        XCTAssertNil(ClickFallback.plan(rows: twice, snapshot: "s", number: 3), "the write picks by label, so a shared one could pick the other row")
        let loose = tree([.object(["role": "row", "name": "Draft", "ref_id": "@s:e1"])])
        XCTAssertNil(ClickFallback.plan(rows: loose, snapshot: "s", number: 1), "no container to write on")
    }

    func testTheSelectionIsReadBackFromALaterRead() throws {
        let (rows, sid, tree) = try outline()
        let hardware = try XCTUnwrap(ClickFallback.plan(rows: rows, snapshot: sid, number: 3))
        let bluetooth = try XCTUnwrap(ClickFallback.plan(rows: rows, snapshot: sid, number: 12))
        XCTAssertEqual(ClickFallback.selected(rows, hardware), true)
        XCTAssertEqual(ClickFallback.selected(rows, bluetooth), false)
        // The same window after the selection moved: the later read's numbers don't matter, the label does.
        let moved = SnapshotRows.rows(of: Self.select(tree, label: "Bluetooth"))
        XCTAssertEqual(ClickFallback.selected(moved, bluetooth), true)
        XCTAssertEqual(ClickFallback.selected(moved, hardware), false)
        XCTAssertNil(ClickFallback.selected([], bluetooth), "not in the read: unknown, never false")
    }

    /// Never both: the write only when the readback after the press shows the item not selected.
    func testTheWriteFollowsOnlyAPressThatDidNotSelect() {
        typealias C = ClickFallback
        XCTAssertEqual(C.afterPress(before: false, after: true, pressError: nil), .done(.press))
        XCTAssertEqual(C.afterPress(before: true, after: true, pressError: nil), .done(.alreadySelected))
        XCTAssertEqual(C.afterPress(before: false, after: true, pressError: .timeout), .done(.press), "the readback wins")
        XCTAssertEqual(C.afterPress(before: false, after: false, pressError: nil), .writeSelection)
        XCTAssertEqual(C.afterPress(before: false, after: false, pressError: .actionFailed), .writeSelection)
        XCTAssertEqual(C.afterPress(before: false, after: false, pressError: .notSupported), .writeSelection)
        XCTAssertEqual(C.afterPress(before: false, after: false, pressError: .timeout), .done(.none), "it may still land")
        XCTAssertEqual(C.afterPress(before: false, after: false, pressError: .outsideAgentWorkspace), .done(.none))
        XCTAssertEqual(C.afterPress(before: nil, after: nil, pressError: nil), .done(.none), "no readback, no write")
    }

    /// Every error code has a next call that is a read, or an explicit none.
    func testEveryErrorCodeMapsToAReadOrNone() {
        let reads: Set<String> = ["windows", "snapshot", "find", "get", "workspaces"]
        for code in HandsErrorCode.allCases {
            for window in [5, nil] as [Int?] {
                let call = HandsNextCall.after(code, window: window)
                if call == .null { continue }
                let tool = call["tool"]?.string ?? ""
                XCTAssertTrue(reads.contains(tool), "\(code) -> \(tool)")
                XCTAssertNotNil(call["arguments"]?.object, "\(code)")
                if tool == "snapshot" { XCTAssertEqual(call["arguments"]?["window"]?.int, window, "\(code)") }
            }
        }
        XCTAssertEqual(HandsNextCall.after(.timeout, window: 5), HandsError.call("snapshot", ["window": 5, "since": "latest"]))
        XCTAssertEqual(HandsNextCall.after(.needsLend, window: 5), .null)
        let none = HandsNextCall.fill(.failure(HandsError(.needsLend, "lend it", suggestion: "ask")), window: 5).line
        XCTAssertTrue(none.contains(#""next_call":null"#), "none is said, not left out: \(none)")
        let kept = HandsError(.staleBareRow, "x", suggestion: "y", nextCall: HandsError.call("snapshot", ["window": 9]))
        XCTAssertEqual(HandsNextCall.fill(.failure(kept), window: 5).error?.nextCall, kept.nextCall, "a next call already there stays")
    }

    func testMCPErrorsCarryTheirNextCall() throws {
        let s = HandsMCP(version: "1", session: "mcp:1") { _ in .failure(HandsError(.staleRef, "gone", suggestion: "snapshot")) }
        let r = s.handle(#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"snapshot","arguments":{"window":7}}}"#).flatMap(JSONValue.parse)
        let text = try XCTUnwrap(r?["result"]?["content"]?.array?.first?["text"]?.string)
        XCTAssertEqual(HandsEnvelope.decode(text)?.error?.nextCall, HandsError.call("snapshot", ["window": 7]))
        let bad = s.handle(#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"snapshot","arguments":{"window":7,"format":"xml"}}}"#).flatMap(JSONValue.parse)
        XCTAssertTrue(bad?["result"]?["content"]?.array?.first?["text"]?.string?.contains(#""next_call":null"#) == true, "a bad argument: none")
    }

    /// The tree with only the item labeled `label` selected.
    static func select(_ n: JSONValue, label: String) -> JSONValue {
        guard case .object(var o) = n else { return n }
        var states = (o["states"]?.array ?? []).filter { $0 != "selected" }
        if o["role"]?.string == "treeitem", (o["children"]?.array ?? []).contains(where: { $0["value"]?.string == label }) { states.append("selected") }
        if o["states"] != nil || states.contains("selected") { o["states"] = .array(states) }
        if let kids = o["children"]?.array { o["children"] = .array(kids.map { select($0, label: label) }) }
        return .object(o)
    }
}
