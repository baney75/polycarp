import XCTest
@testable import BaneySpacesCore

/// A file dragged out of a window must never be taken for that window being carried to the top of the screen.
final class ContentDragTests: XCTestCase {
    func testAFileDraggedOutOfAStillWindowIsContent() {
        var c = ContentDrag()
        c.press(count: 40)
        XCTAssertFalse(c.isContent(windowMoved: false) { 40 }, "a press that hasn't dragged anything yet")
        XCTAssertTrue(c.isContent(windowMoved: false) { 41 }, "Finder wrote the drag pasteboard; the window stayed put")
    }

    /// A window that followed the pointer is a window drag for good: a late write to the pasteboard (a drop finishing)
    /// must never take a real window drag away from the overview.
    func testAWindowThatMovedIsNeverContent() {
        var c = ContentDrag()
        c.press(count: 40)
        var read = false
        XCTAssertFalse(c.isContent(windowMoved: true) { read = true; return 41 })
        XCTAssertFalse(read, "the pasteboard isn't read for a window that moved")
    }

    func testNoPressNoContent() {
        var c = ContentDrag()
        XCTAssertFalse(c.isContent(windowMoved: false) { 41 })
        c.press(count: 40)
        c.release()
        XCTAssertFalse(c.isContent(windowMoved: false) { 41 })
    }

    /// The window-drag watcher lets a content drag go before the overview can act on it.
    func testTheWatcherLetsAContentDragGo() throws {
        let watcher = try SourceText.code("Sources/BaneySpaces/TopDragWatcher.swift")
        let tick = try XCTUnwrap(SourceText.block(after: "private func tick()", in: watcher))
        let check = try XCTUnwrap(tick.range(of: "content.isContent(windowMoved: state.moving || state.pinned"))
        for later in ["onDragStart(grab.window, p)", "onOpen(g, p)"] {
            let at = try XCTUnwrap(tick.range(of: later), later)
            XCTAssertLessThan(check.lowerBound, at.lowerBound, "the content check comes before \(later)")
        }
        XCTAssertTrue(watcher.contains("content.press(count: NSPasteboard(name: .drag).changeCount)"))
    }
}
