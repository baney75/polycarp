import Foundation

/// Each close and move that tiling answers, and the timing.log line it writes once its writes stop (spec/tiling-speed.md
/// R-TS10). Times are seconds on the system uptime clock, as in `TileCauses`.
public struct TileActions: Equatable, Sendable {
    public enum Kind: String, Sendable { case close, move }

    public struct Action: Equatable, Sendable {
        public var kind: Kind
        /// close: destroyed, minimized, quit or workspace; move: key or drag.
        public var how: String
        /// The cause's time.
        public var at: Double
        /// The workspace whose windows' writes count toward it.
        public var workspace: Int
        /// When the last counted write returned.
        public var last: Double?
        public var writes: [WindowID: Int]
        /// Set once a newer action begins on its workspace after this one had a write: looks that began at or after
        /// it answer the newer one, not this.
        public var until: Double?

        public init(_ kind: Kind, how: String, at: Double, workspace: Int, last: Double? = nil, writes: [WindowID: Int] = [:]) {
            (self.kind, self.how, self.at, self.workspace, self.last, self.writes) = (kind, how, at, workspace, last, writes)
        }
    }

    /// Quiet after a write before the line is written, and the longest an action waits for one.
    public static let quiet = 0.5, keep = 3.0

    public private(set) var open: [Action] = []

    public init() {}

    public mutating func begin(_ kind: Kind, how: String, at: Double, workspace: Int) {
        for i in open.indices where open[i].workspace == workspace && open[i].last != nil && open[i].until == nil { open[i].until = at }
        open.append(Action(kind, how: how, at: at, workspace: workspace))
    }

    /// Frames a look that began at `looked` asked for, back at `at`, each with its window's workspace. A write counts
    /// toward every open action on its workspace whose cause came before that look began, so two closes one look
    /// answers both fill; an action already answered stops at the next action's cause (`until`). A write from a look
    /// before the cause answers something else, so a close no look answered still says `fill=-`.
    public mutating func wrote(_ ids: [(id: WindowID, workspace: Int)], looked: Double, at: Double) {
        for w in ids {
            for i in open.indices where open[i].workspace == w.workspace && open[i].at <= looked && open[i].until.map({ looked < $0 }) ?? true {
                open[i].writes[w.id, default: 0] += 1
                open[i].last = at
            }
        }
    }

    /// The actions finished by `now` (0.5 s quiet after a write, or 3 s after the cause), taken off the list.
    public mutating func due(now: Double) -> [Action] {
        var done: [Action] = []
        open.removeAll { a in
            let over = now - a.at >= Self.keep || a.last.map { now - $0 >= Self.quiet } ?? false
            if over { done.append(a) }
            return over
        }
        return done
    }

    /// `<epoch> close fill=30 writes=2 windows=2 how=destroyed`; `fill=-` when nothing was written.
    public static func line(epoch: Int, _ a: Action) -> String {
        let fill = a.last.map { String(max(0, Int((($0 - a.at) * 1000).rounded()))) } ?? "-"
        return "\(epoch) \(a.kind.rawValue) fill=\(fill) writes=\(a.writes.values.max() ?? 0) windows=\(a.writes.count) how=\(a.how)"
    }
}
