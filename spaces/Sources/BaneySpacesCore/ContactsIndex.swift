import ContactsMatch
import Foundation

/// The people the launcher searches, ready for a key press. Built once off the main thread from what Contacts gave
/// (`ContactsLibrary` in the app), never changed after: a change in Contacts builds a new one. Names, nicknames and
/// companies are folded here (`Fuzzy.fold`) and matched by `ContactTable` (the ContactsMatch target, which says how each
/// match is ranked). 5,000 people answer in under 2 ms (`ContactsSpeedTests`).
public final class ContactsIndex: @unchecked Sendable {
    public let records: [ContactRecord]
    private let table: ContactTable
    private let ids: [String: Int]

    public var count: Int { records.count }

    public init(_ records: [ContactRecord]) {
        self.records = records
        var ids: [String: Int] = [:]
        var fields: [[String]] = []
        fields.reserveCapacity(records.count)
        for (i, r) in records.enumerated() {
            ids[r.id] = ids[r.id] ?? i
            var mine: [String] = []
            for f in [r.name, r.nickname, r.organization] {
                let folded = Fuzzy.fold(f)
                mine.append(mine.contains(folded) ? "" : folded)
            }
            fields.append(mine)
        }
        self.ids = ids
        table = ContactTable(fields)
    }

    public func index(of id: String) -> Int? { ids[id] }

    /// No recent use.
    public static let notRecent = ContactTable.notRecent

    /// Each person's place in the recents (0 the newest), lined up with `records`, for `search`. Worked out once when
    /// the recents or the people change, never per key press.
    public func ranks(_ recents: ContactRecents) -> [UInt16] {
        var out = [UInt16](repeating: Self.notRecent, count: records.count)
        for (n, id) in recents.order.prefix(Int(Self.notRecent) - 1).enumerated() {
            if let i = ids[id] { out[i] = UInt16(n) }
        }
        return out
    }

    /// The people that answer `query`, best first, at most `limit`. `ranks` comes from `ranks(_:)`.
    public func search(_ query: String, ranks: [UInt16]? = nil, limit: Int = 8) -> [ContactMatch] {
        table.search(Fuzzy.fold(query), ranks: ranks, limit: limit).map { ContactMatch(index: $0.index, tier: $0.tier, recent: $0.recent) }
    }

    /// Whether anyone's words start with every word of `query` (tier 3 or better): how the launcher tells the name in
    /// "message anna running late" from the draft after it.
    public func hasWordMatch(_ query: String) -> Bool {
        search(query, limit: 1).first.map { $0.tier >= 3 } ?? false
    }
}

/// One person found: their place in `ContactsIndex.records` and how well they answered (`ContactTable` says how).
public struct ContactMatch: Equatable, Sendable {
    public let index: Int
    public let tier: Int
    /// The owner reached them from Polycarp lately.
    public let recent: Bool
}
