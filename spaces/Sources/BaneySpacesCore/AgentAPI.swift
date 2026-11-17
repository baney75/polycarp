import CoreGraphics
import Foundation

/// The agent API's queries (`spec/agent-api.md`): what the window manager knows, as one versioned JSON shape on every
/// platform, filtered to what the caller may see. Pure: the app gathers `Facts` on the main thread in one pass (the
/// model plus one window-server read, no Accessibility round trip per window), and everything here runs anywhere.
public enum AgentAPI {
    public static let version = 1

    public enum Query: String, CaseIterable, Sendable {
        case windows, workspaces, displays, focused, layout, theme, state
    }

    /// One window the window manager places, read in the same pass as the rest.
    public struct WindowFacts: Equatable, Sendable {
        public var window: HandsWindow
        /// Where it is drawn; for a parked window, where it goes back to. Nil when unknown.
        public var frame: CGRect?
        public var minimized: Bool
        public init(window: HandsWindow, frame: CGRect? = nil, minimized: Bool = false) {
            self.window = window; self.frame = frame; self.minimized = minimized
        }
    }

    public struct DisplayFacts: Equatable, Sendable {
        public var id: DisplayKey
        public var name: String
        public var frame: CGRect
        /// Without the menu bar and the Dock (Windows: the taskbar).
        public var visible: CGRect
        public var scale: Double
        public init(id: DisplayKey, name: String, frame: CGRect, visible: CGRect, scale: Double) {
            self.id = id; self.name = name; self.frame = frame; self.visible = visible; self.scale = scale
        }
    }

    public struct ThemeFacts: Equatable, Sendable {
        public var theme: String
        public var palette: String
        /// The Polycarp theme that draws instead of `theme` and `palette`, when one is in force.
        public var polycarp: (name: String, title: String, mode: String)?
        public init(theme: String, palette: String, polycarp: (name: String, title: String, mode: String)? = nil) {
            self.theme = theme; self.palette = palette; self.polycarp = polycarp
        }
        public static func == (a: ThemeFacts, b: ThemeFacts) -> Bool {
            a.theme == b.theme && a.palette == b.palette && a.polycarp?.name == b.polycarp?.name
                && a.polycarp?.title == b.polycarp?.title && a.polycarp?.mode == b.polycarp?.mode
        }
    }

    /// Everything, unfiltered. Displays are in order, the main one first.
    public struct Facts: Equatable, Sendable {
        public var windows: [WindowFacts]
        public var current: Int
        public var shown: [DisplayKey: Int]
        public var focusedDisplay: DisplayKey?
        public var focusedWindow: WindowID?
        public var agentWorkspace: Int?
        public var names: [Int: String]
        public var displays: [DisplayFacts]
        public var theme: ThemeFacts
        public var savedLayouts: [SavedLayout]
        public init(windows: [WindowFacts], current: Int, shown: [DisplayKey: Int], focusedDisplay: DisplayKey?, focusedWindow: WindowID?,
                    agentWorkspace: Int?, names: [Int: String] = [:], displays: [DisplayFacts], theme: ThemeFacts, savedLayouts: [SavedLayout] = []) {
            self.windows = windows; self.current = current; self.shown = shown; self.focusedDisplay = focusedDisplay
            self.focusedWindow = focusedWindow; self.agentWorkspace = agentWorkspace; self.names = names; self.displays = displays
            self.theme = theme; self.savedLayouts = savedLayouts
        }

        /// The display showing workspace `n`, or nil while it is out of sight.
        public func display(showing n: Int?) -> DisplayKey? {
            guard let n else { return nil }
            return displays.map(\.id).first { shown[$0] == n } ?? shown.first { $0.value == n }?.key
        }
    }

    /// A saved layout (`layouts/<workspace>/<name>.json`). Names are unique per workspace only, so a layout is named by
    /// both (`$defs/saved_layout`, review 434 r2 second-S1).
    public struct SavedLayout: Equatable, Sendable {
        public var workspace: Int
        public var name: String
        public init(workspace: Int, name: String) { self.workspace = workspace; self.name = name }
    }

    /// What the caller may see: `all` under Full Access on this Mac, else the agent workspace and lent apps.
    public struct View: Equatable, Sendable {
        public var access: AgentAccessMode
        /// The windows the scope guard allows the caller.
        public var inScope: Set<WindowID>
        public init(access: AgentAccessMode, inScope: Set<WindowID>) { self.access = access; self.inScope = inScope }
        public var scope: String { access == .full ? "all" : "agent" }
    }

    public static func frame(_ r: CGRect) -> JSONValue {
        func n(_ v: CGFloat) -> JSONValue { v == v.rounded() && abs(v) < 1e9 ? .int(Int(v)) : .double(Double(v)) }
        return .object(["x": n(r.minX), "y": n(r.minY), "width": n(r.width), "height": n(r.height)])
    }

    static func opt<T>(_ v: T?, _ f: (T) -> JSONValue) -> JSONValue { v.map(f) ?? .null }

    public static func window(_ w: WindowFacts, _ f: Facts) -> JSONValue {
        let ws = w.window.workspace
        return .object([
            "id": .int(Int(w.window.id)), "pid": .int(Int(w.window.pid)), "app": .string(w.window.app), "bundle": .string(w.window.bundle),
            "title": .string(w.window.title), "workspace": opt(ws, JSONValue.int), "display": opt(f.display(showing: ws), JSONValue.string),
            "frame": opt(w.frame, frame), "focused": .bool(f.focusedWindow == w.window.id), "agent": .bool(ws != nil && ws == f.agentWorkspace),
            "minimized": .bool(w.minimized),
        ])
    }

    /// The windows in scope, by id.
    static func visible(_ f: Facts, _ v: View) -> [WindowFacts] {
        f.windows.filter { v.inScope.contains($0.window.id) }.sorted { $0.window.id < $1.window.id }
    }

    /// One query's `data`. `state` is all the others at once.
    public static func result(_ q: Query, _ f: Facts, _ v: View) -> JSONValue {
        var o: [String: JSONValue] = ["version": .int(version), "scope": .string(v.scope), "access": .string(v.access.rawValue)]
        for (k, value) in parts(q, f, v) { o[k] = value }
        return .object(o)
    }

    static func parts(_ q: Query, _ f: Facts, _ v: View) -> [String: JSONValue] {
        let mine = visible(f, v)
        switch q {
        case .windows:
            return ["windows": .array(mine.map { window($0, f) })]
        case .workspaces:
            let rows: [JSONValue] = Workspaces.range.map { n in
                let display = f.display(showing: n)
                // Only windows in scope: a count of his would change as he opens and closes them (review F3).
                let ids = mine.filter { $0.window.workspace == n }.map { JSONValue.int(Int($0.window.id)) }
                return .object([
                    "number": .int(n), "name": opt(f.names[n].flatMap { $0.isEmpty ? nil : $0 }, JSONValue.string),
                    "shown": .bool(display != nil), "display": opt(display, JSONValue.string), "current": .bool(f.current == n),
                    "agent": .bool(f.agentWorkspace == n), "windows": .int(ids.count),
                    "window_ids": .array(ids),
                ])
            }
            return ["current": .int(f.current), "agent_workspace": opt(f.agentWorkspace, JSONValue.int), "workspaces": .array(rows)]
        case .displays:
            let focused = f.focusedDisplay ?? f.displays.first?.id
            return ["displays": .array(f.displays.enumerated().map { i, d in
                .object(["id": .string(d.id), "name": .string(d.name), "main": .bool(i == 0), "frame": frame(d.frame), "visible": frame(d.visible),
                         "scale": .double(d.scale), "workspace": opt(f.shown[d.id], JSONValue.int), "focused": .bool(d.id == focused)])
            })]
        case .focused:
            let w = f.focusedWindow.flatMap { v.inScope.contains($0) ? $0 : nil }
            return ["focused": .object(["display": opt(f.focusedDisplay ?? f.displays.first?.id, JSONValue.string), "workspace": .int(f.current),
                                        "window": opt(w) { .int(Int($0)) }])]
        case .layout:
            let groups = Dictionary(grouping: mine.filter { $0.window.workspace != nil }) { $0.window.workspace! }
            return ["layout": .object([
                "workspaces": .array(groups.keys.sorted().map { n in
                    .object(["number": .int(n), "windows": .array(groups[n]!.map { w in
                        .object(["id": .int(Int(w.window.id)), "app": .string(w.window.app), "title": .string(w.window.title), "frame": opt(w.frame, frame)])
                    })])
                }),
                // Only layouts of workspaces in the caller's scope: under scope `agent`, the agent workspace's.
                "saved": .array(f.savedLayouts.filter { v.scope == "all" || $0.workspace == f.agentWorkspace }
                    .sorted { ($0.workspace, $0.name) < ($1.workspace, $1.name) }
                    .map { .object(["workspace": .int($0.workspace), "name": .string($0.name)]) }),
            ])]
        case .theme:
            return ["theme": theme(f.theme)]
        case .state:
            var all: [String: JSONValue] = [:]
            for q in Query.allCases where q != .state { all.merge(parts(q, f, v)) { a, _ in a } }
            return all
        }
    }

    public static func theme(_ t: ThemeFacts) -> JSONValue {
        .object(["theme": .string(t.theme), "palette": .string(t.palette),
                 "polycarp_theme": t.polycarp.map { p in .object(["name": .string(p.name), "title": .string(p.title), "mode": .string(p.mode)]) } ?? .null])
    }

    /// `polycarp-spaces query <name>` without `--json`: a few lines for a person.
    public static func text(_ q: Query, _ data: JSONValue) -> String {
        var lines: [String] = ["scope: \(data["scope"]?.string ?? "?") (access \(data["access"]?.string ?? "?"))"]
        if [.windows, .state].contains(q) {
            for w in data["windows"]?.array ?? [] {
                let ws = w["workspace"]?.int.map(String.init) ?? "-"
                lines.append("window \(w["id"]?.int ?? 0)\tworkspace \(ws)\t\(w["app"]?.string ?? "")\t\(w["title"]?.string ?? "")" + (w["focused"]?.bool == true ? "\t(focused)" : ""))
            }
        }
        if [.workspaces, .state].contains(q) {
            for r in data["workspaces"]?.array ?? [] {
                var marks: [String] = []
                if r["current"]?.bool == true { marks.append("current") }
                if r["shown"]?.bool == true { marks.append("shown") }
                if r["agent"]?.bool == true { marks.append("agent") }
                lines.append("workspace \(r["number"]?.int ?? 0)\t\(r["windows"]?.int ?? 0) windows" + (marks.isEmpty ? "" : "\t" + marks.joined(separator: ", ")))
            }
        }
        if [.displays, .state].contains(q) {
            for d in data["displays"]?.array ?? [] {
                lines.append("display \(d["id"]?.string ?? "")\t\(d["name"]?.string ?? "")\tworkspace \(d["workspace"]?.int.map(String.init) ?? "-")" + (d["focused"]?.bool == true ? "\t(focused)" : ""))
            }
        }
        if [.focused, .state].contains(q), let f = data["focused"] {
            lines.append("focused: workspace \(f["workspace"]?.int ?? 0), window \(f["window"]?.int.map(String.init) ?? "none in scope")")
        }
        if q == .layout {
            for g in data["layout"]?["workspaces"]?.array ?? [] {
                for w in g["windows"]?.array ?? [] {
                    let r = w["frame"]
                    lines.append("workspace \(g["number"]?.int ?? 0)\twindow \(w["id"]?.int ?? 0)\t\(r?["x"]?.text ?? "?"),\(r?["y"]?.text ?? "?") \(r?["width"]?.text ?? "?")x\(r?["height"]?.text ?? "?")\t\(w["app"]?.string ?? "")")
                }
            }
            let saved = (data["layout"]?["saved"]?.array ?? []).map { "\($0["name"]?.string ?? "?") (workspace \($0["workspace"]?.int ?? 0))" }
            lines.append("saved layouts: " + saved.joined(separator: ", "))
        }
        if [.theme, .state].contains(q), let t = data["theme"] {
            let p = t["polycarp_theme"]?["title"]?.string.map { ", Polycarp theme \($0) draws instead" } ?? ""
            lines.append("theme: \(t["theme"]?.string ?? "?"), palette \(t["palette"]?.string ?? "?")\(p)")
        }
        return lines.joined(separator: "\n")
    }
}
