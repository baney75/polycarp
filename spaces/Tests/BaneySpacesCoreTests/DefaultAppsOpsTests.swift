import XCTest
@testable import BaneySpacesCore

final class DefaultAppsOpsTests: XCTestCase {
    private var file = ""

    override func setUp() { file = NSTemporaryDirectory() + "defaults-" + UUID().uuidString + "/config.toml" }
    override func tearDown() { try? FileManager.default.removeItem(at: URL(fileURLWithPath: file).deletingLastPathComponent()) }

    private let mac = FakeInstalledApps(["com.apple.Safari": "Safari", "org.mozilla.firefox": "Firefox", "com.apple.mail": "Mail", "org.odd": "Odd"],
                                        system: [.scheme("http"): "com.apple.Safari"], commands: ["claude": "/b/claude"])

    private func ok(_ r: DefaultAppsOps.Result, line: UInt = #line) -> [String: SurfaceValue] {
        switch r {
        case let .success(v): return v.object ?? [:]
        case let .failure(f): XCTFail(f.message, line: line); return [:]
        }
    }

    func testSetTakesAnIdAProgramOrAName() throws {
        for (asked, id) in [("org.mozilla.firefox", "org.mozilla.firefox"), ("firefox", "org.mozilla.firefox"), ("ORG.MOZILLA.FIREFOX", "org.mozilla.firefox"), ("org.odd", "org.odd")] {
            let d = ok(DefaultAppsOps.set("browser", asked, file: file, installed: mac))
            XCTAssertEqual(d["app"]?.object?["id"], .string(id), asked)
            XCTAssertEqual(d["source"], .string("you"))
            XCTAssertEqual(try DefaultAppsFile.load(path: file).apps[.browser], .app(id))
        }
        XCTAssertEqual(ok(DefaultAppsOps.set("agent", "claude code", file: file, installed: mac))["app"]?.object?["id"], .string("claude"))
        XCTAssertEqual(try DefaultAppsFile.load(path: file).apps, [.browser: .app("org.odd"), .agent: .command("claude")])
        XCTAssertEqual(ok(DefaultAppsOps.reset("browser", file: file, installed: mac))["source"], .string("macos"))
        XCTAssertEqual(try DefaultAppsFile.load(path: file).apps, [.agent: .command("claude")])
    }

    func testSetRefusesWhatIsNotInstalledAndWritesNothing() {
        for (role, app) in [("browser", "com.google.Chrome"), ("agent", "codex"), ("browser", "claude"), ("nose", "com.apple.mail"), ("mail", "$(rm)")] {
            guard case .failure = DefaultAppsOps.set(role, app, file: file, installed: mac) else { XCTFail("\(role) \(app)"); continue }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
    }

    func testOnlyBrowserAndMailSayHowToSetTheWholeMac() {
        XCTAssertNotNil(ok(DefaultAppsOps.set("browser", "firefox", file: file, installed: mac))["everywhere"])
        XCTAssertNotNil(ok(DefaultAppsOps.set("mail", "mail", file: file, installed: mac))["everywhere"])
        XCTAssertNil(ok(DefaultAppsOps.set("agent", "claude", file: file, installed: mac))["everywhere"])
    }

    func testListSaysEveryRoleAndEachWarning() throws {
        try DefaultAppsFile.set(.browser, to: .app("org.mozilla.firefox"), path: file)
        try (DefaultAppsFile.text(at: file)! + "mail = 3\n").write(toFile: file, atomically: true, encoding: .utf8)
        let d = ok(DefaultAppsOps.list(file: file, installed: mac))
        XCTAssertEqual(d["defaults"]?.array?.compactMap { $0.object?["role"]?.string }, AppRole.allCases.map(\.rawValue))
        XCTAssertEqual(d["warnings"]?.array?.count, 1)
        XCTAssertEqual(ok(DefaultAppsOps.get("mail", file: file, installed: mac))["warnings"]?.array?.count, 1)
        XCTAssertEqual(ok(DefaultAppsOps.get("browser", file: file, installed: mac))["warnings"]?.array?.count, 0)
        let c = ok(DefaultAppsOps.candidates("browser", file: file, installed: mac))["candidates"]?.array ?? []
        XCTAssertEqual(c.map { $0.object?["current"] }, [.bool(false), .bool(true)])
    }
}

final class CommandSearchTests: XCTestCase {
    func testFoldersComeFromFilesAndPathInOrderOnce() {
        let files = ["/h/.zshrc": "echo hi\nexport PATH=\"$HOME/a:${HOME}/b:$PATH\"\n  PATH=~/c:/d:./here:$(x)/y:`z`\nMYPATH=/no\n",
                     "/etc/paths": "/usr/bin\n/e\n", "/etc/paths.d/z": "/f\n"]
        let f = CommandSearch.folders(path: "/d:/g::rel", home: "/h", read: { files[$0] },
                                      list: { $0 == "/etc/paths.d" ? ["z"] : $0 == "/h/.nvm/versions/node" ? ["v20", "v22"] : [] })
        XCTAssertEqual(Array(f.prefix(8)), ["/h/a", "/h/b", "/h/c", "/d", "/g", "/usr/bin", "/e", "/f"])
        XCTAssertEqual(Set(f).count, f.count)
        XCTAssertTrue(f.allSatisfy { $0.hasPrefix("/") && !$0.contains("$") && !$0.contains("`") }, "\(f)")
        XCTAssertTrue(f.contains("/h/.local/bin") && f.contains("/opt/homebrew/bin"))
        XCTAssertEqual(f.suffix(2), ["/h/.nvm/versions/node/v22/bin", "/h/.nvm/versions/node/v20/bin"])
    }

    func testTheBestNameWinsWhicheverFolderItIsIn() {
        let s = CommandSearch(folders: ["/a", "/b"])
        XCTAssertEqual(s.find(["agy", "gemini"], isProgram: ["/a/gemini", "/b/agy"].contains), "/b/agy")
        XCTAssertEqual(s.find(["gemini"], isProgram: ["/a/gemini", "/b/gemini"].contains), "/a/gemini")
        XCTAssertNil(s.find(["x"], isProgram: { _ in false }))
    }

    /// R-D6: a program that would leave a mark when run is found, and leaves none.
    func testFindingRunsNothing() throws {
        let dir = NSTemporaryDirectory() + "search-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir + "/claude.d", withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try "#!/bin/sh\ntouch '\(dir)/ran'\n".write(toFile: dir + "/claude", atomically: true, encoding: .utf8)
        XCTAssertNil(CommandSearch(folders: [dir]).find(["claude"]), "not executable")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir + "/claude")
        try "export PATH=\"\(dir):$PATH\"\ntouch '\(dir)/ran'\n".write(toFile: dir + "/.zshrc", atomically: true, encoding: .utf8)
        XCTAssertEqual(CommandSearch.live(env: [:], home: dir).find(["claude"]), dir + "/claude")
        XCTAssertNil(CommandSearch(folders: [dir]).find(["claude.d"]), "a folder is no program")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir + "/ran"))
    }

    /// The sources that find things hold no way to start a process.
    func testTheDetectionSourcesStartNoProcess() throws {
        let core = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BaneySpacesCore")
        for file in ["DefaultApps", "DefaultAppCatalog", "DefaultAppsFile", "DefaultAppsOps", "CommandSearch", "LaunchServicesApps"] {
            let text = try String(contentsOf: core.appendingPathComponent(file + ".swift"), encoding: .utf8)
            for way in ["Process(", "posix_spawn", "popen(", "system(", "NSAppleScript", "setDefaultApplication", "LSSetDefault", "execv"] {
                XCTAssertFalse(text.contains(way), "\(file) has \(way)")
            }
        }
    }
}
