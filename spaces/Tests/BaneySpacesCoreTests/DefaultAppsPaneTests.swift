import XCTest
@testable import BaneySpacesCore

/// Settings > Default apps: what each row says, and that macOS's own default changes only from its button. The app target
/// can't be imported, so the wiring is read from its sources.
final class DefaultAppsPaneTests: XCTestCase {
    private func app(_ id: String, _ name: String, note: String? = nil) -> DefaultCandidate {
        DefaultCandidate(app: .app(id), name: name, path: nil, note: note)
    }
    private func resolved(_ role: AppRole, _ c: DefaultCandidate?, _ s: ResolvedDefault.Source, gone: DefaultApp? = nil) -> ResolvedDefault {
        ResolvedDefault(role: role, app: c, source: s, gone: gone, candidates: [c].compactMap { $0 })
    }

    func testEveryJobHasOneRow() {
        let shown = DefaultAppsText.groups.flatMap(\.roles)
        XCTAssertEqual(shown.count, AppRole.allCases.count)
        XCTAssertEqual(Set(shown), Set(AppRole.allCases))
    }

    func testTheLineSaysWhoDecidedAndWhatTheRestOfTheMacUses() {
        let safari = app("com.apple.Safari", "Safari"), other = app("org.example.browser", "Other")
        XCTAssertEqual(DefaultAppsText.line(resolved(.browser, safari, .system), system: safari), "macOS's default")
        XCTAssertEqual(DefaultAppsText.line(resolved(.browser, other, .you), system: safari), "Polycarp only. Other apps use Safari")
        XCTAssertEqual(DefaultAppsText.line(resolved(.browser, safari, .you), system: safari), "You chose it, and other apps use it too")
        XCTAssertEqual(DefaultAppsText.line(resolved(.notes, other, .you), system: safari), "You chose it", "macOS keeps no default for notes")
        XCTAssertEqual(DefaultAppsText.line(resolved(.agent, nil, .none), system: nil), "Asks you the first time")
        XCTAssertEqual(DefaultAppsText.line(resolved(.music, nil, .none), system: nil), "None is installed")
        XCTAssertEqual(DefaultAppsText.line(resolved(.terminal, app("w", "Warp", note: "Can only open a folder"), .firstInstalled), system: nil),
                       "First one installed. Can only open a folder")
        XCTAssertTrue(DefaultAppsText.line(resolved(.browser, safari, .system, gone: .app("org.example.gone")), system: safari)
            .hasSuffix("isn't installed. Using Safari until it is back."))
    }

    func testTheFirstChoiceLeavesItToMacOS() {
        let safari = app("com.apple.Safari", "Safari"), other = app("org.example.browser", "Other")
        XCTAssertEqual(DefaultAppsText.automatic(.browser, resolved(.browser, other, .you), system: safari), "macOS default: Safari")
        XCTAssertEqual(DefaultAppsText.automatic(.notes, resolved(.notes, other, .firstInstalled), system: nil), "Automatic: Other")
        XCTAssertEqual(DefaultAppsText.automatic(.notes, resolved(.notes, other, .you), system: nil), "Automatic")
        XCTAssertEqual(DefaultAppsText.automatic(.agent, resolved(.agent, other, .you), system: nil), "Ask me")
        XCTAssertEqual(DefaultAppsText.item(app("w", "Warp", note: "folder only")), "Warp (folder only)")
    }

    func testOnlyAnAppMacOSDoesntUseYetAsksWhere() {
        let safari = app("com.apple.Safari", "Safari")
        XCTAssertTrue(DefaultAppsText.asksWhere(.browser, .app("org.example.browser"), system: safari))
        XCTAssertTrue(DefaultAppsText.asksWhere(.mail, .app("org.example.mail"), system: nil))
        XCTAssertFalse(DefaultAppsText.asksWhere(.browser, safari.app, system: safari), "it is macOS's already")
        XCTAssertFalse(DefaultAppsText.asksWhere(.editor, .app("org.example.editor"), system: safari))
        XCTAssertFalse(DefaultAppsText.asksWhere(.mail, .command("mutt"), system: safari), "macOS can't have a program")
    }

    /// R-D8: one call in the whole app, reached from one button.
    func testMacOSsOwnDefaultChangesOnlyFromItsButton() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        var calls: [String] = [], users: [String] = []
        for folder in ["Sources", "../cli/src"] {
            let files = try XCTUnwrap(FileManager.default.enumerator(at: root.appendingPathComponent(folder), includingPropertiesForKeys: nil))
            for case let f as URL in files where ["swift", "rs", "m", "c"].contains(f.pathExtension) {
                let text = try String(contentsOf: f, encoding: .utf8)
                let name = f.lastPathComponent
                for call in ["setDefaultApplication(", "LSSetDefault"] where text.contains(call) { calls.append(name) }
                if text.contains("SystemDefault.set(") { users.append(name) }
            }
        }
        XCTAssertEqual(calls, ["SystemDefault.swift"])
        XCTAssertEqual(users, ["DefaultAppsPane.swift"])
        let pane = try SourceText.code("Sources/BaneySpaces/DefaultApps/DefaultAppsPane.swift")
        XCTAssertEqual(pane.components(separatedBy: "SystemDefault.set(").count, 2)
        XCTAssertEqual(pane.components(separatedBy: "everywhere(").count, 3, "its button and itself")
        XCTAssertTrue(pane.contains(#"Button("Everywhere on This Mac") { everywhere(a.role, a.app) }"#))
        let done = try XCTUnwrap(SourceText.block(after: "private func everywhere(_ role: AppRole, _ app: DefaultApp) ", in: pane))
        XCTAssertTrue(done.contains("if let refused {"), "a no keeps the old choice")
        let set = try SourceText.code("Sources/BaneySpaces/DefaultApps/SystemDefault.swift")
        XCTAssertTrue(set.contains(#"role == .browser ? ["http", "https"] : ["mailto"]"#))
        XCTAssertTrue(set.contains("guard current(scheme) == app.standardizedFileURL else {"), "what macOS kept, read back")
    }

    /// Opening the pane reads nothing on the main thread, and an answer that comes late moves nothing.
    func testThePaneReadsOffTheMainThread() throws {
        let store = try SourceText.code("Sources/BaneySpaces/DefaultApps/DefaultAppsStore.swift")
        let show = try XCTUnwrap(SourceText.block(after: "func showIcons() ", in: store))
        XCTAssertTrue(show.contains("queue.async {"))
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "func refresh() ", in: store)).contains("queue.async {"))
        let pane = try SourceText.code("Sources/BaneySpaces/DefaultApps/DefaultAppsPane.swift")
        XCTAssertFalse(pane.contains("urlForApplication"))
        XCTAssertFalse(pane.contains("Picker("), "every choice of eleven lists is 40 ms")
        let list = try SourceText.code("Sources/BaneySpaces/DefaultApps/LazyPopUp.swift")
        XCTAssertEqual(list.components(separatedBy: "view.items()").count, 2)
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "func opening(_ note: Notification) ", in: list)).contains("view.items()"))
        XCTAssertTrue(list.contains("setAccessibilityLabel(label)"))
        XCTAssertFalse(pane.contains("LaunchServicesApps()"))
        XCTAssertTrue(pane.contains(#"?? " ")"#), "the line has its height before its words")
    }
}
