import XCTest
@testable import BaneySpacesCore

private func source(_ path: String) throws -> String {
    try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/MoveWordsTests.swift", with: path), encoding: .utf8)
}

/// #124 first-F7, second-S5, first-F6, second-S4 and round 2 first-F6: `agent move` routing and the words agents read.
final class MoveWordsTests: XCTestCase {
    /// `--window=4211` is the inline form the hands parser takes, so it goes to the hands verb like `--window 4211`.
    func testMoveWindowInlineFormIsTheHandsVerb() {
        XCTAssertTrue(HandsTools.movesWindow(["move", "--window=4211"]))
        XCTAssertTrue(HandsTools.movesWindow(["move", "--window", "4211"]))
        XCTAssertTrue(HandsTools.movesWindow(["move", "--frame", "0,0,800,600", "--window=4211"]))
        XCTAssertFalse(HandsTools.movesWindow(["move", "notes"]))
        XCTAssertFalse(HandsTools.movesWindow(["move", "--windowed"]))
        XCTAssertFalse(HandsTools.movesWindow(["snapshot", "--window=4211"]))
    }

    /// Rows carry no name (`workspaceRows` passes nil), so the tool must not promise one.
    func testWorkspacesToolPromisesNoName() throws {
        let summary = try XCTUnwrap(HandsTools.tool(verb: "workspaces")).summary
        XCTAssertNil(summary.range(of: #"\bname\b"#, options: .regularExpression), summary)
    }

    /// The scope rule and the lend section name different moves, so they no longer contradict each other.
    func testSkillSaysWhichMoveBringsALentWindowOver() throws {
        let skill = try source("skill/SKILL.md")
        XCTAssertFalse(skill.contains("`agent move` only moves windows"))
        XCTAssertTrue(skill.contains("`agent move <id | words>` only moves windows of apps started for an"))
        XCTAssertTrue(skill.contains("`move --window N` brings a lent window onto the agent workspace"))
    }
}
