import Foundation

/// What the "in use" veil over a window shows: who is working in it, and how to draw it for the person's display
/// settings. The renderer is `VeilLayer` (BaneySpacesCursor); `docs/agent-computer-use.md`, "The agent cursor".
public struct VeilLook: Equatable, Sendable {
    public struct Agent: Equatable, Sendable {
        public var name: String
        public var status: DockAgent.State
        public var identity: RGB
        public init(name: String, status: DockAgent.State, identity: RGB) {
            self.name = name; self.status = status; self.identity = identity
        }
        public init(_ look: CursorLook) { self.init(name: look.name, status: look.status, identity: look.identity) }
        public var statusColor: RGB { CursorPalette.status(status) }
        /// The pill's words: "Claude · working".
        public var label: String { name + " · " + VeilLook.word(status) }
    }

    /// Newest first: the first one's colors draw the edge.
    public var agents: [Agent]
    /// Reduce Motion (or a glide preset of `off`): the edge is drawn still, nothing travels or pulses.
    public var still: Bool
    /// Reduce Transparency: no scrim, and the pill is opaque.
    public var solid: Bool
    public init(agents: [Agent], still: Bool = false, solid: Bool = false) {
        self.agents = agents; self.still = still; self.solid = solid
    }

    public static func word(_ s: DockAgent.State) -> String {
        switch s {
        case .working: return "working"
        case .asking: return "needs you"
        case .failed: return "stopped"
        case .done: return "done"
        }
    }

    /// The pill shows at most this many agents; more are counted ("+2").
    public static let maxPills = 3
}
