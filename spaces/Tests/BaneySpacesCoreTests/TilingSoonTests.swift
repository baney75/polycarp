import XCTest
@testable import BaneySpacesCore

/// A look asked for sooner than the pending one takes its place: a 5 s retry never holds up a new window's look.
final class TilingSoonTests: XCTestCase {
    func testTheEarliestLookWins() {
        XCTAssertTrue(TilingSoon.replaces(pending: nil, asked: 5.1), "none pending")
        XCTAssertTrue(TilingSoon.replaces(pending: 105.1, asked: 100.02), "a new window while a retry waits")
        XCTAssertFalse(TilingSoon.replaces(pending: 100.02, asked: 105.1), "the retry waits for the look already due")
        XCTAssertFalse(TilingSoon.replaces(pending: 100.1, asked: 100.1), "the same moment is one look")
    }

    func testTheAppCancelsTheLaterLook() throws {
        let tiling = try SourceText.code("Sources/BaneySpaces/Tiling.swift")
        let body = try XCTUnwrap(SourceText.block(after: "func lookSoon(_ seconds: TimeInterval)", in: tiling))
        XCTAssertTrue(body.contains("guard TilingSoon.replaces(pending: soon == nil ? nil : soonDue, asked: due) else { return }"))
        XCTAssertTrue(body.contains("soon?.cancel()"))
        XCTAssertTrue(body.contains("(soon, soonDue) = (work, due)"))
    }
}
