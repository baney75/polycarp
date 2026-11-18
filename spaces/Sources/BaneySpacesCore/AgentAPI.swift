import Foundation

/// The agent workspace API (docs/agent-workspace-api.md): two operations on the session socket, for the helpers of an
/// agent app (Tychicus) that run apps on Polycarp's agent workspace. `windows` lists the windows there; `move` sends one
/// window there. Nothing else: computer use (reading, clicking, typing into apps) lives in Tychicus, not Polycarp.
/// Pure: the app answers with these replies, and the command and the tests decode them the same way.
public enum AgentAPI {
    public static let version = 2

    /// What an error reply carries in `info["code"]`.
    public enum Code: String, Sendable, CaseIterable {
        /// No agent workspace is set: `polycarp-spaces agent on [N]` sets one.
        case agentWorkspaceOff = "agent_workspace_off"
        /// `move` named no window number, or something else.
        case badRequest = "bad_request"
        /// `move` named a window Polycarp doesn't place (closed, or never seen).
        case noSuchWindow = "no_such_window"
    }

    /// One window on the agent workspace.
    public struct Window: Codable, Equatable, Sendable {
        public var id: UInt32
        public var pid: Int32
        public var app: String
        public var title: String
        public init(id: UInt32, pid: Int32, app: String, title: String) {
            self.id = id; self.pid = pid; self.app = app; self.title = title
        }
    }

    public static func refusal(_ code: Code, _ message: String) -> Wire.Reply {
        .init(ok: false, error: message, info: ["code": code.rawValue, "version": "\(version)"])
    }

    static let off = refusal(.agentWorkspaceOff, "the agent workspace is off: polycarp-spaces agent on [N]")

    /// `windows`: every window on the agent workspace, as a JSON array in `info["windows"]`, sorted by id.
    public static func windows(agentWorkspace: Int?, _ list: [Window]) -> Wire.Reply {
        guard let n = agentWorkspace else { return off }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        let json = (try? enc.encode(list.sorted { $0.id < $1.id })).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        return .init(ok: true, info: ["version": "\(version)", "workspace": "\(n)", "windows": json])
    }

    /// What `move` does with its arguments.
    public enum Move: Equatable, Sendable {
        case move(window: UInt32, to: Int)
        case refused(Wire.Reply)
    }

    /// `move <window>`: one window number, a window Polycarp places, and an agent workspace to send it to.
    public static func move(args: [String], agentWorkspace: Int?, places: (UInt32) -> Bool) -> Move {
        guard let n = agentWorkspace else { return .refused(off) }
        guard args.count == 1, let id = UInt32(args[0]) else {
            return .refused(refusal(.badRequest, "usage: polycarp-spaces agent move <window number>"))
        }
        guard places(id) else { return .refused(refusal(.noSuchWindow, "no window \(id) on any workspace")) }
        return .move(window: id, to: n)
    }

    /// The reply to a `move` that went ahead.
    public static func moved(_ id: UInt32, to n: Int) -> Wire.Reply {
        .init(ok: true, info: ["version": "\(version)", "workspace": "\(n)", "window": "\(id)"])
    }

    /// The windows in a `windows` reply, or nil when it holds none to read (an error, or a malformed list).
    public static func decodeWindows(_ reply: Wire.Reply) -> [Window]? {
        guard reply.ok, let text = reply.info?["windows"] else { return nil }
        return try? JSONDecoder().decode([Window].self, from: Data(text.utf8))
    }
}
