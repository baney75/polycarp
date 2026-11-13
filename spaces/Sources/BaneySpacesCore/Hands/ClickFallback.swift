import Foundation

/// Item 3: a click on a row, cell or item in an outline, table or list. Some apps don't select a row on a press
/// (System Information's sidebar: 8 of 8 clicks failed while select on the outline worked), so when the press doesn't
/// select it, the click writes the selection instead, in the same transaction. The selection is read before and after;
/// a press that selected the row is never followed by the write.
public enum ClickFallback {
    public static let containers: Set<String> = ["outline", "table", "list"]
    /// Selection is the row's in a table: a cell resolves to the row that holds it, and is the item only with no row above.
    public static let items: Set<String> = ["treeitem", "row"]
    /// What may sit between the clicked element and its row (System Information's rows hold a text field). A control
    /// (button, checkbox, switch, link, popup) does what it is pressed for, so a click on one keeps the plain press
    /// (review r1 first-F1).
    public static let passive: Set<String> = ["statictext", "textfield", "image", "cell", "group"]

    public struct Plan: Equatable, Sendable {
        /// The full ref of the outline, table or list.
        public var container: String
        /// The text the selection write names the item by.
        public var label: String
        public var itemRole: String
        /// The container's row key: the readback looks for the item only in it, the scope `plan` proved the label unique in.
        public var containerKey: String
        /// The view of the read the plan came from: row keys depend on it, so the readbacks read the same way.
        public var view = SnapshotRowsMemory.View.full
    }

    /// The selection write for row `number` of the read `rows` came from, or nil: not an item in a collection, a
    /// control inside one, or no label that names it alone among its kind there (the write picks by label).
    public static func plan(rows: [SnapshotRows.Row], snapshot: String, number: Int) -> Plan? {
        guard let start = rows.firstIndex(where: { $0.number == number }) else { return nil }
        var item: Int?, cell: Int?, at: Int? = start
        while let i = at {
            let role = rows[i].role
            if items.contains(role) { item = i; break }
            // A cell with no row above is the item; the walk stops at its collection (166 r2 second-F6).
            if containers.contains(role) { break }
            if role == "cell" { cell = cell ?? i } else if !passive.contains(role) { return nil }
            at = rows[i].parent
        }
        guard let it = item ?? cell else { return nil }
        var up = rows[it].parent
        while let i = up, !containers.contains(rows[i].role) { up = rows[i].parent }
        guard let box = up, let boxNumber = rows[box].number, let label = label(rows, it), !label.isEmpty else { return nil }
        let role = rows[it].role
        let same = rows.indices.filter { rows[$0].role == role && inside(rows, $0, box) && Self.label(rows, $0) == label }
        guard same == [it] else { return nil }
        return Plan(container: "@\(snapshot):e\(boxNumber)", label: label, itemRole: role, containerKey: rows[box].key)
    }

    /// The plan for row `number` of a remembered read, in that read's view, or nil when its container's ref is no good
    /// now (`usable` says): the click is then the plain press (194 r1 first-F1, 203 r1 first-F2).
    public static func plan(read: SnapshotRowsMemory.Read, snapshot: String, number: Int, usable: (String) -> Bool) -> Plan? {
        guard var p = plan(rows: read.rows, snapshot: snapshot, number: number), usable(p.container) else { return nil }
        // The readbacks read in this read's view, so the row keys they compare match (second-F5).
        p.view = read.view
        return p
    }

    /// Whether the item is selected in a later read of the window: nil when its container isn't there, or the item
    /// isn't in it exactly once (review r1 second-F8: a same-named row in another collection is never read).
    public static func selected(_ rows: [SnapshotRows.Row], _ plan: Plan) -> Bool? {
        guard let box = rows.firstIndex(where: { $0.key == plan.containerKey }) else { return nil }
        let found = rows.indices.filter { rows[$0].role == plan.itemRole && inside(rows, $0, box) && label(rows, $0) == plan.label }
        guard found.count == 1 else { return nil }
        // A row the read hid (no ref, name or value) holds the selection for the cells it moved up (194 r1 second-F6).
        // The item's own state still counts: a shown treeitem under a hidden one, or a cell a table selects by
        // (203 r1 first-F1). A shown item is its own item: a selected hidden parent says nothing about it (224 r1 first-F1).
        let row = rows[found[0]]
        return items.contains(row.role) ? row.states.contains("selected") : (row.hiddenItemSelected ?? false) || row.states.contains("selected")
    }

    /// Whether the click is verified. With no readback (the row moved, the read didn't reach it) the press's own
    /// evidence decides, as on the plain path: the engine's verdict or a change in the window (review r1 first-F4).
    public static func verified(landed: Landed, afterPress: Bool?, engineVerified: Bool, treeChanged: Bool) -> Bool {
        if landed != .none { return true }
        return afterPress == nil && (engineVerified || treeChanged)
    }

    /// The code the click's next call comes from: a refused write's own (in_use, outside the workspace), or unverified.
    public static func nextCode(verified: Bool, writeError: HandsErrorCode?) -> HandsErrorCode? {
        writeError ?? (verified ? nil : .unverified)
    }

    /// What the engine itself answers when an action ran; any other code on the write is a refusal of a check, whichever
    /// check it came from (194 r1 first-F1).
    static let engineCodes: Set<HandsErrorCode> = [.actionFailed, .notSupported, .unverified, .timeout, .engineError]

    /// The press failed and nothing landed: its error, saying a write was also tried when one was (review r1 first-F5).
    /// A refused write answers with the refusal, so its code decides the next call (166 r2 first-F3).
    public static func failure(press: HandsError, write: HandsError?) -> HandsError {
        guard let write else { return press }
        if !engineCodes.contains(write.code) {
            var e = write
            e.message += "; the press had failed first: \(press.message)"
            return e
        }
        var e = press
        e.message += "; the selection write was tried too and failed: \(write.message)"
        return e
    }

    /// A failed press on a click that still answers: its code and message, so the agent learns of it (166 r2 first-F4).
    public static func pressError(_ e: HandsError?) -> JSONValue? {
        e.map { .object(["code": .string($0.code.rawValue), "message": .string($0.message)]) }
    }

    /// What the click's transaction saw.
    public struct Run: Sendable {
        public var before: Bool?, afterPress: Bool?, afterWrite: Bool?
        public var press: JSONValue?, write: JSONValue?
        public var pressError: HandsError?, writeError: HandsError?
        public var landed = Landed.none
        /// What the window's reads before and after the press differ by.
        public var diff: AXDiff?
        public init() {}
    }

    /// The click's answer from what its transaction saw, without the target and opened windows the router adds. An error
    /// only when nothing landed, nothing was written and the press failed; a refused write after a press that ran is
    /// said in `selection_write` and decides `next_call` (194 r1 first-F4, first-F5).
    public static func answer(_ r: Run, ref: String, plan: Plan, window: Int) -> Result<[String: JSONValue], HandsError> {
        if r.landed == .none, r.write == nil, let e = r.pressError { return .failure(failure(press: e, write: r.writeError)) }
        let engineVerified = r.press?["disposition"]?["delivery"]?.string == "delivered_verified"
        let ok = verified(landed: r.landed, afterPress: r.afterPress, engineVerified: engineVerified, treeChanged: r.diff?.changed ?? false)
        func flag(_ b: Bool?) -> JSONValue { b.map(JSONValue.bool) ?? .null }
        var o: [String: JSONValue] = [
            "action": "click", "ref": .string(ref), "verified": .bool(ok), "landed": .string(r.landed.rawValue),
            "evidence": .object(["kind": "selection_readback", "item": .string(plan.label), "selected_before": flag(r.before),
                                 "selected_after_press": flag(r.afterPress), "selected_after_write": flag(r.afterWrite)]),
            "engine": r.press ?? .null,
        ]
        if r.afterPress == nil, let d = r.diff { o["press_evidence"] = d.json() }
        if let e = pressError(r.pressError) { o["press_error"] = e }
        if let w = r.write { o["selection_write"] = .object(["container": .string(plan.container), "engine": w]) }
        if let e = r.writeError {
            o["selection_write"] = .object(["container": .string(plan.container), "error": .string(e.message), "code": .string(e.code.rawValue)])
        }
        if let code = nextCode(verified: ok, writeError: r.writeError?.code) { o["next_call"] = HandsNextCall.after(code, window: window) }
        return .success(o)
    }

    /// Which mechanism landed, as the click reports it.
    public enum Landed: String, Sendable {
        case press, selectionWrite = "selection_write", alreadySelected = "already_selected", none
    }

    public enum Next: Equatable, Sendable { case done(Landed), writeSelection }

    /// After the press: done, or write the selection. `pressError`: the press failed with this code.
    public static func afterPress(before: Bool?, after: Bool?, pressError: HandsErrorCode?) -> Next {
        if after == true { return .done(before == true ? .alreadySelected : .press) }
        // A timeout or a refused scope may have landed or must not go on; nothing more is sent.
        if let pressError, pressError != .actionFailed, pressError != .notSupported { return .done(.none) }
        // The write is only made when the readback shows the item not selected.
        return after == false ? .writeSelection : .done(.none)
    }

    /// The roles an item's label may come from below it.
    static let text: Set<String> = ["statictext", "textfield", "cell"]

    /// An item's label: its name, or the first text under it (System Information's rows hold a text field), or else the
    /// first named group or image under it (194 r1 first-F3). A control under it and all it holds are skipped: a
    /// checkbox's or a disclosure triangle's name is no label (166 r2 first-F1).
    static func label(_ rows: [SnapshotRows.Row], _ i: Int) -> String? {
        if !rows[i].name.isEmpty { return rows[i].name }
        var named: String?
        var j = i + 1
        while j < rows.count, rows[j].depth > rows[i].depth {
            let r = rows[j]
            if !passive.contains(r.role) {
                j += 1
                while j < rows.count, rows[j].depth > r.depth { j += 1 }
                continue
            }
            if text.contains(r.role), !r.name.isEmpty { return r.name }
            if r.role != "cell", text.contains(r.role), !r.value.isEmpty { return r.value }
            if named == nil, r.role == "group" || r.role == "image", !r.name.isEmpty { named = r.name }
            j += 1
        }
        return named
    }

    static func inside(_ rows: [SnapshotRows.Row], _ i: Int, _ box: Int) -> Bool {
        var up = rows[i].parent
        while let p = up { if p == box { return true }; up = rows[p].parent }
        return false
    }
}
