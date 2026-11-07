import XCTest
@testable import BaneySpacesCore

final class BrowserStatusTests: XCTestCase {
    private let sample = """
    {"ok":false,"version":"1.1.9","checks":[
      {"id":"launcher","status":"ok","label":"Agent launcher in place"},
      {"id":"host:Helium","status":"ok","label":"Helium: native host registered"},
      {"id":"host:Chrome","status":"fail","label":"Chrome: native host not registered"},
      {"id":"connected","status":"ok","label":"Extension connected (1.1.9)"},
      {"id":"connected:Helium","status":"ok","label":"Helium: extension connected (1.1.9)"},
      {"id":"mcp:claude","status":"ok","label":"Claude Code: Tabkyra MCP server configured"},
      {"id":"mcp:codex","status":"fail","label":"Codex: Tabkyra MCP server not configured"},
      {"id":"mcp:cursor","status":"warn","label":"Cursor: Tabkyra MCP server not configured"}]}
    """

    func testReadsBrowsersConnectionAndAgentsFromDoctor() throws {
        let s = try XCTUnwrap(BrowserStatus.parse(Data(sample.utf8)))
        XCTAssertEqual(s.browsers, [.init(name: "Helium", registered: true), .init(name: "Chrome", registered: false)])
        XCTAssertTrue(s.extensionConnected)
        XCTAssertEqual(s.extensionVersion, "1.1.9")
        XCTAssertEqual(s.connections, ["Helium": "1.1.9"])
        XCTAssertFalse(s.unattributed)
        XCTAssertEqual(s.agents.map(\.id), ["claude", "codex", "cursor"])
        XCTAssertEqual(s.agents.first?.name, "Claude Code")
        XCTAssertEqual(s.addable.map(\.id), ["codex"], "only Claude Code and Codex are added by the one button")
    }

    func testNotConnectedAndNoBrowser() throws {
        let s = try XCTUnwrap(BrowserStatus.parse(Data(#"{"checks":[{"id":"host","status":"fail","label":"No Chromium browser found"},{"id":"connected","status":"fail","label":"Extension not connected"}]}"#.utf8)))
        XCTAssertTrue(s.browsers.isEmpty)
        XCTAssertFalse(s.extensionConnected)
        XCTAssertNil(s.extensionVersion)
    }

    func testGarbageIsNotAStatus() {
        XCTAssertNil(BrowserStatus.parse(Data("tabkyra: command not found".utf8)))
        XCTAssertNil(BrowserStatus.parse(Data("{}".utf8)))
    }

    func testBundledPathsAreInsideResourcesBrowser() {
        let r = URL(fileURLWithPath: "/Applications/Polycarp.app/Contents/Resources")
        XCTAssertEqual(BrowserBundle.helper(resources: r)?.path, "/Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser")
        XCTAssertEqual(BrowserBundle.extensionFolder(resources: r)?.path, "/Applications/Polycarp.app/Contents/Resources/browser/extension")
        XCTAssertEqual(BrowserBundle.appName(for: "Chrome"), "Google Chrome")
        XCTAssertEqual(BrowserBundle.appName(for: "Helium"), "Helium")
    }

    /// The Settings tab, the welcome row and the helper's own commands are wired, and nothing reimplements the host
    /// registration in Swift (the helper's `install`/`setup` do it).
    func testTheTabCallsTheHelperAndWritesNoManifestItself() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let setup = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/Setup.swift"), encoding: .utf8)
        XCTAssertTrue(setup.contains("case .browser: BrowserSettingsView()"))
        let view = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/BrowserSetup.swift"), encoding: .utf8)
        for command in [#"["install", "--browser", browser]"#, #"["setup", "--yes", "--no-wait"]"#, #"["doctor", "--json"]"#] { XCTAssertTrue(view.contains(command), command) }
        XCTAssertFalse(view.contains("NativeMessagingHosts"))
        let welcome = try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/WelcomeWindow.swift"), encoding: .utf8)
        XCTAssertTrue(welcome.contains("BrowserWelcomeRow()"))
    }

    func testAlwaysAllowReadsWhatTheHelperSays() {
        XCTAssertEqual(BrowserStatus.anySite(fromStatus: Data(#"{"connected":true,"permissionMode":"allow_all"}"#.utf8)), true)
        XCTAssertEqual(BrowserStatus.anySite(fromStatus: Data(#"{"connected":true,"permissionMode":"ask"}"#.utf8)), false)
        XCTAssertNil(BrowserStatus.anySite(fromStatus: Data(#"{"connected":false}"#.utf8)), "no browser answered: unknown, not off")
    }

    func testClaudeAllowRuleChangesOnlyItsOneEntry() throws {
        let before = Data(#"{"model":"opus","permissions":{"allow":["Bash(ls)"],"deny":["Read(x)"]}}"#.utf8)
        let on = try XCTUnwrap(ClaudeAllowRule.applied(true, to: before))
        XCTAssertTrue(ClaudeAllowRule.isOn(on))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: on) as? [String: Any])
        XCTAssertEqual(root["model"] as? String, "opus")
        let permissions = try XCTUnwrap(root["permissions"] as? [String: Any])
        XCTAssertEqual(permissions["allow"] as? [String], ["Bash(ls)", "mcp__polycarp"])
        XCTAssertEqual(permissions["deny"] as? [String], ["Read(x)"])
        let again = try XCTUnwrap(ClaudeAllowRule.applied(true, to: on))
        XCTAssertEqual((try JSONSerialization.jsonObject(with: again) as? [String: Any])?["permissions"].flatMap { ($0 as? [String: Any])?["allow"] as? [String] }, ["Bash(ls)", "mcp__polycarp"], "not added twice")
        let off = try XCTUnwrap(ClaudeAllowRule.applied(false, to: on))
        XCTAssertFalse(ClaudeAllowRule.isOn(off))
    }

    func testClaudeAllowRuleLeavesABrokenFileAlone() {
        XCTAssertNil(ClaudeAllowRule.applied(true, to: Data("{ not json".utf8)))
        XCTAssertTrue(ClaudeAllowRule.isOn(ClaudeAllowRule.applied(true, to: nil)), "no file yet is fine")
        XCTAssertFalse(ClaudeAllowRule.isOn(nil))
    }

    func testTheSwitchNeedsClaudeCodesEntryUnderItsCurrentName() {
        var status = BrowserStatus()
        XCTAssertFalse(status.claudeReady)
        status.agents = [.init(id: "claude", name: "Claude Code", connected: false)]
        XCTAssertFalse(status.claudeReady, "an entry under the old name reads as not connected")
        status.agents = [.init(id: "claude", name: "Claude Code", connected: true)]
        XCTAssertTrue(status.claudeReady)
    }
}
