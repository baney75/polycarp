import XCTest
@testable import BaneySpacesCore

final class DefaultAppsFileTests: XCTestCase {
    private let ghostty = "com.mitchellh.ghostty"
    private var dir = ""
    private var file: String { dir + "/baneyspaces/config.toml" }

    override func setUpWithError() throws {
        dir = NSTemporaryDirectory() + "defaults-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(atPath: dir) }

    func testWhereItIs() {
        XCTAssertEqual(DefaultAppsFile.path(env: [:], home: "/h"), "/h/.config/baneyspaces/config.toml")
        XCTAssertEqual(DefaultAppsFile.path(env: ["XDG_CONFIG_HOME": "/x"], home: "/h"), "/x/baneyspaces/config.toml")
        XCTAssertEqual(DefaultAppsFile.path(env: ["XDG_CONFIG_HOME": "x"], home: "/h"), "/h/.config/baneyspaces/config.toml", "a relative one is none")
        XCTAssertEqual(DefaultAppsFile.path(env: ["XDG_CONFIG_HOME": "/x", "BANEYSPACES_CONFIG_DIR": "/d"], home: "/h"), "/d/config.toml")
    }

    func testReadsItsOwnTableOnly() {
        let c = DefaultAppsFile.read("[keys]\nmod = \"cmd\"\n\n[defaults]\nterminal = \"\(ghostty)\" # mine\nagent = 'claude'\n[theme]\nbrowser = \"x.y\"\n")
        XCTAssertEqual(c.apps, [.terminal: .app(ghostty), .agent: .command("claude")])
        XCTAssertEqual(c.warnings, [])
        XCTAssertEqual(DefaultAppsFile.read(""), .init())
    }

    func testABrokenValueNamesItsKeyAndTheRestApplies() {
        let c = DefaultAppsFile.read("[defaults]\nterminal = \"Ghostty\"\nbrowser = 3\nnose = \"a.b\"\nmail = \"com.apple.mail\"\nagent = \"rm\"\n")
        XCTAssertEqual(c.apps, [.mail: .app("com.apple.mail")])
        XCTAssertEqual(c.warnings.count, 4)
        XCTAssertTrue(c.warnings[0].hasPrefix("defaults.terminal (line 2): \"Ghostty\" isn't a bundle identifier"), c.warnings[0])
        XCTAssertTrue(c.warnings[1].hasPrefix("defaults.browser (line 3): 3 isn't"), c.warnings[1])
        XCTAssertTrue(c.warnings[2].hasPrefix("defaults.nose (line 4): no such role"), c.warnings[2])
        XCTAssertTrue(c.warnings[3].contains("one of claude, codex"), c.warnings[3])
    }

    func testALineThatIsNoTOMLLosesOnlyItself() {
        let c = DefaultAppsFile.read("[defaults]\nterminal = com.x.y\r\nmail = \"com.apple.mail\"\nmail = \"x.y\"\n")
        XCTAssertEqual(c.apps, [.mail: .app("com.apple.mail")])
        XCTAssertEqual(c.warnings.count, 2)
        XCTAssertTrue(c.warnings[0].hasPrefix("defaults.terminal (line 2): "), c.warnings[0])
        XCTAssertEqual(c.warnings.last, "defaults.mail (line 4) is set twice; the first one counts")
    }

    func testATroubleElsewhereInTheFileDoesNotReachTheChoices() {
        let c = DefaultAppsFile.read("[keys]\nmod = cmd\n[defaults]\nterminal = \"\(ghostty)\"\n")
        XCTAssertEqual(c.apps, [.terminal: .app(ghostty)])
        XCTAssertEqual(c.warnings.count, 1)
        XCTAssertTrue(c.warnings[0].hasPrefix("config.toml line 2: "), c.warnings[0])
    }

    func testAnEditChangesOneLineAndKeepsTheRest() throws {
        let before = "# my file\n[keys]\nmod = \"cmd\"\n\n[defaults]\n# work\nterminal = \"a.b\"   # for now\nbrowser = \"c.d\"\n\n[theme]\nname = \"omarchy\"\n"
        XCTAssertEqual(try DefaultAppsFile.edit(before, role: .terminal, to: .app(ghostty)),
                       before.replacingOccurrences(of: "terminal = \"a.b\"   # for now", with: "terminal = \"\(ghostty)\"  # for now"))
        XCTAssertEqual(try DefaultAppsFile.edit(before, role: .agent, to: .command("claude")),
                       before.replacingOccurrences(of: "browser = \"c.d\"\n", with: "browser = \"c.d\"\nagent = \"claude\"\n"))
        XCTAssertEqual(try DefaultAppsFile.edit(before, role: .browser, to: nil), before.replacingOccurrences(of: "browser = \"c.d\"\n", with: ""))
        XCTAssertEqual(try DefaultAppsFile.edit(before, role: .mail, to: nil), before)
    }

    func testAnEditMakesTheTable() throws {
        XCTAssertEqual(try DefaultAppsFile.edit("", role: .agent, to: .command("claude")), "[defaults]\nagent = \"claude\"\n")
        XCTAssertEqual(try DefaultAppsFile.edit("[keys]\nmod = \"alt\"", role: .agent, to: .command("pi")), "[keys]\nmod = \"alt\"\n\n[defaults]\nagent = \"pi\"\n")
        XCTAssertEqual(try DefaultAppsFile.edit("[defaults]\n\n[keys]\n", role: .agent, to: .command("pi")), "[defaults]\nagent = \"pi\"\n\n[keys]\n")
        XCTAssertEqual(try DefaultAppsFile.edit("[defaults]\r\nmail = \"a.b\"\r\n", role: .agent, to: .command("pi")), "[defaults]\r\nmail = \"a.b\"\r\nagent = \"pi\"\r\n")
    }

    func testAnEditFixesItsOwnBrokenLineAndLeavesTheOthers() throws {
        let before = "[defaults]\nterminal = com.x\nmail = oops\n"
        let after = try DefaultAppsFile.edit(before, role: .terminal, to: .app(ghostty))
        XCTAssertEqual(after, "[defaults]\nterminal = \"\(ghostty)\"\nmail = oops\n")
        XCTAssertThrowsError(try DefaultAppsFile.edit("defaults = { terminal = \"a.b\" }\n", role: .terminal, to: nil), "a form a line can't change is refused")
    }

    func testWritingKeepsALinkAndItsMode() throws {
        try FileManager.default.createDirectory(atPath: dir + "/repo", withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: dir + "/baneyspaces", withIntermediateDirectories: true)
        try "[defaults]\n".write(toFile: dir + "/repo/c.toml", atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dir + "/repo/c.toml")
        try FileManager.default.createSymbolicLink(atPath: file, withDestinationPath: dir + "/repo/c.toml")
        try DefaultAppsFile.set(.terminal, to: .app(ghostty), path: file)
        XCTAssertEqual(try DefaultAppsFile.load(path: dir + "/repo/c.toml").apps, [.terminal: .app(ghostty)])
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: file), dir + "/repo/c.toml")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: dir + "/repo/c.toml")[.posixPermissions] as? Int, 0o600)
    }

    func testResettingWithNoFileMakesNone() throws {
        try DefaultAppsFile.set(.mail, to: nil, path: file)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
    }

    func testVideoGoesThroughTheFileAndAnOldFileStillLoads() throws {
        let old = "[defaults]\nterminal = \"\(ghostty)\"\nmusic = \"com.spotify.client\"\n"
        try FileManager.default.createDirectory(atPath: dir + "/baneyspaces", withIntermediateDirectories: true)
        try old.write(toFile: file, atomically: true, encoding: .utf8)
        let before = try DefaultAppsFile.load(path: file)
        XCTAssertEqual(before.apps, [.terminal: .app(ghostty), .music: .app("com.spotify.client")])
        XCTAssertEqual(before.warnings, [])
        let mac = FakeInstalledApps([DefaultAppCatalog.quickTime: "QuickTime Player"])
        XCTAssertEqual(DefaultAppResolver.resolve(.video, choice: before.apps[.video], installed: mac).app?.name, "QuickTime Player")
        try DefaultAppsFile.set(.video, to: .app(DefaultAppCatalog.flick), path: file)
        let after = try DefaultAppsFile.load(path: file)
        XCTAssertEqual(after.apps[.video], .app(DefaultAppCatalog.flick))
        XCTAssertEqual(after.apps[.terminal], .app(ghostty), "the rest stays")
        XCTAssertEqual(after.warnings, [])
        try DefaultAppsFile.set(.video, to: nil, path: file)
        XCTAssertNil(try DefaultAppsFile.load(path: file).apps[.video])
    }

}
