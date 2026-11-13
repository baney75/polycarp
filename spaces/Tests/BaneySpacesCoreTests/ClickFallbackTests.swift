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
        let key = try XCTUnwrap(rows.first { $0.number == 2 }?.key)
        let want = ClickFallback.Plan(container: "@\(sid):e2", label: "Bluetooth", itemRole: "treeitem", containerKey: key)
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

    func tree(_ children: [JSONValue]) -> [SnapshotRows.Row] {
        SnapshotRows.rows(of: .object(["role": "window", "children": .array(children)]))
    }
    func node(_ role: String, _ name: String, _ n: Int, states: [String] = [], _ kids: [JSONValue] = []) -> JSONValue {
        .object(["role": .string(role), "name": .string(name), "ref_id": .string("@s:e\(n)"), "states": .array(states.map(JSONValue.string)), "children": .array(kids)])
    }

    // Review r1 first-F1: a control inside a row does what it is pressed for; no selection write follows it.
    func testAControlInsideARowKeepsThePlainPress() throws {
        let rows = tree([node("table", "", 1, [node("row", "", 2, [node("checkbox", "Wi-Fi on", 3), node("statictext", "Wi-Fi", 4)]),
                                               node("row", "", 5, [node("cell", "", 6, [node("button", "Info", 7)])])])])
        XCTAssertNil(ClickFallback.plan(rows: rows, snapshot: "s", number: 3), "the checkbox")
        XCTAssertNil(ClickFallback.plan(rows: rows, snapshot: "s", number: 7), "a button in a cell")
        XCTAssertEqual(ClickFallback.plan(rows: rows, snapshot: "s", number: 4)?.itemRole, "row", "the row's text still falls back")
        // 166 r2 first-F1: the label is the row's text, not the checkbox's name before it.
        XCTAssertEqual(ClickFallback.plan(rows: rows, snapshot: "s", number: 4)?.label, "Wi-Fi")
        let triangle = tree([node("outline", "", 1, [node("row", "", 2, [node("disclosuretriangle", "Expand", 3), node("cell", "", 4, [node("statictext", "Mail", 5)])])])])
        XCTAssertEqual(ClickFallback.plan(rows: triangle, snapshot: "s", number: 5)?.label, "Mail", "a named triangle is skipped")
    }

    // Review r1 first-F3: selection is the row's, so a cell's click reads and writes it on the row.
    func testACellResolvesToItsRow() throws {
        let rows = tree([node("table", "", 1, [node("row", "", 2, states: ["selected"], [node("cell", "", 3, [node("statictext", "Draft", 4)])])])])
        let plan = try XCTUnwrap(ClickFallback.plan(rows: rows, snapshot: "s", number: 3))
        XCTAssertEqual(plan.itemRole, "row")
        XCTAssertEqual(plan.label, "Draft")
        XCTAssertEqual(ClickFallback.plan(rows: rows, snapshot: "s", number: 4), plan)
        XCTAssertEqual(ClickFallback.selected(rows, plan), true, "the row's selected state, not the cell's")
    }

    // 166 r2 second-F6: a cell with no row above it is the item.
    func testACellWithNoRowIsTheItem() throws {
        let rows = tree([node("table", "", 1, [node("cell", "", 2, [node("statictext", "Draft", 3)]), node("cell", "", 4, [node("statictext", "Sent", 5)])])])
        let plan = try XCTUnwrap(ClickFallback.plan(rows: rows, snapshot: "s", number: 3))
        XCTAssertEqual(plan.itemRole, "cell")
        XCTAssertEqual(plan.label, "Draft")
        XCTAssertEqual(plan.container, "@s:e1")
        XCTAssertNil(ClickFallback.plan(rows: rows, snapshot: "s", number: 1), "the table itself")
    }

    // Review r1 second-F8: two collections with a row of the same name; the readback stays in the clicked one.
    func testTheReadbackStaysInTheContainerThePlanCameFrom() throws {
        func window(sidebar: Bool, list: Bool) -> [SnapshotRows.Row] {
            tree([node("outline", "Sidebar", 1, [node("treeitem", "Documents", 2, states: sidebar ? ["selected"] : [])]),
                  node("list", "Files", 3, [node("row", "Documents", 4, states: list ? ["selected"] : [])])])
        }
        let plan = try XCTUnwrap(ClickFallback.plan(rows: window(sidebar: true, list: false), snapshot: "s", number: 4))
        XCTAssertEqual(ClickFallback.selected(window(sidebar: true, list: false), plan), false)
        XCTAssertEqual(ClickFallback.selected(window(sidebar: false, list: true), plan), true)
        let two = tree([node("list", "Files", 3, [node("row", "Documents", 4)]), node("outline", "Sidebar", 1, [node("row", "Documents", 2, states: ["selected"])])])
        XCTAssertEqual(ClickFallback.selected(two, plan), false, "a same-named row elsewhere is never read")
    }

    // Review r1 first-F4: with no readback, the press's own evidence decides, as on the plain path.
    func testWithNoReadbackThePressEvidenceDecides() {
        typealias C = ClickFallback
        XCTAssertTrue(C.verified(landed: .none, afterPress: nil, engineVerified: true, treeChanged: false))
        XCTAssertTrue(C.verified(landed: .none, afterPress: nil, engineVerified: false, treeChanged: true))
        XCTAssertFalse(C.verified(landed: .none, afterPress: nil, engineVerified: false, treeChanged: false))
        XCTAssertFalse(C.verified(landed: .none, afterPress: false, engineVerified: true, treeChanged: true), "a readback that says not selected wins")
        XCTAssertTrue(C.verified(landed: .press, afterPress: true, engineVerified: false, treeChanged: false))
    }

    // Review r1 second-F9 and first-F5: a refused write keeps its code for the next call; a failed write is said.
    func testARefusedOrFailedWriteIsReported() throws {
        XCTAssertEqual(ClickFallback.nextCode(verified: false, writeError: .inUse), .inUse)
        XCTAssertEqual(ClickFallback.nextCode(verified: false, writeError: .outsideAgentWorkspace), .outsideAgentWorkspace)
        XCTAssertEqual(ClickFallback.nextCode(verified: false, writeError: nil), .unverified)
        XCTAssertNil(ClickFallback.nextCode(verified: true, writeError: nil))
        let e = ClickFallback.failure(press: HandsError(.actionFailed, "no press", suggestion: ""), write: HandsError(.actionFailed, "no write", suggestion: ""))
        XCTAssertTrue(e.message.contains("selection write was tried too and failed: no write"), e.message)
        // 166 r2 first-F3: a refused write answers with the refusal, so its code decides the next call.
        let r = ClickFallback.failure(press: HandsError(.actionFailed, "no press", suggestion: ""), write: HandsError(.outsideAgentWorkspace, "moved", suggestion: ""), refused: true)
        XCTAssertEqual(r.code, .outsideAgentWorkspace)
        XCTAssertTrue(r.message.contains("the press had failed first: no press"), r.message)
        // 166 r2 first-F4: a failed press is reported on a click that still answers.
        XCTAssertEqual(ClickFallback.pressError(HandsError(.actionFailed, "no press", suggestion: "")), .object(["code": "action_failed", "message": "no press"]))
        XCTAssertNil(ClickFallback.pressError(nil))
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+RowClick.swift")
        XCTAssertFalse(src.contains("acting() == nil else { break }"))
        XCTAssertTrue(src.contains("if let e = acting() { writeError = e; refused = true; break }"))
        XCTAssertTrue(src.contains("write: writeError, refused: refused"))
        XCTAssertTrue(src.contains("o[\"press_error\"] = e"))
    }

    // Review r1 first-F2: a bare row number names its window for the next call.
    func testABareRowNumberNamesItsWindow() throws {
        let w = RefWindow.of(window: nil, ref: "12", bare: { $0 == 12 ? "@sx:e12" : nil }, snapshotWindow: { $0 == "sx" ? 4211 : nil })
        XCTAssertEqual(w, 4211)
        XCTAssertEqual(RefWindow.of(window: nil, ref: "@sx:e3", bare: { _ in nil }, snapshotWindow: { _ in 4211 }), 4211)
        XCTAssertEqual(RefWindow.of(window: 9, ref: "12", bare: { _ in nil }, snapshotWindow: { _ in nil }), 9)
        XCTAssertNil(RefWindow.of(window: nil, ref: "12", bare: { _ in nil }, snapshotWindow: { _ in 1 }))
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(src.contains("RefWindow.of(window: req.int(\"window\"), ref: req.string(\"ref\")"))
        // first-F7: a row click skips the plain path's full read before.
        XCTAssertTrue(src.contains("if !writes, kind != .toggle, plan == nil, case .success"))
    }

    // 166 r2 first-F2 (and 187 r1 second-F5): a plan from an interactive or compact read keeps that view, and the readbacks read in it, so row keys match.
    func testTheReadbackReadsInTheViewThePlanCameFrom() throws {
        var m = SnapshotRowsMemory()
        m.remember(session: "a", window: 7, view: "false|true|6", snapshot: "sc", rows: [], now: Date())
        m.remember(session: "a", window: 7, view: "false|false|10", snapshot: "sf", rows: [], now: Date())
        XCTAssertEqual(m.read(snapshot: "sc", session: "a")?.view, SnapshotRowsMemory.View(interactive: false, compact: true, depth: 6))
        XCTAssertEqual(m.read(snapshot: "sf", session: "a")?.view, .full)
        XCTAssertEqual(SnapshotRowsMemory.View(key: "true|false|3"), SnapshotRowsMemory.View(interactive: true, compact: false, depth: 3))
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains("p.view = read.view"), "the plan carries its read's view")
        let row = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter+RowClick.swift")
        XCTAssertTrue(row.contains("interactive: plan.view.interactive, compact: plan.view.compact"), "the readbacks use it")
        XCTAssertFalse(row.contains("compact: false, depth: 10"))
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
