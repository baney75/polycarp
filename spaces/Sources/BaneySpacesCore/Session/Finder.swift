import CoreGraphics
import Foundation

/// Ranks session rows for the launcher with the launcher's own matcher, so both search alike.
public enum SessionRank {
    /// `items` best first with their scores on the launcher's scale (spec/launcher.md R-L8: a
    /// window answers to its title, its app and title, and its detail at a cost), dropping the
    /// ones that don't match. Ties keep their order; an empty query keeps them all with 0.
    public static func scored<T>(_ query: String, _ items: [T],
                                 window: (T) -> (title: String, app: String, detail: String)) -> [(item: T, score: Int)] {
        let index = LauncherIndex(items.enumerated().map { i, x in
            let w = window(x)
            return .window(id: String(i), title: w.title, app: w.app, detail: w.detail)
        })
        return index.search(query).map { (items[Int($0.id)!], $0.score) }
    }

    public static func rank<T>(_ query: String, _ items: [T], window: (T) -> (title: String, app: String, detail: String)) -> [T] {
        scored(query, items, window: window).map(\.item)
    }
}

/// Pairs Ghostty's windows (AppleScript IDs) with macOS windows (Accessibility, CGWindowID) by title.
/// Both lists come front to back, so equal titles pair up in order.
public enum WindowMatch {
    public static func pair(scripted: [(id: String, title: String)], native: [(number: UInt32, title: String)]) -> [String: UInt32] {
        var left = native
        var out: [String: UInt32] = [:]
        // Exact titles first, then titles the app extended: Chromium browsers append
        // " - High memory usage - 1.0 GB - Helium" or " - Part of group Work - Helium".
        for exact in [true, false] {
            for s in scripted where out[s.id] == nil {
                let hit = left.firstIndex { exact ? $0.title == s.title : (!s.title.isEmpty && $0.title.hasPrefix(s.title + " - ")) }
                if let i = hit {
                    out[s.id] = left[i].number
                    left.remove(at: i)
                }
            }
        }
        // One window each left over: they're the same window with a title that moved between reads.
        let unmatched = scripted.filter { out[$0.id] == nil }
        if unmatched.count == 1, left.count == 1 { out[unmatched[0].id] = left[0].number }
        return out
    }
}
