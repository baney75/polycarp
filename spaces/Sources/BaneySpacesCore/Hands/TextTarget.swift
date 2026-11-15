import Foundation

/// `click` by text (`{"window":7,"text":"Appearance"}`): the element is picked from a fresh read of the window when the
/// call runs, so one call does what took a snapshot and a click, and a `run-steps` step can name an element that only
/// appears after the step before it (System Settings' Accessibility, then its Display pane).
///
/// It never guesses: a label equal to the text wins (case, spacing and a trailing ellipsis aside), so "Display" is never
/// "Displays"; a label that only contains the text counts when it is the only one; two of either are refused with their
/// refs, which the caller can click directly or narrow with `role`.
public enum TextTarget {
    public struct Match: Equatable, Sendable {
        public var ref: String
        public var role: String
        public var label: String
        public init(ref: String, role: String, label: String) { self.ref = ref; self.role = role; self.label = label }
    }

    /// At most this many candidates are named in a refusal.
    static let listed = 8

    /// A label as compared: lowercased, spaces trimmed and collapsed, and a trailing "…" or "..." dropped.
    static func norm(_ s: String) -> String {
        var t = s.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        for tail in ["…", "..."] where t.hasSuffix(tail) { t = String(t.dropLast(tail.count)).trimmingCharacters(in: .whitespaces) }
        return t
    }

    /// The element of `tree` (the engine's read of window `window`) that `text` names, narrowed to `role` when given.
    public static func pick(tree: JSONValue, text: String, role: String?, window: Int) -> Result<Match, HandsError> {
        let want = norm(text)
        guard !want.isEmpty else {
            return .failure(HandsError(.badArguments, "text is empty", suggestion: #"Example: {"window":4211,"text":"Appearance"}"#, retry: .safe, nextCall: .null))
        }
        let wantRole = role.map { norm($0).replacingOccurrences(of: " ", with: "") }
        var exact: [Match] = [], partial: [Match] = []
        func walk(_ n: JSONValue) {
            guard case .object(let o) = n else { return }
            if let ref = o["ref_id"]?.string ?? o["ref"]?.string {
                let r = o["role"]?.string ?? ""
                if wantRole.map({ norm(r).replacingOccurrences(of: " ", with: "") == $0 }) ?? true {
                    let labels = ["name", "title", "value", "description"].compactMap { o[$0]?.string }.filter { !norm($0).isEmpty }
                    if let l = labels.first(where: { norm($0) == want }) { exact.append(Match(ref: ref, role: r, label: l)) }
                    else if let l = labels.first(where: { norm($0).contains(want) }) { partial.append(Match(ref: ref, role: r, label: l)) }
                }
            }
            for c in o["children"]?.array ?? [] { walk(c) }
        }
        walk(tree)
        let quoted = "\"\(text.trimmingCharacters(in: .whitespaces))\""
        let narrowed = role.map { " with role \($0)" } ?? ""
        for (hits, how) in [(exact, "show"), (partial, "contain")] where !hits.isEmpty {
            if hits.count == 1 { return .success(hits[0]) }
            let names = hits.prefix(listed).map { "\($0.ref) \($0.role) \"\($0.label)\"" }.joined(separator: ", ")
            let more = hits.count > listed ? ", and \(hits.count - listed) more" : ""
            return .failure(HandsError(.ambiguousTarget,
                                       "\(hits.count) elements\(narrowed) in window \(window) \(how) \(quoted): \(names)\(more). Nothing was sent",
                                       suggestion: "Click one of these refs, or pass role to narrow it, like {\"window\":\(window),\"text\":\(quoted),\"role\":\"\(hits[0].role)\"}",
                                       retry: .safe, nextCall: .null))
        }
        return .failure(HandsError(.actionFailed, "no element\(narrowed) in window \(window) shows \(quoted). Nothing was sent",
                                   suggestion: "Read the window and click by ref, or try the label as the window shows it",
                                   retry: .safe, nextCall: HandsError.call("snapshot", ["window": .int(window)])))
    }
}
