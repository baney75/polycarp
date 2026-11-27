import CoreGraphics
import Foundation

/// The tiling probe (spec/tiling-speed.md R-TS12): `polycarp-spaces agent probe` tiles the agent workspace off screen,
/// only while it runs, with windows of a helper copy of the app, and reports the timing lines the actions write. Pure:
/// the area, the arguments, the session's state, the commands it takes and the numbers it prints.
public enum TilingProbe {
    /// The display key the probe's area is shown under (`TilingShot.Place`).
    public static let display: DisplayKey = "probe"
    /// Points between the leftmost display and the probe's area.
    public static let gap = 2000.0
    public static let rounds = 1...10, seconds = 1...300
    public static let standardRounds = 3, standardSeconds = 180
    /// Seconds a sample waits to land before it is a miss.
    public static let wait = 2.0

    /// R-TS12.4: the size of the main display's tiling area, its right edge `gap` left of the leftmost display, its top
    /// at the area's top. In the coordinates TilingView's areas use: the window server's (Accessibility's), from the
    /// main display's top left, y down.
    public static func area(screens: [CGRect], usable: CGRect) -> CGRect {
        let left = screens.map(\.minX).min() ?? usable.minX
        return CGRect(x: left - gap - usable.width, y: usable.minY, width: usable.width, height: usable.height)
    }

    // MARK: Starting

    public struct Ask: Equatable, Sendable {
        public var caller: Int32
        public var rounds: Int
        public var seconds: Int
        public init(caller: Int32, rounds: Int, seconds: Int) { (self.caller, self.rounds, self.seconds) = (caller, rounds, seconds) }
    }

    public enum Start: Equatable, Sendable {
        case go(Ask)
        case refused(Wire.Reply)
    }

    /// R-TS12.2: `start <caller pid> <rounds> <seconds>`. A number missing or empty takes its default.
    public static func start(_ args: [String], agentWorkspace: Int?, running: Bool, active: Bool,
                             alive: (Int32) -> Bool) -> Start {
        func arg(_ i: Int) -> String? { args.count > i && !args[i].isEmpty ? args[i] : nil }
        func bad(_ why: String) -> Start { .refused(AgentAPI.refusal(.badRequest, why)) }
        guard args.first == "start" else { return bad("usage: probe start <caller pid> [rounds] [seconds]") }
        guard let pid = arg(1).flatMap(Int32.init), pid > 0, alive(pid) else { return bad("the caller's pid isn't a running process") }
        let r = arg(2).map { Int($0) } ?? standardRounds, s = arg(3).map { Int($0) } ?? standardSeconds
        guard let r, rounds.contains(r) else { return bad("rounds go from 1 to 10") }
        guard let s, seconds.contains(s) else { return bad("seconds go from 1 to 300") }
        guard agentWorkspace != nil else { return .refused(AgentAPI.off) }
        guard !running else { return .refused(AgentAPI.refusal(.probeBusy, "a probe runs already")) }
        guard active else { return .refused(AgentAPI.refusal(.probeOff, "Polycarp isn't placing windows now")) }
        return .go(Ask(caller: pid, rounds: r, seconds: s))
    }

    // MARK: The session

    public enum Why: String, Sendable { case done, deadline, caller, inactive, workspace, error }

    /// One probe, from its start to its end. Times are seconds on any one clock the caller keeps (the app's uptime).
    public struct Session: Equatable, Sendable {
        public let ask: Ask
        public let workspace: Int
        public let deadline: Double
        public private(set) var why: Why?
        public private(set) var result: String?

        public init(_ ask: Ask, workspace: Int, now: Double) {
            (self.ask, self.workspace, deadline) = (ask, workspace, now + Double(min(ask.seconds, TilingProbe.seconds.upperBound)))
        }

        /// Tiling takes the agent workspace while this is true, and only then (R-TS12.3).
        public var running: Bool { why == nil }

        /// What ends it now, if anything: its deadline, Polycarp leaving active, the agent workspace changing.
        public func check(now: Double, active: Bool, agentWorkspace: Int?) -> Why? {
            guard running else { return nil }
            if agentWorkspace != workspace { return .workspace }
            if !active { return .inactive }
            return now >= deadline ? .deadline : nil
        }

        /// Ends it; false when it had ended already, so the first end holds.
        public mutating func end(_ why: Why, result: String? = nil) -> Bool {
            guard running else { return false }
            (self.why, self.result) = (why, why == .done ? result : nil)
            return true
        }

        /// `status`: `running`, `done` with `result`, or `ended` with `why`.
        public var reply: Wire.Reply {
            switch why {
            case nil: return .init(ok: true, info: ["state": "running"])
            case .done?: return .init(ok: true, info: ["state": "done", "result": result ?? "[]"])
            case let w?: return .init(ok: true, info: ["state": "ended", "why": w.rawValue])
            }
        }
    }

    /// `status` with no probe since the app started: a daemon that restarted has none.
    public static let none = Wire.Reply(ok: true, info: ["state": "ended", "why": Why.error.rawValue])

    // MARK: What it does

    /// The keys a round presses, in order (R-TS12.11).
    public static let keys: [TilingCommand] = TileDirection.allCases.map { .move($0) } + TileDirection.allCases.map { .focus($0) }
        + TileDirection.allCases.map { .grow($0) }

    /// R-TS12.8: focus, move and resize, in four directions. Nothing else runs inside the probe.
    public static func allows(_ c: TilingCommand) -> Bool {
        switch c {
        case .focus, .move, .grow: return true
        default: return false
        }
    }

    /// What the probe does with a command's outcome: look again, or move the engine's focus alone. It never focuses an
    /// app, crosses a display or turns anything on or off.
    public enum Step: Equatable, Sendable {
        case look
        case focus(WindowID)
        case nothing(String)
    }

    public static func step(_ outcome: TilingOutcome) -> Step {
        switch outcome {
        case .changed: return .look
        case .focus(let id): return .focus(id)
        case .nothing(let why): return .nothing(why)
        default: return .nothing("the probe stays on its workspace")
        }
    }

    /// R-TS12.7: new windows of a probe helper join the agent workspace, before any look sees them. The rest go the usual way.
    public static func homes(_ added: [(id: WindowID, pid: Int32)], probe: Set<Int32>, agent: Int?) -> [WindowID: Int] {
        guard let agent else { return [:] }
        return Dictionary(added.filter { probe.contains($0.pid) }.map { ($0.id, agent) }, uniquingKeysWith: { a, _ in a })
    }

    /// R-TS12.7: the window owners a switch's `Concealment` is built from. A probe helper's windows are left out, so a
    /// switch neither hides the helper nor parks them: they stay in the probe area.
    public static func switchOwners(_ owner: [WindowID: Int32], probe: Set<Int32>) -> [WindowID: Int32] {
        probe.isEmpty ? owner : owner.filter { !probe.contains($0.value) }
    }

    // MARK: The numbers

    public enum Kind: String, CaseIterable, Codable, Sendable {
        case focus = "key focus", move = "key move", resize = "key resize", new, close

        public init?(_ c: TilingCommand) {
            switch c {
            case .focus: self = .focus
            case .move: self = .move
            case .grow: self = .resize
            default: return nil
            }
        }
    }

    /// One action's time in ms, nil when it never landed, and the most frames any one window got for it.
    public struct Sample: Equatable, Sendable {
        public var kind: Kind
        public var ms: Double?
        public var writes: Int
        public init(_ kind: Kind, ms: Double?, writes: Int = 0) { (self.kind, self.ms, self.writes) = (kind, ms, writes) }
    }

    public struct Stat: Codable, Equatable, Sendable {
        public var kind: String
        public var n: Int
        public var p50: Int?
        public var p90: Int?
        public var max: Int?
        public var misses: Int
        public var writes: Int
    }

    /// Nearest rank, as `scripts/speed-report.sh` takes it: the smallest value with at least p of them at or below it.
    public static func rank(_ values: [Double], _ p: Double) -> Double? {
        let v = values.sorted()
        return v.isEmpty ? nil : v[Swift.max(0, Int((Double(v.count) * p).rounded(.up)) - 1)]
    }

    /// R-TS12.12: for each kind, its samples, their p50, p90 and max over those that landed, the misses and the writes.
    public static func stats(_ samples: [Sample]) -> [Stat] {
        Kind.allCases.map { k in
            let mine = samples.filter { $0.kind == k }, landed = mine.compactMap(\.ms)
            func ms(_ v: Double?) -> Int? { v.map { Int($0.rounded()) } }
            return Stat(kind: k.rawValue, n: mine.count, p50: ms(rank(landed, 0.5)), p90: ms(rank(landed, 0.9)), max: ms(landed.max()),
                        misses: mine.count - landed.count, writes: mine.map(\.writes).max() ?? 0)
        }
    }

    /// 0 when every sample landed, 1 on any miss.
    public static func code(_ stats: [Stat]) -> Int32 { stats.contains { $0.misses > 0 } ? 1 : 0 }

    public static func json(_ stats: [Stat]) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return (try? enc.encode(stats)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }

    public static func decode(_ json: String) -> [Stat]? { try? JSONDecoder().decode([Stat].self, from: Data(json.utf8)) }
}

extension TilingOptions {
    /// R-TS12.3: settings read again keep a probe that runs, on the same agent workspace only. No settings key turns
    /// one on.
    public func reloaded(_ s: Surfaces.Tiling, agentWorkspace: Int?) -> TilingOptions {
        var o = TilingOptions(s, agentWorkspace: agentWorkspace)
        o.probing = probing && agentWorkspace == self.agentWorkspace
        return o
    }

    /// Why `tile on`, `tile toggle` and Settings never turn workspace `n` on or off: the agent workspace, probe or not.
    public func refusesTurning(_ n: Int) -> String? { n == agentWorkspace ? "the agent workspace never tiles" : nil }
}

extension TilingEngine {
    /// A probe's end: the workspace's layout goes, and what it held of those windows.
    public mutating func dropLayout(of workspace: Int) {
        let ids = Set(slots.filter { $0.key.workspace == workspace }.flatMap { $0.value.all })
        slots = slots.filter { $0.key.workspace != workspace }
        for id in ids { (before[id], asked[id]) = (nil, nil) }
        dropUnneeded()
    }
}
