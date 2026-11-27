import XCTest

/// spec/tiling-speed.md R-TS8, cases 24 to 30: a window that leaves its workspace leaves the model the moment its note
/// comes, and tiling looks at once. Donovan's second report (2026-11-26) of closes that never filled; each of these
/// fails on the code before it, where the window stayed until a scan saw the window server drop it. Reads the wiring,
/// as `WindowNotesWiringTests` does; the probe checks it live.
final class LeaveNowWiringTests: XCTestCase {
    private func body(_ code: String, from start: String, to end: String) throws -> String {
        let a = try XCTUnwrap(code.range(of: start), start).lowerBound
        let b = try XCTUnwrap(code.range(of: end, range: a..<code.endIndex), end).lowerBound
        return String(code[a..<b])
    }
    private var spaces: String { get throws { try SourceText.code("Sources/BaneySpaces/Spaces.swift") } }

    /// Case 24 and 25: the close button, ⌘W or a tab merged away; the window server may list it a while yet.
    func testCase24ADestroyedWindowLeavesTheModelAtOnce() throws {
        let code = try spaces
        let note = try body(code, from: "private func windowNote(", to: "private func leaveNow(")
        XCTAssertTrue(note.contains("leaveNow([id], how: \"destroyed\", at: at)"))
        let leave = try body(code, from: "private func leaveNow(", to: "private func mayBeTab(")
        XCTAssertTrue(leave.contains("model.sync(seen: [], alive: Set(model.home.keys).subtracting(here))"), "out of the model now")
        XCTAssertTrue(leave.contains("leftEarly[id] = .init(workspace: n, serial: scanSerial)"), "kept, so a wrong note costs nothing")
        XCTAssertTrue(leave.contains("persist()"))
    }

    /// Case 24: tiling looks at once, not in 20 ms, and no scan or settle comes first.
    func testCase24TilingLooksAtOnce() throws {
        let left = try body(try SourceText.code("Sources/BaneySpaces/Tiling.swift"), from: "func left(_ ids: Set<WindowID>", to: "struct Timed")
        XCTAssertTrue(left.contains("look()"))
        XCTAssertFalse(left.contains("lookSoon"))
    }

    /// A closed native tab's hidden sibling takes its tile; filling first would move the others twice.
    func testCase25ATabWithAHiddenSiblingWaitsForTheScan() throws {
        let code = try spaces
        let note = try body(code, from: "private func windowNote(", to: "private func leaveNow(")
        XCTAssertTrue(note.contains("if mayBeTab(id) { onWindowsLeft([id], \"destroyed\", at) } else { leaveNow("))
        let tab = try body(code, from: "private func mayBeTab(", to: "private func focusMovedWithin(")
        XCTAssertTrue(tab.contains("places[$0]?.onScreen != true"))
        // Review of #881, first-F1: the hidden tab a scan dropped as closed waits in `dormant`.
        XCTAssertTrue(tab.contains("dormant.contains(where: { $0.value.pid == pid && $0.value.workspace == n })"))
    }

    /// Case 26: an app quits; every one of its windows leaves.
    func testCase26AQuitTakesEveryWindowOutAtOnce() throws {
        let quit = try body(try spaces, from: "func appQuit(", to: "activations.forget(")
        XCTAssertTrue(quit.contains("leaveNow(Set(windows.filter { $0.value.pid == pid }.keys), how: \"quit\", at: at)"))
    }

    /// Case 27: minimize; the window server still draws it through the animation.
    func testCase27AMinimizedWindowLeavesTheLayoutAtOnce() throws {
        let code = try spaces
        let note = try body(code, from: "private func windowNote(", to: "private func leaveNow(")
        XCTAssertTrue(note.contains("minimizedAt[id] = Date()"))
        XCTAssertTrue(note.contains("minimizedAt[id] = nil"), "brought back, it is tiled again")
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/TilingView.swift").contains("f.minimized = minimizedJustNow(id) ||"))
    }

    /// Case 28: moved to another workspace, its old one fills before the switch parks it.
    func testCase28AMoveFillsTheOldWorkspaceBeforeTheSwitch() throws {
        let move = try body(try spaces, from: "func move(_ ids: [WindowID], to n: Int)", to: "func switcherOrder(")
        let assign = try XCTUnwrap(move.range(of: "model.assign(id, to: n, focus: false)")).lowerBound
        let left = try XCTUnwrap(move.range(of: "onWindowsLeft(leaving, \"workspace\", at)")).lowerBound
        let switched = try XCTUnwrap(move.range(of: "switchTo(model.current")).lowerBound
        XCTAssertTrue(assign < left && left < switched, "the model knows it left, then tiling looks, then the switch")
    }

    /// Case 29: a sheet or panel is not a window the model holds, so nothing leaves and nothing is written.
    func testCase29ASheetIsNoWindowThatLeaves() throws {
        let leave = try body(try spaces, from: "private func leaveNow(", to: "private func mayBeTab(")
        XCTAssertTrue(leave.contains("let here = ids.filter { model.workspace(of: $0) != nil }"))
        XCTAssertTrue(leave.contains("guard !here.isEmpty else { return }"))
    }

    /// Case 30: a window a note took out that its app still lists goes back where it was.
    func testCase30AWrongNoteCostsTheWindowNothing() throws {
        let code = try spaces
        XCTAssertTrue(code.contains("if let n = leftEarly.removeValue(forKey: id)?.workspace {\n                model.putBack(id, on: n)"))
        XCTAssertTrue(code.contains("let held = LeftEarly.held(leftEarly, scan: plan.serial, relisted: relisted)"))
        XCTAssertTrue(code.contains("model.sync(seen: list.map(\\.id).filter { !held.contains($0) }"), "a stale listing never brings it back")
        let prune = try body(code, from: "private func prune(alive:", to: "func switchTo(")
        XCTAssertTrue(prune.contains("?? leftEarly[$0.key]?.workspace"), "⌘W in the app in front still counts as a close here")
        XCTAssertTrue(prune.contains("leftEarly = leftEarly.filter { alive.contains($0.key) }"))
    }
}
