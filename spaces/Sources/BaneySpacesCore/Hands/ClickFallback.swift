import Foundation

/// Item 3: a click on a row, cell or item in an outline, table or list. Some apps don't select a row on a press
/// (System Information's sidebar: 8 of 8 clicks failed while select on the outline worked), so when the press doesn't
/// select it, the click writes the selection instead, in the same transaction. The selection is read before and after;
/// a press that selected the row is never followed by the write.
public enum ClickFallback {
    public static let containers: Set<String> = ["outline", "table", "list"]
    public static let items: Set<String> = ["treeitem", "row", "cell"]

    public struct Plan: Equatable, Sendable {
        /// The full ref of the outline, table or list.
        public var container: String
        /// The text the selection write names the item by.
        public var label: String
        public var itemRole: String
    }

    /// The selection write for row `number` of the read `rows` came from, or nil: not an item in a collection, or no
    /// label that names it alone among its kind there (the write picks by label, so a shared one could pick another).
    public static func plan(rows: [SnapshotRows.Row], snapshot: String, number: Int) -> Plan? {
        guard let start = rows.firstIndex(where: { $0.number == number }) else { return nil }
        var item: Int? = start
        while let i = item, !items.contains(rows[i].role) { item = rows[i].parent }
        guard let it = item else { return nil }
        var up = rows[it].parent
        while let i = up, !containers.contains(rows[i].role) { up = rows[i].parent }
        guard let box = up, let boxNumber = rows[box].number, let label = label(rows, it), !label.isEmpty else { return nil }
        let role = rows[it].role
        let same = rows.indices.filter { rows[$0].role == role && inside(rows, $0, box) && Self.label(rows, $0) == label }
        guard same == [it] else { return nil }
        return Plan(container: "@\(snapshot):e\(boxNumber)", label: label, itemRole: role)
    }

    /// Whether the item is selected in a later read of the window: nil when it isn't there exactly once.
    public static func selected(_ rows: [SnapshotRows.Row], _ plan: Plan) -> Bool? {
        let found = rows.indices.filter { rows[$0].role == plan.itemRole && label(rows, $0) == plan.label }
        guard found.count == 1 else { return nil }
        return rows[found[0]].states.contains("selected")
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

    /// An item's label: its name, or the first name or text under it (System Information's rows hold a text field).
    static func label(_ rows: [SnapshotRows.Row], _ i: Int) -> String? {
        if !rows[i].name.isEmpty { return rows[i].name }
        var j = i + 1
        while j < rows.count, rows[j].depth > rows[i].depth {
            // A disclosure triangle's value (1) or a checkbox's is no label; text is.
            if !rows[j].name.isEmpty { return rows[j].name }
            if ["textfield", "statictext"].contains(rows[j].role), !rows[j].value.isEmpty { return rows[j].value }
            j += 1
        }
        return nil
    }

    static func inside(_ rows: [SnapshotRows.Row], _ i: Int, _ box: Int) -> Bool {
        var up = rows[i].parent
        while let p = up { if p == box { return true }; up = rows[p].parent }
        return false
    }
}
