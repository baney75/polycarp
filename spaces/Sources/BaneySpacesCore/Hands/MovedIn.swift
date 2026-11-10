import Foundation

/// Windows an agent moved onto the agent workspace with `move`. Such a window is still Donovan's: being on the agent
/// workspace grants it nothing. It is usable only while the scope that let it move still holds (the lend, or Full
/// Access), and when that scope ends it is denied and goes back to the workspace it came from (`settle`); the entry is
/// dropped only once the window is read back off the agent workspace (`returned`). The book is saved, so a relaunch keeps
/// it (`launch`). Windows Donovan put on the agent workspace himself, and windows of processes Polycarp started for an
/// agent, are never in this book.
public struct MovedInWindows: Equatable, Sendable {
    public enum Origin: String, Codable, Sendable { case lent, fullAccess = "full_access" }

    public struct Entry: Equatable, Codable, Sendable {
        public var window: UInt32
        public var pid: Int32
        /// The process's start time, so a reused pid never matches. Nil when it could not be read: such an entry is dropped
        /// at the next launch.
        public var startedAt: Double?
        public var origin: Origin
        /// The workspace it was on before the move, and the agent workspace it went to.
        public var from: Int
        public var to: Int
        /// Its origin ended and it is on its way back: denied until it is read back off `to`.
        public var returning: Bool
        public init(window: UInt32, pid: Int32, startedAt: Double? = nil, origin: Origin, from: Int, to: Int, returning: Bool = false) {
            self.window = window; self.pid = pid; self.startedAt = startedAt; self.origin = origin; self.from = from; self.to = to
            self.returning = returning
        }
    }

    public private(set) var entries: [UInt32: Entry] = [:]
    public init() {}
    public init(entries: [Entry]) { for e in entries { self.entries[e.window] = e } }

    /// The origin a `move` with this scope records, or nil when the window needs no entry: one already on the agent
    /// workspace, or one of a process Polycarp started for an agent.
    public static func origin(scope: ScopeDecision, agentOwned: Bool) -> Origin? {
        guard !agentOwned else { return nil }
        switch scope {
        case .lent: return .lent
        case .fullAccess: return .fullAccess
        default: return nil
        }
    }

    /// Records a move. A nil origin records nothing.
    public mutating func record(window: UInt32, pid: Int32, startedAt: Double? = nil, origin: Origin?, from: Int, to: Int) {
        guard let origin else { return }
        entries[window] = Entry(window: window, pid: pid, startedAt: startedAt, origin: origin, from: from, to: to)
    }

    public func entry(for w: HandsWindow) -> Entry? {
        guard let e = entries[w.id], e.pid == w.pid else { return nil }
        return e
    }

    /// Whether the scope that let it onto the agent workspace still holds now. A lend of the window always counts (he lent
    /// it); Full Access counts only for what Full Access brought over.
    public static func holds(_ e: Entry, lends: LendBook, now: Date, mode: AgentAccessMode) -> Bool {
        if e.returning { return false }
        let w = HandsWindow(id: e.window, pid: e.pid, app: "", workspace: nil)
        if lends.isLent(w, now: now) { return true }
        return e.origin == .fullAccess && mode == .full
    }

    /// The scope for a window, given what `ScopeGuard` said. Only `.onAgentWorkspace` for a moved-in window changes:
    /// denied once its origin ends, and while it is on its way back.
    public func decide(_ w: HandsWindow, base: ScopeDecision, lends: LendBook, now: Date, mode: AgentAccessMode) -> ScopeDecision {
        guard base == .onAgentWorkspace, let e = entry(for: w), !Self.holds(e, lends: lends, now: now, mode: mode) else { return base }
        let what = e.origin == .lent ? "while \(w.app) was lent, and the lend has ended" : "under Full Access, and agent access is \(mode.title) now"
        return .denied(HandsError(.needsLend, "window \(w.id) of \(w.app) was moved to the agent workspace \(what)",
                                  suggestion: "It goes back to Donovan's workspace \(e.from). Work in a window `polycarp-spaces agent open` made, or ask Donovan to lend \(w.app) again.",
                                  retry: .never))
    }

    /// Marks every entry whose origin has ended as returning, and returns all returning entries (new and earlier ones not yet
    /// read back). The caller sends back each one still on `to`, then calls `returned` once it reads it back off `to`; one
    /// Donovan has moved since is read back as returned.
    public mutating func settle(lends: LendBook, now: Date, mode: AgentAccessMode) -> [Entry] {
        for (id, e) in entries where !Self.holds(e, lends: lends, now: now, mode: mode) { entries[id]?.returning = true }
        return entries.values.filter(\.returning).sorted { $0.window < $1.window }
    }

    /// The window was read back off the agent workspace it was moved to: the entry is done.
    public mutating func returned(window: UInt32) { entries[window] = nil }

    /// Drops the entry of a process that has quit.
    public mutating func drop(window: UInt32) { entries[window] = nil }

    /// What a launch does with the saved entries, before any agent request: an entry whose process is gone (no start time,
    /// or a different one) is dropped; one whose origin no longer holds is kept as returning, denied and sent back; the
    /// rest are kept as they were.
    public struct Launch: Equatable, Sendable {
        public var keep: [Entry]
        public var sendBack: [Entry]
        public var drop: [Entry]
        public var book: MovedInWindows { MovedInWindows(entries: keep + sendBack) }
    }

    public static func launch(_ saved: [Entry], startTime: (Int32) -> Double?, lends: LendBook, now: Date, mode: AgentAccessMode) -> Launch {
        var out = Launch(keep: [], sendBack: [], drop: [])
        for var e in saved.sorted(by: { $0.window < $1.window }) {
            guard let was = e.startedAt, let t = startTime(e.pid), abs(t - was) < 0.5 else { out.drop.append(e); continue }
            if holds(e, lends: lends, now: now, mode: mode) { out.keep.append(e) } else { e.returning = true; out.sendBack.append(e) }
        }
        return out
    }

    /// Where an ended entry goes: the workspace it came from, or Donovan's current one when that is gone or is the agent
    /// workspace now.
    public static func destination(_ e: Entry, workspaces: Set<Int>, current: Int, agentWorkspace: Int?) -> Int {
        workspaces.contains(e.from) && e.from != agentWorkspace ? e.from : current
    }

    /// The saved form: every entry, as JSON.
    public func encoded() -> Data { (try? JSONEncoder().encode(entries.values.sorted { $0.window < $1.window })) ?? Data("[]".utf8) }
    public static func decode(_ data: Data) -> [Entry] { (try? JSONDecoder().decode([Entry].self, from: data)) ?? [] }
}

/// `move`, at the moment it moves: the agent workspace, the live window, its scope and whether the agent workspace is
/// shown, read together after any wait. The destination is the agent workspace as it is now, never the one read before.
public struct MoveState: Equatable, Sendable {
    public var agentWorkspace: Int?
    public var window: HandsWindow?
    public var scope: ScopeDecision
    public var agentShown: Bool
    public init(agentWorkspace: Int?, window: HandsWindow?, scope: ScopeDecision, agentShown: Bool) {
        self.agentWorkspace = agentWorkspace; self.window = window; self.scope = scope; self.agentShown = agentShown
    }
}

public enum MoveDecision {
    public struct Go: Equatable, Sendable {
        public var to: Int
        /// False when it is already there (a reframe).
        public var moves: Bool
        /// The agent workspace changed during the wait.
        public var changed: Bool
        public init(to: Int, moves: Bool, changed: Bool) { self.to = to; self.moves = moves; self.changed = changed }
    }

    public static func decide(before: MoveState, after: MoveState) -> Result<Go, HandsError> {
        guard let w = after.window else {
            return .failure(HandsError(.windowNotFound, "window \(before.window.map { String($0.id) } ?? "?") is gone", suggestion: "Run `polycarp-spaces agent windows`.", retry: .afterSnapshot))
        }
        if let b = before.window, b.pid != w.pid {
            return .failure(HandsError(.staleRef, "window \(w.id) belongs to a different process now", suggestion: "Take a new snapshot.", retry: .afterSnapshot))
        }
        guard let n = after.agentWorkspace else {
            return .failure(HandsError(.agentWorkspaceOff, "the agent workspace was turned off while the move waited", suggestion: "Ask Donovan to run `polycarp-spaces agent on`.", retry: .never))
        }
        if let e = WorkspaceVerbs.moveRefusal(window: w, scope: after.scope, agentWorkspace: n, agentShown: after.agentShown) { return .failure(e) }
        return .success(Go(to: n, moves: w.workspace != n, changed: before.agentWorkspace != n))
    }
}

/// A bounded read of an accessibility tree into `AXNodeInfo`, over any element type so it can be tested. A sheet's or
/// dialog's subtree is read deeper than a window's; whenever any part of it is cut off (more children than `perLevel`, the
/// depth limit reached with children left, the node budget spent, or children that could not be read) it is marked
/// unreadable, so `PanelDetector` fails closed and the sheet is refused. A sheet is allowed only when the read saw all of it.
public enum AXTreeRead {
    public static let perLevel = 40
    public static let budget = 1500
    public static let childDepth = 5

    /// `string(element, attribute)` reads AXRole, AXSubrole, AXIdentifier, AXTitle and AXValue; `children` returns the
    /// element's children and whether they could be read. `deep` forces the sheet or dialog read on the root.
    public static func node<E>(_ root: E, depth: Int, deep rootDeep: Bool? = nil, perLevel: Int = perLevel, budget: Int = budget,
                               childDepth: Int = childDepth, string: (E, String) -> String?, children: (E) -> (list: [E], readable: Bool)) -> AXNodeInfo {
        var left = budget
        func read(_ el: E, depth: Int, strict: Bool) -> AXNodeInfo {
            left -= 1
            let role = string(el, "AXRole")
            let subrole = string(el, "AXSubrole")
            let deep = strict || role == "AXSheet" || subrole == "AXSheet"
            var n = AXNodeInfo(role: role, subrole: subrole, identifier: string(el, "AXIdentifier"), title: string(el, "AXTitle"),
                               value: role == "AXStaticText" ? string(el, "AXValue") : nil)
            let reach = deep && !strict ? childDepth : depth
            guard reach > 0 || deep else { return n }
            let (kids, readable) = children(el)
            if deep && (!readable || left <= 0 || kids.count > perLevel || (reach <= 0 && !kids.isEmpty)) { n.readable = false; return n }
            guard reach > 0 else { return n }
            n.children = kids.prefix(perLevel).map { read($0, depth: reach - 1, strict: deep) }
            if deep && (left <= 0 || n.children.contains { !$0.readable }) { n.readable = false }
            return n
        }
        let subrole = string(root, "AXSubrole")
        let dialog = rootDeep ?? (subrole == "AXDialog" || subrole == "AXSystemDialog" || string(root, "AXRole") == "AXSheet")
        return read(root, depth: dialog ? childDepth : depth, strict: dialog)
    }
}
