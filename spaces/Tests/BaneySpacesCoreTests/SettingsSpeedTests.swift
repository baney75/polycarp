import Foundation
import XCTest

/// Gap X2 (issue #350): Settings panes open and switch in as little main-thread time as SwiftUI allows, with one 60 Hz
/// frame (16 ms) as the goal. Appearance and Silas built every group at once, Appearance a live preview of every theme
/// too, and a drop target above the pane read a preference from every row. `scripts/settings-speed.sh` times a release
/// build offscreen on efficiency cores and fails a pane more than 30% slower than recorded here; `--write` records new
/// times and keeps `before`, the times this work started from.
final class SettingsSpeedTests: XCTestCase {
    private struct Pane: Decodable { let cpuOpenMs: Double; let cpuSwitchMs: Double }
    private struct Record: Decodable {
        struct Before: Decodable { let panes: [String: Pane] }
        let goalMs: Double
        let panes: [String: Pane]
        let before: Before
    }

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
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("scripts/settings-speed.json"))
        let record = try JSONDecoder().decode(Record.self, from: data)
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
