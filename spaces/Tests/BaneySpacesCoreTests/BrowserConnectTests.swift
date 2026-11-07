import AppKit
import XCTest
@testable import BaneySpacesCore

/// A list that several threads append to.
private final class Collected<T>: @unchecked Sendable {
    private let lock = NSLock(); private var items: [T] = []
    func append(_ item: T) { lock.lock(); items.append(item); lock.unlock() }
    var value: [T] { lock.lock(); defer { lock.unlock() }; return items }
}

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
        // The panel: a connection that names no browser is never this browser connecting, whether it was there at open or came later.
        XCTAssertEqual(BrowserPanelState.next(s, bundledVersion: "1.2.0", browser: "Chrome"), .waiting)
        XCTAssertFalse(BrowserPanelState.next(s, bundledVersion: "1.2.0", browser: "Chrome").closesItself)
        // It shows as its own information line.
        XCTAssertEqual(BrowserPanelState.unattributedNote(s, browser: "Chrome"), "Polycarp is connected in a browser (extension 1.2.0), but it can't say which. This closes when Chrome connects.")
        // Once the helper names the browser, that is success.
        let named = status(connections: ["Chrome": "1.2.0"], browsers: [("Helium", true), ("Chrome", true)])
        XCTAssertEqual(BrowserPanelState.next(named, bundledVersion: "1.2.0", browser: "Chrome"), .connected)
        XCTAssertNil(BrowserPanelState.unattributedNote(named, browser: "Chrome"), "an attributed connection needs no note")
        XCTAssertNil(BrowserPanelState.unattributedNote(nil, browser: "Chrome"))
    }

    func testAnUnattributedConnectionAfterOpeningNeverClosesAnotherBrowsersPanel() {
        // Nothing connected when Chrome's panel opened, then an older Helium host connects without a name: Chrome stays waiting.
        XCTAssertEqual(BrowserPanelState.next(status(browsers: [("Helium", true), ("Chrome", true)]), bundledVersion: "1.2.0", browser: "Chrome"), .waiting)
        let later = status(unattributed: "1.2.0", browsers: [("Helium", true), ("Chrome", true)])
        XCTAssertEqual(BrowserPanelState.next(later, bundledVersion: "1.2.0", browser: "Chrome"), .waiting)
    }

    func testALiveBrowserThatDidNotAnswerStillCountsAsConnected() throws {
        // doctor reports a live connection whose extension is silent as a warning; the row must not offer Connect for it.
        let json = #"{"checks":[{"id":"host:Helium","status":"ok","label":"Helium: native host registered"},{"id":"connected:Helium","status":"warn","label":"Helium: extension connected but not responding (unknown version)"}]}"#
        let s = try XCTUnwrap(BrowserStatus.parse(Data(json.utf8)))
        XCTAssertEqual(s.connections["Helium"], "")
        XCTAssertEqual(BrowserRows.rows(s, bundledVersion: "1.2.0").first?.state, .connected)
    }

    func testBundleIDsAreTheHelpersAndOpenByIdNeedsOne() {
        XCTAssertEqual(BrowserBundle.bundleID(for: "Chrome Beta"), "com.google.Chrome.beta")
        XCTAssertEqual(BrowserBundle.bundleID(for: "Helium"), "net.imput.helium")
        XCTAssertNil(BrowserBundle.bundleID(for: "Netscape"))
        // No app found: the plain message names the browser and its own address.
        XCTAssertEqual(BrowserBundle.openYourselfMessage(for: "Brave"), "Open Brave and go to brave://extensions yourself, then drag the folder from the panel onto the page.")
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

    func testANewBuildOfTheSameVersionReachesTheBrowser() throws {
        // 2026-11-06: Previews keep the same versions, so Helium kept a five-hour-old copy with the old logo and the slow panel.
        let root = fm.temporaryDirectory.appendingPathComponent("extcopy-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: root) }
        let support = root.appendingPathComponent("Support", isDirectory: true)
        let src = try fakeExtension(root, version: "1.1.10")
        let info = src.appendingPathComponent("build-info.json")
        try #"{"id":"one"}"#.write(to: info, atomically: true, encoding: .utf8)
        let dest = try XCTUnwrap(ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "0.3.0"))
        XCTAssertEqual(ExtensionCopy.buildID(of: dest), "one")
        try "b".write(to: src.appendingPathComponent("ort/file.js"), atomically: true, encoding: .utf8)
        ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "0.3.0")
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("ort/file.js"), encoding: .utf8), "a", "the same build isn't copied again")
        try #"{"id":"two"}"#.write(to: info, atomically: true, encoding: .utf8)
        ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "0.3.0")
        XCTAssertEqual(ExtensionCopy.buildID(of: dest), "two")
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("ort/file.js"), encoding: .utf8), "b")
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

    func testConcurrentRefreshesOnOneDestinationEndWithACompleteCopy() throws {
        let root = fm.temporaryDirectory.appendingPathComponent("extcopy-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: root) }
        let support = root.appendingPathComponent("Support", isDirectory: true)
        let src = try fakeExtension(root, version: "1.0.0")
        // Many files, so a half-made copy would show.
        for i in 0..<200 { try "file \(i)".write(to: src.appendingPathComponent("ort/f\(i).js"), atomically: true, encoding: .utf8) }
        // An older complete copy is there, so the swap path runs; a leftover staging folder from a dead run is swept.
        XCTAssertNotNil(ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "1"))
        try fm.createDirectory(at: support.appendingPathComponent(ExtensionCopy.stagingPrefix + "dead"), withIntermediateDirectories: true)
        // Eight callers at once with a new app version, the way launch, the poll and Connect overlap.
        let results = Collected<URL?>()
        DispatchQueue.concurrentPerform(iterations: 8) { _ in
            let dest = ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "2")
            results.append(dest)
        }
        let all = results.value
        XCTAssertEqual(all.count, 8)
        let dest = ExtensionCopy.destination(supportDir: support)
        XCTAssertTrue(all.allSatisfy { $0?.path == dest.path }, "every caller got the copy")
        XCTAssertEqual(ExtensionCopy.manifestVersion(of: dest), "1.0.0")
        XCTAssertTrue(try String(contentsOf: dest.appendingPathComponent("manifest.json"), encoding: .utf8).contains(#""key":"KEY""#))
        for i in 0..<200 {
            XCTAssertEqual(try? String(contentsOf: dest.appendingPathComponent("ort/f\(i).js"), encoding: .utf8), "file \(i)", "f\(i).js is whole")
        }
        XCTAssertEqual(try String(contentsOf: support.appendingPathComponent(ExtensionCopy.stampName), encoding: .utf8), "2|1.0.0|?")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: support.path).sorted(), ["Extension", "Extension.stamp"], "no staging folder is left")
    }

    func testAFailedCopyKeepsThePreviousCompleteCopy() throws {
        let root = fm.temporaryDirectory.appendingPathComponent("extcopy-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: root) }
        let support = root.appendingPathComponent("Support", isDirectory: true)
        let src = try fakeExtension(root, version: "1.0.0")
        let dest = try XCTUnwrap(ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "1"))
        // The next source is a folder with a manifest the copy can't finish reading: an unreadable file inside it.
        _ = try fakeExtension(root, version: "1.1.0", extra: "new")
        let blocked = src.appendingPathComponent("ort/file.js")
        try fm.setAttributes([.posixPermissions: 0o000], ofItemAtPath: blocked.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: blocked.path) }
        let result = ExtensionCopy.refresh(source: src, supportDir: support, appVersion: "2")
        XCTAssertEqual(result?.path, dest.path, "the old copy is still handed out")
        XCTAssertEqual(ExtensionCopy.manifestVersion(of: dest), "1.0.0")
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("ort/file.js"), encoding: .utf8), "a")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: support.path).sorted(), ["Extension", "Extension.stamp"])
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

    func testTheStoreLinkNeedsAListing() {
        XCTAssertNil(ExtensionStore.url(id: nil))
        XCTAssertEqual(ExtensionStore.url(id: "abc")?.absoluteString, "https://chromewebstore.google.com/detail/abc")
    }
}
