import XCTest

/// Clicking an agent badge in the Workspace Dock (T3 Code's yellow "?", a tile's orange finished
/// count) flashed the app up and put you straight back on the workspace you were on (Donovan,
/// 2026-11-20, reported before). The session engine raised the window and called `activate()`
/// itself, so Spaces saw an activation it hadn't asked for, of an app it had hidden on another
/// workspace, and re-applied the workspace you were on. A plain icon click worked because it goes
/// through `Spaces.focus`. Every row the session engine goes to (badge, toast, ⌘⇧U, launcher) must
/// go through Spaces when its window has a workspace, with the engine only selecting the tab.
/// The code lives in the app target, which tests can't import, so this reads the source.
final class AgentBadgeFocusTests: XCTestCase {
    private func code(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        // Code only: a comment that names the old pattern must not count.
        return try String(contentsOf: url, encoding: .utf8)
            .split(separator: "\n").map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }

    /// The body of the first function whose declaration line contains `signature`.
    private func body(of signature: String, in text: String) -> String {
        guard let start = text.range(of: signature) else { return "" }
        var depth = 0
        var opened = false
        var end = text.endIndex
        for i in text[start.lowerBound...].indices {
            let c = text[i]
            if c == "{" { depth += 1; opened = true }
            if c == "}" { depth -= 1; if opened && depth == 0 { end = i; break } }
        }
        return String(text[start.lowerBound..<end])
    }

    func testARowWithAWorkspaceGoesThroughSpacesBeforeTheEngine() throws {
        let session = try code("Sources/BaneySpaces/Session/SessionController.swift")
        let focus = body(of: "func focus(_ item: Item)", in: session)
        let viaSpaces = try XCTUnwrap(focus.range(of: "focusWindow(item.windowNumber"),
                                      "SessionController.focus must hand the window to Spaces first")
        let selectOnly = try XCTUnwrap(focus.range(of: "engine.focus(item, bringForward: false)"),
                                       "after Spaces went there, the engine only selects the tab or split")
        XCTAssertLessThan(viaSpaces.lowerBound, selectOnly.lowerBound)
    }

    func testTheEngineActivatesOnlyWhenAskedToBringTheAppForward() throws {
        let engine = try code("Sources/BaneySpaces/Session/Engine.swift")
        let focus = body(of: "func focus(_ item: Item, bringForward: Bool", in: engine)
        XCTAssertFalse(focus.isEmpty, "Engine.focus takes bringForward")
        let guardRange = try XCTUnwrap(focus.range(of: "if bringForward {"))
        let activate = try XCTUnwrap(focus.range(of: "t.app.activate()"))
        let raise = try XCTUnwrap(focus.range(of: "w.ax.raise()"))
        XCTAssertLessThan(guardRange.lowerBound, activate.lowerBound)
        XCTAssertLessThan(guardRange.lowerBound, raise.lowerBound)
        XCTAssertEqual(focus.components(separatedBy: ".activate(").count - 1, 1, "one activate, inside the bringForward branch")
    }

    func testTheAppWiresTheSessionToSpacesFocus() throws {
        let app = try code("Sources/BaneySpaces/AppDelegate.swift")
        let wiring = body(of: "self.session.focusWindow = {", in: app)
        XCTAssertTrue(wiring.contains("self.spaces.focus(id, on: n)"), "the session's focusWindow must be Spaces.focus")
    }
}
