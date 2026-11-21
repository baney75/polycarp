import Foundation

/// Seconds spent on each workspace each day, for the evening examen and the day view. Only time you were there counts:
/// not while the screen slept or was locked, and not a stretch of over 5 minutes with no input. Keeps 90 days, stored as
/// ledger.json in the support folder: `{"days":{"2026-11-21":{"1":3600,"3":120}},"version":1}`.
public struct DayLedger: Codable, Equatable, Sendable {
    public static let schema = 1
    public static let keepDays = 90

    public var version = DayLedger.schema
    /// Day to workspace number to seconds, both keys as text so the file stays a plain JSON object.
    private var days: [String: [String: Int]] = [:]

    public init() {}

    private enum CodingKeys: String, CodingKey { case version, days }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? Self.schema
        // Entries that aren't a day, a workspace or a positive count are dropped, not fatal.
        for (d, row) in try c.decodeIfPresent([String: [String: Int]].self, forKey: .days) ?? [:] {
            guard let day = PurposeDay(d) else { continue }
            let clean = row.filter { k, v in Int(k).map(Workspaces.range.contains) == true && v > 0 }
            if !clean.isEmpty { days[day.description] = clean }
        }
    }

    /// Seconds per workspace on `day`; a workspace with none has no entry.
    public func seconds(on day: PurposeDay) -> [Int: Int] {
        Dictionary(uniqueKeysWithValues: (days[day.description] ?? [:]).compactMap { k, v in Int(k).map { ($0, v) } })
    }

    public func total(on day: PurposeDay) -> Int { (days[day.description] ?? [:]).values.reduce(0, +) }

    /// Every day with time on it, oldest first.
    public var recorded: [PurposeDay] { days.keys.compactMap(PurposeDay.init).sorted() }

    /// Adds the time from `start` to `end` on workspace `n`, split at each day's start so a late night counts for the day
    /// it began in and the rest for the next.
    public mutating func add(_ n: Int, from start: Date, to end: Date, clock: DayClock) {
        guard Workspaces.range.contains(n), end > start else { return }
        var from = start
        while from < end {
            let day = clock.day(of: from)
            let until = min(end, clock.end(of: day))
            // Guards against a calendar that can't move forward, so this always ends.
            guard until > from else { return }
            let secs = Int(until.timeIntervalSince(from).rounded())
            if secs > 0 { days[day.description, default: [:]]["\(n)", default: 0] += secs }
            from = until
        }
    }

    /// Drops days more than `keepDays` before `today`.
    public mutating func prune(today: PurposeDay, clock: DayClock) {
        let oldest = clock.adding(-(Self.keepDays - 1), to: today).description
        days = days.filter { $0.key >= oldest }
    }
}

/// Turns the app's events into ledger time. A value with no clock of its own: every event says when it happened, so
/// tests drive it through any day, zone or DST change.
///
/// Time counts from the last moment counted to the latest input. A pause under 5 minutes counts once input comes back,
/// since reading and thinking are work; a pause of 5 minutes or more counts nothing from the last input on.
public struct LedgerTracker: Equatable, Sendable {
    /// Idle this long and the time since the last input stops counting.
    public static let idleLimit: TimeInterval = 300
    /// One counted stretch never spans longer than this. The app counts every minute, so a longer one means its timer
    /// never fired: the Mac slept in a way the app didn't hear about. Better to drop it than count a night.
    public static let longestStretch: TimeInterval = 600

    /// The workspace you are on, once known.
    public private(set) var workspace: Int?
    /// Counted up to here; nil while nothing counts (asleep, locked, idle, or no workspace known yet).
    public private(set) var since: Date?
    /// The screen sleeps or is locked.
    public private(set) var away = false

    public init() {}

    /// You moved to workspace `n` at `t`. A switch is input, so it counts up to `t` and starts counting there.
    public mutating func switched(to n: Int, at t: Date, ledger: inout DayLedger, clock: DayClock) {
        count(to: t, ledger: &ledger, clock: clock)
        workspace = n
        since = away ? nil : t
    }

    /// The screen slept, the Mac slept or the session locked at `t`, with `idle` seconds since the last input.
    public mutating func wentAway(at t: Date, idle: TimeInterval, ledger: inout DayLedger, clock: DayClock) {
        if idle < Self.idleLimit { count(to: t.addingTimeInterval(-max(0, idle)), ledger: &ledger, clock: clock) }
        away = true
        since = nil
    }

    /// The screen woke or the session unlocked at `t`. Counting starts with the next input (`tick`).
    public mutating func cameBack(at t: Date) { away = false }

    /// The minute timer, and any other moment worth counting: `idle` is seconds since the last input.
    public mutating func tick(at t: Date, idle: TimeInterval, ledger: inout DayLedger, clock: DayClock) {
        guard !away, workspace != nil else { return }
        let lastInput = t.addingTimeInterval(-max(0, idle))
        if idle >= Self.idleLimit {
            // Whatever came before the last input was counted on an earlier tick; nothing after it counts.
            count(to: lastInput, ledger: &ledger, clock: clock)
            since = nil
        } else if since == nil {
            // Input came back. The latest input is the nearest moment known to have been yours.
            since = lastInput
        } else {
            count(to: lastInput, ledger: &ledger, clock: clock)
        }
    }

    private mutating func count(to t: Date, ledger: inout DayLedger, clock: DayClock) {
        guard let s = since, let n = workspace, t > s else { return }
        if t.timeIntervalSince(s) <= Self.longestStretch { ledger.add(n, from: s, to: t, clock: clock) }
        since = t
    }
}

/// Whether the person is back at the Mac after sleep, the lock or the screen saver. The screen waking is not coming back
/// while the lock screen is up (typing the password is input, and would count): only unlocking is.
public struct PresenceGate: Equatable, Sendable {
    public enum Event: Sendable { case locked, unlocked, wentAway, woke, sessionActive }
    public private(set) var locked = false
    public init() {}

    /// Notes `e` and says whether it means the person is back.
    public mutating func back(after e: Event) -> Bool {
        switch e {
        case .locked: locked = true; return false
        case .wentAway: return false
        case .unlocked, .sessionActive: locked = false; return true
        case .woke: return !locked
        }
    }
}

/// The ledger in memory with its tracker, written to ledger.json off the caller's thread. Feed it from the main thread;
/// read it from anywhere.
public final class DayLedgerStore: @unchecked Sendable {
    /// Posted on the main thread when time was added (at most once a minute while you work) or a day ended.
    public static let didChange = Notification.Name("PolycarpDayLedgerDidChange")
    public static let fileName = "ledger.json"

    public let url: URL
    private let log: (String) -> Void
    private let center: NotificationCenter
    private let writer = LatestWriter(label: "com.baney.polycarp.ledger")
    private let lock = NSLock()
    private var ledger: DayLedger
    private var tracker = LedgerTracker()
    private var clock: DayClock

    public init(folder: URL, clock: DayClock = DayClock(), now: Date = Date(), log: @escaping (String) -> Void = { _ in },
                center: NotificationCenter = .default) {
        url = folder.appendingPathComponent(Self.fileName)
        self.clock = clock
        self.log = log
        self.center = center
        let loaded = PurposeFile.load(DayLedger.self, from: url, newest: DayLedger.schema, now: now)
        if let line = PurposeFile.line(Self.fileName, loaded) { log(line) }
        if case .read(let v) = loaded { ledger = v } else { ledger = DayLedger() }
    }

    /// Seconds per workspace on `day`.
    public func seconds(on day: PurposeDay) -> [Int: Int] {
        lock.lock(); defer { lock.unlock() }
        return ledger.seconds(on: day)
    }

    /// Seconds per workspace today.
    public func today(at now: Date = Date()) -> [Int: Int] {
        lock.lock(); defer { lock.unlock() }
        return ledger.seconds(on: clock.day(of: now))
    }

    public var snapshot: DayLedger {
        lock.lock(); defer { lock.unlock() }
        return ledger
    }

    public var dayClock: DayClock {
        lock.lock(); defer { lock.unlock() }
        return clock
    }

    public func setClock(_ c: DayClock) {
        lock.lock(); clock = c; lock.unlock()
    }

    public func switched(to n: Int, at t: Date = Date()) { apply(t) { $0.switched(to: n, at: t, ledger: &$1, clock: $2) } }
    public func wentAway(at t: Date = Date(), idle: TimeInterval) { apply(t) { $0.wentAway(at: t, idle: idle, ledger: &$1, clock: $2) } }
    public func cameBack(at t: Date = Date()) { apply(t) { tracker, _, _ in tracker.cameBack(at: t) } }
    public func tick(at t: Date = Date(), idle: TimeInterval) { apply(t) { $0.tick(at: t, idle: idle, ledger: &$1, clock: $2) } }

    /// Waits for queued writes: for tests and quit only.
    public func flush() { writer.flush() }

    private func apply(_ t: Date, _ step: (inout LedgerTracker, inout DayLedger, DayClock) -> Void) {
        lock.lock()
        let before = ledger
        step(&tracker, &ledger, clock)
        ledger.prune(today: clock.day(of: t), clock: clock)
        let changed = ledger != before
        let saved = ledger
        lock.unlock()
        guard changed else { return }
        writer.write(to: url, log: log) { try? JSONEncoder().encode(saved) }
        let center = center
        if Thread.isMainThread { center.post(name: Self.didChange, object: self) } else {
            DispatchQueue.main.async { [self] in center.post(name: Self.didChange, object: self) }
        }
    }
}
