import XCTest

/// The browser piece of the installer: `tabkyra` links to the app's helper unless a working one of someone
/// else's is there. Every run is in a throwaway HOME with stub commands; nothing real is read or changed.
final class BrowserInstallTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    private let fm = FileManager.default

    /// A fake Polycarp.app with a helper that answers --version, and a throwaway HOME beside it.
    private func sandbox() throws -> (home: URL, app: URL, helper: URL, link: URL) {
        let home = fm.temporaryDirectory.appendingPathComponent("bs-browser-\(UUID().uuidString)").resolvingSymlinksInPath()
        let app = home.appendingPathComponent("Apps/Polycarp.app")
        let bin = app.appendingPathComponent("Contents/Resources/bin")
        let helper = app.appendingPathComponent("Contents/Resources/browser/polycarp-browser")
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        try fm.createDirectory(at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "x".write(to: bin.appendingPathComponent("polycarp-spaces"), atomically: true, encoding: .utf8)
        try "#!/bin/sh\necho 1.0.0\n".write(to: helper, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)
        try fm.createDirectory(at: home.appendingPathComponent(".local/bin"), withIntermediateDirectories: true)
        return (home, app, helper, home.appendingPathComponent(".local/bin/tabkyra"))
    }

    private func installInPlace(home: URL, app: URL, takeOver: Bool = false) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [root.appendingPathComponent("scripts/install-app.sh").path, "--in-place", app.path]
        var env = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "BANEYSPACES_DEST_DIR": home.appendingPathComponent("elsewhere").path]
        if takeOver { env["POLYCARP_TAKE_OVER_TABKYRA"] = "1" }
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, out)
        return out
    }

    func testTabkyraLinksToTheBundledHelperWhenTheNameIsFree() throws {
        let s = try sandbox()
        defer { try? fm.removeItem(at: s.home) }
        _ = try installInPlace(home: s.home, app: s.app)
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: s.link.path), s.helper.path)
        // Run again from a moved app: an existing link into a Polycarp.app follows it.
        let moved = s.home.appendingPathComponent("Moved/Polycarp.app")
        try fm.createDirectory(at: moved.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.moveItem(at: s.app, to: moved)
        _ = try installInPlace(home: s.home, app: moved)
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: s.link.path), moved.appendingPathComponent("Contents/Resources/browser/polycarp-browser").path)
    }

    func testAWorkingTabkyraOfSomeoneElsesIsLeftAlone() throws {
        let s = try sandbox()
        defer { try? fm.removeItem(at: s.home) }
        let theirs = s.home.appendingPathComponent("npm/tabkyra")
        try fm.createDirectory(at: theirs.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho 1.1.8\n".write(to: theirs, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: theirs.path)
        try fm.createSymbolicLink(at: s.link, withDestinationURL: theirs)
        let out = try installInPlace(home: s.home, app: s.app)
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: s.link.path), theirs.path)
        XCTAssertTrue(out.contains("left alone"), out)
    }

    func testAPlainFileIsNeverReplaced() throws {
        let s = try sandbox()
        defer { try? fm.removeItem(at: s.home) }
        try "#!/bin/sh\necho mine\n".write(to: s.link, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: s.link.path)
        _ = try installInPlace(home: s.home, app: s.app, takeOver: true)
        XCTAssertNil(try? fm.destinationOfSymbolicLink(atPath: s.link.path))
        XCTAssertEqual(try String(contentsOf: s.link, encoding: .utf8), "#!/bin/sh\necho mine\n")
    }

    func testTakingOverRelinksAndWritesTheOldLinkDown() throws {
        let s = try sandbox()
        defer { try? fm.removeItem(at: s.home) }
        let theirs = s.home.appendingPathComponent("npm/tabkyra")
        try fm.createDirectory(at: theirs.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho 1.1.8\n".write(to: theirs, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: theirs.path)
        try fm.createSymbolicLink(at: s.link, withDestinationURL: theirs)
        _ = try installInPlace(home: s.home, app: s.app, takeOver: true)
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: s.link.path), s.helper.path)
        let note = s.home.appendingPathComponent("Library/Application Support/Polycarp/tabkyra-previous-link")
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), theirs.path)
        XCTAssertTrue(fm.fileExists(atPath: theirs.path), "their tabkyra is untouched")
    }

    func testABrokenLinkIsReplaced() throws {
        let s = try sandbox()
        defer { try? fm.removeItem(at: s.home) }
        try fm.createSymbolicLink(at: s.link, withDestinationURL: s.home.appendingPathComponent("gone/tabkyra"))
        _ = try installInPlace(home: s.home, app: s.app)
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: s.link.path), s.helper.path)
    }

    func testAnAppWithoutTheHelperLinksNothing() throws {
        let s = try sandbox()
        defer { try? fm.removeItem(at: s.home) }
        try fm.removeItem(at: s.helper)
        _ = try installInPlace(home: s.home, app: s.app)
        XCTAssertFalse(fm.fileExists(atPath: s.link.path))
        XCTAssertNil(try? fm.destinationOfSymbolicLink(atPath: s.link.path))
    }
}
