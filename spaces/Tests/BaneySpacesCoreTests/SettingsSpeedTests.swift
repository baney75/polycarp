import Foundation
import XCTest

/// Gap X2 (issue #350): Settings panes open and switch in as little main-thread time as SwiftUI allows, with one 60 Hz
/// frame (16 ms) as the goal. Appearance and Silas built every group at once, Appearance a live preview of every theme
/// too, and a drop target above the pane read a preference from every row. `scripts/settings-speed.sh` times a release
/// build offscreen on efficiency cores and fails a pane more than 30% slower than recorded here; `--write` records new
/// times and keeps `before`, the times this work started from.
final class SettingsSpeedTests: XCTestCase {
    private struct Pane: Decodable { let cpuOpenMs: Double; let cpuSwitchMs: Double }
    private struct Built: Decodable { let cpuBuiltMs: Double; let cpuStepMs: Double }
    private struct Record: Decodable {
        struct Before: Decodable { let panes: [String: Pane] }
        let goalMs: Double
        let panes: [String: Pane]
        let before: Before
    }
    /// What the deck (`SettingsDeck`) adds to the record: a switch to a pane already built, each pane's hidden build,
    /// how much the app grew with every pane built, and how long the first click after opening can wait.
    private struct DeckRecord: Decodable {
        let panes: [String: Built]
        let memoryMB: Double
        let firstInputMs: Double
    }
    private func recordData() throws -> Data { try Data(contentsOf: Repo.root.appendingPathComponent("scripts/settings-speed.json")) }

    /// The panes `SettingsTab` lists, read from its declaration.
    private func panes() throws -> Set<String> {
        let source = try Repo.code("Sources/BaneySpaces/Setup.swift")
        let start = try XCTUnwrap(source.range(of: "enum SettingsTab"))
        let end = try XCTUnwrap(source.range(of: "var id: Self", range: start.upperBound..<source.endIndex))
        let text = String(source[start.upperBound..<end.lowerBound])
        let cases = try NSRegularExpression(pattern: #"= "(\w+)""#)
        return Set(cases.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } })
    }

    func testEveryPaneIsRecordedAndTheLongOnesGotFaster() throws {
        let record = try JSONDecoder().decode(Record.self, from: recordData())
        XCTAssertEqual(record.goalMs, 16, "one frame at 60 Hz")
        let names = try panes()
        XCTAssertEqual(names.count, 11, "SettingsTab read from Setup.swift")
        XCTAssertEqual(Set(record.panes.keys), names, "every pane is timed; run scripts/settings-speed.sh --write after adding one")
        XCTAssertEqual(Set(record.before.panes.keys), names, "every pane has the time it started from")
        for (name, p) in record.panes.sorted(by: { $0.key < $1.key }) {
            let was = try XCTUnwrap(record.before.panes[name])
            // No pane is recorded slower than it started, past noise between two runs.
            XCTAssertLessThanOrEqual(p.cpuOpenMs, was.cpuOpenMs * 1.15, "\(name) opens in \(p.cpuOpenMs) ms, was \(was.cpuOpenMs)")
            XCTAssertLessThanOrEqual(p.cpuSwitchMs, was.cpuSwitchMs * 1.15, "\(name) switches in \(p.cpuSwitchMs) ms, was \(was.cpuSwitchMs)")
        }
        // The two #350 named build only what is in view now: at least a fifth less time to open or switch to.
        for name in ["Appearance", "Silas"] {
            let p = try XCTUnwrap(record.panes[name]), was = try XCTUnwrap(record.before.panes[name])
            XCTAssertLessThanOrEqual(p.cpuOpenMs, was.cpuOpenMs * 0.8, "\(name) opens in \(p.cpuOpenMs) ms, was \(was.cpuOpenMs)")
            XCTAssertLessThanOrEqual(p.cpuSwitchMs, was.cpuSwitchMs * 0.8, "\(name) switches in \(p.cpuSwitchMs) ms, was \(was.cpuSwitchMs)")
        }
    }

    /// Settings keeps every pane built while open: a switch to one it holds fits in one frame, holding them all costs
    /// at most 30 MB, and the first click after opening waits no longer than the first-open budget.
    func testABuiltPaneSwitchesInOneFrame() throws {
        let goal = try JSONDecoder().decode(Record.self, from: recordData()).goalMs
        let deck = try JSONDecoder().decode(DeckRecord.self, from: recordData())
        XCTAssertEqual(Set(deck.panes.keys), try panes(), "every pane's switch to it built is timed")
        for (name, p) in deck.panes.sorted(by: { $0.key < $1.key }) {
            XCTAssertLessThanOrEqual(p.cpuBuiltMs, goal, "\(name): a switch to it built takes \(p.cpuBuiltMs) ms")
            XCTAssertGreaterThan(p.cpuStepMs, 0, "\(name) was built hidden")
        }
        XCTAssertGreaterThan(deck.memoryMB, 0, "measured")
        XCTAssertLessThanOrEqual(deck.memoryMB, 30, "every pane built grows the app \(deck.memoryMB) MB")
        XCTAssertLessThanOrEqual(deck.firstInputMs, 150, "the settings-first budget (spec/speed.json)")
    }

    /// The deck's rules: the window builds the pane in view; the rest are built one a turn, never while you type or click
    /// or while something tracks; closing lets go of all but the pane on screen.
    func testTheDeckBuildsOneAQuietTurnAndLetsGoOnClose() throws {
        let deck = try Repo.code("Sources/BaneySpaces/SettingsDeck.swift")
        XCTAssertTrue(deck.contains("RunLoop.main.add(t, forMode: .default)"), "no build while a menu, scroll or drag tracks")
        XCTAssertTrue(deck.contains("guard let self, Self.quiet() else { return }"), "no build within quietFor of an input")
        XCTAssertTrue(deck.contains("static let quietFor: TimeInterval = 0.2"))
        XCTAssertTrue(deck.contains("forName: NSWindow.willCloseNotification, object: window"), "closing lets go")
        XCTAssertTrue(deck.contains("for (t, v) in built where t != shown { v.removeFromSuperview(); built[t] = nil }"))
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("SettingsPanes(tab: model.tab)"), "the window holds its panes in the deck")
        XCTAssertFalse(setup.contains(".id(model.tab)"), "a switch never rebuilds the pane")
    }

    /// A pane builds only the groups in view: its groups are rows of a lazy stack, never children of an eager one or one
    /// wrapping view (which a lazy stack builds whole), and the theme shelf builds only the tiles in view.
    func testPanesBuildOnlyWhatIsInView() throws {
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("LazyVStack(alignment: .leading, spacing: 18)"), "the pane container is lazy")
        XCTAssertTrue(setup.contains("case .appearance: appearanceSections"), "Appearance's groups are the stack's rows")
        XCTAssertTrue(setup.contains(".themeDrop("), "the drop target is a modifier, not a view around the groups")
        let editor = try Repo.code("Sources/BaneySpaces/Appearance/ThemeEditorWindow.swift")
        XCTAssertTrue(editor.contains("LazyHStack(spacing: 8)"), "the shelf")
        // A drop target above the lazy stack reads a preference from every row it places: about a third of each pane's time.
        let drop = try XCTUnwrap(editor.range(of: "struct ThemeDropTarget")).lowerBound
        let body = String(editor[drop...].prefix(1400))
        XCTAssertTrue(body.contains("if on {"), "other panes get no drop target")
        XCTAssertTrue(body.contains(".background {\n                    Color.clear.contentShape(Rectangle())\n                        .onDrop("),
                      "the drop target is a clear view behind the pane, not a modifier above its rows")
        XCTAssertEqual(body.components(separatedBy: ".onDrop(").count, 2, "one drop target")
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Voice/VoiceSettingsView.swift").contains("LazyVStack(alignment: .leading, spacing: 18)"), "Silas")
    }
}
