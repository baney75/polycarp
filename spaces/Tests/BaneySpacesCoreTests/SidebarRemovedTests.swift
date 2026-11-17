@testable import BaneySpacesCore
import XCTest

/// Donovan removed the sidebar (2026-10-30): the launcher is the one search, and ⌃⌘K opens it.
/// The app target can't be imported by tests, so this reads the source.
final class SidebarRemovedTests: XCTestCase {
    private var root: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    /// Code only: a comment that mentions a name must not count as using it.
    private func code(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false).map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    func testNoSidebarPaletteOrEdgeStripIsDeclared() throws {
        let sources = root.appendingPathComponent("Sources")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
        XCTAssertFalse(files.isEmpty, "found no sources to check")
        for file in files {
            let text = try code(file)
            // Spelled in two halves so this file doesn't name them itself.
            for name in ["Sidebar" + "Panel", "Edge" + "Trigger", "Palette" + "Panel"] {
                XCTAssertFalse(text.contains("class \(name)") || text.contains("struct \(name)") || text.contains("enum \(name)"),
                               "\(file.lastPathComponent) declares \(name), which was removed")
            }
        }
    }

    func testControlCommandKOpensTheLauncher() throws {
        let text = try code(root.appendingPathComponent("Sources/BaneySpaces/AppDelegate.swift"))
        XCTAssertTrue(text.contains("session.onSearch = { [weak self] in self?.launcher.toggle() }"),
                      "the session engine's onSearch must open the launcher")
        // Global means registered before registerShortcuts stops for a missing Accessibility permission: the keymap
        // binds ⌃⌘K and ⌃⌘U by default to actions that need no start, and the loop takes those before `started`.
        let keys = Keymap.defaults(mod: [.cmd])
        XCTAssertEqual(keys.action(for: Chord([.ctrl, .cmd], "k")), .search)
        XCTAssertEqual(keys.action(for: Chord([.ctrl, .cmd], "u")), .agentFinished)
        XCTAssertFalse(KeyAction.search.needsStart, "⌃⌘K must work without Accessibility")
        XCTAssertFalse(KeyAction.agentFinished.needsStart, "⌃⌘U must work without Accessibility")
        let body = try XCTUnwrap(text.components(separatedBy: "private func registerShortcuts() {").dropFirst().first)
        XCTAssertTrue(body.contains("for b in keys.keymap.bindings where started || !b.action.needsStart {"),
                      "keys that need no Accessibility must be registered before it is given")
        XCTAssertTrue(text.contains("case .search: session.onSearch()"), "⌃⌘K must call the session engine's onSearch")
    }

    func testNewClaudeAndNewTerminalAreLauncherCommands() throws {
        let launcher = try code(root.appendingPathComponent("Sources/BaneySpaces/Launcher.swift"))
        XCTAssertTrue(launcher.contains("\"New Claude Session\"") && launcher.contains("\"New Terminal\""))
        let app = try code(root.appendingPathComponent("Sources/BaneySpaces/AppDelegate.swift"))
        XCTAssertTrue(app.contains("a.newClaude = { [weak self] in self?.session.newClaude(in: self?.terminalFolder) }"))
        XCTAssertTrue(app.contains("a.newTerminal = { [weak self] in self?.session.engine.newTerminal(in: self?.terminalFolder) }"), "New Terminal opens in the folder you were in")
    }
}
