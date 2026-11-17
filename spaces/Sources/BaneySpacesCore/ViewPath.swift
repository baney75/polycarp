import Foundation

/// The paths outside the agent API that change what Donovan sees, and who may use each (spec/agent-api.md, "Who
/// reaches what").
///
/// - The URL scheme (`polycarp://switch/2`, `move/3`, `restore`, and the old `baneyspaces://`) answers any process,
///   and a web page after one browser prompt. It follows the agent API's view control rule.
/// - The session socket (`polycarp-spaces switch|move|restore`, `focus`, `send`) trusts every process running as
///   Donovan. It is a convenience channel, not an agent boundary: nothing on it can tell his shell from an agent in
///   that shell, so it is not gated here. Polycarp's own scripts and probes use it.
public enum ViewPath {
    /// The URL commands that change the view. The others (`viewer`, `launcher`, `voice`, `dock`) show Polycarp's own
    /// windows, where every action still takes a key press or a click.
    public static let gatedURLCommands: Set<String> = ["switch", "move", "restore"]

    /// What the view looks like when a URL command arrives.
    public struct View: Equatable, Sendable {
        public var current: Int
        public var shown: Set<Int>
        public var agentWorkspace: Int?
        public init(current: Int, shown: Set<Int>, agentWorkspace: Int?) {
            self.current = current; self.shown = shown; self.agentWorkspace = agentWorkspace
        }
    }

    /// Why the URL command `command` (with workspace `n`) is refused, or nil when it may run. A switch or a restore
    /// always changes what a display shows, so it needs view control. A move takes the focused window off the
    /// workspace in front: onto the agent workspace it waits while that is shown (`in_use`), anywhere else it needs
    /// view control. Commands this does not gate are never refused.
    public static func urlRefusal(_ command: String, _ n: Int, view: View, access: AgentAccessMode, viewControl: Bool) -> HandsError? {
        guard gatedURLCommands.contains(command) else { return nil }
        let what: String
        switch command {
        case "switch": what = "the URL polycarp://switch/\(n)"
        case "move":
            what = "the URL polycarp://move/\(n)"
            switch AgentCommands.need(from: view.current, to: n, agentWorkspace: view.agentWorkspace, shown: view.shown) {
            case .nothing: return nil
            case .notWhileShown: return ViewControl.notWhileShown(what)
            case .viewControl: break
            }
        default: what = "the URL polycarp://restore"
        }
        guard var e = ViewControl.refusal(what, access: access, enabled: viewControl, remote: false) else { return nil }
        e.suggestion = scriptSuggestion
        return e
    }

    public static let scriptSuggestion = "A script on this Mac uses `polycarp-spaces switch|move|restore` on the session socket instead. Only Donovan turns view control on."
}
