import CoreGraphics
import Foundation

/// One `[[rules]]` table in `spaces.toml` (W2): which app's new windows it takes, and where they go.
public struct AppRule: Equatable, Sendable {
    /// The app's name or bundle id, any case.
    public var app: String
    /// A regular expression the window's title must contain a match for. A window still without a title doesn't match.
    public var title: String?
    /// The workspace its new windows open on.
    public var workspace: Int?
    /// Where on the display its new windows go: a placement, as in `window left-half`.
    public var layout: Placement?
    /// macOS never tiles, so every window floats: `float = true` says only that no layout applies.
    public var float: Bool
    public let line: Int

    public func matches(name: String, bundle: String?, title t: String) -> Bool {
        let a = app.lowercased()
        guard a == name.lowercased() || a == bundle?.lowercased() else { return false }
        guard let title else { return true }
        guard !t.isEmpty, let re = try? NSRegularExpression(pattern: title) else { return false }
        return re.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
    }
}

public enum AppRules {
    /// `[[rules]]` from the whole file. Any problem means no rules: a rule half read could send windows somewhere the
    /// file never said.
    public static func load(_ root: TOMLTable, reserved: Set<Int> = []) -> (rules: [AppRule], problems: [KeymapProblem]) {
        guard let value = root["rules"] else { return ([], []) }
        let top = root.line(of: "rules")
        guard let items = value.array else { return ([], [KeymapProblem(line: top, path: "rules", reason: "is a list: write [[rules]]")]) }
        var rules: [AppRule] = [], problems: [KeymapProblem] = []
        for (i, item) in items.enumerated() {
            let path = "rules[\(i + 1)]"
            guard let t = item.table else { problems.append(.init(line: top, path: path, reason: "is not a table")); continue }
            func bad(_ key: String, _ reason: String) { problems.append(.init(line: t.line(of: key) ?? top, path: "\(path).\(key)", reason: reason)) }
            let line = t.entries.first?.line ?? top ?? 0
            for e in t.entries where !["app", "title", "workspace", "layout", "float"].contains(e.key) {
                bad(e.key, "unknown key (app, title, workspace, layout, float)")
            }
            guard let app = t["app"]?.string, !app.isEmpty else { bad("app", "every rule names an app (its name or bundle id)"); continue }
            var rule = AppRule(app: app, title: nil, workspace: nil, layout: nil, float: false, line: line)
            if let v = t["title"] {
                if let s = v.string, (try? NSRegularExpression(pattern: s)) != nil { rule.title = s } else { bad("title", "\(v.shown) is not a regular expression") }
            }
            if let v = t["workspace"] {
                if let n = v.integer, Workspaces.range.contains(n), !reserved.contains(n) { rule.workspace = n }
                else { bad("workspace", "\(v.shown) is not a workspace from 1 to 9" + (reserved.isEmpty ? "" : " that isn't the agent workspace")) }
            }
            if let v = t["layout"] {
                if let s = v.string, let p = Placement(rawValue: s) { rule.layout = p }
                else { bad("layout", "\(v.shown) is not a layout (\(Placement.allCases.map(\.rawValue).joined(separator: ", ")))") }
            }
            if let v = t["float"] {
                if let b = v.bool { rule.float = b } else { bad("float", "\(v.shown) is not true or false") }
            }
            if rule.float, rule.layout != nil { bad("float", "a floating window takes no layout: drop one of them") }
            if rule.workspace == nil, rule.layout == nil, !rule.float, t["workspace"] == nil, t["layout"] == nil {
                bad("app", "the rule does nothing: give it a workspace or a layout")
            }
            rules.append(rule)
        }
        return problems.isEmpty ? (rules, []) : ([], problems)
    }
}

/// A window seen for the first time, as the rules see it.
public struct NewWindow: Equatable, Sendable {
    public var id: WindowID
    public var name: String
    public var bundle: String?
    public var title: String
    /// Where it landed: the workspace a new window joins (R-P1).
    public var workspace: Int
    public init(id: WindowID, name: String, bundle: String?, title: String, workspace: Int) {
        self.id = id; self.name = name; self.bundle = bundle; self.title = title; self.workspace = workspace
    }
}

/// Applies the rules to new windows only, each window once. A window that had a workspace before (one that came back
/// after Accessibility missed it, or its app relaunched and restored it), one an agent claimed, and one you moved are
/// never taken: the caller passes only brand-new windows, and a window decided once is never decided again.
public struct RuleBook: Sendable {
    public var rules: [AppRule]
    private var decided: Set<WindowID> = []

    public struct Decision: Equatable, Sendable {
        public var workspace: Int?
        public var layout: Placement?
        public let rule: Int
    }

    public init(rules: [AppRule] = []) { self.rules = rules }

    /// What the first matching rule does with `w`, or nil. First match wins.
    public mutating func decide(_ w: NewWindow) -> Decision? {
        guard decided.insert(w.id).inserted, let rule = rules.first(where: { $0.matches(name: w.name, bundle: w.bundle, title: w.title) })
        else { return nil }
        let to = rule.workspace.flatMap { $0 == w.workspace ? nil : $0 }
        let layout = rule.float ? nil : rule.layout
        guard to != nil || layout != nil else { return nil }
        return Decision(workspace: to, layout: layout, rule: rule.line)
    }

    /// Windows that closed are forgotten, so a window number used again is new again.
    public mutating func keep(only alive: Set<WindowID>) { decided.formIntersection(alive) }
}
