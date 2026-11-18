import CoreGraphics
import Foundation

/// The agent API's events (spec/agent-api.md, "Events"): what changed between two reads of the facts, as one caller may
/// see it. Pure, so the same diff serves `polycarp-spaces subscribe`, the MCP `events` tool and the tests.
public enum AgentEvents {
    /// Every type a server sends, in the order the contract lists them (`hello` and `lagged` included).
    public static let types = ["hello", "workspace_switched", "window_focused", "window_created", "window_closed", "window_moved", "theme_changed", "lagged"]

    public struct Event: Equatable, Sendable {
        public var type: String
        public var data: JSONValue
        public init(_ type: String, _ data: JSONValue) { self.type = type; self.data = data }
    }

    /// The types a subscriber asked for: nil asks for every one. Unknown names are refused, so a typo never subscribes to
    /// nothing in silence. `hello` and `lagged` always come.
    public static func filter(_ text: String?) -> Result<Set<String>?, HandsError> {
        let names = (text ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !names.isEmpty else { return .success(nil) }
        let unknown = names.filter { !types.contains($0) }
        guard unknown.isEmpty else {
            return .failure(HandsError(.badArguments, "no event type \(unknown.joined(separator: ", "))",
                                       suggestion: "Types: " + types.joined(separator: ", ") + ".", retry: .never))
        }
        return .success(Set(names).union(["hello", "lagged"]))
    }

    /// The first event every subscriber gets: who it is, what it will be sent, and the whole state at that moment.
    public static func hello(_ f: AgentAPI.Facts, _ v: AgentAPI.View, types wanted: Set<String>?) -> Event {
        Event("hello", .object(["scope": .string(v.scope), "access": .string(v.access.rawValue),
                                "events": .array(types.filter { wanted?.contains($0) ?? true }.map(JSONValue.string)),
                                "state": AgentAPI.result(.state, f, v)]))
    }

    /// One event as sent: `$defs/event`.
    public static func object(_ e: Event, seq: Int, at: Date) -> JSONValue {
        .object(["version": .int(AgentAPI.version), "seq": .int(seq), "at": .int(Int(at.timeIntervalSince1970 * 1000)),
                 "type": .string(e.type), "data": e.data])
    }

    /// One line on the wire.
    public static func line(_ e: Event, seq: Int, at: Date) -> String { object(e, seq: seq, at: at).text }

    static func place(_ w: AgentAPI.WindowFacts, _ f: AgentAPI.Facts) -> JSONValue {
        var o: [String: JSONValue] = ["workspace": AgentAPI.opt(w.window.workspace, JSONValue.int),
                                      "display": AgentAPI.opt(f.display(showing: w.window.workspace), JSONValue.string)]
        if let r = w.frame { o["frame"] = AgentAPI.frame(r) }
        return .object(o)
    }

    static func moved(_ a: AgentAPI.WindowFacts, _ b: AgentAPI.WindowFacts, _ fa: AgentAPI.Facts, _ fb: AgentAPI.Facts) -> Bool {
        if a.window.workspace != b.window.workspace || fa.display(showing: a.window.workspace) != fb.display(showing: b.window.workspace) { return true }
        guard let r = a.frame, let s = b.frame else { return false }
        return abs(r.minX - s.minX) >= 1 || abs(r.minY - s.minY) >= 1 || abs(r.width - s.width) >= 1 || abs(r.height - s.height) >= 1
    }

    /// Whether a listener ends instead of hearing a diff: Donovan changed Access, so its scope and what it may ask changed
    /// under it. It starts again and gets a `hello` with the new scope (spec/agent-api.md, "Events").
    public static func ends(_ oldView: AgentAPI.View, _ newView: AgentAPI.View) -> Bool { oldView.access != newView.access }

    /// What changed from `old` (as `oldView` saw it) to `new` (as `newView` sees it). A window leaving the caller's scope is
    /// `window_closed` and one entering it `window_created`, so a caller never learns of a window it may not see.
    public static func diff(_ old: AgentAPI.Facts, _ oldView: AgentAPI.View, _ new: AgentAPI.Facts, _ newView: AgentAPI.View) -> [Event] {
        var out: [Event] = []
        for d in new.displays.map(\.id) where new.shown[d] != nil && new.shown[d] != old.shown[d] {
            out.append(Event("workspace_switched", .object(["display": .string(d), "from": AgentAPI.opt(old.shown[d], JSONValue.int), "to": .int(new.shown[d]!)])))
        }
        let before = Dictionary(AgentAPI.visible(old, oldView).map { ($0.window.id, $0) }) { a, _ in a }
        let after = Dictionary(AgentAPI.visible(new, newView).map { ($0.window.id, $0) }) { a, _ in a }
        for id in before.keys.sorted() where after[id] == nil {
            out.append(Event("window_closed", .object(["window": .int(Int(id)), "workspace": AgentAPI.opt(before[id]!.window.workspace, JSONValue.int)])))
        }
        for id in after.keys.sorted() {
            let b = after[id]!
            if let a = before[id] {
                if moved(a, b, old, new) {
                    out.append(Event("window_moved", .object(["window": .int(Int(id)), "from": place(a, old), "to": place(b, new)])))
                }
            } else {
                out.append(Event("window_created", .object(["window": AgentAPI.window(b, new)])))
            }
        }
        let seenBefore = old.focusedWindow.flatMap { oldView.inScope.contains($0) ? $0 : nil }
        let seenNow = new.focusedWindow.flatMap { newView.inScope.contains($0) ? $0 : nil }
        if seenBefore != seenNow || old.current != new.current || old.focusedDisplay != new.focusedDisplay {
            out.append(Event("window_focused", AgentAPI.parts(.focused, new, newView)["focused"]!))
        }
        if old.theme != new.theme { out.append(Event("theme_changed", AgentAPI.theme(new.theme))) }
        return out
    }
}
