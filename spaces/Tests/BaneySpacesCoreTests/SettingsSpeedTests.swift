import Foundation
import XCTest

/// Gap X2 (issue #350): every Settings pane opens and switches inside one 60 Hz frame of main-thread time. Appearance took
/// 76 ms and Silas 73 ms, because each pane built every group at once, Appearance a live preview of every theme too.
/// `scripts/settings-speed.sh --write` times a release build offscreen and records the medians here.
final class SettingsSpeedTests: XCTestCase {
    private struct Record: Decodable {
        struct Pane: Decodable { let cpuOpenMs: Double; let cpuSwitchMs: Double }
        let budgetMs: Double
        let panes: [String: Pane]
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

    func testEveryPaneOpensAndSwitchesInOneFrame() throws {
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("scripts/settings-speed.json"))
        let record = try JSONDecoder().decode(Record.self, from: data)
        XCTAssertEqual(record.budgetMs, 16, "one frame at 60 Hz")
        let names = try panes()
        XCTAssertEqual(names.count, 11, "SettingsTab read from Setup.swift")
        XCTAssertEqual(Set(record.panes.keys), names, "every pane is timed; run scripts/settings-speed.sh --write after adding one")
        for (name, p) in record.panes.sorted(by: { $0.key < $1.key }) {
            XCTAssertLessThanOrEqual(p.cpuOpenMs, record.budgetMs, "\(name) opens in \(p.cpuOpenMs) ms")
            XCTAssertLessThanOrEqual(p.cpuSwitchMs, record.budgetMs, "\(name) switches in \(p.cpuSwitchMs) ms")
        }
    }

    /// A pane builds only the groups in view: its groups are rows of a lazy stack, never children of an eager one or one
    /// wrapping view (which a lazy stack builds whole), and the theme shelf builds only the tiles in view.
    func testPanesBuildOnlyWhatIsInView() throws {
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("LazyVStack(alignment: .leading, spacing: 18)"), "the pane container is lazy")
        XCTAssertTrue(setup.contains("case .appearance: appearanceSections"), "Appearance's groups are the stack's rows")
        XCTAssertTrue(setup.contains(".themeDrop("), "the drop target is a modifier, not a view around the groups")
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Appearance/ThemeEditorWindow.swift").contains("LazyHStack(spacing: 8)"), "the shelf")
        XCTAssertTrue(try Repo.code("Sources/BaneySpaces/Voice/VoiceSettingsView.swift").contains("LazyVStack(alignment: .leading, spacing: 18)"), "Silas")
    }
}
