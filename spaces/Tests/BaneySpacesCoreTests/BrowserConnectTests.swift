import AppKit
import XCTest
@testable import BaneySpacesCore

final class BrowserConnectTests: XCTestCase {
    private let fm = FileManager.default

    private func status(connected: Bool, version: String? = "1.2.0", browsers: [(String, Bool)] = [("Helium", true)]) -> BrowserStatus {
        var s = BrowserStatus()
        s.browsers = browsers.map { .init(name: $0.0, registered: $0.1) }
        s.extensionConnected = connected
        s.extensionVersion = connected ? version : nil
        return s
    }

    // MARK: which browsers, and what each row says

    func testOneRegisteredBrowserHoldsTheConnection() {
        let rows = BrowserRows.rows(status(connected: true, browsers: [("Helium", true), ("Chrome", false)]), lastClicked: nil, bundledVersion: "1.2.0")
        XCTAssertEqual(rows, [.init(name: "Helium", state: .connected), .init(name: "Chrome", state: .connect)])
    }

    func testWithTwoRegisteredTheLastClickedOneHoldsIt() {
        let s = status(connected: true, browsers: [("Helium", true), ("Chrome", true)])
        XCTAssertEqual(BrowserRows.rows(s, lastClicked: "Chrome", bundledVersion: "1.2.0").map(\.state), [.connect, .connected])
        XCTAssertEqual(BrowserRows.rows(s, lastClicked: nil, bundledVersion: "1.2.0").map(\.state), [.connect, .connect])
    }

    func testNotConnectedEveryRowOffersConnect() {
        let rows = BrowserRows.rows(status(connected: false, browsers: [("Helium", true), ("Chrome", false)]), lastClicked: "Helium", bundledVersion: "1.2.0")
        XCTAssertEqual(rows.map(\.state), [.connect, .connect])
    }

    func testAnOlderLoadedExtensionSaysReload() {
        let rows = BrowserRows.rows(status(connected: true, version: "1.1.9"), lastClicked: nil, bundledVersion: "1.2.0")
        XCTAssertEqual(rows.first?.state, .reload(loaded: "1.1.9", current: "1.2.0"))
        XCTAssertFalse(BrowserRows.stale(loaded: nil, current: "1.2.0"), "an unknown version is not called stale")
        XCTAssertFalse(BrowserRows.stale(loaded: "1.2.0", current: "1.2.0"))
    }

    // MARK: the panel

    func testPanelStates() {
        XCTAssertEqual(BrowserPanelState.next(nil, bundledVersion: "1.2.0"), .waiting)
        XCTAssertEqual(BrowserPanelState.next(status(connected: false), bundledVersion: "1.2.0"), .waiting)
        XCTAssertEqual(BrowserPanelState.next(status(connected: true), bundledVersion: "1.2.0"), .connected)
        XCTAssertEqual(BrowserPanelState.next(status(connected: true, version: "1.0.0"), bundledVersion: "1.2.0"), .reload(loaded: "1.0.0", current: "1.2.0"))
        XCTAssertTrue(BrowserPanelState.connected.closesItself)
        XCTAssertFalse(BrowserPanelState.waiting.closesItself)
        XCTAssertFalse(BrowserPanelState.reload(loaded: "a", current: "b").closesItself, "a stale copy stays up until it is reloaded")
        XCTAssertEqual(BrowserPanelState.closeDelay, 1.5)
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
