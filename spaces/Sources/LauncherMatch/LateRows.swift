/// Rows that come in after the list is up, such as files from a disk search, join it without
/// moving a row you may be about to pick (spec/launcher.md R-L14).
public enum LateRows {
    /// The late rows to show now. `shown` are the late rows on screen, the first of them at row
    /// `at` of the list; `selected` is the row you moved the selection to since the last
    /// keystroke, or nil if you haven't; `fresh` is the newest ranking, best first.
    ///
    /// With the selection above the late rows (or never moved) they take the newest ranking.
    /// With it on one of them, that row and every late row above it stay where they are and the
    /// rest fill in below. With it below them, they stay exactly as they are: a row added or
    /// dropped would move the selected one.
    public static func merge<T>(shown: [T], at: Int, selected: Int?, fresh: [T], limit: Int, id: (T) -> String) -> [T] {
        guard let selected, selected >= at else { return Array(fresh.prefix(limit)) }
        guard selected < at + shown.count else { return shown }
        let held = shown.prefix(selected - at + 1)
        let ids = Set(held.map(id))
        return Array(held) + fresh.filter { !ids.contains(id($0)) }.prefix(max(0, limit - held.count))
    }
}
