import Foundation

/// The wake alarm (`alarm.*` in surfaces.json): when it rings, when the Mac is held awake for it, and how a ring stops.
/// Pure: a clock and the settings decide it, so tests pin it; `WakeAlarm` in the app plays it.
public enum Alarm {
    /// How long before the ring the Mac is held awake, on power, with `keepAwake` on.
    public static let holdBefore: TimeInterval = 3600
    /// A ring time this far behind the clock was missed (the Mac slept through it) and doesn't ring late.
    public static let lateLimit: TimeInterval = 60

    /// The next wake time strictly after `date` on a day `settings.days` allows, in `calendar`'s time zone; nil when
    /// `wake` is off. On a DST day the wall clock time is kept: 06:30 rings at 06:30, once. A time inside the hour the
    /// clocks skip rings at the first minute that exists after it.
    public static func nextRing(after date: Date, settings: Surfaces.Alarm, calendar: Calendar) -> Date? {
        guard settings.wake, let at = settings.time else { return nil }
        let today = calendar.dateComponents([.year, .month, .day], from: date)
        // Noon is never skipped or doubled by DST, so day arithmetic from it lands on the right date.
        guard let noon = calendar.date(from: DateComponents(year: today.year, month: today.month, day: today.day, hour: 12)) else { return nil }
        for offset in 0...8 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: noon) else { continue }
            let c = calendar.dateComponents([.year, .month, .day, .weekday], from: day)
            guard settings.days.allows(weekday: c.weekday ?? 1) else { continue }
            guard let ring = calendar.date(from: DateComponents(year: c.year, month: c.month, day: c.day, hour: at.hour, minute: at.minute))
            else { continue }
            if ring > date { return ring }
        }
        return nil
    }

    /// `nextRing` in a `DayClock`'s time zone (the purpose layer's clock).
    public static func nextRing(after date: Date, settings: Surfaces.Alarm, clock: DayClock) -> Date? {
        nextRing(after: date, settings: settings, calendar: clock.calendar)
    }

    /// Whether to hold the Mac awake now: `keepAwake` on, on power, and the ring within the next hour.
    public static func shouldHoldAwake(now: Date, next: Date?, onPower: Bool, settings: Surfaces.Alarm) -> Bool {
        guard settings.keepAwake, onPower, let next else { return false }
        let left = next.timeIntervalSince(now)
        return left > 0 && left <= holdBefore
    }

    /// Whether a ring due at `scheduled` still rings at `now`: a timer that fires on wake from sleep, long after its time,
    /// is a missed alarm, not one to play.
    public static func ringsNow(scheduled: Date, now: Date) -> Bool { now.timeIntervalSince(scheduled) <= lateLimit }

    /// Whether the ring opens the morning card: only while the morning question hasn't been given on `today`.
    public static func opensMorningCard(state: RhythmState, today: PurposeDay) -> Bool {
        state.morningAsked.map { $0 < today } ?? true
    }

    /// One alarm going off: a ring at once, then one each minute up to `limit` in all. Any input stops it, once `settle`
    /// has passed: lighting the display and opening the morning card in the first moment must not read as someone there.
    public struct Ringing: Equatable, Sendable {
        public static let limit = 5
        public static let every: TimeInterval = 60
        public static let settle: TimeInterval = 2

        public let startedAt: Date
        public private(set) var rings = 0
        public private(set) var stopped = false

        public init(startedAt: Date) { self.startedAt = startedAt }

        /// What to do at `now`, with `inputSince` true when there was input since the last step. `ring` plays one ring;
        /// `done` means it is over (stopped by input, or the last ring has played) and needs no more steps.
        public mutating func step(now: Date, inputSince: Bool) -> (ring: Bool, done: Bool) {
            if stopped || rings >= Self.limit { return (false, true) }
            if inputSince, now.timeIntervalSince(startedAt) >= Self.settle { stopped = true; return (false, true) }
            guard now >= startedAt.addingTimeInterval(Double(rings) * Self.every) else { return (false, false) }
            rings += 1
            return (true, rings >= Self.limit)
        }
    }
}

extension Surfaces.AlarmDays {
    /// Whether the alarm rings on `weekday` (1 is Sunday, 7 is Saturday).
    public func allows(weekday: Int) -> Bool {
        switch self {
        case .every: true
        case .weekdays: (2...6).contains(weekday)
        case .notSunday: weekday != 1
        }
    }
}

/// The one-thing timer: a stretch of minutes given to the one thing. It runs whether or not a one thing is set, and keeps
/// the one thing's words from when it started.
public struct OneThingTimer: Codable, Equatable, Sendable {
    /// The lengths a timer may have, in minutes.
    public static let minutes = 1...240

    public var startedAt: Date
    public var minutes: Int
    public var oneThing: String?

    public init(startedAt: Date, minutes: Int, oneThing: String?) {
        self.startedAt = startedAt; self.minutes = minutes; self.oneThing = oneThing
    }

    public var endsAt: Date { startedAt.addingTimeInterval(Double(minutes) * 60) }

    /// Seconds left at `now`, never below 0.
    public func remaining(now: Date) -> TimeInterval { max(0, endsAt.timeIntervalSince(now)) }

    public func done(now: Date) -> Bool { remaining(now: now) <= 0 }

    /// A length out of range.
    public struct Problem: Error, Equatable, CustomStringConvertible {
        public let description: String
    }
}

/// The running timer, kept in the app's defaults ("oneThingTimer") so a relaunch keeps it. Each change is announced
/// with `didChange` on the calling thread, `userInfo["what"]` "started", "stopped" or "ended".
public final class OneThingTimerStore: @unchecked Sendable {
    public static let didChange = Notification.Name("PolycarpOneThingTimerDidChange")
    public static let key = "oneThingTimer"

    private let defaults: UserDefaults
    private let center: NotificationCenter
    private let lock = NSLock()
    private var value: OneThingTimer?

    public init(defaults: UserDefaults = .standard, center: NotificationCenter = .default) {
        self.defaults = defaults
        self.center = center
        value = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(OneThingTimer.self, from: $0) }
    }

    /// The timer, running or done but not yet ended; nil when none was started.
    public var timer: OneThingTimer? {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    /// Starts a timer of `minutes` now, in place of any running one.
    @discardableResult
    public func start(minutes: Int, oneThing: String?, now: Date = Date()) throws -> OneThingTimer {
        guard OneThingTimer.minutes.contains(minutes) else {
            throw OneThingTimer.Problem(description: "a timer runs 1 to 240 minutes, not \(minutes)")
        }
        let t = OneThingTimer(startedAt: now, minutes: minutes, oneThing: oneThing)
        set(t, what: "started")
        return t
    }

    /// Stops the running timer before its end. Returns it, or nil when none ran.
    @discardableResult
    public func stop() -> OneThingTimer? {
        guard let t = timer else { return nil }
        set(nil, what: "stopped")
        return t
    }

    /// The timer came to its end: it is cleared. Returns it when it was done at `now`, else nil and nothing changes.
    @discardableResult
    public func end(now: Date = Date()) -> OneThingTimer? {
        guard let t = timer, t.done(now: now) else { return nil }
        set(nil, what: "ended")
        return t
    }

    private func set(_ t: OneThingTimer?, what: String) {
        lock.lock()
        value = t
        lock.unlock()
        if let t, let data = try? JSONEncoder().encode(t) { defaults.set(data, forKey: Self.key) } else { defaults.removeObject(forKey: Self.key) }
        center.post(name: Self.didChange, object: self, userInfo: ["what": what])
    }
}

extension BarText {
    /// The timer's time left: "24 min" and down to "1 min", then "0:42" under a minute. Whole minutes and seconds,
    /// rounded down.
    public static func timer(remaining: TimeInterval) -> String {
        let r = max(0, remaining)
        if r >= 60 { return "\(Int(r / 60)) min" }
        return String(format: "0:%02d", Int(r))
    }

    /// Seconds until `timer(remaining:)` says something else, so the bar redraws when it changes and not every second.
    public static func timerNextChange(remaining: TimeInterval) -> TimeInterval {
        let r = max(0, remaining)
        let step: TimeInterval = r >= 60 ? 60 : 1
        let wait = r - (r / step).rounded(.down) * step
        return max(0.05, wait)
    }
}
