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
///    the agent workspace and Donovan's can raise a dialog for his window; the agent never gets that one. A child whose
///    window is known and not one the agent may use is refused whatever the timing says.
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

    /// sol-F1: the scopes the rule sees for an app's placed windows, each usable one also inspected now: one that fails (an
    /// outside document, a file panel) is not usable, so it authorizes no child and the app counts as split.
    public static func inspected(_ placed: [(window: HandsWindow, scope: ScopeDecision)], problem: (HandsWindow) -> HandsError?) -> [(window: HandsWindow, scope: ScopeDecision)] {
        placed.map { p in
            guard p.scope.allowed, let e = problem(p.window) else { return p }
            return (window: p.window, scope: .denied(e))
        }
    }

    /// A placed window that holds a sheet (with or without a window number of its own) on an app split between the agent and
    /// Donovan: its snapshot and refs reach the sheet, so the window is usable only while every sheet on it is one this
    /// session's action raised. Unsure counts as not.
    public static func sheetOnWindowRefusal(window w: HandsWindow, sheetsAttributed: [Bool], split: Bool) -> HandsError? {
        guard split, sheetsAttributed.contains(false) else { return nil }
        return HandsError(.outsideAgentWorkspace,
                          "window \(w.id) of \(w.app) holds a sheet your action didn't raise, and \(w.app) also has windows you may not use, so the sheet may be Donovan's (rule 2)",
                          suggestion: "Leave it for Donovan; work in another window until the sheet closes.", retry: .never)
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
        // A sheet or dialog whose window is known belongs to that window: when it is not one the agent may use, the child
        // is Donovan's, whoever acted last. Attribution only settles a child whose window is unknown.
        if let p = c.parent, !usable.contains(where: { $0.window.id == p }) {
            return .refused(.ownership, HandsError(.outsideAgentWorkspace,
                "window \(c.id) is a \(kindName) of \(c.app) on window \(p), which is not one you may use, so it is Donovan's (rule 2)",
                suggestion: "Leave it for Donovan. Work in a window of yours meanwhile.", retry: .never))
        }
        // A child whose window is unknown is the agent's only when every window of that process is: on a split app it may
        // be Donovan's, whatever the timing says.
        if c.parent == nil, !all {
            return .refused(.ownership, HandsError(.outsideAgentWorkspace,
                "window \(c.id) is a \(kindName) of \(c.app), which also has windows you may not use, and which window it belongs to is unknown, so it may be Donovan's (rule 2)",
                suggestion: "Leave it for Donovan. Work in a window of yours meanwhile.", retry: .never))
        }
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
    struct Action: Equatable, Sendable { var session: String; var at: Date; var before: Set<UInt32>; var sheetsBefore: Set<UInt32> = [] }
    struct Seen: Equatable, Sendable { var pid: Int32; var session: String?; var at: Date; var parent: UInt32? = nil }
    /// The actions on each pid within the last 10 s (first-F3: two sessions acting on one app).
    private var actions: [Int32: [Action]] = [:]
    private var seen: [UInt32: Seen] = [:]
    /// Sheets with no window number of their own, by the placed window that holds them; cleared when the sheet closes.
    private var sheets: [UInt32: Seen] = [:]

    public init() {}

    /// `session` is about to act on `pid`, which has these child windows now.
    public mutating func acted(session: String, pid: Int32, at: Date, existing: Set<UInt32>, sheetsOn: Set<UInt32> = []) {
        actions[pid] = (actions[pid] ?? []).filter { at.timeIntervalSince($0.at) <= ChildWindowRule.attributionWindow }
        // One already there but not yet seen is judged by the earlier actions, before this one counts.
        for id in existing where seen[id] == nil { seen[id] = Seen(pid: pid, session: owner(pid: pid, at: at) { $0.before.contains(id) }, at: at) }
        for id in sheetsOn where sheets[id] == nil { sheets[id] = Seen(pid: pid, session: owner(pid: pid, at: at) { $0.sheetsBefore.contains(id) }, at: at) }
        actions[pid]?.append(Action(session: session, at: at, before: existing, sheetsBefore: sheetsOn))
    }

    /// The placed windows of `pid` that hold a sheet with no number of their own at `at`. A sheet first seen within 10 s after
    /// an action, and not there before it, is that action's session's; one that closed is forgotten.
    public mutating func observedSheets(on: Set<UInt32>, pid: Int32, at: Date) {
        sheets = sheets.filter { $0.value.pid != pid || on.contains($0.key) }
        for id in on where sheets[id] == nil {
            sheets[id] = Seen(pid: pid, session: owner(pid: pid, at: at) { $0.sheetsBefore.contains(id) }, at: at)
        }
    }

    /// The one session whose action, within 10 s before `at`, may have raised something not there before it; nil when none
    /// did or when several sessions did (whose it is can't be told).
    private func owner(pid: Int32, at: Date, wasThere: (Action) -> Bool) -> String? {
        let who = Set((actions[pid] ?? []).filter { !wasThere($0) && at >= $0.at && at.timeIntervalSince($0.at) <= ChildWindowRule.attributionWindow }.map(\.session))
        return who.count == 1 ? who.first : nil
    }

    /// Whether this session's action raised the sheet now on window `id`. False when unsure (never seen).
    public func sheetAttributed(on id: UInt32, pid: Int32, session: String) -> Bool {
        guard !session.isEmpty, let s = sheets[id], s.pid == pid else { return false }
        return s.session == session
    }

    /// The child windows `pid` has at `at`. Each one seen for the first time is the acting session's, when exactly one session
    /// acted within the window before it and it was not there then; otherwise nobody's, for good.
    /// `parents` is each child's window as known when it is first seen: its own (a sheet's window, AXParent) or else the app's
    /// main or focused window at that moment. Kept, so a later look still knows which window raised it.
    public mutating func observed(_ ids: Set<UInt32>, pid: Int32, at: Date, parents: [UInt32: UInt32] = [:]) {
        for id in ids where seen[id] == nil {
            seen[id] = Seen(pid: pid, session: owner(pid: pid, at: at) { $0.before.contains(id) }, at: at, parent: parents[id])
        }
        if seen.count > 2048 { seen = seen.filter { at.timeIntervalSince($0.value.at) < 3600 } }
    }

    /// The window it belonged to when first seen, when that was known.
    public func parent(of id: UInt32, pid: Int32) -> UInt32? {
        guard let s = seen[id], s.pid == pid else { return nil }
        return s.parent
    }

    /// Whether this session's action raised it.
    public func attributed(_ id: UInt32, pid: Int32, session: String) -> Bool {
        guard !session.isEmpty, let s = seen[id], s.pid == pid else { return false }
        return s.session == session
    }

    /// Whether a watch should still be looking at `pid` for this session's action.
    public func watching(pid: Int32, now: Date) -> Bool {
        actions[pid]?.last.map { now.timeIntervalSince($0.at) <= ChildWindowRule.attributionWindow } ?? false
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
/// The `note` of an `open` that identified no window: plain that none was, and why.
public enum OpenNote {
    public static func text(_ start: SessionWindows.OpenStart, app: String) -> String {
        switch start {
        case .owns: return "Polycarp couldn't identify the window this open made yet, so this session owns none of it for now; if it appears within 30 s it becomes yours. Run `polycarp-spaces agent windows`"
        case .noSession: return "Polycarp couldn't identify the window this open made yet; this open had no session, so no window of it is anyone's. Run `polycarp-spaces agent windows`"
        case .overlap: return "Polycarp identified no window for this open: another open of \(app) is still waiting for its window or overlapped one in the last 30 s, so it can't tell whose new window is whose and gives it to neither; you may still use it, but `close` won't close it"
        }
    }
}

public struct SessionWindows: Equatable, Sendable {
    private var opened: [String: [UInt32: Int32]] = [:]
    public init() {}

    public mutating func record(session: String, window: UInt32, pid: Int32) {
        guard !session.isEmpty else { return }
        opened[session, default: [:]][window] = pid
    }

    /// The session that owns this window, if any.
    public func owner(of window: UInt32) -> String? { opened.first { $0.value[window] != nil }?.key }

    /// One `open` request and the launch it made, from just after the launch until it owns a window, is cleared, or its
    /// pending life (30 s after it ended) runs out. A request is tied to its own launch: one that started a new process
    /// (`separate`) matches only windows of that process; one that asked an already running app (one pid for everyone) may
    /// take a window only while it is the only request for that app, and two overlapping requests for it get nothing.
    public struct OpenRequest: Equatable, Sendable {
        public var id: Int
        public var session: String
        /// The app, as `open` keys it (bundle id, or name), lowercased.
        public var app: String
        public var separate: Bool
        /// The process the launch started (separate, known once the launch completes), or the running app's.
        public var pid: Int32?
        /// The windows that existed before the launch: never its window.
        public var known: Set<UInt32>
        public var at: Date
        /// The `open` has replied without a window; the request waits for it.
        public var pending: Bool
    }
    public static let pendingLife: TimeInterval = 30
    public private(set) var requests: [OpenRequest] = []
    /// Running apps whose new windows are in doubt after overlapping opens, until this time: no open owns one meanwhile.
    public private(set) var disputed: [String: Date] = [:]

    private mutating func expire(now: Date) { requests.removeAll { $0.pending && now.timeIntervalSince($0.at) > Self.pendingLife } }

    /// How a launch was registered. An overlap with another request for the same running app clears that request too (both
    /// report `window_identified: false`).
    /// sol-F2: the reply key the session's `open` sets when it asked the app for no window (a running app with no New Window
    /// command and no files). Such an open registers no claim, so no later window of that app becomes the session's.
    public static let noWindowKey = "no_window"
    public static func asksForWindow(_ info: [String: String]?) -> Bool { info?[noWindowKey] != "1" }

    public enum OpenStart: Equatable, Sendable {
        /// Its window, when found, is recorded for its session.
        case owns
        /// No session: its window is still looked for by the same rules and reported, but owned by nobody.
        case noSession
        /// It overlapped another open of the same running app (now or in the 30 s before): nothing is looked for.
        case overlap
    }

    @discardableResult
    public mutating func beginOpen(id: Int, session: String, app: String, separate: Bool, pid: Int32?, known: Set<UInt32>, at: Date) -> OpenStart {
        expire(now: at)
        let key = app.lowercased()
        disputed = disputed.filter { $0.value > at }
        if !separate, disputed[key] != nil || requests.contains(where: { $0.app == key && !$0.separate }) {
            // Overlapping opens of one running app: whose new window is whose can't be told, now or for the next 30 s (a
            // late window of the cleared ones may still come), so no open of it owns one until then.
            requests.removeAll { $0.app == key && !$0.separate }
            disputed[key] = at.addingTimeInterval(Self.pendingLife)
            return .overlap
        }
        requests.append(OpenRequest(id: id, session: session, app: key, separate: separate, pid: pid, known: known, at: at, pending: false))
        return session.isEmpty ? .noSession : .owns
    }

    /// The process a separate launch started, once its completion reports it.
    public mutating func launched(_ id: Int, pid: Int32) {
        if let i = requests.firstIndex(where: { $0.id == id && $0.separate }) { requests[i].pid = pid }
    }

    /// The window this request may take from `windows` (the app's windows on the agent workspace now), or nil.
    private func pick(_ r: OpenRequest, from windows: [HandsWindow], newest: Bool) -> HandsWindow? {
        if !r.separate, requests.contains(where: { $0.id != r.id && $0.app == r.app && !$0.separate }) { return nil }
        if !r.separate, let until = disputed[r.app], until > r.at { return nil }
        let ok = windows.filter { w in
            !r.known.contains(w.id) && owner(of: w.id) == nil && (r.separate ? r.pid == w.pid : (r.pid == nil || r.pid == w.pid))
        }
        return newest ? ok.max { $0.id < $1.id } : ok.min { $0.id < $1.id }
    }

    /// The claim of an `open` still looking for its window: recorded for its session, and the request is done.
    public mutating func claim(_ id: Int, windows: [HandsWindow], now: Date) -> HandsWindow? {
        expire(now: now)
        guard let r = requests.first(where: { $0.id == id && !$0.pending }), let w = pick(r, from: windows, newest: true) else { return nil }
        record(session: r.session, window: w.id, pid: w.pid)  // nothing is recorded for no session
        requests.removeAll { $0.id == id }
        return w
    }

    /// The `open` replied without a window: its request stays, pending, for the window that may still come.
    public mutating func endOpen(_ id: Int) {
        // A request with no session stays only to count toward an overlap; resolvePending skips it.
        if let i = requests.firstIndex(where: { $0.id == id }) { requests[i].pending = true }
    }

    /// The launch failed or was refused: nothing of it is anyone's.
    public mutating func cancelOpen(_ id: Int) { requests.removeAll { $0.id == id } }

    /// Gives each pending request of `app` its own launch's window from `windows`, when it has appeared.
    @discardableResult
    public mutating func resolvePending(app: String, windows: [HandsWindow], now: Date) -> [(session: String, window: HandsWindow)] {
        expire(now: now)
        var given: [(session: String, window: HandsWindow)] = []
        for r in requests where r.pending && r.app == app.lowercased() && !r.session.isEmpty {
            guard let w = pick(r, from: windows, newest: false) else { continue }
            record(session: r.session, window: w.id, pid: w.pid)
            requests.removeAll { $0.id == r.id }
            given.append((r.session, w))
        }
        return given
    }

    /// The low-level exclusive claim: the newest of `candidates` no other session owns, recorded for `session`.
    public mutating func claim(_ candidates: [HandsWindow], session: String) -> HandsWindow? {
        guard !session.isEmpty else { return nil }
        let free = candidates.filter { w in owner(of: w.id).map { $0 == session } ?? true }
        guard let pick = free.max(by: { $0.id < $1.id }) else { return nil }
        record(session: session, window: pick.id, pid: pick.pid)
        return pick
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

/// How the collector finds each child window's parent (`ChildWindowsAX.read`): every window the app lists is looked at
/// first, and only then are children built, so a sheet listed before its window still gets that window.
public enum ChildCollect {
    public struct Listed: Equatable, Sendable {
        public var id: UInt32
        /// Placed by BaneySpaces (a document window), so it can be a parent.
        public var placed: Bool
        /// The sheets attached to it that have a window number of their own.
        public var sheets: [UInt32]
        /// Its AXParent, when that is a window.
        public var axParent: UInt32?
        public init(id: UInt32, placed: Bool, sheets: [UInt32] = [], axParent: UInt32? = nil) {
            self.id = id; self.placed = placed; self.sheets = sheets; self.axParent = axParent
        }
    }

    public struct Child: Equatable, Sendable {
        public var id: UInt32
        /// Its own window: a sheet's, or AXParent. Nil when unknown.
        public var parent: UInt32?
        public init(id: UInt32, parent: UInt32?) { self.id = id; self.parent = parent }
    }

    /// The children, in listing order, each with its parent once every listed window has been seen.
    public static func assemble(_ listed: [Listed]) -> [Child] {
        let placed = Set(listed.filter(\.placed).map(\.id))
        var sheetOf: [UInt32: UInt32] = [:]
        for w in listed where w.placed { for s in w.sheets where s != w.id && sheetOf[s] == nil { sheetOf[s] = w.id } }
        var out: [Child] = [], seen = Set<UInt32>()
        func add(_ id: UInt32, axParent: UInt32?) {
            guard !placed.contains(id), seen.insert(id).inserted else { return }
            let ax = axParent.flatMap { placed.contains($0) && $0 != id ? $0 : nil }
            out.append(Child(id: id, parent: sheetOf[id] ?? ax))
        }
        for w in listed {
            if w.placed { for s in w.sheets { add(s, axParent: nil) } } else { add(w.id, axParent: w.axParent) }
        }
        return out
    }

    /// The parent an unattached child is first seen with: the app's main window, only when it is also the focused window
    /// and one the session may use. Otherwise unknown (refused on a split app).
    public static func hint(main: UInt32?, focused: UInt32?, usable: Set<UInt32>) -> UInt32? {
        guard let main, main == focused, usable.contains(main) else { return nil }
        return main
    }
}

/// `move`, `arrange` and `close`, at the moment they change something: the acting mode (Read Only refuses), every target's
/// live window, scope and in-use condition, all read in the one main-thread pass that makes the change. Nothing is changed
/// unless every target passes, so `arrange` applies all of its frames or none.
public struct MutationTarget: Equatable, Sendable {
    public var window: HandsWindow
    /// The window now; nil when it is gone.
    public var live: HandsWindow?
    public var scope: ScopeDecision
    /// The in-use refusal when Donovan is using the app now.
    public var inUse: HandsError?
    public init(window: HandsWindow, live: HandsWindow?, scope: ScopeDecision, inUse: HandsError?) {
        self.window = window; self.live = live; self.scope = scope; self.inUse = inUse
    }
}

public enum MutationGate {
    public static func refusal(mode: AgentAccessMode, targets: [MutationTarget]) -> HandsError? {
        if let e = AgentAccessGate.actingRefusal(mode: mode) { return e }
        for t in targets {
            guard let live = t.live else {
                return HandsError(.windowNotFound, "window \(t.window.id) is gone", suggestion: "Run `polycarp-spaces agent windows`.", retry: .afterSnapshot)
            }
            guard live.pid == t.window.pid else {
                return HandsError(.staleRef, "window \(t.window.id) belongs to a different process now", suggestion: "Take a new snapshot.", retry: .afterSnapshot)
            }
            if case .denied(let e) = t.scope { return e }
            if let e = t.inUse { return e }
        }
        return nil
    }

    /// Runs `perform` only when nothing refuses.
    public static func run<T>(mode: AgentAccessMode, targets: [MutationTarget], perform: () -> Result<T, HandsError>) -> Result<T, HandsError> {
        if let e = refusal(mode: mode, targets: targets) { return .failure(e) }
        return perform()
    }
}
