import Foundation
import XCTest

/// A rebase that meets another branch's change log entry keeps both copies, each worded a little
/// differently, so a whole-line compare misses them. The bold title is what a reader sees twice.
final class ChangelogTests: XCTestCase {
    private let changelog = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("CHANGELOG.md")

    /// The titles of the entries not yet released: every line before the first numbered release
    /// heading that starts with `- **` up to the closing `**`.
    static func unreleasedTitles(_ text: String) -> [String] {
        var titles: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("## "), line.dropFirst(3).first?.isNumber == true { break }
            guard line.hasPrefix("- **") else { continue }
            let rest = line.dropFirst(4)
            guard let end = rest.range(of: "**") else { continue }
            titles.append(String(rest[..<end.lowerBound]))
        }
        return titles
    }

    func testEachUnreleasedEntryIsListedOnce() throws {
        let text = try String(contentsOf: changelog, encoding: .utf8)
        let titles = Self.unreleasedTitles(text)
        XCTAssertGreaterThan(titles.count, 10, "read no entries from \(changelog.path)")
        let counts = Dictionary(titles.map { ($0, 1) }, uniquingKeysWith: +)
        let doubled = counts.filter { $0.value > 1 }.keys.sorted()
        XCTAssertEqual(doubled, [], "listed more than once in spaces/CHANGELOG.md")
    }

    func testTitlesStopAtTheFirstRelease() {
        let text = """
        ## Unreleased

        - **New.** Words.
        - **Same.** One wording.

        ## 0.3.0 (2026-10-30)

        - **Same.** Another wording.
        """
        XCTAssertEqual(Self.unreleasedTitles(text), ["New.", "Same."])
    }
}
