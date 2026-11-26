import XCTest

/// spec/tiling-speed.md R-TS6, cases 21 and 22: an app's own note that a window opened or closed starts a scan of that
/// app at once, and tiling hears of it. No pure test can stand in for an app's notes, so this reads the wiring; the
/// probe (`scripts/tile-probe.swift`) times it live.
final class WindowNotesWiringTests: XCTestCase {
    func testTheWatcherAsksForTheWindowNotes() throws {
        let code = try SourceText.code("Sources/BaneySpaces/FocusWatcher.swift")
        for note in ["kAXWindowCreatedNotification", "kAXMainWindowChangedNotification", "kAXUIElementDestroyedNotification",
                     "kAXWindowMiniaturizedNotification", "kAXWindowDeminiaturizedNotification"] {
            XCTAssertTrue(code.contains(note), note)
        }
        XCTAssertTrue(code.contains("Spaces.axQueue.async"), "each window's notes are asked for off the main thread")
    }

    func testANoteScansItsAppAtOnceAndReachesTiling() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        let start = try XCTUnwrap(code.range(of: "private func windowNote(")).lowerBound
        let end = try XCTUnwrap(code.range(of: "private func focusMovedWithin(", range: start..<code.endIndex)).lowerBound
        let body = String(code[start..<end])
        XCTAssertTrue(body.contains("refresh(full: false, asking: [pid], then: nil)"))
        XCTAssertTrue(body.contains("onWindowNote(TileCauses.Cause(.new"))
        XCTAssertTrue(body.contains("onWindowNote(TileCauses.Cause(.close"))
        XCTAssertTrue(body.contains("onChange?()"), "a window the window server dropped reaches tiling without a scan")
        XCTAssertTrue(code.contains("watcher.watchWindows("), "every scanned window is watched")
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/AppDelegate.swift").contains("spaces.onWindowNote = { [weak self] cause in self?.tiling.cause(cause) }"))
    }
}
