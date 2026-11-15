import XCTest
import BaneySpacesCore

/// What the Settings window reads, and when: opening it read everything three times on the main thread, and an open
/// window redrew four times a second for values that hadn't changed. The app target can't be imported, so these read it.
final class SettingsReadsTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func read(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }

    /// The text from `start` up to `end`, both required.
    private func body(_ text: String, from start: String, to end: String) throws -> String {
        let a = try XCTUnwrap(text.range(of: start), "no \(start)")
        let b = try XCTUnwrap(text[a.upperBound...].range(of: end), "no \(end) after \(start)")
        return String(text[a.lowerBound..<b.lowerBound])
    }

    func testReadsAFewMillisecondsApartAreOne() {
        XCTAssertTrue(SettingsReads.due(last: nil, now: 10))
        XCTAssertFalse(SettingsReads.due(last: 10, now: 10 + SettingsReads.again - 0.01))
        XCTAssertTrue(SettingsReads.due(last: 10, now: 10 + SettingsReads.again))
    }

    func testOnlyTheAutomationPaneReadsEveryWindow() {
        XCTAssertTrue(SettingsReads.readsWindows(pane: "Automation"))
        for pane in ["General", "Keys", "Dock", "Appearance", "Launcher", "Permissions", "Updates", "Agents", "Silas", "Browser"] {
            XCTAssertFalse(SettingsReads.readsWindows(pane: pane), pane)
        }
    }

    func testASlowReadIsTraced() {
        XCTAssertNil(SettingsReads.slowLine(seconds: 0.049, pane: "General", windows: false))
        XCTAssertEqual(SettingsReads.slowLine(seconds: 0.12, pane: "General", windows: false), "slow settings read: 120 ms on main, General pane")
        XCTAssertEqual(SettingsReads.slowLine(seconds: 0.3, pane: "Automation", windows: true),
                       "slow settings read: 300 ms on main, Automation pane, every window read")
    }

    func testOpeningTheWindowReadsOnce() throws {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        let show = try body(setup, from: "    func show() {", to: "\n    }\n")
        XCTAssertTrue(show.contains("model.readShown(force: true)"))
        XCTAssertFalse(show.contains("model.reload()"), "show reads through readShown")
        XCTAssertFalse(show.contains("model.reloadParked()"), "show refreshed every window on any pane")
        let key = try body(setup, from: "NSWindow.didBecomeKeyNotification", to: "}))")
        XCTAssertTrue(key.contains("self?.model.readShown()"))
        XCTAssertFalse(key.contains("reload"), "the window taking the keyboard read everything again")
        let active = try body(setup, from: "NSApplication.didBecomeActiveNotification", to: "\n        }\n")
        XCTAssertTrue(active.contains("self?.model.readShown()"))
        XCTAssertFalse(active.contains("model.reload()"), "the app coming forward read everything again")
    }

    func testTheOpenWindowsReadsSetOnlyWhatChanged() throws {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        let reads = try body(setup, from: "func tick() {", to: "    func toggleParked(")
        let bare = try NSRegularExpression(pattern: #"(?m)^\s+(?:if [^{]*\{\s*)?(\w+) = (?!self\[)"#)
        let names = bare.matches(in: reads, range: NSRange(reads.startIndex..., in: reads)).compactMap {
            Range($0.range(at: 1), in: reads).map { String(reads[$0]) }
        }
        XCTAssertEqual(names, ["lastRead"], "a published value set without put(_:_:) redraws the pane even when it didn't change")
        XCTAssertTrue(reads.contains("if self[keyPath: key] != value { self[keyPath: key] = value }"))
    }

    func testTheLoginItemIsNeverReadOnTheMainThreadAfterTheFirst() throws {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        let code = setup.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        // The first model, `readLogin`, and `finish` (once, when setup ends).
        XCTAssertEqual(code.filter { $0.contains("SMAppService.mainApp.status") }.count, 3)
        XCTAssertTrue(setup.contains("private static let firstLoginStatus = SMAppService.mainApp.status"))
        let login = try body(setup, from: "    func readLogin() {", to: "\n    }\n")
        XCTAssertTrue(login.contains("DispatchQueue.global(qos: .userInitiated).async {\n            let status = SMAppService.mainApp.status"))
        let optional = try body(setup, from: "    private func reloadOptional() {", to: "\n    }\n")
        XCTAssertFalse(optional.contains("SMAppService"), "tick reads this once a second")
    }

    func testTheThemeShelfRedrawsOnlyWhenItsThemesChanged() throws {
        let model = try read("Sources/BaneySpaces/Appearance/ThemeEditorModel.swift")
        let reload = try body(model, from: "    func reload() {", to: "    /// Customize:")
        XCTAssertTrue(reload.contains("if let self, tiles != self.tiles { self.tiles = tiles }"))
    }
}
