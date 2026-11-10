import XCTest

/// The browser piece of the installer: `polycarp-browser` links to the app's helper unless the name is a file or someone
/// else's link, and the old `tabkyra` command goes only where it is Polycarp's own link. Every run is in a throwaway HOME;
/// nothing real is read or changed.
final class BrowserInstallTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    private let fm = FileManager.default

    private struct Sandbox {
        let home: URL, app: URL, helper: URL
        /// ~/.local/bin/polycarp-browser and ~/.local/bin/tabkyra.
        let link: URL, oldLink: URL
        var previousNote: URL { home.appendingPathComponent("Library/Application Support/Polycarp/tabkyra-previous-link") }
    }

    /// A fake Polycarp.app with a helper that answers --version, and a throwaway HOME beside it.
    private func sandbox() throws -> Sandbox {
        let home = fm.temporaryDirectory.appendingPathComponent("bs-browser-\(UUID().uuidString)").resolvingSymlinksInPath()
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        let app = home.appendingPathComponent("Apps/Polycarp.app")
        let bin = app.appendingPathComponent("Contents/Resources/bin")
        let helper = app.appendingPathComponent("Contents/Resources/browser/polycarp-browser")
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        try fm.createDirectory(at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "x".write(to: bin.appendingPathComponent("polycarp-spaces"), atomically: true, encoding: .utf8)
        try executable("#!/bin/sh\necho 1.0.0\n", at: helper)
        let local = home.appendingPathComponent(".local/bin")
        try fm.createDirectory(at: local, withIntermediateDirectories: true)
        return Sandbox(home: home, app: app, helper: helper,
                       link: local.appendingPathComponent("polycarp-browser"), oldLink: local.appendingPathComponent("tabkyra"))
    }

    private func executable(_ text: String, at url: URL) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    /// Someone else's working tabkyra or polycarp-browser, as an npm link would leave it.
    private func theirs(_ s: Sandbox, _ name: String) throws -> URL {
        let url = s.home.appendingPathComponent("npm/\(name)")
        try executable("#!/bin/sh\necho 1.1.8\n", at: url)
        return url
    }

    @discardableResult
    private func installInPlace(_ s: Sandbox, app: URL? = nil) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [root.appendingPathComponent("scripts/install-app.sh").path, "--in-place", (app ?? s.app).path]
        p.environment = ["HOME": s.home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "BANEYSPACES_DEST_DIR": s.home.appendingPathComponent("elsewhere").path]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, out)
        return out
    }

    private func target(_ url: URL) -> String? { try? fm.destinationOfSymbolicLink(atPath: url.path) }
    private func present(_ url: URL) -> Bool { target(url) != nil || fm.fileExists(atPath: url.path) }

    func testPolycarpBrowserLinksToTheBundledHelperAndFollowsAMovedApp() throws {
        let s = try sandbox()
        try installInPlace(s)
        XCTAssertEqual(target(s.link), s.helper.path)
        XCTAssertFalse(present(s.oldLink), "the tabkyra command is no longer made")
        // Run again from a moved app: an existing link into a Polycarp.app follows it.
        let moved = s.home.appendingPathComponent("Moved/Polycarp.app")
        try fm.createDirectory(at: moved.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.moveItem(at: s.app, to: moved)
        try installInPlace(s, app: moved)
        XCTAssertEqual(target(s.link), moved.appendingPathComponent("Contents/Resources/browser/polycarp-browser").path)
    }

    func testSomeoneElsesPolycarpBrowserLinkOrFileIsLeftAloneWithANote() throws {
        let s = try sandbox()
        let other = try theirs(s, "polycarp-browser")
        try fm.createSymbolicLink(at: s.link, withDestinationURL: other)
        XCTAssertTrue(try installInPlace(s).contains("left alone"))
        XCTAssertEqual(target(s.link), other.path)
        try fm.removeItem(at: s.link)
        try executable("#!/bin/sh\necho mine\n", at: s.link)
        XCTAssertTrue(try installInPlace(s).contains("left alone"))
        XCTAssertNil(target(s.link))
        XCTAssertEqual(try String(contentsOf: s.link, encoding: .utf8), "#!/bin/sh\necho mine\n")
    }

    func testOurOldTabkyraLinkIsRemoved() throws {
        let s = try sandbox()
        try fm.createSymbolicLink(at: s.oldLink, withDestinationURL: s.home.appendingPathComponent("Old/Polycarp.app/Contents/Resources/browser/polycarp-browser"))
        try installInPlace(s)
        XCTAssertFalse(present(s.oldLink), "Polycarp's own tabkyra link goes")
        XCTAssertEqual(target(s.link), s.helper.path)
    }

    func testAnEarlierTakeOverIsUndoneWhenOurTabkyraLinkGoes() throws {
        let s = try sandbox()
        let other = try theirs(s, "tabkyra")
        try fm.createSymbolicLink(at: s.oldLink, withDestinationURL: s.helper)
        try fm.createDirectory(at: s.previousNote.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "\(other.path)\n".write(to: s.previousNote, atomically: true, encoding: .utf8)
        try installInPlace(s)
        XCTAssertEqual(target(s.oldLink), other.path, "the link Polycarp took the name from is back")
        XCTAssertFalse(fm.fileExists(atPath: s.previousNote.path))
    }

    func testAnyOtherTabkyraIsNeverTouched() throws {
        let s = try sandbox()
        // Someone else's working link (an npm link), then a broken one, then a plain file: all stay as they are.
        let other = try theirs(s, "tabkyra")
        try fm.createSymbolicLink(at: s.oldLink, withDestinationURL: other)
        try installInPlace(s)
        XCTAssertEqual(target(s.oldLink), other.path)
        try fm.removeItem(at: s.oldLink)
        let gone = s.home.appendingPathComponent("gone/tabkyra")
        try fm.createSymbolicLink(at: s.oldLink, withDestinationURL: gone)
        try installInPlace(s)
        XCTAssertEqual(target(s.oldLink), gone.path, "a broken link of someone else's is not taken over")
        try fm.removeItem(at: s.oldLink)
        try executable("#!/bin/sh\necho mine\n", at: s.oldLink)
        try installInPlace(s)
        XCTAssertEqual(try String(contentsOf: s.oldLink, encoding: .utf8), "#!/bin/sh\necho mine\n")
        XCTAssertFalse(fm.fileExists(atPath: s.home.appendingPathComponent("Library/Application Support/Polycarp/tabkyra-previous-link").path))
    }

    func testAnAppWithoutTheHelperLinksNothing() throws {
        let s = try sandbox()
        try fm.removeItem(at: s.helper)
        try installInPlace(s)
        XCTAssertFalse(present(s.link))
        XCTAssertFalse(present(s.oldLink))
    }

    func testTheInstallersNoLongerTakeOverTabkyra() throws {
        for file in ["scripts/install-app.sh", "../install.sh"] {
            let script = try String(contentsOf: root.appendingPathComponent(file), encoding: .utf8)
            for gone in ["POLYCARP_TAKE_OVER_TABKYRA", "working_tabkyra", "retire_tabkyra()", "POLYCARP_TABKYRA_DIRS"] {
                XCTAssertFalse(script.contains(gone), "\(file) still has \(gone)")
            }
        }
    }
}

/// uninstall.sh's command links: Polycarp's own go, someone else's stay, and a tabkyra Polycarp took over comes back.
final class UninstallBrowserLinkTests: XCTestCase {
    private let fm = FileManager.default

    private func run(home: URL) throws {
        let sh = try Repo.text("uninstall.sh")
        let from = try XCTUnwrap(sh.range(of: "# The browser command, only if it links into Polycarp's helper."))
        let to = try XCTUnwrap(sh.range(of: "# BEGIN restore-browser-previous"))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "set -eu; \(String(sh[from.lowerBound..<to.lowerBound]))"]
        p.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin"]
        try p.run(); p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0)
    }

    func testOursGoTheirsStayAndATakenOverTabkyraComesBack() throws {
        let home = fm.temporaryDirectory.appendingPathComponent("ub-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        let bin = home.appendingPathComponent(".local/bin")
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        let ours = "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser"
        try fm.createSymbolicLink(atPath: bin.appendingPathComponent("polycarp-browser").path, withDestinationPath: ours)
        try fm.createSymbolicLink(atPath: bin.appendingPathComponent("tabkyra").path, withDestinationPath: ours)
        let note = home.appendingPathComponent("Library/Application Support/Polycarp/tabkyra-previous-link")
        try fm.createDirectory(at: note.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "/npm/bin/tabkyra".write(to: note, atomically: true, encoding: .utf8)
        try run(home: home)
        XCTAssertNil(try? fm.destinationOfSymbolicLink(atPath: bin.appendingPathComponent("polycarp-browser").path))
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: bin.appendingPathComponent("tabkyra").path), "/npm/bin/tabkyra")
        // Someone else's polycarp-browser stays.
        try fm.createSymbolicLink(atPath: bin.appendingPathComponent("polycarp-browser").path, withDestinationPath: "/npm/bin/polycarp-browser")
        try run(home: home)
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: bin.appendingPathComponent("polycarp-browser").path), "/npm/bin/polycarp-browser")
    }
}
