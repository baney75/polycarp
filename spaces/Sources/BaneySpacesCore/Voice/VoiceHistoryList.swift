import Foundation

/// How Settings > Silas lists History: every saved dictation, drawn a page at a time, each one copyable, selectable and
/// expandable, and Clear asks first. Plain words and numbers, tested without SwiftUI.
public enum VoiceHistoryList {
    /// Rows drawn per page. The core keeps every item (`pc_history_get(core, 0)`); only drawing is paged.
    public static let page = 50

    /// How many rows to draw after `pages` pages were asked for.
    public static func shown(total: Int, pages: Int) -> Int { min(total, page * max(1, pages)) }

    /// The button under the list, or nil when everything is drawn.
    public static func more(total: Int, shown: Int) -> String? {
        let left = total - shown
        return left > 0 ? "Show \(min(page, left)) more" : nil
    }

    /// Two lines fit most dictations; longer ones get Show all.
    public static func isLong(_ text: String) -> Bool { text.count > 140 || text.contains("\n") }

    /// The confirmation Clear shows.
    public static func clearTitle(count: Int) -> String {
        count == 1 ? "Clear the 1 dictation in History?" : "Clear all \(count) dictations in History?"
    }
    public static let clearMessage = "This can't be undone. Your dictionary stays."

    /// VoiceOver names for a row's buttons, so a list of "Remove, Remove, Remove" says which one.
    public static func removeLabel(_ text: String) -> String { "Remove \u{201C}\(snippet(text))\u{201D}" }
    public static func copyLabel(_ text: String) -> String { "Copy \u{201C}\(snippet(text))\u{201D}" }

    /// The first six words, for a label.
    static func snippet(_ text: String) -> String {
        let words = text.split(whereSeparator: \.isWhitespace)
        let head = words.prefix(6).joined(separator: " ")
        return words.count > 6 ? head + "\u{2026}" : head
    }
}
