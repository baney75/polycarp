import XCTest
@testable import BaneySpacesCore

final class TerminalAgentTests: XCTestCase {
    let both: Set<String> = ["claude", "codex"]

    func testNamesAndCommandsFindTheirAgent() {
        XCTAssertEqual(TerminalAgent.matches("claude", installed: both).map(\.command), ["claude"])
        XCTAssertEqual(TerminalAgent.matches("Claude Code", installed: both).map(\.command), ["claude"])
        XCTAssertEqual(TerminalAgent.matches("codex", installed: both).map(\.command), ["codex"])
        XCTAssertEqual(TerminalAgent.matches("cl", installed: both).map(\.command), ["claude"])
    }

    func testEukheIsOfferedOnlyWhenFoundAndItsAppFolderIsSearched() {
        let all: Set<String> = ["claude", "codex", "eukhe"]
        XCTAssertEqual(TerminalAgent.matches("eukhe", installed: all).map(\.command), ["eukhe"])
        XCTAssertEqual(TerminalAgent.matches("Eukhe", installed: all).map(\.name), ["Eukhe"])
        XCTAssertEqual(TerminalAgent.matches("eu", installed: all).map(\.command), ["eukhe"])
        XCTAssertEqual(TerminalAgent.matches("eukhe", installed: both), [], "not shown when Local Studio is absent")
        XCTAssertTrue(TerminalAgent.folders.contains("/Applications/Local Studio Nightly.app/Contents/MacOS"))
        XCTAssertTrue(TerminalAgent.folders.contains("/Applications/Local Studio.app/Contents/MacOS"))
    }

    func testScatteredLettersAndOtherWordsDoNot() {
        XCTAssertEqual(TerminalAgent.matches("cdx", installed: both), [])
        XCTAssertEqual(TerminalAgent.matches("safari", installed: both), [])
        XCTAssertEqual(TerminalAgent.matches("", installed: both).count, 0)
    }

    func testOnlyInstalledAgentsAreOffered() {
        XCTAssertEqual(TerminalAgent.matches("codex", installed: ["claude"]), [])
        XCTAssertEqual(TerminalAgent.matches("claude", installed: []), [])
    }

    /// Regression (Donovan, 2026-11-04): Codex from the launcher showed "Allow Ghostty to execute agent-codex.command?".
    func testGhosttyRunsTheScriptFileWithItsPathQuoted() {
        XCTAssertEqual(GhosttyRun.command(script: "/Users/baney/Library/Application Support/BaneySpaces/agent-codex.command"),
                       "/bin/zsh '/Users/baney/Library/Application Support/BaneySpaces/agent-codex.command'")
        XCTAssertEqual(GhosttyRun.command(script: "/a/it's.command"), "/bin/zsh '/a/it'\\''s.command'")
    }

    func testGhosttyIsNeverHandedAScriptFileWhenItCanBeScripted() throws {
        let launcher = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        let opener = try SourceText.code("Sources/BaneySpaces/DefaultApps/RoleOpener.swift")
        XCTAssertTrue(opener.contains("if let ghostty = Terminals.ghostty { ghostty(folder, URL(fileURLWithPath: script), open) } else { open() }"),
                      "Ghostty first, opening the file only as the fallback")
        let brew = try XCTUnwrap(SourceText.block(after: "private static func runInTerminal(_ command: String)", in: launcher))
        let brewGhostty = try XCTUnwrap(brew.range(of: "if Terminals.isGhostty(Terminals.handler()), let ghostty = Terminals.ghostty {"))
        let brewOpen = try XCTUnwrap(brew.range(of: "\n        NSWorkspace.shared.open(url)\n    }"))
        XCTAssertTrue(brewGhostty.lowerBound < brewOpen.lowerBound, "brew: Ghostty before opening the file")
        let engine = try SourceText.code("Sources/BaneySpaces/Session/Engine.swift")
        let run = try XCTUnwrap(SourceText.block(after: "func runInGhostty(", in: engine))
        XCTAssertTrue(run.contains("let r = s.run(\"runWindow\", [dir ?? \"\", command])") && run.contains("Self.neverReached.contains(r.error)"), "only an unsent request falls back")
        let scripts = try String(contentsOf: SourceText.root.appendingPathComponent("Sources/BaneySpaces/Session/Scripts.swift"), encoding: .utf8)
        let handler = try XCTUnwrap(SourceText.between("on runWindow(dir, cmd)", "end runWindow", in: scripts))
        XCTAssertTrue(handler.contains("set command of cfg to cmd") && handler.contains("set wait after command of cfg to true"), "run as the window's command, never typed into his shell")
        XCTAssertTrue(handler.contains("with timeout of 10 seconds"), "every tell carries a timeout")
        XCTAssertTrue(handler.range(of: "activate")!.lowerBound < handler.range(of: "new window with configuration cfg")!.lowerBound, "Ghostty in front before the window is made")
        XCTAssertTrue(handler.contains("is running) then return \"not running\""), "never launches Ghostty from the script")
        XCTAssertTrue(try SourceText.code("Sources/BaneySpaces/AppDelegate.swift").contains("self.session.engine.runInGhostty(in: dir, script: script, orElse: orElse)"))
    }
}
