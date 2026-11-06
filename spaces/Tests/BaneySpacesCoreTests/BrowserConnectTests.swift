import AppKit
import XCTest
@testable import BaneySpacesCore

final class BrowserConnectTests: XCTestCase {
    private let fm = FileManager.default

    private func status(connections: [String: String] = [:], unattributed: String? = nil, browsers: [(String, Bool)] = [("Helium", true)]) -> BrowserStatus {
        var s = BrowserStatus()
        s.browsers = browsers.map { .init(name: $0.0, registered: $0.1) }
        s.connections = connections
        if let v = unattributed { s.extensionConnected = true; s.extensionVersion = v }
        if !connections.isEmpty { s.extensionConnected = true; s.extensionVersion = connections.values.first }
        return s
    }

    // MARK: which browser holds the connection

    func testTheRowShowsTheBrowserThatReallyHoldsTheConnection() {
        let s = status(connections: ["Helium": "1.2.0"], browsers: [("Helium", true), ("Chrome", true)])
        XCTAssertEqual(BrowserRows.rows(s, bundledVersion: "1.2.0"), [.init(name: "Helium", state: .connected), .init(name: "Chrome", state: .connect)])
    }

    func testClickingConnectOnAnotherBrowserNeverMovesTheConnection() {
        // Helium holds it; Chrome was just registered and clicked. Its row still offers Connect, and its panel keeps waiting.
        let s = status(connections: ["Helium": "1.2.0"], browsers: [("Helium", true), ("Chrome", true)])
        XCTAssertEqual(BrowserRows.rows(s, bundledVersion: "1.2.0")[1].state, .connect)
        XCTAssertEqual(BrowserPanelState.next(s, bundledVersion: "1.2.0", browser: "Chrome"), .waiting)
        XCTAssertEqual(BrowserPanelState.next(s, bundledVersion: "1.2.0", browser: "Helium"), .connected)
    }

    func testBothBrowsersConnectedEachRowSaysSo() {
        let s = status(connections: ["Helium": "1.2.0", "Chrome": "1.2.0"], browsers: [("Helium", true), ("Chrome", true)])
        XCTAssertEqual(BrowserRows.rows(s, bundledVersion: "1.2.0").map(\.state), [.connected, .connected])
    }

    func testAnOlderHelperThatNamesNoBrowserGivesOneGlobalLine() {
        let s = status(unattributed: "1.2.0", browsers: [("Helium", true), ("Chrome", true)])
        XCTAssertTrue(s.unattributed)
        XCTAssertEqual(BrowserRows.rows(s, bundledVersion: "1.2.0").map(\.state), [.connect, .connect], "no row claims it")
        // The panel: something that was already connected when it opened is not its browser; one that appears later is.
        XCTAssertEqual(BrowserPanelState.next(s, bundledVersion: "1.2.0", browser: "Chrome", connectedAtOpen: true), .waiting)
        XCTAssertEqual(BrowserPanelState.next(s, bundledVersion: "1.2.0", browser: "Chrome", connectedAtOpen: false), .connected)
    }

    func testOnlyAnOlderLoadedVersionIsStale() {
        XCTAssertTrue(BrowserRows.stale(loaded: "1.1.9", current: "1.1.10"))
        XCTAssertFalse(BrowserRows.stale(loaded: "1.1.12", current: "1.1.10"), "a newer standalone copy: reloading changes nothing")
        XCTAssertFalse(BrowserRows.stale(loaded: "1.2.0", current: "1.2.0"))
        XCTAssertFalse(BrowserRows.stale(loaded: nil, current: "1.2.0"))
        XCTAssertFalse(BrowserRows.stale(loaded: "", current: "1.2.0"))
        let rows = BrowserRows.rows(status(connections: ["Helium": "1.1.9"]), bundledVersion: "1.1.10")
        XCTAssertEqual(rows.first?.state, .reload(loaded: "1.1.9", current: "1.1.10"))
        XCTAssertEqual(BrowserRows.rows(status(connections: ["Helium": "1.1.12"]), bundledVersion: "1.1.10").first?.state, .connected)
    }

    // MARK: the panel

    func testPanelStates() {
        XCTAssertEqual(BrowserPanelState.next(nil, bundledVersion: "1.2.0", browser: "Helium"), .waiting)
        XCTAssertEqual(BrowserPanelState.next(status(), bundledVersion: "1.2.0", browser: "Helium"), .waiting)
        XCTAssertEqual(BrowserPanelState.next(status(connections: ["Helium": "1.0.0"]), bundledVersion: "1.2.0", browser: "Helium"), .reload(loaded: "1.0.0", current: "1.2.0"))
        XCTAssertTrue(BrowserPanelState.connected.closesItself)
        XCTAssertFalse(BrowserPanelState.waiting.closesItself)
        XCTAssertFalse(BrowserPanelState.reload(loaded: "a", current: "b").closesItself, "an older copy stays up until it is reloaded or closed")
        XCTAssertEqual(BrowserPanelState.closeDelay, 1.5)
    }

    func testPanelPlacementNeverCoversThePagesTopBar() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 875)
        let size = CGSize(width: 284, height: 330)
        // Room on the right: beside the window.
        let beside = BrowserPanelPlacement.place(size: size, window: CGRect(x: 100, y: 100, width: 800, height: 600), in: screen)
        XCTAssertEqual(beside.x, 912)
        // Maximized: no room either side, so the window's bottom right, below the page's top bar.
        let full = CGRect(x: 0, y: 0, width: 1440, height: 875)
        let max = BrowserPanelPlacement.place(size: size, window: full, in: screen)
        XCTAssertLessThan(max.y + size.height, full.maxY - 100, "well below the top of the window, where Developer mode is")
        XCTAssertGreaterThanOrEqual(max.x, 0); XCTAssertLessThanOrEqual(max.x + size.width, screen.maxX)
        // Room only on the left.
        let left = BrowserPanelPlacement.place(size: size, window: CGRect(x: 400, y: 100, width: 1040, height: 700), in: screen)
        XCTAssertEqual(left.x, 400 - 12 - 284)
    }

    func testBrowsersOwnSchemeWhereTheyHaveOne() {
        XCTAssertEqual(BrowserBundle.extensionsAddress(for: "Brave"), "brave://extensions")
        XCTAssertEqual(BrowserBundle.extensionsAddress(for: "Edge"), "edge://extensions")
        XCTAssertEqual(BrowserBundle.extensionsAddress(for: "Helium"), "chrome://extensions")
    }

    // MARK: the drag

    func testTheDragIsARealFileURL() throws {
        let folder = fm.temporaryDirectory.appendingPathComponent("drag-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: folder) }
        let writer = ExtensionDrag.writer(for: folder)
        let pb = NSPasteboard(name: NSPasteboard.Name("polycarp-test-\(UUID().uuidString)"))
        pb.clearContents()
        XCTAssertTrue(pb.writeObjects([writer]))
        XCTAssertEqual(ExtensionDrag.type, .fileURL)
        XCTAssertTrue(pb.types?.contains(.fileURL) ?? false)
        let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        XCTAssertEqual(urls?.first?.resolvingSymlinksInPath().path, folder.resolvingSymlinksInPath().path)
    }

    // MARK: the copy

    private func fakeExtension(_ root: URL, version: String, extra: String = "a") throws -> URL {
        let src = root.appendingPathComponent("src", isDirectory: true)
        try? fm.removeItem(at: src)
        try fm.createDirectory(at: src.appendingPathComponent("ort"), withIntermediateDirectories: true)
        try #"{"version":"\#(version)","key":"KEY"}"#.write(to: src.appendingPathComponent("manifest.json"), atomically: true, encoding: .utf8)
        try extra.write(to: src.appendingPathComponent("ort/file.js"), atomically: true, encoding: .utf8)
        return src
    }

    func testTheCopyIsMadeOnceAndRefreshedWhenTheVersionChanges() throws {
        let root = fm.temporaryDirectory.appendingPathComponent("extcopy-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: root) }
        let support = root.appendingPathComponent("Support", isDirectory: true)
        let src = try fakeExtension(root, version: "1.0.0")
        let dest = try XCTUnwrap(ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "0.3.0"))
        XCTAssertEqual(dest.lastPathComponent, "Extension")
        XCTAssertEqual(dest.deletingLastPathComponent().path, support.path)
        XCTAssertEqual(ExtensionCopy.manifestVersion(of: dest), "1.0.0")
        XCTAssertTrue(try String(contentsOf: dest.appendingPathComponent("manifest.json"), encoding: .utf8).contains(#""key":"KEY""#), "the key, so the id, is copied")
        // Same versions: the copy is left as it is, even if the source's other files differ.
        try "b".write(to: src.appendingPathComponent("ort/file.js"), atomically: true, encoding: .utf8)
        ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "0.3.0")
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("ort/file.js"), encoding: .utf8), "a")
        // The app's version changed.
        ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "0.4.0")
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("ort/file.js"), encoding: .utf8), "b")
        // The extension's own version changed under the same app version.
        _ = try fakeExtension(root, version: "1.1.0", extra: "c")
        ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "0.4.0")
        XCTAssertEqual(ExtensionCopy.manifestVersion(of: dest), "1.1.0")
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("ort/file.js"), encoding: .utf8), "c")
        let left = try fm.contentsOfDirectory(atPath: support.path).sorted()
        XCTAssertEqual(left, ["Extension", "Extension.stamp"], "no .new or .old folder is left behind")
    }

    func testAMissingSourceLeavesTheOldCopyAlone() throws {
        let root = fm.temporaryDirectory.appendingPathComponent("extcopy-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: root) }
        let support = root.appendingPathComponent("Support", isDirectory: true)
        let src = try fakeExtension(root, version: "1.0.0")
        let dest = try XCTUnwrap(ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "1"))
        try fm.removeItem(at: src)
        XCTAssertNil(ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "2"))
        XCTAssertEqual(ExtensionCopy.manifestVersion(of: dest), "1.0.0")
    }
}
