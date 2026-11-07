import XCTest

/// In a SwiftUI view, a bare `tag("…")` that doesn't resolve to a helper of that view is `.tag()` on the view itself. The
/// view then contains itself, and the Welcome window overflows the stack on first run (found by the render, 2026-11-07).
final class WelcomeTagTests: XCTestCase {
    func testNoViewCallsABareTag() throws {
        let code = try HandsSourceTests.code("Sources/BaneySpaces/WelcomeWindow.swift")
        let bare = code.split(separator: "\n").filter { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("tag(") || t.contains("{ tag(")
        }
        XCTAssertEqual(bare, [], "use WelcomeTag")
    }
}
