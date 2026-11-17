import Foundation

/// What you pick from the launcher, and after typing what (spec/launcher.md R-L10). Each pick
/// adds 1 to the entry's weight and 1 to the weight of that query leading to that entry; both
/// halve every 14 days. An entry you use lifts a little for anything typed, up to 24; one you
/// picked after typing the same thing lifts more, up to 40, so after "cal" then Calculator,
/// "cal" puts Calculator first. Keys are hashes: what is stored names no app, window or query.
public struct Frecency: Codable, Equatable, Sendable {
    public static let halfLife: TimeInterval = 14 * 86_400
    public static let usedMax = 24
    public static let typedMax = 40
    /// Marks lighter than this are forgotten when the store is saved.
    static let forgotten = 0.05
    /// Marks kept at most, the heaviest.
    static let kept = 500

    struct Mark: Codable, Equatable, Sendable {
        var weight: Double
        var at: Date
        func weight(at now: Date) -> Double {
            weight * pow(0.5, max(0, now.timeIntervalSince(at)) / Frecency.halfLife)
        }
    }

    /// Entry hash to its weight.
    private(set) var used: [String: Mark] = [:]
    /// Query hash, a colon, then entry hash.
    private(set) var typed: [String: Mark] = [:]

    public init() {}

    public var isEmpty: Bool { used.isEmpty && typed.isEmpty }

    /// `id` was picked after typing `query` (empty when nothing was typed).
    public mutating func picked(_ id: String, query: String, at now: Date = Date()) {
        Self.add(&used, Self.key(id), now)
        if let q = Self.queryKey(query) { Self.add(&typed, q + ":" + Self.key(id), now) }
    }

    /// The lift for each entry id for what was typed. Nothing typed, nothing lifted.
    public func boost(for query: String, at now: Date = Date()) -> (String) -> Int {
        guard let q = Self.queryKey(query) else { return { _ in 0 } }
        return { id in
            let k = Self.key(id)
            let u = used[k]?.weight(at: now) ?? 0
            let t = typed[q + ":" + k]?.weight(at: now) ?? 0
            return min(Self.usedMax, Int((8 * log2(1 + u)).rounded())) + min(Self.typedMax, Int((25 * t).rounded()))
        }
    }

    /// Drops marks too light to lift anything and keeps the heaviest few hundred.
    public mutating func prune(at now: Date = Date()) {
        func trim(_ marks: inout [String: Mark]) {
            let live = marks.filter { $0.value.weight(at: now) >= Self.forgotten }
            marks = live.count <= Self.kept ? live
                : Dictionary(uniqueKeysWithValues: live.sorted { $0.value.weight(at: now) > $1.value.weight(at: now) }.prefix(Self.kept).map { ($0.key, $0.value) })
        }
        trim(&used)
        trim(&typed)
    }

    private static func add(_ marks: inout [String: Mark], _ key: String, _ now: Date) {
        let w = marks[key]?.weight(at: now) ?? 0
        marks[key] = Mark(weight: w + 1, at: now)
    }

    /// The query as the matcher reads it (folded words, single spaces), hashed; nil if empty.
    static func queryKey(_ query: String) -> String? {
        let q = Match.Query(query)
        guard !q.isEmpty else { return nil }
        var scalars: [UInt32] = []
        for (i, w) in q.words.enumerated() { if i > 0 { scalars.append(32) }; scalars += w }
        return hash(scalars.lazy.map { UInt64($0) })
    }

    static func key(_ id: String) -> String { hash(id.utf8.lazy.map { UInt64($0) }) }

    /// FNV-1a, 64 bits, in hex: the same on every platform and every run (Swift's own hashing
    /// is seeded per process).
    static func hash<S: Sequence>(_ values: S) -> String where S.Element == UInt64 {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for v in values {
            h ^= v
            h = h &* 0x0000_0100_0000_01B3
        }
        return String(h, radix: 16)
    }
}
