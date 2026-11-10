import CoreGraphics
import Foundation

/// What kind of child window an app raised. Only these are ever an agent's without placement.
public enum ChildWindowKind: String, Codable, Sendable {
    case dialog, alert, sheet, floating
}

/// What accessibility says about one window BaneySpaces does not place (a dialog, an alert, a sheet, a palette).
public struct ChildWindowFacts: Equatable, Sendable {
    public var id: UInt32
    public var pid: Int32
    public var app: String
    public var bundle: String
    /// The process's executable name, for the system prompt check (SecurityAgent, coreauthd...).
    public var processName: String
    public var title: String
    public var role: String?
    public var subrole: String?
    /// AXModal; nil when it could not be read.
    public var modal: Bool?
    /// The window it belongs to, when known (a sheet's window).
    public var parent: UInt32?
    /// Whether it is, holds or may be an Open or Save panel (`PanelDetector`).
    public var panel: Bool

    public init(id: UInt32, pid: Int32, app: String, bundle: String = "", processName: String = "", title: String = "",
                role: String? = nil, subrole: String? = nil, modal: Bool? = nil, parent: UInt32? = nil, panel: Bool = false) {
        self.id = id; self.pid = pid; self.app = app; self.bundle = bundle; self.processName = processName; self.title = title
        self.role = role; self.subrole = subrole; self.modal = modal; self.parent = parent; self.panel = panel
    }

    public var kind: ChildWindowKind? { ChildWindowRule.kind(role: role, subrole: subrole, modal: modal) }
    /// Whether it waits on an answer: the app is blocked until someone answers it.
    public var waiting: Bool { ChildWindowRule.waits(subrole: subrole, modal: modal) || kind == .sheet }

    /// The window as the scope guard and the engine see it: no workspace, since BaneySpaces does not place it.
    public var window: HandsWindow { HandsWindow(id: id, pid: pid, app: app, bundle: bundle, title: title, workspace: nil) }
}

/// Which windows BaneySpaces does not place an agent may still use (Donovan, 2026-11-10: "if a window pops up and it
/// needs to press something on that window it should be able too"). A child window W is usable, with the scope of its
/// parent, only when all of these hold:
///
/// 1. W is a dialog, alert, sheet or floating child (by role, subrole or AXModal), never a standard window (that one is
///    placed like any other) and never a menu; and W's process has at least one window the agent may use now.
/// 2. Ownership is plain: every placed window of that process is one the agent may use, or W first appeared within
///    10 s after an action by this agent session on a window of that process (`ChildAttribution`). An app split between
///    the agent workspace and Donovan's can raise a dialog for his window; the agent never gets that one.
/// 3. W is not an Open or Save panel (refused with `PanelDetector.refusal`), and not a system authentication, password,
///    keychain or permission prompt (SecurityAgent, coreauthd, UserNotificationCenter, TCC).
/// 4. The in-use rule is unchanged: the child counts as its app, and it is never on the agent workspace, so its
///    actions wait while Donovan uses the app.
public enum ChildWindowRule {
    /// How long after an action a new child window counts as that action's.
    public static let attributionWindow: TimeInterval = 10

    /// The kind, or nil for a window that is not a child an agent may answer (a standard window, a menu, anything else).
    public static func kind(role: String?, subrole: String?, modal: Bool?) -> ChildWindowKind? {
        let r = role ?? "", s = subrole ?? ""
        if r.contains("Menu") || s.contains("Menu") { return nil }
        if s == "AXStandardWindow" { return nil }
        if r == "AXSheet" || s == "AXSheet" { return .sheet }
        switch s {
        case "AXSystemDialog": return .alert
        case "AXDialog": return .dialog
        case "AXFloatingWindow", "AXSystemFloatingWindow": return .floating
        default: return modal == true ? .dialog : nil
        }
    }

    /// Whether the window waits on someone: anything modal, and a dialog or alert by its subrole. The same meaning as
    /// `WaitingWindow.asks` in #99 (spaces/dock-leftover-tile); the two should become one once both are merged.
    public static func waits(subrole: String?, modal: Bool?) -> Bool {
        if modal == true { return true }
        return subrole == "AXDialog" || subrole == "AXSystemDialog"
    }

    /// The processes that show macOS's own authentication, password, keychain and permission prompts.
    public static let systemPromptBundles: Set<String> = [
        "com.apple.SecurityAgent", "com.apple.coreauthd", "com.apple.UserNotificationCenter", "com.apple.tccd", "com.apple.TCC",
        "com.apple.LocalAuthentication.UIAgent", "com.apple.CoreServicesUIAgent", "com.apple.universalaccessAuthWarn",
        "com.apple.accessibility.universalAccessAuthWarn", "com.apple.authorizationhost", "com.apple.SecurityAgentHelper",
    ]
    public static let systemPromptProcesses: Set<String> = [
        "SecurityAgent", "coreauthd", "UserNotificationCenter", "tccd", "LocalAuthenticationUIAgent", "LocalAuthentication.UIAgent",
        "CoreServicesUIAgent", "universalAccessAuthWarn", "authorizationhost", "SecurityAgentHelper",
    ]

    public static func isSystemPrompt(bundle: String, processName: String) -> Bool {
        systemPromptBundles.contains(bundle) || systemPromptProcesses.contains(processName)
            || bundle.hasPrefix("com.apple.SecurityAgent") || bundle.hasPrefix("com.apple.LocalAuthentication")
    }

    /// Which rule refused a child window.
    public enum Failed: String, Sendable {
        case ownWindow = "own_window"
        case systemPrompt = "rule3_system_prompt"
        case panel = "rule3_open_save_panel"
        case notAChild = "rule1_not_a_child"
        case noUsableWindow = "rule1_no_usable_window"
        case ownership = "rule2_ownership"
    }

    public enum Decision: Equatable, Sendable {
        /// Usable with this scope. `ownership` says how it was settled: "all_windows_usable" or "after_your_action".
        case usable(scope: ScopeDecision, parent: UInt32?, ownership: String)
        case refused(Failed, HandsError)

        public var scope: ScopeDecision {
            switch self {
            case .usable(let s, _, _): return s
            case .refused(_, let e): return .denied(e)
            }
        }
        public var allowed: Bool { if case .usable = self { return true }; return false }
    }

    /// The one decision. `placed` is every window BaneySpaces places for W's process, each with the agent's scope decision
    /// for it; `attributed` is whether W appeared within 10 s after this session acted on that process.
    public static func decide(_ c: ChildWindowFacts, placed: [(window: HandsWindow, scope: ScopeDecision)], attributed: Bool,
                              selfPid: Int32? = nil) -> Decision {
        let kindName = c.kind?.rawValue ?? "window"
        if let me = selfPid, c.pid == me {
            return .refused(.ownWindow, HandsError(.permissionDenied, "window \(c.id) is Polycarp's own",
                                                   suggestion: "Agents never use Polycarp's windows; its settings are Donovan's.", retry: .never))
        }
        if isSystemPrompt(bundle: c.bundle, processName: c.processName) {
            return .refused(.systemPrompt, HandsError(.permissionDenied,
                "window \(c.id) belongs to \(c.processName.isEmpty ? c.bundle : c.processName), a macOS authentication, password, keychain or permission prompt (rule 3)",
                suggestion: "Agents never answer system prompts. Tell Donovan what asked and why, and let him answer it himself.", retry: .never))
        }
        if c.panel { return .refused(.panel, PanelDetector.refusal(window: c.id, app: c.app)) }
        guard c.kind != nil else {
            return .refused(.notAChild, HandsError(.outsideAgentWorkspace,
                "window \(c.id) of \(c.app) is not a dialog, alert, sheet or floating window, and Polycarp doesn't place it (rule 1)",
                suggestion: "A new document window is placed in a moment: run `windows` again. Menus are never an agent's.", retry: .safe))
        }
        let usable = placed.filter { $0.window.pid == c.pid && $0.scope.allowed }
        guard let first = usable.min(by: { $0.window.id < $1.window.id }) else {
            return .refused(.noUsableWindow, HandsError(.outsideAgentWorkspace,
                "window \(c.id) is a \(kindName) of \(c.app), and no window of \(c.app) is one you may use (rule 1)",
                suggestion: "A dialog is yours only when a window of the same app is on the agent workspace, lent to you, or open under Full Access. Leave this one for Donovan.", retry: .never))
        }
        let ofPid = placed.filter { $0.window.pid == c.pid }
        let all = !ofPid.isEmpty && ofPid.allSatisfy { $0.scope.allowed }
        guard all || attributed else {
            return .refused(.ownership, HandsError(.outsideAgentWorkspace,
                "window \(c.id) is a \(kindName) of \(c.app), which also has windows you may not use, and it did not appear within \(Int(attributionWindow)) s after one of your actions in \(c.app), so it may be Donovan's (rule 2)",
                suggestion: "Leave it for Donovan. A dialog your own action raises is reported in that action's result as `opened`; act on it then. Meanwhile work in another window.", retry: .never))
        }
        let parent = c.parent.flatMap { p in usable.first { $0.window.id == p } }
        return .usable(scope: (parent ?? first).scope, parent: c.parent, ownership: all ? "all_windows_usable" : "after_your_action")
    }
}

/// Which child windows appeared after which session's action. Fed by every look at a process's child windows; a window
/// first seen outside the 10 s after an action is never attributed later, and one that was there before the action never is.
public struct ChildAttribution: Equatable, Sendable {
    struct Action: Equatable, Sendable { var session: String; var at: Date; var before: Set<UInt32> }
    struct Seen: Equatable, Sendable { var pid: Int32; var session: String?; var at: Date }
    private var actions: [Int32: Action] = [:]
    private var seen: [UInt32: Seen] = [:]

    public init() {}

    /// `session` is about to act on `pid`, which has these child windows now.
    public mutating func acted(session: String, pid: Int32, at: Date, existing: Set<UInt32>) {
        actions[pid] = Action(session: session, at: at, before: existing)
        for id in existing where seen[id] == nil { seen[id] = Seen(pid: pid, session: nil, at: at) }
    }

    /// The child windows `pid` has at `at`. Each one seen for the first time is the latest action's, when it came within
    /// the window and was not there before it; otherwise nobody's, for good.
    public mutating func observed(_ ids: Set<UInt32>, pid: Int32, at: Date) {
        for id in ids where seen[id] == nil {
            var owner: String?
            if let a = actions[pid], !a.before.contains(id), at >= a.at, at.timeIntervalSince(a.at) <= ChildWindowRule.attributionWindow { owner = a.session }
            seen[id] = Seen(pid: pid, session: owner, at: at)
        }
        if seen.count > 2048 { seen = seen.filter { at.timeIntervalSince($0.value.at) < 3600 } }
    }

    /// Whether this session's action raised it.
    public func attributed(_ id: UInt32, pid: Int32, session: String) -> Bool {
        guard !session.isEmpty, let s = seen[id], s.pid == pid else { return false }
        return s.session == session
    }

    /// Whether a watch should still be looking at `pid` for this session's action.
    public func watching(pid: Int32, now: Date) -> Bool {
        actions[pid].map { now.timeIntervalSince($0.at) <= ChildWindowRule.attributionWindow } ?? false
    }
}

/// One row of `windows` for a child window: what it is, which window it belongs to, whether the app waits on it, and,
/// when it is refused, why (without its title, which may be Donovan's).
public enum ChildWindowList {
    public static func entry(_ c: ChildWindowFacts, decision: ChildWindowRule.Decision, inUse: InUseState) -> JSONValue {
        var o: [String: JSONValue] = ["id": .int(Int(c.id)), "pid": .int(Int(c.pid)), "app": .string(c.app), "workspace": .null,
                                      "kind": .string(c.kind?.rawValue ?? "window"), "waiting": .bool(c.waiting),
                                      "parent": c.parent.map { .int(Int($0)) } ?? .null]
        switch decision {
        case .usable(let scope, _, let ownership):
            o["title"] = .string(c.title)
            o["scope"] = .string(scope.reason)
            o["ownership"] = .string(ownership)
            if c.waiting { o["note"] = .string("\(c.app) waits on this \(c.kind?.rawValue ?? "window"): snapshot it and answer it, or leave it if it isn't yours to answer.") }
            if let note = inUse.note(c.app) { o["in_use"] = .bool(true); o["in_use_note"] = .string(note) }
        case .refused(let rule, let e):
            o["usable"] = .bool(false)
            o["rule"] = .string(rule.rawValue)
            o["reason"] = .string(e.message)
        }
        return .object(o)
    }

    /// What an action's result says about a child window that appeared while it ran.
    public static func opened(_ c: ChildWindowFacts) -> JSONValue {
        .object(["window": .int(Int(c.id)), "kind": .string(c.kind?.rawValue ?? "window"), "title": .string(c.title),
                 "waiting": .bool(c.waiting), "parent": c.parent.map { .int(Int($0)) } ?? .null])
    }
}

/// Marks the elements of a sheet in a snapshot of its window, so an agent knows which part of the tree is the sheet that
/// blocks the window.
public enum SheetMark {
    public static func mark(_ tree: JSONValue) -> (tree: JSONValue, sheets: Int) {
        var count = 0
        func walk(_ n: JSONValue, inSheet: Bool) -> JSONValue {
            guard case .object(var o) = n else { return n }
            let role = (o["role"]?.string ?? "").lowercased()
            let isSheet = role == "sheet" || role == "axsheet" || (o["subrole"]?.string ?? "").lowercased().hasSuffix("sheet")
            if isSheet { count += 1; o["sheet"] = .bool(true) }
            let within = inSheet || isSheet
            if within { o["in_sheet"] = .bool(true) }
            if let kids = o["children"]?.array { o["children"] = .array(kids.map { walk($0, inSheet: within) }) }
            return .object(o)
        }
        let out = walk(tree, inSheet: false)
        return (out, count)
    }
}

/// Which windows each agent session opened with `open`, by window id and process, so `close` closes only those.
public struct SessionWindows: Equatable, Sendable {
    private var opened: [String: [UInt32: Int32]] = [:]
    public init() {}

    public mutating func record(session: String, window: UInt32, pid: Int32) {
        guard !session.isEmpty else { return }
        opened[session, default: [:]][window] = pid
    }

    public mutating func forget(window: UInt32) { for k in opened.keys { opened[k]?[window] = nil } }

    /// Whether this session opened this exact window of this exact process.
    public func opened(by session: String, window: UInt32, pid: Int32) -> Bool {
        !session.isEmpty && opened[session]?[window] == pid
    }

    public func windows(of session: String) -> [UInt32: Int32] { opened[session] ?? [:] }
}

/// The verbs that manage the agent workspace, and who may use them.
public enum WorkspaceVerbs {
    /// Change where windows are or whether they exist. Never for a connector (`forRemote` allows nothing like them).
    public static let manage: Set<String> = ["arrange", "move", "close"]

    public static func connectorRefusal(verb: String) -> HandsError? {
        guard manage.contains(verb) else { return nil }
        return HandsError(.permissionDenied, "\(verb) isn't open to an assistant connected from another machine",
                          suggestion: "Connectors may read `workspaces`, and `open` an app on the agent workspace; arranging, moving and closing windows are for agents on this Mac.", retry: .never)
    }

    /// `move`: onto the agent workspace only. A window already there just stays (or takes `frame`); a lent or Full Access
    /// window comes off Donovan's workspace; never onto a workspace he is looking at; never a child window.
    public static func moveRefusal(window w: HandsWindow, scope: ScopeDecision, agentWorkspace: Int?, agentShown: Bool) -> HandsError? {
        if case .denied(let e) = scope { return e }
        guard let agent = agentWorkspace else {
            return HandsError(.agentWorkspaceOff, "there is no agent workspace to move \(w.app) to", suggestion: "Ask Donovan to run `polycarp-spaces agent on`.", retry: .never)
        }
        guard w.workspace != nil else {
            return HandsError(.notSupported, "window \(w.id) is a child window of \(w.app); it goes where its app's window goes",
                              suggestion: "Answer it where it is, or move its parent window.", retry: .never)
        }
        if w.workspace == agent { return nil }
        if agentShown {
            return HandsError(.inUse, "Donovan is looking at the agent workspace, so nothing is moved onto it now",
                              suggestion: "Retry once he has left it, or work on a window already there. Do not ask him to switch away.", retry: .safe)
        }
        switch scope {
        case .lent, .fullAccess: return nil
        default:
            return HandsError(.needsLend, "window \(w.id) of \(w.app) isn't yours to move",
                              suggestion: "Only a lent window, or any window under Full Access, comes to the agent workspace.", retry: .never)
        }
    }

    /// `close`: only a window this session opened, of the same process.
    public static func closeRefusal(window w: HandsWindow, session: String, opened: SessionWindows) -> HandsError? {
        guard opened.opened(by: session, window: w.id, pid: w.pid) else {
            return HandsError(.permissionDenied, "window \(w.id) of \(w.app) wasn't opened by this session",
                              suggestion: "close closes only windows your own `open` made in this session; leave the rest as they are. Answer a dialog with its own buttons.", retry: .never)
        }
        return nil
    }
}

/// `arrange`: how the agent workspace's windows are laid out, so screenshots and reads come out the same each time.
public enum AgentArrange {
    public enum Layout: String, CaseIterable, Sendable { case full, halves, thirds, grid, frames }

    /// The smallest window size a layout or a frame makes.
    public static let minSize = CGSize(width: 240, height: 160)

    /// One frame per window, in order, inside `area` (screen coordinates with the origin at the top left). `halves` and
    /// `thirds` are columns; windows past the last column start the columns again, on top of the first ones.
    public static func frames(_ layout: Layout, count: Int, area: CGRect) -> [CGRect] {
        guard count > 0 else { return [] }
        func columns(_ n: Int) -> [CGRect] {
            let w = (area.width / CGFloat(n)).rounded(.down)
            return (0..<count).map { i in CGRect(x: area.minX + CGFloat(i % n) * w, y: area.minY, width: w, height: area.height) }
        }
        switch layout {
        case .full, .frames: return Array(repeating: area, count: count)
        case .halves: return columns(2)
        case .thirds: return columns(3)
        case .grid:
            let cols = Int(Double(count).squareRoot().rounded(.up))
            let rows = Int((Double(count) / Double(cols)).rounded(.up))
            let w = (area.width / CGFloat(cols)).rounded(.down), h = (area.height / CGFloat(rows)).rounded(.down)
            return (0..<count).map { i in CGRect(x: area.minX + CGFloat(i % cols) * w, y: area.minY + CGFloat(i / cols) * h, width: w, height: h) }
        }
    }

    /// "4211=0,0,800,600": a window id and a frame in points from the area's top-left corner. Nil when it isn't one.
    public static func parseFrame(_ text: String) -> (window: UInt32, frame: CGRect)? {
        let parts = text.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2, let id = UInt32(parts[0]) else { return nil }
        let n = parts[1].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard n.count == 4, n.allSatisfy({ $0.isFinite }) else { return nil }
        return (id, CGRect(x: n[0], y: n[1], width: n[2], height: n[3]))
    }

    /// A frame given relative to the area, made absolute and kept inside it, at least `minSize`.
    public static func place(_ relative: CGRect, in area: CGRect) -> CGRect {
        let w = min(max(relative.width, minSize.width), area.width), h = min(max(relative.height, minSize.height), area.height)
        let x = min(max(area.minX + relative.minX, area.minX), area.maxX - w)
        let y = min(max(area.minY + relative.minY, area.minY), area.maxY - h)
        return CGRect(x: x, y: y, width: w, height: h)
    }
}

/// One row of `workspaces`.
public struct WorkspaceRow: Equatable, Sendable {
    public var number: Int
    public var name: String?
    public var shown: Bool
    public var current: Bool
    public var windows: Int
    public init(number: Int, name: String? = nil, shown: Bool, current: Bool, windows: Int) {
        self.number = number; self.name = name; self.shown = shown; self.current = current; self.windows = windows
    }
}

public enum WorkspaceList {
    /// `workspaces`: every workspace (which one is the agent's, which are shown) and, for each window the agent may use,
    /// where it is. Counts only, never the titles of Donovan's windows.
    public static func json(rows: [WorkspaceRow], agentWorkspace: Int?, access: AgentAccessMode,
                            usable: [(window: HandsWindow, scope: ScopeDecision)]) -> JSONValue {
        .object([
            "agent_workspace": agentWorkspace.map(JSONValue.int) ?? .null,
            "agent_workspace_shown": .bool(agentWorkspace.map { n in rows.contains { $0.number == n && $0.shown } } ?? false),
            "access": .string(access.rawValue),
            "workspaces": .array(rows.map { r in
                var o: [String: JSONValue] = ["number": .int(r.number), "shown": .bool(r.shown), "current": .bool(r.current),
                                              "agent": .bool(r.number == agentWorkspace), "windows": .int(r.windows)]
                if let n = r.name, !n.isEmpty { o["name"] = .string(n) }
                return .object(o)
            }),
            "your_windows": .array(usable.sorted { $0.window.id < $1.window.id }.map { u in
                .object(["id": .int(Int(u.window.id)), "app": .string(u.window.app), "pid": .int(Int(u.window.pid)),
                         "workspace": u.window.workspace.map(JSONValue.int) ?? .null, "scope": .string(u.scope.reason)])
            }),
            "note": .string("Agents never change which workspace is shown and never create, rename or delete workspaces. Work on the agent workspace; while it is shown Donovan is looking at it."),
        ])
    }
}
