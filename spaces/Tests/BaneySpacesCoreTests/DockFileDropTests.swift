import CoreGraphics
import XCTest
@testable import BaneySpacesCore

/// Donovan, 2026-11-22: "the drag files on app isn't working." A file dragged onto an app's icon in the Workspace Dock
/// must open in that app, the icon must light only for an app that opens it, and a file dragged out of a window must
/// never be taken for that window being carried to the top of the screen or to the dock.
final class DockFileDropTests: XCTestCase {
    private let preview = AppTileDrop.App(bundleID: "com.apple.Preview", bundleURL: URL(fileURLWithPath: "/System/Applications/Preview.app"), pid: 501)
    private let textEdit = AppTileDrop.App(bundleID: "com.apple.TextEdit", bundleURL: URL(fileURLWithPath: "/System/Applications/TextEdit.app"), pid: 502)
    private let png = URL(fileURLWithPath: "/tmp/shot.png")
    private let pdf = URL(fileURLWithPath: "/tmp/paper.pdf")

    /// Workspace 1's tile with Preview's and TextEdit's icons inside it, keyed as the dock reports them.
    private let frames: [String: CGRect] = [
        "tile:1": CGRect(x: 0, y: 0, width: 120, height: 60),
        "1:501": CGRect(x: 8, y: 8, width: 40, height: 40),
        "1:502": CGRect(x: 56, y: 8, width: 40, height: 40),
        "bar": CGRect(x: 0, y: 0, width: 300, height: 60),
    ]

    /// The dock's targets with the app kind registered as the dock registers it: Preview opens PNGs and PDFs, TextEdit
    /// opens neither. Each open is recorded.
    private func targets(opened: OpenLog, apps: [String: AppTileDrop.App]? = nil) -> DockDropTargets {
        let apps = apps ?? ["1:501": preview, "1:502": textEdit]
        var t = DockDropTargets()
        t.register(AppTileDrop.kind(
            app: { n, id in apps["\(n):\(id)"] },
            openers: { urls in DockOpen.apps(openingAll: urls, handlers: { _ in [URL(fileURLWithPath: "/System/Applications/Preview.app")] },
                                               identify: { $0.lastPathComponent == "Preview.app" ? "com.apple.Preview" : nil }) },
            open: { urls, app, n in opened.calls.append((urls, app, n)) }))
        return t
    }

    final class OpenLog { var calls: [([URL], AppTileDrop.App, Int)] = [] }

    func testAnAppIconTakesOnlyWhatItsAppOpens() {
        let t = targets(opened: OpenLog())
        XCTAssertEqual(t.hit(at: CGPoint(x: 20, y: 20), frames: frames, urls: [png, pdf]),
                       DockDropHit(key: "1:501", kind: "app", accepts: true), "Preview opens PNGs and PDFs: its icon lights")
        XCTAssertEqual(t.hit(at: CGPoint(x: 70, y: 20), frames: frames, urls: [png]),
                       DockDropHit(key: "1:502", kind: "app", accepts: false), "TextEdit doesn't: its icon stays dark")
        XCTAssertEqual(t.hit(at: CGPoint(x: 20, y: 20), frames: frames, urls: [])?.accepts, false, "a drag with no files or links takes nothing")
    }

    func testADropOpensTheFilesWithTheAppUnderThePointer() {
        let log = OpenLog()
        let t = targets(opened: log)
        XCTAssertTrue(t.drop(key: "1:501", urls: [png, pdf]))
        XCTAssertEqual(log.calls.count, 1)
        XCTAssertEqual(log.calls.first?.0, [png, pdf])
        XCTAssertEqual(log.calls.first?.1.bundleURL, preview.bundleURL, "opened with Preview, the app whose icon took the drop")
        XCTAssertEqual(log.calls.first?.2, 1, "on the icon's workspace")
    }

    func testADropOnAnAppThatCantOpenItOpensNothing() {
        let log = OpenLog()
        let t = targets(opened: log)
        XCTAssertFalse(t.drop(key: "1:502", urls: [png]))
        XCTAssertFalse(t.drop(key: "tile:1", urls: [png]), "a workspace's tile is not an app")
        XCTAssertFalse(t.drop(key: "1:501", urls: []))
        XCTAssertTrue(log.calls.isEmpty)
    }

    func testAnAppThatQuitIsStillOpenedByItsBundle() {
        let log = OpenLog()
        let gone = AppTileDrop.App(bundleID: "com.apple.Preview", bundleURL: preview.bundleURL, pid: 501, running: false)
        let t = targets(opened: log, apps: ["1:501": gone])
        XCTAssertTrue(t.drop(key: "1:501", urls: [png]))
        XCTAssertEqual(log.calls.first?.1.bundleURL, preview.bundleURL, "the drop launches the app from its bundle")
        XCTAssertEqual(log.calls.first?.1.running, false)
    }

    func testAnAppWithNoBundleTakesNothing() {
        let log = OpenLog()
        let bare = AppTileDrop.App(bundleID: "com.apple.Preview", bundleURL: nil, pid: 501)
        let t = targets(opened: log, apps: ["1:501": bare])
        XCTAssertEqual(t.hit(at: CGPoint(x: 20, y: 20), frames: frames, urls: [png])?.accepts, false)
        XCTAssertFalse(t.drop(key: "1:501", urls: [png]))
        XCTAssertTrue(log.calls.isEmpty)
    }

    func testTheIconNotItsTileIsTheTarget() {
        let t = targets(opened: OpenLog())
        XCTAssertEqual(t.tile(at: CGPoint(x: 20, y: 20), frames: frames)?.key, "1:501")
        XCTAssertNil(t.tile(at: CGPoint(x: 110, y: 55), frames: frames), "between icons nothing takes a drop")
        XCTAssertNil(AppTileDrop.parse("tile:1"))
        XCTAssertNil(AppTileDrop.parse("more:2"))
        XCTAssertNil(AppTileDrop.parse("btn:new"))
        XCTAssertNil(AppTileDrop.parse("bar"))
        XCTAssertEqual(AppTileDrop.parse("3:812")?.workspace, 3)
        XCTAssertEqual(AppTileDrop.parse("3:812")?.id, "812")
    }

    /// A later tile kind (a room) plugs in by registering itself; the app icons are untouched.
    func testAnotherKindOfTilePlugsIn() {
        let log = OpenLog()
        var t = targets(opened: log)
        var roomTook: [URL] = []
        let room = { (took: @escaping ([URL]) -> Void) in
            DockDropKind(name: "room", claims: { $0.hasPrefix("room:") }, accepts: { _, urls in urls.allSatisfy { $0.pathExtension == "pdf" } },
                         take: { _, urls in took(urls); return true })
        }
        t.register(room { roomTook = $0 })
        var f = frames
        f["room:study"] = CGRect(x: 200, y: 8, width: 40, height: 40)
        XCTAssertEqual(t.hit(at: CGPoint(x: 210, y: 20), frames: f, urls: [pdf]), DockDropHit(key: "room:study", kind: "room", accepts: true))
        XCTAssertEqual(t.hit(at: CGPoint(x: 210, y: 20), frames: f, urls: [png])?.accepts, false)
        XCTAssertTrue(t.drop(key: "room:study", urls: [pdf]))
        XCTAssertEqual(roomTook, [pdf])
        XCTAssertTrue(log.calls.isEmpty, "a drop on the room opens nothing in an app")
        XCTAssertEqual(t.hit(at: CGPoint(x: 20, y: 20), frames: f, urls: [png])?.key, "1:501", "the app icons answer as before")
        // Registering the same kind again replaces it rather than adding a second.
        t.register(room { _ in })
        XCTAssertEqual(t.kinds.filter { $0.name == "room" }.count, 1)
    }

    // MARK: A file dragged out of a window is not the window carried

    func testAFileDraggedOutOfAStillWindowIsContent() {
        var c = ContentDrag()
        c.press(count: 40)
        XCTAssertFalse(c.isContent(windowMoved: false, dockSaw: nil) { 40 }, "a press that hasn't dragged anything yet")
        XCTAssertTrue(c.isContent(windowMoved: false, dockSaw: nil) { 41 }, "Finder wrote the drag pasteboard; the window stayed put")
    }

    /// A window that followed the pointer is a window drag for good: a late write to the pasteboard (a drop finishing)
    /// must never take a real window drag away from the overview or the dock.
    func testAWindowThatMovedIsNeverContent() {
        var c = ContentDrag()
        c.press(count: 40)
        var read = false
        XCTAssertFalse(c.isContent(windowMoved: true, dockSaw: true) { read = true; return 41 })
        XCTAssertFalse(read, "the pasteboard isn't read for a window that moved")
    }

    /// The dock samples the pasteboard with the buttons up, so its answer wins over the press's own sample.
    func testTheDocksWatchDecidesWhenItIsWatching() {
        var c = ContentDrag()
        c.press(count: 40)
        var read = false
        XCTAssertFalse(c.isContent(windowMoved: false, dockSaw: false) { read = true; return 41 }, "a late write the dock knows came before the press")
        XCTAssertTrue(c.isContent(windowMoved: false, dockSaw: true) { 40 })
        XCTAssertFalse(read)
    }

    func testNoPressNoContent() {
        var c = ContentDrag()
        XCTAssertFalse(c.isContent(windowMoved: false, dockSaw: nil) { 41 })
        c.press(count: 40)
        c.release()
        XCTAssertFalse(c.isContent(windowMoved: false, dockSaw: nil) { 41 })
    }

    // MARK: The wiring (source checks: the app target has no tests of its own)

    /// The dock's panel is an AppKit drag destination that reads the drag's own pasteboard, and the SwiftUI drop that
    /// read the drag pasteboard by name is gone.
    func testTheDockPanelIsADragDestination() throws {
        let dock = try SourceText.code("Sources/BaneySpaces/WorkspaceDock.swift")
        XCTAssertFalse(dock.contains(".onDrop("), "no SwiftUI drop on the dock")
        XCTAssertFalse(dock.contains("board.readObjects"), "the dock never reads the drag pasteboard's items by name")
        XCTAssertTrue(dock.contains("registerForDraggedTypes(DockDropDestination.types)"))
        XCTAssertTrue(dock.contains("host.drop = drop"), "the dock's own panel takes the drop")
        for call in ["drop?.entered(sender)", "drop?.updated(sender)", "drop?.exited()", "drop?.perform(sender)", "drop?.ended()"] {
            XCTAssertTrue(dock.contains(call), "the hosting view forwards \(call)")
        }
        XCTAssertTrue(dock.contains("drop.targets.register(AppTileDrop.kind("), "app icons are a registered drop kind")
        XCTAssertTrue(dock.contains("let carrying = seen || drop.hovering"), "a drag over the panel counts as carrying")
        XCTAssertTrue(dock.contains("if drop.hovering { input.inKeepZone = true }"), "the dock stays up while a drag hovers it")
        let destination = try SourceText.code("Sources/BaneySpaces/DockDropDestination.swift")
        XCTAssertTrue(destination.contains("info.draggingPasteboard.readObjects(forClasses: [NSURL.self]"))
        XCTAssertFalse(destination.contains("NSPasteboard(name: .drag)"))
    }

    /// The window-drag watcher lets a content drag go before the overview or the dock can act on it.
    func testTheWatcherLetsAContentDragGo() throws {
        let watcher = try SourceText.code("Sources/BaneySpaces/TopDragWatcher.swift")
        let tick = try XCTUnwrap(SourceText.block(after: "private func tick()", in: watcher))
        let check = try XCTUnwrap(tick.range(of: "content.isContent(windowMoved: state.moving || state.pinned"))
        for later in ["onDragStart(grab.window, p)", "onOpen(g, p)", "onCarry(grab, p)"] {
            let at = try XCTUnwrap(tick.range(of: later), later)
            XCTAssertLessThan(check.lowerBound, at.lowerBound, "the content check comes before \(later)")
        }
        XCTAssertTrue(watcher.contains("content.press(count: NSPasteboard(name: .drag).changeCount)"))
        let app = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(app.contains("t.contentDragSeen = { [weak self] in self?.dock.outsideDragSeen }"))
    }
}

/// Review of #613, first-F1 (high): the dock's tick sees the buttons up a few milliseconds before AppKit delivers the
/// drop, and once cleared the lit tile there, so a normal drop on an app icon was refused at random.
final class DockDropReleaseTests: XCTestCase {
    func testTheDropThatArrivesJustAfterTheButtonsComeUpStillCounts() {
        var r = DockDropRelease()
        XCTAssertFalse(r.buttonsUp(now: 10.000), "the first tick with the buttons up must not end the drag")
        XCTAssertFalse(r.buttonsUp(now: 10.034), "nor one a tick later, while AppKit's drop is on its way")
        XCTAssertFalse(r.buttonsUp(now: 10.0 + DockDropRelease.grace - 0.01))
    }

    func testADragWithNoDropOrEndGoesStaleAfterTheGrace() {
        var r = DockDropRelease()
        _ = r.buttonsUp(now: 5)
        XCTAssertTrue(r.buttonsUp(now: 5 + DockDropRelease.grace))
    }

    func testAPressOrANewDragStartsTheWaitOver() {
        var r = DockDropRelease()
        _ = r.buttonsUp(now: 1)
        r.reset()
        XCTAssertFalse(r.buttonsUp(now: 1 + DockDropRelease.grace + 1), "the wait counts from the latest release")
    }
}

/// Review of #613, round 2 first-F1 (high): the panel registered only file and link types, so AppKit never told it
/// about a text, image or file-promise drag, and those stopped springing tiles forward as they did before.
final class DockDragTypesTests: XCTestCase {
    func testTheDockFollowsTextImagesAndFilePromisesNotOnlyFiles() {
        let followed = Set(DockDragTypes.followed)
        XCTAssertTrue(Set(DockDragTypes.dropped).isSubset(of: followed))
        for t in ["public.utf8-plain-text", "public.tiff", "public.png", "com.apple.NSFilePromiseItemMetaData"] {
            XCTAssertTrue(followed.contains(t), "\(t) must spring a tile")
        }
    }

    func testOnlyFilesAndLinksDrop() {
        XCTAssertEqual(DockDragTypes.dropped, ["public.file-url", "public.url"])
    }
}
