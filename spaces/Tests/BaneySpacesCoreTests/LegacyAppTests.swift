import XCTest
@testable import BaneySpacesCore

final class LegacyAppTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("legacy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: root) }

    private func install(bundleID: String, in folder: String = "Applications") throws {
        let contents = root.appendingPathComponent("\(folder)/BaneySpaces.app/Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": bundleID], format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
    }

    func testNothingInstalledShowsNothing() {
        let found = LegacyApp.installed(in: LegacyApp.searchFolders(home: root))
        XCTAssertNil(found)
        XCTAssertNil(LegacyApp.line(installed: found, supportDir: root))
    }

    func testAnInstalledOldAppGetsOneCalmLine() throws {
        try install(bundleID: "com.baney.baneyspaces")
        let found = LegacyApp.installed(in: LegacyApp.searchFolders(home: root))
        XCTAssertNotNil(found)
        let support = root.appendingPathComponent("Polycarp")
        XCTAssertEqual(LegacyApp.line(installed: found, supportDir: support), "BaneySpaces is still installed.", "no import yet, so no claim of one")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try Data().write(to: support.appendingPathComponent(Product.importedMarker))
        XCTAssertEqual(LegacyApp.line(installed: found, supportDir: support),
                       "BaneySpaces is still installed. Polycarp imported its settings.")
    }

    func testTheLineSaysWhichPartIsStillToComeWhenTheImportIsNotFinished() throws {
        try install(bundleID: "com.baney.baneyspaces")
        let found = LegacyApp.installed(in: LegacyApp.searchFolders(home: root))
        let support = root.appendingPathComponent("Polycarp")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try Data("layout.json\nbangs.json\n".utf8).write(to: support.appendingPathComponent(SettingsImport.pendingName))
        let line = try XCTUnwrap(LegacyApp.line(installed: found, supportDir: support))
        XCTAssertTrue(line.contains("layout.json, bangs.json") && line.contains("try again"), line)
        XCTAssertFalse(line.contains("imported its settings"), line)
    }

    func testAFolderOfThatNameWithAnotherBundleIDDoesNotCount() throws {
        try install(bundleID: "com.example.other")
        XCTAssertNil(LegacyApp.installed(in: LegacyApp.searchFolders(home: root)))
    }

    func testThereIsNoRemoveButtonUntilTheOldUninstallerIsSafe() throws {
        // BaneySpaces' uninstall.sh starts the old binary (no one-copy guard) three times; see LegacyApp.
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertFalse(setup.contains("Remove BaneySpaces") || setup.contains("LegacyApp.remove"))
    }
}
