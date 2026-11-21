import Foundation

/// `polycarp-spaces purpose|one|day|timer`: the purpose layer on the session socket (`Wire.Request.Op.purpose`), for agents
/// and scripts. Pure: the app answers with these replies, and the command and the tests decode them the same way. Local
/// callers only (`Remote.allows` never lets it through): what a workspace is for is yours to say.
public enum PurposeAPI {
    public static let version = 1

    /// What a request asks. `text` is the subcommand, `args` the rest.
    public enum Ask: Equatable, Sendable {
        case list
        case set(Int, String)
        case clear(Int)
        case one(String)
        case clearOne
        case day
        /// Starts the one-thing timer: these minutes, or `alarm.timerMinutes` when nil.
        case startTimer(Int?)
        case stopTimer
        case timerStatus
        case refused(String)
    }

    public static let usage = "usage: polycarp-spaces purpose list|set <n> <text>|clear <n>, one <text>|--clear, day [--json], timer [minutes]|stop|status [--json]"
    public static let timerUsage = "usage: polycarp-spaces timer [minutes]|stop|status [--json] (minutes from 1 to 240)"

    public static func ask(text: String?, args: [String]) -> Ask {
        let args = args.filter { $0 != "--json" }
        switch text ?? "list" {
        case "list" where args.isEmpty: return .list
        case "set":
            guard args.count >= 2, let n = Int(args[0]) else { return .refused("usage: polycarp-spaces purpose set <n> <text>") }
            let words = args.dropFirst().joined(separator: " ")
            return Purposes.clean(words, limit: .max) == nil ? .clear(n) : .set(n, words)
        case "clear":
            guard args.count == 1, let n = Int(args[0]) else { return .refused("usage: polycarp-spaces purpose clear <n>") }
            return .clear(n)
        case "one":
            if args == ["--clear"] { return .clearOne }
            guard !args.isEmpty, !args.contains("--clear") else { return .refused("usage: polycarp-spaces one <text>|--clear") }
            let words = args.joined(separator: " ")
            return Purposes.clean(words, limit: .max) == nil ? .clearOne : .one(words)
        case "day" where args.isEmpty: return .day
        case "timer":
            switch args {
            case []: return .startTimer(nil)
            case ["stop"]: return .stopTimer
            case ["status"]: return .timerStatus
            default:
                guard args.count == 1, let m = Int(args[0]), OneThingTimer.minutes.contains(m) else { return .refused(timerUsage) }
                return .startTimer(m)
            }
        default: return .refused(usage)
        }
    }

    /// One workspace in `list`.
    public struct Row: Codable, Equatable, Sendable {
        public var workspace: Int
        public var purpose: String?
        public init(workspace: Int, purpose: String?) { self.workspace = workspace; self.purpose = purpose }
    }

    /// `list`, `set`, `clear`, `one`: every workspace (unnamed ones with no purpose) and today's one thing.
    public struct Listing: Codable, Equatable, Sendable {
        public var version = PurposeAPI.version
        public var day: PurposeDay
        public var current: Int
        public var workspaces: [Row]
        public var one: Purposes.OneThing?

        public init(_ p: Purposes, day: PurposeDay, current: Int) {
            self.day = day
            self.current = current
            workspaces = Workspaces.range.map { Row(workspace: $0, purpose: p.purpose(of: $0)) }
            one = p.oneThing(on: day)
        }
    }

    /// `day`: today's time per workspace, most first.
    public struct DayReport: Codable, Equatable, Sendable {
        public struct Entry: Codable, Equatable, Sendable {
            public var workspace: Int
            public var seconds: Int
            public var purpose: String?
        }
        public var version = PurposeAPI.version
        public var day: PurposeDay
        public var total: Int
        public var workspaces: [Entry]

        public init(day: PurposeDay, seconds: [Int: Int], purposes: Purposes) {
            self.day = day
            workspaces = seconds.filter { $0.value > 0 }
                .map { Entry(workspace: $0.key, seconds: $0.value, purpose: purposes.purpose(of: $0.key)) }
                .sorted { ($0.seconds, -$0.workspace) > ($1.seconds, -$1.workspace) }
            total = workspaces.map(\.seconds).reduce(0, +)
        }
    }

    /// `timer`, `timer stop`, `timer status`: the one-thing timer as it is after the ask.
    public struct TimerReport: Codable, Equatable, Sendable {
        public var version = PurposeAPI.version
        public var running: Bool
        public var minutes: Int?
        /// ISO 8601, UTC.
        public var startedAt: String?
        public var endsAt: String?
        /// Whole seconds left.
        public var remaining: Int?
        /// The one thing when the timer started.
        public var oneThing: String?
        /// The length a bare `timer` starts (`alarm.timerMinutes`).
        public var defaultMinutes: Int

        public init(_ timer: OneThingTimer?, now: Date, defaultMinutes: Int) {
            let live = timer.flatMap { $0.done(now: now) ? nil : $0 }
            let iso = ISO8601DateFormatter()
            running = live != nil
            minutes = live?.minutes
            startedAt = live.map { iso.string(from: $0.startedAt) }
            endsAt = live.map { iso.string(from: $0.endsAt) }
            remaining = live.map { Int($0.remaining(now: now).rounded(.down)) }
            oneThing = live?.oneThing
            self.defaultMinutes = defaultMinutes
        }
    }

    /// Answers `ask` from the stores. `current` is the workspace you are on, where `one` is set. `timer` is the one-thing
    /// timer and `timerMinutes` the length a bare `timer` starts. Call on the main thread so the change is announced
    /// before the reply goes out.
    public static func answer(_ ask: Ask, purposes: PurposeStore, ledger: DayLedgerStore, current: Int, now: Date = Date(),
                              timer: OneThingTimerStore? = nil, timerMinutes: Int = Surfaces.defaults.alarm.timerMinutes) -> Wire.Reply {
        do {
            switch ask {
            case .startTimer, .stopTimer, .timerStatus:
                guard let timer else { return .init(ok: false, error: "the timer isn't ready yet; try again in a moment") }
                if case .startTimer(let m) = ask { try timer.start(minutes: m ?? timerMinutes, oneThing: purposes.oneThing?.text, now: now) }
                if case .stopTimer = ask { timer.stop() }
                return reply(TimerReport(timer.timer, now: now, defaultMinutes: timerMinutes), key: "timer")
            case .refused(let why): return .init(ok: false, error: why)
            case .list: break
            case .set(let n, let text): try purposes.setPurpose(text, for: n)
            case .clear(let n): try purposes.setPurpose(nil, for: n)
            case .one(let text): try purposes.setOneThing(text, workspace: current)
            case .clearOne: try purposes.setOneThing(nil, workspace: nil)
            case .day:
                let day = purposes.day
                return reply(DayReport(day: day, seconds: ledger.seconds(on: day), purposes: purposes.snapshot), key: "day")
            }
        } catch let p as Purposes.Problem {
            return .init(ok: false, error: p.description)
        } catch let p as OneThingTimer.Problem {
            return .init(ok: false, error: p.description)
        } catch {
            return .init(ok: false, error: "\(error)")
        }
        return reply(Listing(purposes.snapshot, day: purposes.day, current: current), key: "purposes")
    }

    static func reply(_ value: some Encodable, key: String) -> Wire.Reply {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        let json = (try? enc.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return .init(ok: true, info: ["version": "\(version)", key: json])
    }

    public static func decodeListing(_ reply: Wire.Reply) -> Listing? { decode(reply, key: "purposes") }
    public static func decodeDay(_ reply: Wire.Reply) -> DayReport? { decode(reply, key: "day") }
    public static func decodeTimer(_ reply: Wire.Reply) -> TimerReport? { decode(reply, key: "timer") }

    private static func decode<T: Decodable>(_ reply: Wire.Reply, key: String) -> T? {
        guard reply.ok, let text = reply.info?[key] else { return nil }
        return try? JSONDecoder().decode(T.self, from: Data(text.utf8))
    }

    /// The command's plain lines for a listing.
    public static func lines(_ l: Listing) -> [String] {
        let named = l.workspaces.filter { $0.purpose != nil }
        var out = named.isEmpty ? ["no workspace has a purpose yet (polycarp-spaces purpose set <n> <text>)"]
            : named.map { "\($0.workspace)\($0.workspace == l.current ? "*" : " ") \($0.purpose ?? "")" }
        if let one = l.one {
            out.append("one thing: \(one.text)" + (one.workspace.map { " (set on workspace \($0))" } ?? ""))
        } else {
            out.append("one thing: none today (polycarp-spaces one <text>)")
        }
        return out
    }

    /// The command's plain lines for a day.
    public static func lines(_ d: DayReport) -> [String] {
        guard !d.workspaces.isEmpty else { return ["\(d.day): no time recorded yet"] }
        return ["\(d.day): \(Journal.duration(d.total))"]
            + d.workspaces.map { "  \($0.workspace)  \(Journal.duration($0.seconds))" + ($0.purpose.map { "  \($0)" } ?? "") }
    }

    /// The command's plain line for the timer.
    public static func lines(_ t: TimerReport) -> [String] {
        guard t.running, let left = t.remaining, let minutes = t.minutes else {
            return ["no timer running (polycarp-spaces timer [minutes]; \(t.defaultMinutes) min by default)"]
        }
        return ["timer: \(BarText.timer(remaining: Double(left))) left of \(minutes) min" + (t.oneThing.map { ", on: \($0)" } ?? "")]
    }
}
