import Foundation

/// What a tiling look answers, and the timing.log line each answer writes (spec/tiling-speed.md R-TS1, R-TS2). Times
/// are seconds on the system uptime clock, which key events and `ProcessInfo.systemUptime` share.
public struct TileCauses: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case key, new, close
        case `switch`
    }

    public struct Cause: Equatable, Sendable {
        public var kind: Kind
        public var at: Double
        /// The app a `new` window belongs to.
        public var pid: Int32?
        /// The workspace a `close` window left.
        public var workspace: Int?

        public init(_ kind: Kind, at: Double, pid: Int32? = nil, workspace: Int? = nil) {
            (self.kind, self.at, self.pid, self.workspace) = (kind, at, pid, workspace)
        }
    }

    /// A frame a look asks for: the window's app, its workspace, and whether the last look had the window at all.
    public struct Wrote: Equatable, Sendable {
        public var pid: Int32
        public var workspace: Int
        public var new: Bool

        public init(pid: Int32, workspace: Int, new: Bool) { (self.pid, self.workspace, self.new) = (pid, workspace, new) }
    }

    /// How long a cause waits for a look to answer it; a switch's look comes right after it or not at all.
    public static let keep = 3.0, switchKeep = 1.0

    public private(set) var pending: [Cause] = []

    public init() {}

    public mutating func add(_ cause: Cause) { pending.append(cause) }

    /// The causes a look at `now` answers by asking for `wrote` (or, with `focus`, by moving the focus alone), taken off
    /// the list. Causes no look answered in time leave it with no answer.
    public mutating func answer(now: Double, wrote: [Wrote], focus: Bool = false) -> [Cause] {
        pending.removeAll { now - $0.at > ($0.kind == .switch ? Self.switchKeep : Self.keep) }
        var answered: [Cause] = []
        pending.removeAll { c in
            let yes: Bool
            switch c.kind {
            case .key: yes = focus || !wrote.isEmpty
            case .switch: yes = !wrote.isEmpty
            case .new: yes = wrote.contains { $0.new && $0.pid == c.pid }
            case .close: yes = wrote.contains { $0.workspace == c.workspace }
            }
            if yes { answered.append(c) }
            return yes
        }
        return answered
    }

    /// `1795726000 tile=key looked=4 asked=21 landed=140 moves=3`, each mark in ms from the cause; `landed=-` when the
    /// settle never reported.
    public static func line(epoch: Int, _ c: Cause, looked: Double, asked: Double, landed: Double?, moves: Int) -> String {
        func ms(_ t: Double) -> String { String(max(0, Int(((t - c.at) * 1000).rounded()))) }
        return "\(epoch) tile=\(c.kind.rawValue) looked=\(ms(looked)) asked=\(ms(asked)) landed=\(landed.map(ms) ?? "-") moves=\(moves)"
    }
}
