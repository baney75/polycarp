import Foundation

/// Where to pick a long video up again (spec/player.md, R-P5): kept per file for videos over 10 minutes only, forgotten
/// once you watch to the end, and capped so the file never grows past a few hundred entries.
public struct PlayerResume: Codable, Equatable, Sendable {
    /// Only videos longer than this are remembered.
    public static let minimumDuration = 600.0
    /// A position this close to the start isn't worth resuming.
    public static let startSlack = 10.0
    /// A position this close to the end counts as watched: the entry goes.
    public static let endSlack = 30.0
    /// A file whose length changed by more than this is a different file under the same name.
    public static let durationSlack = 1.0
    public static let limit = 200

    public struct Entry: Codable, Equatable, Sendable {
        public var position: Double
        public var duration: Double
        public var savedAt: Double
    }

    public private(set) var entries: [String: Entry] = [:]

    public init() {}

    public static func remembers(_ kind: MediaKind, duration: Double) -> Bool {
        kind == .video && duration.isFinite && duration > minimumDuration
    }

    /// Notes where `path` is. A position near either end, or a short or non-video file, leaves no entry.
    public mutating func note(_ path: String, kind: MediaKind, position: Double, duration: Double, now: Double) {
        guard Self.remembers(kind, duration: duration), position.isFinite else { return }
        if position < Self.startSlack || position > duration - Self.endSlack {
            entries[path] = nil
            return
        }
        entries[path] = Entry(position: position, duration: duration, savedAt: now)
        if entries.count > Self.limit {
            let oldest = entries.sorted { ($0.value.savedAt, $0.key) < ($1.value.savedAt, $1.key) }.prefix(entries.count - Self.limit)
            for (k, _) in oldest { entries[k] = nil }
        }
    }

    /// Where to start `path`, or nil to start at the beginning.
    public func position(for path: String, duration: Double) -> Double? {
        guard let e = entries[path], abs(e.duration - duration) <= Self.durationSlack else { return nil }
        return e.position
    }

    /// Whether `path` has an entry at all, before its length is known.
    public func has(_ path: String) -> Bool { entries[path] != nil }

    public func encoded() -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return (try? enc.encode(self)) ?? Data()
    }

    /// The saved store, or an empty one when the data is missing or unreadable.
    public static func decode(_ data: Data?) -> PlayerResume {
        guard let data, let r = try? JSONDecoder().decode(PlayerResume.self, from: data) else { return PlayerResume() }
        return r
    }

    public static func load(_ url: URL) -> PlayerResume { decode(try? Data(contentsOf: url)) }

    public func save(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoded().write(to: url, options: .atomic)
    }
}

/// When the player notes a video's place (R-P5): every 15 s of play or after a jump back, per file, and never while the
/// seek to a saved place runs (until it lands, the time reads 0, and noting 0 would delete the place).
public struct PlayerResumeClock: Equatable, Sendable {
    public private(set) var last = 0.0
    public private(set) var seeking = false
    public init() {}
    /// A new file starts its own clock.
    public mutating func newItem() { last = 0; seeking = false }
    public mutating func seekStarted() { seeking = true }
    public mutating func seekEnded(at position: Double) { seeking = false; last = position }
    /// Whether a place may be noted at all (on a pause, a close, a step to another file).
    public var mayNote: Bool { !seeking }
    /// The periodic tick at `now`: true when it is time to note.
    public mutating func tick(_ now: Double) -> Bool {
        guard !seeking, now - last > 15 || now < last else { return false }
        last = now
        return true
    }
}
