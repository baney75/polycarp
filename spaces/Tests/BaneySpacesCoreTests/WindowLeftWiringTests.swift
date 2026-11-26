import XCTest

/// spec/tiling-speed.md R-TS10: every way a window leaves its workspace tells tiling before the model changes, and each
/// frame write that returns counts toward the open closes and moves. Reads the wiring, as `WindowNotesWiringTests` does.
final class WindowLeftWiringTests: XCTestCase {
    private func body(_ code: String, from start: String, to end: String) throws -> String {
        let a = try XCTUnwrap(code.range(of: start), start).lowerBound
        let b = try XCTUnwrap(code.range(of: end, range: a..<code.endIndex), end).lowerBound
        return String(code[a..<b])
    }

    func testEveryLeaveCallsOnWindowLeft() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        let note = try body(code, from: "private func windowNote(", to: "private func focusMovedWithin(")
        XCTAssertTrue(note.contains("onWindowLeft(id, \"destroyed\""))
        XCTAssertTrue(note.contains("onWindowLeft(id, \"minimized\""))
        let quit = try body(code, from: "func appQuit(", to: "activations.forget(")
        XCTAssertTrue(quit.contains("onWindowLeft(id, \"quit\""))
        let move = try body(code, from: "func move(_ ids: [WindowID], to n: Int)", to: "model.assign(id, to: n")
        XCTAssertTrue(move.contains("onWindowLeft(id, \"workspace\""), "told before the model changes")
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/AppDelegate.swift").contains("spaces.onWindowLeft = { [weak self] id, how, at in self?.tiling.left(id, how: how, at: at) }"))
    }

    func testTheWriteCountsTowardTheActions() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Tiling.swift")
        let write = try body(code, from: "private func write(", to: "private func settle(")
        XCTAssertTrue(write.contains("actions.wrote("))
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/TilingRun.swift").contains("action(.move, how: \"key\""))
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/TilingDrags.swift").contains("action(.move, how: \"drag\""))
    }
}
