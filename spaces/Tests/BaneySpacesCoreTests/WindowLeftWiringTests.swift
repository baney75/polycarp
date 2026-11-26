import XCTest

/// spec/tiling-speed.md R-TS10: every way a window leaves its workspace tells tiling before the model changes, and each
/// frame write that returns counts toward the open closes and moves. Reads the wiring, as `WindowNotesWiringTests` does.
final class WindowLeftWiringTests: XCTestCase {
    private func body(_ code: String, from start: String, to end: String) throws -> String {
        let a = try XCTUnwrap(code.range(of: start), start).lowerBound
        let b = try XCTUnwrap(code.range(of: end, range: a..<code.endIndex), end).lowerBound
        return String(code[a..<b])
    }

    func testEveryLeaveCallsOnWindowsLeft() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        let note = try body(code, from: "private func windowNote(", to: "private func focusMovedWithin(")
        XCTAssertTrue(note.contains("onWindowsLeft([id], \"destroyed\""))
        XCTAssertTrue(note.contains("onWindowsLeft([id], \"minimized\""))
        let quit = try body(code, from: "func appQuit(", to: "activations.forget(")
        XCTAssertTrue(quit.contains("\"quit\", at)"))
        let move = try body(code, from: "func move(_ ids: [WindowID], to n: Int)", to: "model.assign(id, to: n")
        XCTAssertTrue(move.contains("\"workspace\", at)"), "told before the model changes")
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/AppDelegate.swift").contains("spaces.onWindowsLeft = { [weak self] ids, how, at in self?.tiling.left(ids, how: how, at: at) }"))
    }

    func testTheWriteCountsTowardTheActions() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Tiling.swift")
        let write = try body(code, from: "private func write(", to: "private func settle(")
        XCTAssertTrue(write.contains("actions.wrote("))
        XCTAssertTrue(write.contains("looked: timed.looked"), "a write counts by when its look began (review of #871, first-F2)")
        let left = try body(code, from: "func left(_ ids: Set<WindowID>", to: "struct Timed")
        XCTAssertTrue(left.contains("shown.contains(workspace)"), "a close out of sight is not timed (second-F5)")
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/TilingRun.swift").contains("action(.move, how: \"key\""))
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/TilingDrags.swift").contains("action(.move, how: \"drag\""))
    }
}
