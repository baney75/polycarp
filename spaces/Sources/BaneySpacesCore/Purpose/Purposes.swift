import Foundation

/// What each workspace is for, and the one thing in front today. Purity of heart is to will one thing: each workspace
/// says what it is for, and the machine keeps one thing in front. Purposes carry over from day to day until changed;
/// the one thing belongs to the day it was set and clears at the next day's start (`DayClock`, 4 am).
/// Stored as purposes.json in the support folder.
public struct Purposes: Codable, Equatable, Sendable {
    public static let schema = 1
    /// Short enough for a dock tile's label and the top bar.
    public static let purposeLimit = 60
    public static let oneThingLimit = 80

    /// The one thing: what it is, the workspace it was set on (nil when that wasn't known) and its day.
    public struct OneThing: Codable, Equatable, Sendable {
        public var text: String
        public var workspace: Int?
        public var day: PurposeDay
        public init(text: String, workspace: Int?, day: PurposeDay) { self.text = text; self.workspace = workspace; self.day = day }
    }

    public var version = Purposes.schema
    /// The day this file was last written. Purposes carry over whatever it says; it is for people reading the file.
    public var day: PurposeDay?
    /// Workspace number to purpose, as JSON object keys ("1" to "9"). An unnamed workspace has no entry.
    private var byWorkspace: [String: String] = [:]
    public var oneThing: OneThing?
    /// Tomorrow's one thing, named at the evening examen. It becomes the one thing when its day starts and leaves today's
    /// alone until then.
    public var next: OneThing?

    public init() {}

    private enum CodingKeys: String, CodingKey { case version, day, byWorkspace = "purposes", oneThing = "one", next }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? Self.schema
        day = try c.decodeIfPresent(PurposeDay.self, forKey: .day)
        // A hand-edited file is held to the same rules as a set: in range, trimmed, within the limit.
        let raw = try c.decodeIfPresent([String: String].self, forKey: .byWorkspace) ?? [:]
        for (k, v) in raw {
            guard let n = Int(k), Workspaces.range.contains(n), let text = Self.clean(v, limit: Self.purposeLimit) else { continue }
            byWorkspace["\(n)"] = text
        }
        if var one = try c.decodeIfPresent(OneThing.self, forKey: .oneThing), let text = Self.clean(one.text, limit: Self.oneThingLimit) {
            one.text = text
            if let n = one.workspace, !Workspaces.range.contains(n) { one.workspace = nil }
            oneThing = one
        }
        if var n = try c.decodeIfPresent(OneThing.self, forKey: .next), let text = Self.clean(n.text, limit: Self.oneThingLimit) {
            n.text = text
            n.workspace = nil
            next = n
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version)
        try c.encodeIfPresent(day, forKey: .day)
        try c.encode(byWorkspace, forKey: .byWorkspace)
        try c.encodeIfPresent(oneThing, forKey: .oneThing)
        try c.encodeIfPresent(next, forKey: .next)
    }

    /// Workspace `n`'s purpose, or nil when it is unnamed.
    public func purpose(of n: Int) -> String? { byWorkspace["\(n)"] }

    /// Every named workspace, by number.
    public var all: [Int: String] {
        Dictionary(uniqueKeysWithValues: byWorkspace.compactMap { k, v in Int(k).map { ($0, v) } })
    }

    /// The one thing if it belongs to `today`, else nil: yesterday's is gone even before the file says so.
    public func oneThing(on today: PurposeDay) -> OneThing? {
        if let one = oneThing, one.day == today { return one }
        if let n = next, n.day == today { return n }
        return nil
    }

    /// Sets or clears the one thing for `day` (tomorrow, from the examen).
    public mutating func setNext(_ text: String?, day: PurposeDay) throws {
        guard let text, let clean = Self.clean(text, limit: .max) else { next = nil; return }
        guard clean.count <= Self.oneThingLimit else { throw Problem.tooLong(clean.count, limit: Self.oneThingLimit) }
        next = OneThing(text: clean, workspace: nil, day: day)
    }

    /// Sets or clears (nil, or text that is empty once trimmed) workspace `n`'s purpose. Text over the limit is refused,
    /// never cut, so the caller can say so.
    public mutating func setPurpose(_ text: String?, for n: Int) throws {
        guard Workspaces.range.contains(n) else { throw Problem.noSuchWorkspace(n) }
        guard let text, let clean = Self.clean(text, limit: .max) else { byWorkspace["\(n)"] = nil; return }
        guard clean.count <= Self.purposeLimit else { throw Problem.tooLong(clean.count, limit: Self.purposeLimit) }
        byWorkspace["\(n)"] = clean
    }

    /// Sets or clears today's one thing.
    /// A one thing set or cleared by hand on `day` also uses up a `next` named for that day, so the rollover can't bring
    /// it back over what you just did.
    public mutating func setOneThing(_ text: String?, workspace: Int?, day: PurposeDay) throws {
        guard let text, let clean = Self.clean(text, limit: .max) else { oneThing = nil; dropNext(through: day); return }
        guard clean.count <= Self.oneThingLimit else { throw Problem.tooLong(clean.count, limit: Self.oneThingLimit) }
        oneThing = OneThing(text: clean, workspace: workspace.flatMap { Workspaces.range.contains($0) ? $0 : nil }, day: day)
        dropNext(through: day)
    }

    private mutating func dropNext(through day: PurposeDay) {
        if let n = next, n.day <= day { next = nil }
    }

    /// One line, trimmed: newlines and tabs become spaces, runs of spaces become one. Nil when nothing is left. Text over
    /// `limit` is cut (only a file someone edited by hand gets here with that).
    public static func clean(_ text: String, limit: Int) -> String? {
        let words = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        guard !words.isEmpty else { return nil }
        let line = words.joined(separator: " ")
        return line.count > limit ? String(line.prefix(limit)) : line
    }

    public enum Problem: Error, Equatable, CustomStringConvertible {
        case noSuchWorkspace(Int)
        case tooLong(Int, limit: Int)

        public var description: String {
            switch self {
            case .noSuchWorkspace(let n): "no workspace \(n); pick one from \(Workspaces.range.lowerBound) to \(Workspaces.range.upperBound)"
            case .tooLong(let n, let limit): "that is \(n) characters; keep it to \(limit)"
            }
        }
    }
}

/// The purposes in memory, for every surface to read at any moment. Reads take a lock for a few nanoseconds and never
/// touch the disk; each change is written to purposes.json on a background queue and announced at once with
/// `didChange`, posted on the main thread (synchronously when the change was made there).
public final class PurposeStore: @unchecked Sendable {
    /// Posted on the main thread after every change, including the one thing clearing at the day's start.
    /// `userInfo["what"]` is "purpose" (with `userInfo["workspace"]`, an Int) or "oneThing".
    public static let didChange = Notification.Name("PolycarpPurposesDidChange")
    public static let fileName = "purposes.json"

    public let url: URL
    private let now: () -> Date
    private let log: (String) -> Void
    private let center: NotificationCenter
    private let writer = LatestWriter(label: "com.baney.polycarp.purposes")
    private let lock = NSLock()
    private var value: Purposes
    private var clock: DayClock
    /// Today and when it ends, so a read costs a clock read and a compare, not a calendar lookup.
    private var today: PurposeDay
    private var todayEnds: Date

    /// Reads purposes.json from `folder` once, here. A bad file is moved aside and logged (`PurposeFile`).
    public init(folder: URL, clock: DayClock = DayClock(), now: @escaping () -> Date = Date.init,
                log: @escaping (String) -> Void = { _ in }, center: NotificationCenter = .default) {
        url = folder.appendingPathComponent(Self.fileName)
        self.clock = clock
        self.now = now
        self.log = log
        self.center = center
        let loaded = PurposeFile.load(Purposes.self, from: url, newest: Purposes.schema, now: now())
        if let line = PurposeFile.line(Self.fileName, loaded) { log(line) }
        if case .read(let v) = loaded { value = v } else { value = Purposes() }
        let t = now()
        today = clock.day(of: t)
        todayEnds = clock.end(of: today)
    }

    /// Everything, as of now. The one thing in the copy is nil once its day is over.
    public var snapshot: Purposes {
        lock.lock(); defer { lock.unlock() }
        var v = value
        v.oneThing = v.oneThing(on: currentDay())
        return v
    }

    public func purpose(of n: Int) -> String? {
        lock.lock(); defer { lock.unlock() }
        return value.purpose(of: n)
    }

    /// Today's one thing, or nil.
    public var oneThing: Purposes.OneThing? {
        lock.lock(); defer { lock.unlock() }
        return value.oneThing(on: currentDay())
    }

    /// The day as this store counts it.
    public var day: PurposeDay {
        lock.lock(); defer { lock.unlock() }
        return currentDay()
    }

    /// Sets workspace `n`'s purpose; empty text clears it. Throws `Purposes.Problem` for a workspace out of range or
    /// text over 60 characters.
    public func setPurpose(_ text: String?, for n: Int) throws {
        try change(["what": "purpose", "workspace": n]) { v, _ in try v.setPurpose(text, for: n) }
    }

    /// Sets today's one thing, saying which workspace it was set on; empty text clears it.
    public func setOneThing(_ text: String?, workspace: Int?) throws {
        try change(["what": "oneThing"]) { v, day in try v.setOneThing(text, workspace: workspace, day: day) }
    }

    /// Tomorrow's one thing, if one was named.
    public var tomorrow: Purposes.OneThing? {
        lock.lock(); defer { lock.unlock() }
        let day = currentDay()
        return value.next.flatMap { $0.day > day ? $0 : nil }
    }

    /// Sets tomorrow's one thing (the examen's last answer); empty text clears it. Today's stays until the day ends.
    public func setTomorrow(_ text: String?) throws {
        try change(["what": "oneThing"]) { v, day in try v.setNext(text, day: self.clock.adding(1, to: day)) }
    }

    /// Call at the day's start, on wake and when the time zone changes: a one thing left from an earlier day is dropped
    /// from the file and `didChange` says so. Returns whether it did.
    @discardableResult
    public func rollover() -> Bool {
        lock.lock()
        refreshDay()
        var v = value
        if let n = v.next, n.day <= today {
            // Tomorrow came: the examen's answer is today's one thing, or is dropped once its day has passed.
            // A one thing set by hand on the new day before this ran wins.
            v.oneThing = v.oneThing?.day == today ? v.oneThing : (n.day == today ? n : nil)
            v.next = nil
        } else if let one = v.oneThing, one.day != today {
            v.oneThing = nil
        }
        guard v != value else { lock.unlock(); return false }
        value = v
        value.day = today
        let saved = value
        lock.unlock()
        persist(saved)
        announce(["what": "oneThing"])
        return true
    }

    /// When the next day starts, for the timer that calls `rollover`.
    public var nextRollover: Date {
        lock.lock(); defer { lock.unlock() }
        _ = currentDay()
        return todayEnds
    }

    /// Takes a new time zone (`NSSystemTimeZoneDidChange`). `DayClock()` follows the Mac's zone already; a fixed one, as
    /// the tests use, is replaced.
    public func setClock(_ c: DayClock) {
        lock.lock()
        clock = c
        today = c.day(of: now())
        todayEnds = c.end(of: today)
        lock.unlock()
        rollover()
    }

    /// Waits for queued writes: for tests and quit only.
    public func flush() { writer.flush() }

    private func change(_ info: [String: Any], _ edit: (inout Purposes, PurposeDay) throws -> Void) throws {
        lock.lock()
        let day = currentDay()
        var next = value
        do { try edit(&next, day) } catch { lock.unlock(); throw error }
        next.day = day
        let changed = next != value
        value = next
        lock.unlock()
        guard changed else { return }
        persist(next)
        announce(info)
    }

    private func persist(_ v: Purposes) {
        writer.write(to: url, log: log) {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            return try? enc.encode(v)
        }
    }

    private func announce(_ info: [String: Any]) {
        let center = center
        if Thread.isMainThread { center.post(name: Self.didChange, object: self, userInfo: info); return }
        DispatchQueue.main.async { [self] in center.post(name: Self.didChange, object: self, userInfo: info) }
    }

    /// Under the lock.
    private func currentDay() -> PurposeDay {
        if now() >= todayEnds { refreshDay() }
        return today
    }

    /// Under the lock. Also used when the clock might have gone back (a time zone change).
    private func refreshDay() {
        let t = now()
        today = clock.day(of: t)
        todayEnds = clock.end(of: today)
    }
}
