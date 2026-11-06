import XCTest

/// The settings window is a sidebar of sections. The app target can't be imported here, so this reads the sources: every
/// `SettingsTab` case is in the sidebar exactly once, so a new section can't be forgotten, and the window stays one fixed size.
final class SettingsSidebarTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func read(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }

    private func captures(_ pattern: String, in text: String) -> [String] {
        let re = try! NSRegularExpression(pattern: pattern)
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
            Range(m.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    private func tabCases() throws -> [String] {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        let start = try XCTUnwrap(setup.range(of: "enum SettingsTab: String, CaseIterable, Identifiable {"))
        let rest = setup[start.upperBound...]
        let end = try XCTUnwrap(rest.range(of: "var id: Self"))
        let body = String(rest[..<end.lowerBound])
        let names = captures(#"(?:case|,)\s*(\w+)\s*=\s*""#, in: body)
        XCTAssertFalse(names.isEmpty)
        return names
    }

    private func sidebarTabs() throws -> [String] {
        let kit = try read("Sources/BaneySpaces/SettingsKit.swift")
        let start = try XCTUnwrap(kit.range(of: "static let groups: [Group] = ["))
        let end = try XCTUnwrap(kit[start.upperBound...].range(of: "static var order"))
        return captures(#"\.(\w+)(?=[,\]])"#, in: String(kit[start.upperBound..<end.lowerBound]))
    }

    func testEverySectionIsInTheSidebarOnce() throws {
        let cases = try tabCases()
        let listed = try sidebarTabs()
        XCTAssertEqual(Set(cases), Set(listed), "a SettingsTab is missing from SettingsSidebar.groups, or listed there without a case")
        XCTAssertEqual(listed.count, Set(listed).count, "a section is listed twice")
    }

    func testSectionsAreGroupedAsDesigned() throws {
        let kit = try read("Sources/BaneySpaces/SettingsKit.swift")
        XCTAssertTrue(kit.contains(#"tabs: [.general, .keys, .dock, .appearance, .launcher]"#))
        XCTAssertTrue(kit.contains(#"header: "Your tools", tabs: [.voice, .browser, .agents]"#))
        XCTAssertTrue(kit.contains(#"header: "System", tabs: [.automation, .updates]"#))
    }

    func testTheWindowIsOneFixedSizeAndHasNoDoneButtonOrRefit() throws {
        let kit = try read("Sources/BaneySpaces/SettingsKit.swift")
        XCTAssertTrue(kit.contains("CGSize(width: 760, height: 560)"))
        XCTAssertTrue(kit.contains("static let width: CGFloat = 190"))
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        XCTAssertFalse(setup.contains(#"Button("Done""#))
        XCTAssertFalse(setup.contains("sizingOptions"))
        XCTAssertFalse(setup.contains("fittingSize"))
        XCTAssertTrue(setup.contains(#"keyboardShortcut("w", modifiers: .command)"#))
        XCTAssertFalse(setup.contains("Picker(\"\", selection: $model.tab)"), "the segmented picker is gone")
    }

    func testStatusColorsComeFromTheTheme() throws {
        let setup = try read("Sources/BaneySpaces/Setup.swift")
        for literal in ["Color.green", ".foregroundStyle(.green)", "Color.orange", ".foregroundStyle(.orange)"] {
            XCTAssertFalse(setup.contains(literal), "Setup.swift still draws \(literal)")
        }
        let kit = try read("Sources/BaneySpaces/SettingsKit.swift")
        for role in ["done", "working", "urgent"] { XCTAssertTrue(kit.contains("role(\"\(role)\")")) }
    }
}
