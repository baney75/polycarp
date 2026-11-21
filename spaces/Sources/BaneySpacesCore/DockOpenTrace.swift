import Foundation

/// Where a Workspace Dock open spends its time. `WorkspaceDock.show(on:)` marks each phase as it ends (`mark`), the
/// first frame after it lands, and an open over `budgetMs` writes one trace.log line naming the phases that cost
/// the most (`line`). The dock bench (`DockOpenTiming`, `DockOpenSpeedTests`) reads the same phases.
///
/// Budget: 33 ms p90 from the pointer's reveal to the dock laid out and drawn, two frames at 60 Hz.
public final class DockOpenPhases {
    public static let budgetMs = 33.0
    /// A phase is named as slow when it alone took a quarter of the budget or more.
    public static let slowMs = budgetMs / 4

    public private(set) var phases: [(name: String, ms: Double)] = []
    private let now: () -> Double
    private let start: Double
    private var last: Double

    /// `now` is in milliseconds; tests pass their own.
    public init(now: @escaping () -> Double = DockOpenPhases.uptimeMs) {
        self.now = now
        start = now()
        last = start
    }

    public static func uptimeMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

    /// Ends the phase running since the last mark (or the start) and names it. A name marked twice adds up.
    public func mark(_ name: String) {
        let t = now()
        let ms = t - last
        last = t
        if let i = phases.firstIndex(where: { $0.name == name }) { phases[i].ms += ms } else { phases.append((name, ms)) }
    }

    /// From the start to the last mark.
    public var totalMs: Double { last - start }

    public func ms(_ name: String) -> Double { phases.first { $0.name == name }?.ms ?? 0 }

    /// The phases at or over `slowMs`, slowest first.
    public var slow: [String] {
        phases.filter { $0.ms >= Self.slowMs }.sorted { $0.ms > $1.ms }.map(\.name)
    }

    /// The trace.log line for an open over budget, or nil within it. Every phase is listed in order, in whole ms,
    /// so the line alone shows where the time went:
    /// `dock open slow: 64 ms (budget 33), slow: load, draw; reset 0, refresh 4, load 31, ..., draw 14`.
    public func line(budgetMs: Double = DockOpenPhases.budgetMs) -> String? {
        guard totalMs > budgetMs else { return nil }
        let all = phases.map { "\($0.name) \(Int($0.ms.rounded()))" }.joined(separator: ", ")
        let named = slow.isEmpty ? "none alone" : slow.joined(separator: ", ")
        return "dock open slow: \(Int(totalMs.rounded())) ms (budget \(Int(budgetMs))), slow: \(named); \(all)"
    }

    /// The p-th percentile (0 to 100) of `values`, nearest rank. 0 for none.
    public static func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let rank = Int((p / 100 * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank, 1), sorted.count) - 1]
    }
}
