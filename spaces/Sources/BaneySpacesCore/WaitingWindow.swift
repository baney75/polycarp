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
    /// nothing, and keeping it beside its app would hold an ordinary window back. Only when the
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
        /// Its app's windows are all on workspaces out of sight. It joins the workspace named here;
        /// it is not brought into view and you are not taken there.
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
