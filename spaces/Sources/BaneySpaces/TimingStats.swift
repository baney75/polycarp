import Foundation

/// A bench line: p50 and p90 in ms.
enum TimingStats {
    static func line(_ name: String, _ ms: [Double]) -> String {
        let s = ms.sorted()
        func p(_ q: Double) -> Double { s.isEmpty ? 0 : s[min(s.count - 1, Int((Double(s.count) * q).rounded(.up)) - 1)] }
        return name.padding(toLength: 42, withPad: " ", startingAt: 0)
            + String(format: " p50 %6.1f  p90 %6.1f  max %6.1f ms  (n=%d)", p(0.5), p(0.9), s.last ?? 0, s.count)
    }
}
