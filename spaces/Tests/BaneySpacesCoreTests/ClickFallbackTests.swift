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
        // 194 r1 first-F1: a refusal is known by its code, whichever check made it.
        let r = ClickFallback.failure(press: HandsError(.actionFailed, "no press", suggestion: ""), write: HandsError(.outsideAgentWorkspace, "moved", suggestion: ""))
        XCTAssertEqual(r.code, .outsideAgentWorkspace)
        XCTAssertTrue(r.message.contains("the press had failed first: no press"), r.message)
        // 166 r2 first-F4: a failed press is reported on a click that still answers.
        XCTAssertEqual(ClickFallback.pressError(HandsError(.actionFailed, "no press", suggestion: "")), .object(["code": "action_failed", "message": "no press"]))
        XCTAssertNil(ClickFallback.pressError(nil))
        for code in [HandsErrorCode.inUse, .permissionDenied, .staleRef, .needsLend] {
            XCTAssertEqual(ClickFallback.failure(press: HandsError(.actionFailed, "p", suggestion: ""), write: HandsError(code, "w", suggestion: "")).code, code, "\(code)")
        }
        XCTAssertEqual(ClickFallback.failure(press: HandsError(.actionFailed, "p", suggestion: ""), write: HandsError(.timeout, "w", suggestion: "")).code, .actionFailed, "the engine's own failure")
    }

    /// 194 r1 first-F5 and first-F4: the click's answer, by value, from what its transaction saw.
    func testTheClickAnswersFromWhatItsTransactionSaw() throws {
        let plan = ClickFallback.Plan(container: "@s:e1", label: "Draft", itemRole: "row", containerKey: "k")
        var run = ClickFallback.Run()
        run.before = false; run.afterPress = false
        run.pressError = HandsError(.actionFailed, "no press", suggestion: ""); run.writeError = HandsError(.inUse, "his now", suggestion: "")
        guard case .failure(let e) = ClickFallback.answer(run, ref: "@s:e2", plan: plan, window: 9) else { return XCTFail("nothing ran") }
        XCTAssertEqual(e.code, .inUse, "the refusal is the error when the press failed too")
        run.pressError = nil; run.press = .object([:])
        let ok = try ClickFallback.answer(run, ref: "@s:e2", plan: plan, window: 9).get()
        XCTAssertEqual(ok["verified"], .bool(false))
        XCTAssertEqual(ok["selection_write"]?["code"], "in_use", "a press that ran: the refusal is said, not the error")
        XCTAssertEqual(ok["next_call"], HandsNextCall.after(.inUse, window: 9))
        var wrote = ClickFallback.Run()
        wrote.before = false; wrote.afterPress = false; wrote.afterWrite = true; wrote.landed = .selectionWrite
        wrote.pressError = HandsError(.actionFailed, "no press", suggestion: ""); wrote.write = .object([:])
        let w = try ClickFallback.answer(wrote, ref: "@s:e2", plan: plan, window: 9).get()
        XCTAssertEqual(w["landed"], "selection_write")
        XCTAssertEqual(w["press_error"]?["code"], "action_failed")
        XCTAssertNil(w["next_call"])
        XCTAssertEqual(w["evidence"]?["selected_after_write"], .bool(true))
    }

    /// 194 r1 second-F6: a row the read hid still holds the selection of the cells it moved up.
    func testAHiddenRowHoldsItsCellsSelection() throws {
        func window(selected: Bool) -> [SnapshotRows.Row] {
            SnapshotRows.rows(of: .object(["role": "window", "children": .array([node("table", "", 1, [
                .object(["role": "row", "states": .array(selected ? ["selected"] : []), "children": .array([node("cell", "", 2, [node("statictext", "Draft", 3)])])]),
                .object(["role": "row", "children": .array([node("cell", "", 4, [node("statictext", "Sent", 5)])])])])])]))
        }
        let plan = try XCTUnwrap(ClickFallback.plan(rows: window(selected: false), snapshot: "s", number: 3))
        XCTAssertEqual(plan.itemRole, "cell")
        XCTAssertEqual(ClickFallback.selected(window(selected: false), plan), false)
        XCTAssertEqual(ClickFallback.selected(window(selected: true), plan), true, "the row's state, though the read hid the row")
        XCTAssertEqual(ClickFallback.afterPress(before: false, after: ClickFallback.selected(window(selected: true), plan), pressError: nil), .done(.press), "no write after a press that selected it")
    }

    /// 203 r1 first-F1: under a hidden, unselected item, a shown item's own selected state (an outline's child row, a
    /// cell a table selects by) still counts, so a press that selected it is never followed by the write.
    func testAnItemsOwnSelectionCountsUnderAHiddenUnselectedItem() throws {
        func outline(selected: Bool) -> [SnapshotRows.Row] {
            SnapshotRows.rows(of: .object(["role": "window", "children": .array([node("outline", "", 1, [
                .object(["role": "treeitem", "children": .array([
                    .object(["role": "treeitem", "name": "Child", "ref_id": "@s:e2", "states": .array(selected ? ["selected"] : [])])])])])])]))
        }
        let child = try XCTUnwrap(ClickFallback.plan(rows: outline(selected: false), snapshot: "s", number: 2))
        XCTAssertEqual(ClickFallback.selected(outline(selected: true), child), true)
        XCTAssertEqual(ClickFallback.selected(outline(selected: false), child), false)
        func table(selected: Bool) -> [SnapshotRows.Row] {
            SnapshotRows.rows(of: .object(["role": "window", "children": .array([node("table", "", 1, [
                .object(["role": "row", "children": .array([.object(["role": "cell", "ref_id": "@s:e2", "states": .array(selected ? ["selected"] : []),
                                                                      "children": .array([node("statictext", "Draft", 3)])])])])])])]))
        }
        let cell = try XCTUnwrap(ClickFallback.plan(rows: table(selected: false), snapshot: "s", number: 3))
        XCTAssertEqual(ClickFallback.selected(table(selected: true), cell), true, "the cell the table selects by")
        XCTAssertEqual(ClickFallback.afterPress(before: false, after: ClickFallback.selected(outline(selected: true), child), pressError: nil), .done(.press))
    }

    /// 224 r1 first-F1: a selected hidden parent doesn't make its shown, unselected child read selected, so a press that
    /// didn't select the child is followed by the write.
    func testASelectedHiddenParentDoesNotSelectItsChild() throws {
        func outline(child: Bool) -> [SnapshotRows.Row] {
            SnapshotRows.rows(of: .object(["role": "window", "children": .array([node("outline", "", 1, [
                .object(["role": "treeitem", "states": .array(["selected"]), "children": .array([
                    .object(["role": "treeitem", "name": "Child", "ref_id": "@s:e2", "states": .array(child ? ["selected"] : [])])])])])])]))
        }
        let plan = try XCTUnwrap(ClickFallback.plan(rows: outline(child: false), snapshot: "s", number: 2))
        let before = ClickFallback.selected(outline(child: false), plan)
        XCTAssertEqual(before, false)
        XCTAssertEqual(ClickFallback.selected(outline(child: true), plan), true)
        XCTAssertEqual(ClickFallback.afterPress(before: before, after: before, pressError: nil), .writeSelection)
    }

    /// 224 r1 second-F3: the 224 entry says what it covers, is pinned, untested live, and per platform.
    func testThe224EntrySaysItsLimits() throws {
        let log = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("CHANGELOG.md"), encoding: .utf8)
        let entry = try XCTUnwrap(log.split(separator: "\n").first { $0.contains("never undone by a write") })
        XCTAssertTrue(entry.hasSuffix("Pinned by `ClickFallbackTests`. Untested live. Linux and Windows: the press only, unchanged."))
        XCTAssertFalse(entry.contains("remembered only by its view"))
    }

    /// 203 r1 first-F2: a container whose ref is no good now gets no plan (the click is the plain press); a good one keeps
    /// the read's view for the readbacks.
    func testAContainerRefThatIsNoGoodNowFallsBackToThePlainPress() throws {
        var m = SnapshotRowsMemory()
        let rows = SnapshotRows.rows(of: .object(["role": "window", "children": .array([node("table", "", 1, [node("row", "Draft", 2)])])]))
        let compact = SnapshotRowsMemory.View(interactive: false, compact: true, depth: 6)
        m.remember(session: "a", window: 7, view: compact, snapshot: "s", rows: rows, now: Date())
        let read = try XCTUnwrap(m.read(snapshot: "s", session: "a"))
        var asked: [String] = []
        XCTAssertNil(ClickFallback.plan(read: read, snapshot: "s", number: 2, usable: { asked.append($0); return false }))
        XCTAssertEqual(asked, ["@s:e1"], "the container's ref is the one checked")
        let p = try XCTUnwrap(ClickFallback.plan(read: read, snapshot: "s", number: 2, usable: { _ in true }))
        XCTAssertEqual(p.container, "@s:e1")
        XCTAssertEqual(p.view, compact)
        XCTAssertNil(ClickFallback.plan(read: read, snapshot: "s", number: 1, usable: { _ in true }), "the container itself is no item")
    }

    /// 194 r1 first-F3: with no text under the row, a named group or image labels it.
    func testANamedGroupOrImageLabelsARowWithNoText() {
        let group = tree([node("outline", "", 1, [node("row", "", 2, [node("group", "Inbox", 3, [node("image", "", 4)])])])])
        XCTAssertEqual(ClickFallback.plan(rows: group, snapshot: "s", number: 4)?.label, "Inbox")
        let image = tree([node("outline", "", 1, [node("row", "", 2, [node("image", "Downloads", 3)])])])
        XCTAssertEqual(ClickFallback.plan(rows: image, snapshot: "s", number: 3)?.label, "Downloads")
        let both = tree([node("outline", "", 1, [node("row", "", 2, [node("image", "folder", 3), node("statictext", "Projects", 4)])])])
        XCTAssertEqual(ClickFallback.plan(rows: both, snapshot: "s", number: 3)?.label, "Projects", "text first")
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
        // 187 r1 first-F3, 192 r1 first-F6: the bare number is resolved once, before handle, which gets the full ref; the
        // next call's window reads that, also for a call refused before it acts. Never a second resolve.
        let of = try XCTUnwrap(HandsSourceTests.block(after: "private func windowOf(_ req: HandsRequest) -> Int?", in: src))
        XCTAssertFalse(of.contains("bareRef("), "no second resolve")
        let wire = try XCTUnwrap(HandsSourceTests.block(after: "func handleWire(_ r: Wire.Request)", in: src))
        XCTAssertTrue(wire.contains("case .success(let full) = bareRef(n, req) { resolved.args[\"ref\"] = .string(full) }"))
        XCTAssertTrue(wire.contains("handle(resolved), window: windowOf(resolved)"))
    }

    // 166 r2 first-F2 (and 187 r1 second-F5): a plan from an interactive or compact read keeps that view, and the readbacks read in it, so row keys match.
    func testTheReadbackReadsInTheViewThePlanCameFrom() throws {
        var m = SnapshotRowsMemory()
        m.remember(session: "a", window: 7, view: .init(key: "false|true|6"), snapshot: "sc", rows: [], now: Date())
        m.remember(session: "a", window: 7, view: .full, snapshot: "sf", rows: [], now: Date())
        XCTAssertEqual(m.read(snapshot: "sc", session: "a")?.view, SnapshotRowsMemory.View(interactive: false, compact: true, depth: 6))
        XCTAssertEqual(m.read(snapshot: "sf", session: "a")?.view, .full)
        XCTAssertEqual(SnapshotRowsMemory.View(key: "true|false|3"), SnapshotRowsMemory.View(interactive: true, compact: false, depth: 3))
        // 194 r1 first-F2: the view the router keys a read by is built from the request, and parses back to itself.
        for args in [[:], ["interactive": true, "depth": 4], ["compact": true], ["interactive": true, "compact": true, "depth": 25]] as [[String: JSONValue]] {
            let v = SnapshotRowsMemory.View.of(HandsRequest(verb: "snapshot", args: args))
            XCTAssertEqual(SnapshotRowsMemory.View(key: v.key), v, "\(args)")
        }
        XCTAssertEqual(SnapshotRowsMemory.View.of(HandsRequest(verb: "snapshot", args: ["interactive": true, "depth": 4])), .init(interactive: true, compact: false, depth: 4))
        // A find reads compact and keeps that view, though it is remembered by its own name.
        m.remember(session: "a", window: 7, view: .find, as: "find", snapshot: "sx", rows: [], now: Date())
        XCTAssertEqual(m.read(snapshot: "sx", session: "a")?.view, .init(interactive: false, compact: true, depth: 10))
        XCTAssertNotNil(m.previous(session: "a", window: 7, view: "find"))
        // 224 r1 first-F2: the view the router reads in, by value. A find ignores view arguments; a snapshot keeps them.
        let args: [String: JSONValue] = ["interactive": true, "depth": 3]
        XCTAssertEqual(SnapshotRowsMemory.View.reading(HandsRequest(verb: "find", args: args)), .find)
        XCTAssertEqual(SnapshotRowsMemory.View.reading(HandsRequest(verb: "snapshot", args: args)), .init(interactive: true, compact: false, depth: 3))
        let router = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertEqual(router.components(separatedBy: "let view = SnapshotRowsMemory.View.reading(req)").count, 3, "snapshot and find both")
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
