import Foundation

/// A window an app raises to ask you something: a dialog, an alert, a modal panel. It belongs to
/// the app's own windows, not to whatever workspace you happen to be on.
///
/// Found live (Donovan, 2026-11-10): Word, lent to an agent, had its document on the agent
/// workspace while you were on another one. Word asked for you once a minute, which macOS showed as
/// Word's icon popping out of the hidden macOS Dock, and its modal dialog then opened on the
/// workspace you were using. Polycarp left both alone: a dialog is not a window it places, and
/// nothing told you which workspace was waiting.
public enum WaitingWindow {
    /// What a scan read about one listed element that may ask for you.
    public struct Seen: Equatable, Sendable {
        public let id: UInt32
        public let pid: Int32
        public let subrole: String?
        public let modal: Bool?
        public init(id: UInt32, pid: Int32, subrole: String?, modal: Bool?) {
            self.id = id
            self.pid = pid
            self.subrole = subrole
            self.modal = modal
        }
    }

    /// Whether the element waits on you rather than being a window you work in. A readable modal
    /// flag decides: an About box, a Settings window or a Find panel is an `AXDialog` that blocks
    /// nothing, and marking a tile for it would send you to a workspace for nothing. Only when the
    /// flag can't be read does the subrole stand in: a dialog or alert is taken to wait on you.
    public static func asks(subrole: String?, modal: Bool?) -> Bool {
        if let modal { return modal }
        return subrole == "AXDialog" || subrole == "AXSystemDialog"
    }

    /// Where a waiting window belongs.
    public enum Place: Equatable, Sendable {
        /// Not one that waits on you, or its app has no placed window to belong to.
        case ordinary
        /// With its app's window on a workspace in sight: it stays there, beside it.
        case withParent(Int)
        /// Its app's windows are all on workspaces out of sight. It is not brought into view and
        /// you are not taken there; the dock marks that workspace instead.
        case needsAttention(Int)
    }

    /// `parents` are the workspaces holding the app's placed windows; `shown` the workspaces in
    /// sight; `recent` the workspaces most recently visited first, to pick among several.
    public static func place(asks: Bool, parents: Set<Int>, shown: Set<Int>, recent: [Int]) -> Place {
        guard asks, !parents.isEmpty else { return .ordinary }
        if let here = (recent.first { parents.contains($0) && shown.contains($0) }) ?? parents.filter(shown.contains).min() {
            return .withParent(here)
        }
        return .needsAttention(recent.first(where: parents.contains) ?? parents.min()!)
    }

    /// Whether an agent's claim for an app's next window may take this one. A window that waits
    /// on you is never sent off on its own: it stays with its app's windows.
    public static func claimTakes(subrole: String?, modal: Bool?) -> Bool { !asks(subrole: subrole, modal: modal) }

    /// Whether a claim keeps this window. A process an agent started is the agent's, all of it:
    /// its modal goes with the claim (to the agent workspace) instead of staying on yours.
    public static func claimKeeps(agentStartedProcess: Bool, subrole: String?, modal: Bool?) -> Bool {
        agentStartedProcess || claimTakes(subrole: subrole, modal: modal)
    }
}

/// The quiet mark on a dock tile whose workspace has a window waiting on you (`WaitingWindow`).
public enum DockAttention {
    public struct Mark: Hashable, Sendable {
        public let pid: Int32
        public let app: String
        public let workspace: Int
        /// The waiting window, brought to the front when you click the tile.
        public let window: UInt32
        public init(pid: Int32, app: String, workspace: Int, window: UInt32) {
            self.pid = pid
            self.app = app
            self.workspace = workspace
            self.window = window
        }
    }

    /// The marks for what a scan saw: one per app (its first waiting window), only for apps whose
    /// windows are all out of sight. `parents` maps each app to the workspaces of its placed windows.
    public static func marks(_ seen: [WaitingWindow.Seen], names: [Int32: String], parents: [Int32: Set<Int>],
                             shown: Set<Int>, recent: [Int]) -> [Mark] {
        var out: [Int32: Mark] = [:]
        for s in seen.sorted(by: { $0.id < $1.id }) where out[s.pid] == nil {
            let place = WaitingWindow.place(asks: WaitingWindow.asks(subrole: s.subrole, modal: s.modal),
                                            parents: parents[s.pid] ?? [], shown: shown, recent: recent)
            if case .needsAttention(let n) = place {
                out[s.pid] = Mark(pid: s.pid, app: names[s.pid] ?? "App", workspace: n, window: s.id)
            }
        }
        return out.values.sorted { ($0.workspace, $0.pid) < ($1.workspace, $1.pid) }
    }

    /// What VoiceOver says for a marked tile, and the tile's tooltip.
    public static func label(app: String, workspace: Int) -> String { "\(app) needs you on workspace \(workspace)" }

    /// The `trace.log` lines for marks that appeared and went away since the last look.
    public static func traceLines(from old: [Mark], to new: [Mark]) -> [String] {
        let before = Set(old), after = Set(new)
        let set = new.filter { !before.contains($0) }.map { "dock attention set: \($0.app) needs you on workspace \($0.workspace) (window \($0.window))" }
        let cleared = old.filter { !after.contains($0) }.map { "dock attention cleared: \($0.app) on workspace \($0.workspace) (window \($0.window))" }
        return set + cleared
    }
}
