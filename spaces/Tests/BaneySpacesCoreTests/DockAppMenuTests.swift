import BaneySpacesCore
import XCTest

/// The dock's right-click menu for an app, like the macOS Dock's, with its depth in submenus: the menus were "way
/// too cluttered" (Donovan, 2026-10-14), so a one-window app on the tile you're on gets six rows and two dividers.
final class DockAppMenuTests: XCTestCase {
    let one = [DockAppMenu.Window(id: 11, title: "Inbox")]
    let two = [DockAppMenu.Window(id: 11, title: "Inbox"), DockAppMenu.Window(id: 12, title: "")]

    func testOneWindowOnTheCurrentTileHasNoWindowList() {
        let items = DockAppMenu.items(windows: one, app: "Mail", workspace: 2, isCurrent: true)
        guard case .moveTo(let all) = items[1] else { return XCTFail("Move to Workspace comes after Show") }
        XCTAssertEqual(all.map(\.title), ["Workspace 1", "Workspace 3", "Workspace 4", "Workspace 5", "Workspace 6",
                                          "Workspace 7", "Workspace 8", "Workspace 9"], "every workspace but this one")
        XCTAssertEqual(items, [.show, .moveTo(all), .hide, .options, .divider, .quit, .divider, .dock])
    }

    func testTwoWindowsListThemFirstByTitleThenADivider() {
        let items = DockAppMenu.items(windows: two, app: "Mail", workspace: 2, isCurrent: true)
        XCTAssertEqual(Array(items.prefix(3)), [.window(.init(id: 11, title: "Inbox")), .window(.init(id: 12, title: "Mail")), .divider],
                       "a window with no title goes by its app's name")
        XCTAssertEqual(items[3], .show)
    }

    func testAnotherWorkspacesTileKeepsMoveFrontWindowHere() {
        let items = DockAppMenu.items(windows: one, app: "Mail", workspace: 4, isCurrent: false)
        guard case .moveTo(let all) = items[1] else { return XCTFail("Move to Workspace comes after Show") }
        XCTAssertFalse(all.contains { $0.workspace == 4 })
        XCTAssertEqual(items, [.show, .moveTo(all), .moveFrontHere, .hide, .options, .divider, .quit, .divider, .dock])
    }

    func testMoveToWorkspaceNamesEachByItsPurpose() {
        let items = DockAppMenu.items(windows: one, app: "Mail", workspace: 1, isCurrent: true, purposes: [2: "Gannon letter", 3: ""])
        guard case .moveTo(let all) = items[1] else { return XCTFail("Move to Workspace comes after Show") }
        XCTAssertEqual(all.prefix(2).map(\.title), ["Workspace 2  ·  Gannon letter", "Workspace 3"])
        XCTAssertEqual(all.map(\.workspace), Array(2...9))
    }

    func testAnAppWithNoWindowsHereHasNothingToMove() {
        let items = DockAppMenu.items(windows: [], app: "Mail", workspace: 1, isCurrent: true)
        XCTAssertEqual(items, [.show, .hide, .options, .divider, .quit, .divider, .dock])
    }

    /// The view draws these items and no others; Force Quit still hides behind ⌥.
    func testTheDockViewIsAThinRenderOfTheItems() throws {
        let dock = try Repo.code("Sources/BaneySpaces/WorkspaceDock.swift")
        XCTAssertTrue(dock.contains("let items = DockAppMenu.items(windows: app.list.map { DockAppMenu.Window(id: $0.id, title: $0.title) }, app: app.name,"))
        XCTAssertTrue(dock.contains("ForEach(Array(items.enumerated()), id: \\.offset) { _, item in appMenuItem(item, app, in: tile) }"))
        for wired in ["model.onFocusWindow(w.id, tile.id)", "model.onMove(app.list.map(\\.id), t.workspace)",
                      "NSRunningApplication(processIdentifier: app.pid)?.hide()", "NSWorkspace.shared.activateFileViewerSelecting([url])",
                      "quit.modifierKeyAlternate(.option) { force }", "Menu(\"Move to Workspace\")", "Menu(\"Options\")"] {
            XCTAssertTrue(dock.contains(wired), wired)
        }
        XCTAssertFalse(dock.contains("Open at Login"), "no public API opens another app at login")
    }
}
