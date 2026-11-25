import XCTest

/// A private UserDefaults suite for a test, with no file left behind. A suite named like a bundle id is a plist in
/// ~/Library/Preferences that `removePersistentDomain` empties and never deletes: 10,967 `com.baney.test.<UUID>` files
/// and 964 `AppearanceTests-<UUID>` ones were there by 2026-11-25. A suite named by an absolute path is that path's
/// plist, so this one lives in a temporary folder that goes with it.
struct DefaultsSuite {
    let defaults: UserDefaults
    let name: String
    private let folder: URL

    init() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("defaults-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        name = folder.appendingPathComponent("com.baney.test.\(UUID().uuidString)").path
        defaults = try XCTUnwrap(UserDefaults(suiteName: name), "no suite at \(name)")
    }

    func remove() throws {
        defaults.removePersistentDomain(forName: name)
        defaults.synchronize()
        try FileManager.default.removeItem(at: folder)
    }

    /// The files the suite keeps now: in ~/Library/Preferences, or where its name says.
    func files() throws -> [String] {
        let fm = FileManager.default
        let preferences = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Preferences")
        let last = (name as NSString).lastPathComponent
        return try [preferences, folder].filter { fm.fileExists(atPath: $0.path) }.flatMap { dir in
            try fm.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix(last) }.map { dir.appendingPathComponent($0).path }
        }
    }
}

extension XCTestCase {
    /// A suite of this test's own, gone when it ends. A file it left fails the test.
    func defaultsSuite(file: StaticString = #filePath, line: UInt = #line) throws -> (defaults: UserDefaults, name: String) {
        let suite = try DefaultsSuite()
        addTeardownBlock {
            do {
                try suite.remove()
                XCTAssertEqual(try suite.files(), [], "the suite left a file", file: file, line: line)
            } catch { XCTFail("couldn't remove the suite \(suite.name): \(error)", file: file, line: line) }
        }
        return (suite.defaults, suite.name)
    }
}

final class DefaultsSuiteTests: XCTestCase {
    func testASuiteLeavesNoFile() throws {
        let suite = try DefaultsSuite()
        suite.defaults.set("a", forKey: "b")
        suite.defaults.synchronize()
        let kept = try suite.files()
        let preferences = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Preferences").path
        XCTAssertEqual(kept.count, 1, "the suite was never on disk, so nothing is proved")
        XCTAssertFalse(kept.contains { $0.hasPrefix(preferences) }, "the suite writes to the real preferences")
        try suite.remove()
        XCTAssertEqual(try suite.files(), [], "the suite left a file")
    }

    /// Any other way to make a suite leaves its file for good, so the tests make them in one place.
    func testEverySuiteIsMadeHere() throws {
        let files = try XCTUnwrap(FileManager.default.enumerator(at: SourceText.root.appendingPathComponent("Tests"),
                                                                 includingPropertiesForKeys: nil))
        var checked = 0
        for case let url as URL in files where url.pathExtension == "swift" && url.lastPathComponent != "DefaultsSuite.swift" {
            checked += 1
            XCTAssertFalse(try String(contentsOf: url, encoding: .utf8).contains("UserDefaults(suiteName:"),
                           "\(url.lastPathComponent) makes a suite of its own; use defaultsSuite()")
        }
        XCTAssertGreaterThan(checked, 50)
    }
}
