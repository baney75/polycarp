import XCTest
@testable import BaneySpacesCore

/// First launch after BaneySpaces. Everything runs in temporary folders and private defaults suites;
/// the real support folders and the real preferences are never read or written.
final class SettingsImportTests: XCTestCase {
    private var root: URL!
    private var suites: [String] = []

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("import-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        // A file made unreadable by a test must be removable.
        if let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let u as URL in e { chmod(u.path, 0o700) }
        }
        try? FileManager.default.removeItem(at: root)
        for s in suites { UserDefaults(suiteName: s)?.removePersistentDomain(forName: s) }
    }

    private func suite() -> (UserDefaults, String) {
        let name = "com.baney.test.\(UUID().uuidString)"
        suites.append(name)
        return (UserDefaults(suiteName: name)!, name)
    }

    private var oldDir: URL { root.appendingPathComponent("BaneySpaces") }
    private var newDir: URL { root.appendingPathComponent("Polycarp") }

    private func put(_ name: String, _ text: String, in dir: URL? = nil) throws {
        let d = dir ?? oldDir
        let file = d.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }

    private func run(_ old: (UserDefaults, String), _ new: UserDefaults) -> SettingsImport.Outcome {
        SettingsImport.run(legacyDir: oldDir, newDir: newDir, legacyDefaults: old.0, legacyDomain: old.1, newDefaults: new)
    }

    func testFreshMacWritesNothing() {
        let old = suite(), (new, _) = suite()
        XCTAssertEqual(run(old, new), .nothingToImport)
        XCTAssertFalse(FileManager.default.fileExists(atPath: newDir.path), "a fresh Mac gets no folder from the import")
    }

    func testNormalImportCopiesSettingsAndFilesAndLeavesTheOldOnesAlone() throws {
        let old = suite(), (new, _) = suite()
        old.0.set(3, forKey: "modifierChoice")
        old.0.set("dark", forKey: "look")
        try put("bangs.json", #"{"jira":"x"}"#)
        try put("layout.json", "layout")
        try put("state.json", "state")
        // Things that must never come across.
        try put("baneyspaces.sock", "sock"); try put("trace.log", "log"); try put("crash-ledger.json", "{}")
        try put("mc-heartbeat", "1"); try put("remote-token", "secret"); try put("frames.json", "{}")
        try put("Signing/key", "private", in: oldDir)

        guard case .imported(let report) = run(old, new) else { return XCTFail("expected an import") }
        XCTAssertEqual(Set(report.copiedFiles), ["bangs.json", "layout.json", "state.json"])
        XCTAssertEqual(report.failedFiles, [])
        XCTAssertEqual(new.integer(forKey: "modifierChoice"), 3)
        XCTAssertEqual(new.string(forKey: "look"), "dark")
        XCTAssertEqual(try String(contentsOf: newDir.appendingPathComponent("bangs.json")), #"{"jira":"x"}"#)
        for skipped in ["baneyspaces.sock", "trace.log", "crash-ledger.json", "mc-heartbeat", "remote-token", "frames.json", "Signing"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: newDir.appendingPathComponent(skipped).path), skipped)
        }
        // Copy, never move: the old app's data is all still there.
        XCTAssertTrue(FileManager.default.fileExists(atPath: oldDir.appendingPathComponent("bangs.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: oldDir.appendingPathComponent("Signing/key").path))
        XCTAssertEqual(old.0.integer(forKey: "modifierChoice"), 3)
        XCTAssertTrue(FileManager.default.fileExists(atPath: newDir.appendingPathComponent(Product.importedMarker).path))
    }

    func testTheSavedDockSettingsCopyWithTheirTypes() throws {
        // What uninstalling puts back: the Dock's autohide as it was, a bool, and its delay, a number.
        let old = suite(), (new, _) = suite()
        old.0.set(["autohide": false, "autohide-delay": 0.5] as [String: Any], forKey: "systemDockSaved")
        old.0.set(["com.apple.dock/mcx-expose-disabled": 1] as [String: Any], forKey: "systemMissionControlSaved")
        old.0.set(true, forKey: "dockEnabled")
        _ = run(old, new)
        let saved = try XCTUnwrap(new.dictionary(forKey: "systemDockSaved"))
        let hide = try XCTUnwrap(saved["autohide"] as? NSNumber)
        XCTAssertEqual(CFGetTypeID(hide), CFBooleanGetTypeID(), "autohide stays a boolean, not 0")
        XCTAssertFalse(hide.boolValue)
        XCTAssertEqual((saved["autohide-delay"] as? NSNumber)?.doubleValue, 0.5)
        XCTAssertEqual((new.dictionary(forKey: "systemMissionControlSaved")?["com.apple.dock/mcx-expose-disabled"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual(CFGetTypeID(new.object(forKey: "dockEnabled") as! CFTypeRef), CFBooleanGetTypeID())
    }

    func testASecondLaunchDoesNotImportAgain() throws {
        let old = suite(), (new, _) = suite()
        old.0.set("one", forKey: "k")
        try put("bangs.json", "first")
        _ = run(old, new)
        // The person changes things in Polycarp; BaneySpaces changes too. A second launch leaves both alone.
        new.set("mine", forKey: "k")
        try Data("mine".utf8).write(to: newDir.appendingPathComponent("bangs.json"))
        old.0.set("two", forKey: "other"); try put("bangs.json", "second")
        XCTAssertEqual(run(old, new), .alreadyImported)
        XCTAssertEqual(new.string(forKey: "k"), "mine")
        XCTAssertNil(new.object(forKey: "other"))
        XCTAssertEqual(try String(contentsOf: newDir.appendingPathComponent("bangs.json")), "mine")
    }

    func testPartialDataImportsWhatThereIs() throws {
        // Only files, no preferences.
        let a = suite(), (newA, _) = suite()
        try put("layout.json", "L")
        guard case .imported(let r1) = run(a, newA) else { return XCTFail("files alone import") }
        XCTAssertEqual(r1.copiedFiles, ["layout.json"])
        XCTAssertEqual(r1.copiedPreferences, 0)
        // Only preferences, no folder at all.
        try FileManager.default.removeItem(at: oldDir); try FileManager.default.removeItem(at: newDir)
        let b = suite(), (newB, _) = suite()
        b.0.set(1, forKey: "k")
        guard case .imported(let r2) = run(b, newB) else { return XCTFail("preferences alone import") }
        XCTAssertEqual(r2.copiedFiles, [])
        XCTAssertEqual(newB.integer(forKey: "k"), 1)
    }

    func testAnUnreadableFileIsReportedAndTheRestStillCopies() throws {
        let old = suite(), (new, _) = suite()
        old.0.set(7, forKey: "k")
        try put("bangs.json", "ok")
        try put("layout.json", "locked")
        chmod(oldDir.appendingPathComponent("layout.json").path, 0)
        guard case .imported(let report) = run(old, new) else { return XCTFail("expected an import") }
        XCTAssertEqual(report.failedFiles, ["layout.json"])
        XCTAssertEqual(report.copiedFiles, ["bangs.json"])
        XCTAssertEqual(new.integer(forKey: "k"), 7)
        XCTAssertFalse(FileManager.default.fileExists(atPath: newDir.appendingPathComponent("layout.json").path), "no half-written copy")
        XCTAssertFalse(FileManager.default.fileExists(atPath: newDir.appendingPathComponent("layout.json.copying").path))
        let marker = try String(contentsOf: newDir.appendingPathComponent(Product.importedMarker))
        XCTAssertTrue(marker.contains("not copied: layout.json"), marker)
    }

    func testAKeyPolycarpAlreadyHasIsKept() {
        let old = suite(), (new, _) = suite()
        old.0.set("old", forKey: "k"); new.set("new", forKey: "k")
        _ = run(old, new)
        XCTAssertEqual(new.string(forKey: "k"), "new")
    }
}
