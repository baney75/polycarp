import Foundation

/// A snapshot as one line per element, for a model to read: `[5] button "Save" (disabled)`, indented under its parent.
/// `[N]` is the engine's own ref number, so row 5 of snapshot s8f3k2p9 is the ref `@s8f3k2p9:e5`. Elements with no ref,
/// name or value (wrapper groups) print nothing; their children move up a level. `snapshot` prints these by default over
/// MCP; `format: "json"` keeps the engine's tree.
public enum SnapshotRows {
    public struct Row: Equatable, Sendable {
        public var depth: Int
        /// N of the element's ref `@<snapshot>:eN`; nil for a row shown only as context (a named group, a label).
        public var number: Int?
        public var role: String
        public var name: String
        public var value: String
        public var states: [String]
        /// The same element in another snapshot of the window has the same key: the roles and names on its path, and its
        /// place among siblings with the same role and name.
        public var key: String
        /// The row this one is printed under.
        public var parent: Int?

        public var line: String {
            var s = String(repeating: "  ", count: depth)
            if let number { s += "[\(number)] " }
            s += role
            if !name.isEmpty { s += " " + SnapshotRows.quoted(name) }
            if !value.isEmpty, value != name { s += " =" + SnapshotRows.shownValue(value) }
            if !states.isEmpty { s += " (" + states.joined(separator: ",") + ")" }
            return s
        }

        /// The line without its indent, for a change list.
        public var flat: String { String(line.drop { $0 == " " }) }
    }

    /// Longest value printed in a row; the rest is one `get` away.
    public static let valueLimit = 120
    /// Rows printed when the caller sets no `max_elements`.
    public static let defaultMax = 400

    public static func rows(of tree: JSONValue) -> [Row] {
        var out: [Row] = []
        var siblings: [String: Int] = [:]
        var title = ""
        func walk(_ n: JSONValue, depth: Int, parent: Int?, path: String) {
            guard case .object(let o) = n else { return }
            let role = o["role"]?.string ?? ""
            var name = o["name"]?.string ?? o["title"]?.string ?? ""
            if name.isEmpty { name = o["description"]?.string ?? "" }
            let value = o["value"]?.string ?? ""
            let number = (o["ref_id"]?.string ?? o["ref"]?.string).flatMap(refNumber)
            var states = (o["states"]?.array ?? []).compactMap(\.string)
            if o["sheet"]?.bool == true { states.append("sheet") }
            let isRoot = out.isEmpty && parent == nil && depth == 0 && role == "window"
            if isRoot { title = name }
            // The title bar's icon and label repeat the window title, which the header already prints.
            let echo = number == nil && value.isEmpty && !title.isEmpty && name == title
            let shown = (number != nil || !name.isEmpty || !value.isEmpty) && !echo
            var childDepth = depth, childParent = parent, childPath = path
            if shown, !isRoot {
                // A name that is the element's content (Calculator's display) changes with it, so it can't name it.
                let slot = path + "/" + role + ":" + (name == value ? "" : name)
                let ordinal = siblings[slot, default: 0]
                siblings[slot] = ordinal + 1
                let key = slot + "#\(ordinal)"
                out.append(Row(depth: depth, number: number, role: role, name: name, value: value, states: states, key: key, parent: parent))
                childDepth = depth + 1; childParent = out.count - 1; childPath = key
            }
            for c in o["children"]?.array ?? [] { walk(c, depth: childDepth, parent: childParent, path: childPath) }
        }
        walk(tree, depth: 0, parent: nil, path: "")
        return out
    }

    /// 5 from `@s8f3k2p9:e5`.
    public static func refNumber(_ ref: String) -> Int? {
        guard let colon = ref.lastIndex(of: ":") else { return nil }
        let tail = ref[ref.index(after: colon)...]
        guard tail.first == "e" else { return nil }
        return Int(tail.dropFirst())
    }

    /// A bare row number an agent may pass instead of a ref: `5` or `[5]`. Nil for anything else. `e5` is a browser
    /// ref (read_page prints those), so it is refused by `browserRefError`, never read as native row 5.
    public static func bareNumber(_ ref: String) -> Int? {
        var s = Substring(ref.trimmingCharacters(in: .whitespaces))
        if s.hasPrefix("["), s.hasSuffix("]") { s = s.dropFirst().dropLast() }
        guard !s.isEmpty, s.allSatisfy(\.isASCII), let n = Int(s), n > 0 else { return nil }
        return n
    }

    /// The error for a browser ref like `e12` passed to a computer_* tool, or nil when the ref isn't one.
    public static func browserRefError(_ ref: String) -> HandsError? {
        let s = ref.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("e"), s.count > 1, s.dropFirst().allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return HandsError(.badArguments, "\(quoted(s)) is a browser ref from read_page; computer_* tools act on native windows",
                          suggestion: "For a web page, use the browser tools (click, fill, select) with \(s). For a native window, pass a row number like 5 or a full ref like @s8f3k2p9:e5 from computer_snapshot.",
                          retry: .never)
    }

    static func quoted(_ s: String) -> String {
        var out = "\""
        for ch in s {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            default: out.append(ch)
            }
        }
        return out + "\""
    }

    /// Numbers short (a scroll bar's 0.18518517911434174 is 0.19), text quoted and cut at `valueLimit`.
    static func shownValue(_ v: String) -> String {
        // Only a short plain decimal is rounded; anything else (2^70 as 1.180591620717e21, 1.0e999) prints as read.
        if v.count <= 24, v.contains("."), !v.contains(where: { $0 == "e" || $0 == "E" }), let d = Double(v), d.isFinite, abs(d) < 1e15 {
            var t = String(format: "%.2f", d)
            while t.hasSuffix("0") { t.removeLast() }
            if t.hasSuffix(".") { t.removeLast() }
            return t == "-0" ? "0" : t
        }
        if Double(v) != nil { return v }
        guard v.count > valueLimit else { return quoted(v) }
        return quoted(String(v.prefix(valueLimit))) + "…(+\(v.count - valueLimit) chars; get value for all)"
    }

    /// The two lines a full read starts with: what was read, and how to act on a row.
    public static func header(snapshot: String, window: UInt32, title: String, app: String, refs: Int) -> String {
        "snapshot \(snapshot) · window \(window) \(quoted(title)) (\(app)) · \(refs) refs\n"
            + "act by row number {\"ref\":\"5\"} or full ref @\(snapshot):e5"
    }

    /// The rows a query keeps: those whose role, name or value contains one of its `|`-separated words (any case),
    /// and every row they are printed under. Nil query keeps all.
    public static func select(_ rows: [Row], query: String?) -> [Int] {
        let terms = (query ?? "").lowercased().split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !terms.isEmpty else { return Array(rows.indices) }
        var keep = Set<Int>()
        for (i, r) in rows.enumerated() {
            let text = (r.role + " " + r.name + " " + r.value).lowercased()
            guard terms.contains(where: { text.contains($0) }) else { continue }
            var at: Int? = i
            while let j = at, keep.insert(j).inserted { at = rows[j].parent }
        }
        return keep.sorted()
    }

    /// The whole answer for a read: the header (one line for a query), notes, rows, and a truncated line when `max` cut some.
    public static func render(_ rows: [Row], snapshot: String, window: UInt32, title: String, app: String, refs: Int,
                              notes: [String] = [], query: String?, max: Int?, also: String = "") -> String {
        let q = (query ?? "").trimmingCharacters(in: .whitespaces)
        let picked = select(rows, query: q)
        var lines: [String]
        if q.isEmpty {
            lines = [header(snapshot: snapshot, window: window, title: title, app: app, refs: refs)]
        } else if picked.isEmpty {
            lines = ["snapshot \(snapshot) · window \(window) · no row matches \(quoted(q)) (\(rows.count) rows in all). Try one shorter word, or snapshot without query."]
        } else {
            lines = ["snapshot \(snapshot) · window \(window) · query \(quoted(q)): \(picked.count) of \(rows.count) rows"]
        }
        lines += notes.map { "note: " + $0 }
        let limit = Swift.max(1, max ?? defaultMax)
        lines += picked.prefix(limit).map { rows[$0].line }
        if picked.count > limit { lines.append(truncated(shown: limit, total: picked.count, window: window, query: q, also: also)) }
        return lines.joined(separator: "\n")
    }

    /// `also`: the read's view arguments as JSON members (`,"interactive":true`), repeated so the next call reads the same view.
    static func truncated(shown: Int, total: Int, window: UInt32, query: String, also: String = "") -> String {
        let all = query.isEmpty ? "{\"window\":\(window)\(also),\"max_elements\":\(total)}" : "{\"window\":\(window)\(also),\"query\":\(quoted(query)),\"max_elements\":\(total)}"
        let narrower = query.isEmpty ? " or {\"window\":\(window)\(also),\"query\":\"<a word from the row you want>\"}" : ""
        return "truncated: \(shown) of \(total) rows shown. For the rest call snapshot with \(all)\(narrower)"
    }

    public enum Change: Equatable, Sendable {
        case added(Row), changed(Row), removed(Row)
        public var row: Row { switch self { case .added(let r), .changed(let r), .removed(let r): return r } }
    }

    /// What changed between two reads of one window with the same view, matched by `Row.key`. A row whose only change is
    /// its number (the engine renumbers every read) is not a change.
    public static func changes(from old: [Row], to new: [Row]) -> [Change] {
        let before = Dictionary(old.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        let now = Set(new.map(\.key))
        var out: [Change] = []
        for r in new {
            guard let was = before[r.key] else { out.append(.added(r)); continue }
            if was.name != r.name || was.value != r.value || was.states != r.states { out.append(.changed(r)) }
        }
        for r in old where !now.contains(r.key) { out.append(.removed(r)) }
        return out
    }

    /// The answer for `since: "latest"`: the notes and every change (`max` doesn't cut it: the next since read starts from
    /// this one, so a cut change would never be listed). A read with none is one short line. Its numbers are this read's, and
    /// a bare number is refused after it, so the header names the full ref.
    public static func renderSince(_ changes: [Change], new: [Row], snapshot: String, previous: String, window: UInt32,
                                   notes: [String] = [], query: String?) -> String {
        let notes = notes.map { "note: " + $0 }
        guard !changes.isEmpty else { return (["snapshot \(snapshot) · window \(window) · no change since \(previous)"] + notes).joined(separator: "\n") }
        // A query keeps the changed rows that match it; their parents aren't listed in a change list.
        let kept = select(changes.map { var r = $0.row; r.parent = nil; return r }, query: query).map { changes[$0] }
        var added = 0, changed = 0, removed = 0
        for c in kept { switch c { case .added: added += 1; case .changed: changed += 1; case .removed: removed += 1 } }
        var lines = ["snapshot \(snapshot) · window \(window) · since \(previous): \(added) added, \(changed) changed, \(removed) removed · act by full ref @\(snapshot):eN"]
        lines += notes
        for c in kept {
            switch c {
            case .added(let r):
                let under = r.parent.flatMap { new[$0].number }.map { " under [\($0)]" } ?? ""
                lines.append("+ " + r.flat + under)
            case .changed(let r): lines.append("~ " + r.flat)
            case .removed(let r):
                var gone = r; gone.number = nil
                lines.append("- " + gone.flat)
            }
        }
        return lines.joined(separator: "\n")
    }
}

/// What each session last read, so `since: "latest"` has something to compare with and a bare row number (`5`) means one
/// element. Per session: the last read of each window and view, and the last few snapshots in order.
public struct SnapshotRowsMemory: Sendable {
    public struct Read: Equatable, Sendable {
        public var snapshot: String
        public var window: UInt32
        public var rows: [SnapshotRows.Row]
        public var at: Date
        /// Whether the read printed every row with its number. A since read or a find did not, so a bare number after one
        /// may mean a row the agent saw in an older read.
        public var listed: Bool = true
        /// The order the session's reads were made in.
        var seq = 0
        /// Row number to row key, for comparing two snapshots' row N.
        var keys: [Int: String] { Dictionary(rows.compactMap { r in r.number.map { ($0, r.key) } }, uniquingKeysWith: { a, _ in a }) }
        func row(_ n: Int) -> SnapshotRows.Row? { rows.first { $0.number == n } }
    }

    /// Snapshots of a session that a bare number is checked against.
    public static let history = 6
    /// Older snapshots than this don't make a bare number ambiguous.
    public static let horizon: TimeInterval = 600
    static let sessions = 32

    private var last: [String: Read] = [:]
    private var recent: [String: [Read]] = [:]
    /// Per session: reads up to this one are not compared any more (a full read after a refusal), and the window a refusal
    /// asked the agent to read again.
    private var floor: [String: Int] = [:]
    private var needsRead: [String: UInt32] = [:]
    private var seq = 0

    public init() {}

    static func viewKey(session: String, window: UInt32, view: String) -> String { "\(session)\u{1}\(window)\u{1}\(view)" }

    /// The read before this one of the same window and view, if the session made one.
    public func previous(session: String, window: UInt32, view: String) -> Read? {
        last[Self.viewKey(session: session, window: window, view: view)]
    }

    /// What a read counts as. Listed: it printed every row (not a since read, a query or a cut read), so its numbers are
    /// bare numbers. Baseline: the next since read compares with it (not a since read with a query, which hid changes).
    public static func kind(since: Bool, query: String?, rows: Int, max: Int?) -> (listed: Bool, baseline: Bool) {
        let query = !(query ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        let cut = !since && rows > Swift.max(1, max ?? SnapshotRows.defaultMax)
        return (!since && !query && !cut, !(since && query))
    }

    /// `baseline`: whether the next since read of this view compares with this one (not after a since read with a query,
    /// which didn't list every change).
    public mutating func remember(session: String, window: UInt32, view: String, snapshot: String, rows: [SnapshotRows.Row], now: Date,
                                  listed: Bool = true, baseline: Bool = true) {
        seq += 1
        var read = Read(snapshot: snapshot, window: window, rows: rows, at: now, listed: listed)
        read.seq = seq
        // The full read a refusal's next_call asked for: the agent has seen these numbers, so older reads don't count.
        if listed, needsRead[session] == window { floor[session] = seq; needsRead[session] = nil }
        if baseline { last[Self.viewKey(session: session, window: window, view: view)] = read }
        var list = recent[session] ?? []
        list.append(read)
        if list.count > Self.history { list.removeFirst(list.count - Self.history) }
        recent[session] = list
        let kept = Set(list.map(\.seq))
        last = last.filter { !$0.key.hasPrefix(session + "\u{1}") || kept.contains($0.value.seq) }
        if recent.count > Self.sessions, let oldest = recent.min(by: { ($0.value.last?.at ?? .distantPast) < ($1.value.last?.at ?? .distantPast) })?.key {
            recent[oldest] = nil; floor[oldest] = nil; needsRead[oldest] = nil
            last = last.filter { !$0.key.hasPrefix(oldest + "\u{1}") }
        }
    }

    public enum Bare: Equatable, Sendable {
        /// The full ref row N stands for.
        case ref(String)
        /// Refused; nothing was sent. `message`, and the call to make next (nil: snapshot first).
        case refused(code: HandsErrorCode, message: String, latest: Read?)
    }

    /// The session's recent read that printed `snapshot`, for what a ref of it pointed at.
    public func read(snapshot: String, session: String) -> Read? { recent[session]?.last { $0.snapshot == snapshot } }

    /// Row N of the session's latest snapshot, unless a recent earlier snapshot has a different row N (another window, or
    /// another element): then the number alone can't say which the agent saw, and it must pass the full ref.
    /// A refusal marks its window: the next full read of it (the one next_call asks for) clears the refusal.
    public mutating func resolve(bare n: Int, session: String, now: Date) -> Bare {
        let answer = check(bare: n, session: session, now: now)
        if case .refused(_, _, let latest?) = answer { needsRead[session] = latest.window }
        return answer
    }

    func check(bare n: Int, session: String, now: Date) -> Bare {
        guard let list = recent[session], let latest = list.last else {
            return .refused(code: .unknownRef, message: "\"\(n)\" is a row number, and this session has no snapshot yet", latest: nil)
        }
        guard latest.listed else {
            return .refused(code: .staleBareRow, message: "\"\(n)\" is a bare row number, and your last read of window \(latest.window) (\(latest.snapshot)) listed changes or matches, not every row, so the number could mean a row from an older read. Nothing was sent", latest: latest)
        }
        guard let row = latest.row(n) else {
            let top = latest.rows.compactMap(\.number).max() ?? 0
            return .refused(code: .unknownRef, message: "row \(n) isn't in your latest snapshot \(latest.snapshot) of window \(latest.window) (its rows go up to \(top))", latest: latest)
        }
        let key = latest.keys[n]
        for earlier in list.dropLast().reversed() where now.timeIntervalSince(earlier.at) < Self.horizon && earlier.seq > (floor[session] ?? 0) {
            guard let other = earlier.row(n) else { continue }
            if earlier.window != latest.window || earlier.keys[n] != key {
                return .refused(code: .staleBareRow,
                                message: "row \(n) means \(row.flat) in your latest snapshot \(latest.snapshot) (window \(latest.window)), but \(other.flat) in snapshot \(earlier.snapshot) (window \(earlier.window)). Nothing was sent",
                                latest: latest)
            }
        }
        return .ref("@\(latest.snapshot):e\(n)")
    }

    /// The error for a refused bare number. Its next call is always a read, never the action on a guessed element.
    public static func error(_ code: HandsErrorCode, _ message: String, latest: Read?) -> HandsError {
        guard let latest else {
            return HandsError(code, message, suggestion: "Call windows for the window id, then snapshot it and use its row numbers.", retry: .afterSnapshot,
                              nextCall: HandsError.call("windows", [:]))
        }
        return HandsError(code, message, suggestion: "Read the window again with next_call, then act on a row it prints or on a full ref like @\(latest.snapshot):e5.",
                          retry: .afterSnapshot, nextCall: HandsError.call("snapshot", ["window": .int(Int(latest.window))]))
    }
}
