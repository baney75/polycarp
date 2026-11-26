import Foundation
import XCTest

/// Source checks read the app's own files as text: these find a file, strip its comments and cut out one block.
enum SourceText {
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// Code only: comments may name what the code must not call.
    static func code(_ path: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
            .replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    /// The text from `marker` to the brace that closes the block it opens.
    static func block(after marker: String, in text: String) -> String? {
        guard let start = text.range(of: marker), let open = text[start.upperBound...].firstIndex(of: "{") else { return nil }
        var depth = 0
        var i = open
        while i < text.endIndex {
            if text[i] == "{" { depth += 1 } else if text[i] == "}" { depth -= 1; if depth == 0 { return String(text[open...i]) } }
            i = text.index(after: i)
        }
        return nil
    }

    /// The text from `start` up to `end`.
    static func between(_ start: String, _ end: String, in text: String) -> String? {
        guard let a = text.range(of: start), let b = text[a.upperBound...].range(of: end) else { return nil }
        return String(text[a.lowerBound..<b.lowerBound])
    }
}

final class SourceTextTests: XCTestCase {
    func testBlockFindsTheMatchingBrace() {
        XCTAssertEqual(SourceText.block(after: "f()", in: "x f() { a { b } c } d"), "{ a { b } c }")
        XCTAssertNil(SourceText.block(after: "g()", in: "f() { }"))
    }
}
