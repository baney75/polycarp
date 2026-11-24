import Foundation

/// The agent workspace API (docs/agent-workspace-api.md): two operations on the session socket, for the helpers of an
/// agent (a computer-use client) that run apps on Polycarp's agent workspace. `windows` lists the windows there; `move`
/// sends one window there. Nothing else: computer use (reading, clicking, typing into apps) is the client's, not Polycarp's.
/// Pure: the app answers with these replies, and the command and the tests decode them the same way.
public enum AgentAPI {
    public static let version = 2

    /// What an error reply carries in `info["code"]`.
    public enum Code: String, Sendable, CaseIterable {
        /// No agent workspace is set: `polycarp-spaces agent on [N]` sets one.
        case agentWorkspaceOff = "agent_workspace_off"
        /// `move` named no window number, or something else.
        case badRequest = "bad_request"
        /// `move` named a window Polycarp doesn't place (closed, its process gone, or never seen).
        case noSuchWindow = "no_such_window"
        /// `move` named a window on another workspace whose app has run for over `freshProcess` seconds: Donovan's own.
        case refused
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

    /// A window `move` was asked for, as the app places it now: its workspace, its process, and when that process started
    /// (nil when it can't be read).
    public struct Candidate: Equatable, Sendable {
        public var workspace: Int
        public var pid: Int32
        public var started: Date?
        public init(workspace: Int, pid: Int32, started: Date?) { self.workspace = workspace; self.pid = pid; self.started = started }
    }

    /// How new a process must be for `move` to take one of its windows off another workspace. An agent moves an app it has
    /// just started; Donovan's own apps, running longer, stay where he put them.
    public static let freshProcess: TimeInterval = 60

    /// `move <window>`: one window number, a live window Polycarp places, and an agent workspace to send it to. A window on
    /// another workspace moves only when its process started in the last `freshProcess` seconds; one already on the agent
    /// workspace always may (a reframe).
    public static func move(args: [String], agentWorkspace: Int?, window: (UInt32) -> Candidate?,
                            alive: (Int32) -> Bool = AgentStatusRows.processAlive, now: Date = Date()) -> Move {
        guard let n = agentWorkspace else { return .refused(off) }
        guard args.count == 1, let id = UInt32(args[0]) else {
            return .refused(refusal(.badRequest, "usage: polycarp-spaces agent move <window number>"))
        }
        // The model keeps a window of a process that quit until the next scan (#311): that one is gone too.
        guard let w = window(id), alive(w.pid) else { return .refused(refusal(.noSuchWindow, "no window \(id) on any workspace")) }
        guard w.workspace == n || w.started.map({ now.timeIntervalSince($0) <= freshProcess }) == true else {
            return .refused(refusal(.refused, "window \(id) is on workspace \(w.workspace) and its app has run for over a minute; only a window of an app started in the last \(Int(freshProcess)) s moves to the agent workspace"))
        }
        return .move(window: id, to: n)
    }

    /// The record an older Polycarp saved (`moved-in.json`) of windows an agent moved onto the agent workspace, each sent back
    /// when the lend or Full Access that let it move ended. Both are gone, so at launch each one still there goes back once.
    public enum OldMovedIn {
        public struct Entry: Decodable, Equatable, Sendable {
            public var window: UInt32
            public var pid: Int32
            public var from: Int
            public var to: Int
            public init(window: UInt32, pid: Int32, from: Int, to: Int) { self.window = window; self.pid = pid; self.from = from; self.to = to }
        }

        public static func decode(_ data: Data) -> [Entry] { (try? JSONDecoder().decode([Entry].self, from: data)) ?? [] }

        /// Where one goes: the workspace it came from, or Donovan's current one when that is gone or is the agent workspace now.
        public static func destination(_ e: Entry, workspaces: Set<Int> = Set(Workspaces.range), current: Int, agentWorkspace: Int?) -> Int {
            workspaces.contains(e.from) && e.from != agentWorkspace ? e.from : current
        }

        /// The moves to make: each entry whose window still runs in the same process and still sits where the agent put it.
        public static func sendBack(_ entries: [Entry], window: (UInt32) -> Candidate?, alive: (Int32) -> Bool = AgentStatusRows.processAlive,
                                    current: Int, agentWorkspace: Int?) -> [(window: UInt32, to: Int)] {
            entries.sorted { $0.window < $1.window }.compactMap { e in
                guard let w = window(e.window), w.pid == e.pid, alive(w.pid), w.workspace == e.to else { return nil }
                return (window: e.window, to: destination(e, current: current, agentWorkspace: agentWorkspace))
            }
        }
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
