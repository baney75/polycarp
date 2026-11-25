import Foundation
import XCTest
@testable import BaneySpacesCore

/// The theme in the new tab host's `page` and `theme` replies (docs/newtab.md): a real theme file, as values the extension
/// knows, and nothing at all from any other file.
final class NewTabThemeTests: XCTestCase {
    private var folder: URL!
    private var file: String { folder.appendingPathComponent("current/theme.json").path }

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("newtab-theme-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("current"), withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: folder) }

    /// A theme.json whose browser surface is Still Water's, after `change`, and whose Spaces surface is left as it was.
    private func theme(_ change: (inout [String: Any]) -> Void = { _ in }, root edit: (inout [String: Any]) -> Void = { _ in }) throws -> Data {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(PolycarpFixtures.still_water.utf8)) as? [String: Any])
        var surfaces = try XCTUnwrap(root["surfaces"] as? [String: Any])
        var browser = try XCTUnwrap(surfaces["spaces"] as? [String: Any])
        change(&browser)
        surfaces["browser"] = browser
        root["surfaces"] = surfaces
        edit(&root)
        return try JSONSerialization.data(withJSONObject: root)
    }

    private func set(_ section: String, _ key: String, _ value: Any) -> (inout [String: Any]) -> Void {
        { browser in
            var s = browser[section] as? [String: Any] ?? [:]
            s[key] = value
            browser[section] = s
        }
    }

    private func source() -> NewTabHost.Source {
        NewTabHost.Source(surfaces: { .defaults }, theme: { [file] in NewTabTheme.load(path: file) })
    }

    private func ask(_ op: String) throws -> [String: Any] {
        let reply = NewTabHost.answer(Data("{\"op\":\"\(op)\"}".utf8), source: source())
        return try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any])
    }

    func testTheThemeAndThePageReplyCarryTheBrowserSurface() throws {
        try theme({ browser in
            self.set("light", "background", "#FAF0E6")(&browser)
            self.set("shape", "shadow", 0.25)(&browser)
            self.set("type", "line_height", 1)(&browser)
            self.set("motion", "fast", 0)(&browser)
        }).write(to: URL(fileURLWithPath: file))
        for op in ["theme", "page"] {
            let r = try ask(op)
            XCTAssertEqual(r["ok"] as? Bool, true, op)
            let t = try XCTUnwrap(r["theme"] as? [String: Any], op)
            XCTAssertEqual(Set(t.keys), ["shared", "light", "dark", "mode"])
            XCTAssertEqual(t["mode"] as? String, "auto")
            let shared = try XCTUnwrap(t["shared"] as? [String: String])
            let light = try XCTUnwrap(t["light"] as? [String: String]), dark = try XCTUnwrap(t["dark"] as? [String: String])
            XCTAssertEqual(light["--pc-background"], "#faf0e6", "the browser surface, not Spaces' own")
            XCTAssertEqual(light["--pc-on-accent"], "#f1f5f5")
            XCTAssertEqual(dark["--pc-accent"], "#a5cfcb")
            XCTAssertEqual(shared["--pc-radius"], "10px")
            XCTAssertEqual(shared["--pc-shadow"], "0.25")
            XCTAssertEqual(shared["--pc-line-height"], "1", "no .0")
            XCTAssertEqual(shared["--pc-motion-fast"], "0ms")
            XCTAssertEqual(shared["--pc-font-display"], #"Newsreader, "Iowan Old Style", Georgia, serif"#)
            XCTAssertEqual(shared["--pc-motion-easing"], "cubic-bezier(0.2, 0, 0, 1)")
        }
        XCTAssertEqual(try ask("theme")["stamp"] as? String, try ask("page")["stamp"] as? String)
        XCTAssertNil(try ask("theme")["bangs"], "theme is only the theme")
    }

    func testReducedMotionIsEveryDurationZero() throws {
        let t = try XCTUnwrap(NewTabTheme.parse(theme(set("motion", "reduced", true))))
        XCTAssertEqual(["fast", "normal", "slow"].map { t.shared["--pc-motion-" + $0] }, ["0ms", "0ms", "0ms"])
        XCTAssertNotEqual(try XCTUnwrap(NewTabTheme.parse(theme())).shared["--pc-motion-slow"], "0ms")
    }

    /// The extension's shipped `theme.css` and the reply name the same things, so neither can gain a name alone.
    func testTheNamesAreExactlyThoseOfTheExtensionsThemeFile() throws {
        try theme().write(to: URL(fileURLWithPath: file))
        let t = try XCTUnwrap(NewTabTheme.load(path: file))
        let css = try Repo.text("extension/src/shared/theme.css")
        let blocks = css.components(separatedBy: "{").map { block in
            Set(block.components(separatedBy: "}")[0].split(separator: "\n").compactMap { line -> String? in
                let name = line.split(separator: ":")[0].trimmingCharacters(in: .whitespaces)
                return name.hasPrefix("--pc-") ? name : nil
            })
        }
        let root = blocks[1], dark = blocks[3]
        XCTAssertGreaterThan(root.count, 30)
        XCTAssertEqual(Set(t.dark.keys), dark)
        XCTAssertEqual(Set(t.light.keys), dark)
        XCTAssertEqual(Set(t.shared.keys).union(t.light.keys), root)
    }

    func testTheStampChangesWithAnyValueAndOnlyThen() throws {
        try theme().write(to: URL(fileURLWithPath: file))
        let first = try XCTUnwrap(ask("theme")["stamp"] as? String)
        XCTAssertEqual(try ask("theme")["stamp"] as? String, first)
        try theme(root: { $0["title"] = "Renamed" }).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(try ask("theme")["stamp"] as? String, first, "the name isn't drawn")
        try theme(root: { $0["mode"] = "dark" }).write(to: URL(fileURLWithPath: file))
        let pinned = try XCTUnwrap(ask("theme")["stamp"] as? String)
        XCTAssertNotEqual(pinned, first)
        try theme(set("dark", "border", "#3a4d53"), root: { $0["mode"] = "dark" }).write(to: URL(fileURLWithPath: file))
        XCTAssertNotEqual(try ask("theme")["stamp"] as? String, pinned)
    }

    private func assertNoTheme(_ why: String, line: UInt = #line) throws {
        XCTAssertNil(NewTabTheme.load(path: file), why, line: line)
        for op in ["theme", "page"] {
            let r = try ask(op)
            XCTAssertEqual(r["ok"] as? Bool, true, why, line: line)
            XCTAssertNil(r["theme"], why, line: line)
            XCTAssertNil(r["stamp"], why, line: line)
        }
    }

    func testNoFileALinkAFolderOrABigFileIsNoTheme() throws {
        try assertNoTheme("no file: the theme is off")
        XCTAssertNil(NewTabTheme.load(path: nil))

        let real = folder.appendingPathComponent("real.json")
        try theme().write(to: real)
        XCTAssertNotNil(NewTabTheme.load(path: real.path), "the same file, not through a link")
        try FileManager.default.createSymbolicLink(atPath: file, withDestinationPath: real.path)
        try assertNoTheme("a symbolic link")
        try FileManager.default.removeItem(atPath: file)

        try FileManager.default.createDirectory(atPath: file, withIntermediateDirectories: false)
        try assertNoTheme("a folder")
        try FileManager.default.removeItem(atPath: file)

        let padded = try theme(root: { $0["description"] = String(repeating: "x", count: PolycarpTheme.maxBytes) })
        try padded.write(to: URL(fileURLWithPath: file))
        try assertNoTheme("over the size limit")
    }

    func testAMalformedFileIsNoTheme() throws {
        let bad: [(String, Data)] = [
            ("not JSON", Data("{".utf8)), ("a list", Data("[]".utf8)), ("empty", Data()),
            ("no browser surface", try theme(root: { var s = $0["surfaces"] as! [String: Any]; s["browser"] = nil; $0["surfaces"] = s })),
            ("a newer schema", try theme(root: { $0["schema"] = 99 })),
            ("an unknown mode", try theme(root: { $0["mode"] = "sepia" })),
            ("no mode", try theme(root: { $0["mode"] = nil })),
            ("a color with CSS in it", try theme(set("light", "accent", "red;}body{display:none"))),
            ("a short color", try theme(set("dark", "accent", "#abc"))),
            ("text too faint to read", try theme(set("dark", "foreground", "#283639"))),
            ("a font with CSS in it", try theme(set("type", "ui", "a;}body{background:url(https://example.com)"))),
            ("an easing with CSS in it", try theme(set("motion", "easing", "ease;}"))),
            ("a radius out of range", try theme(set("shape", "radius", 900))),
            ("a radius that is a word", try theme(set("shape", "radius", "10px"))),
            ("a line height out of range", try theme(set("type", "line_height", 40))),
            ("a line height that is a word", try theme(set("type", "line_height", "1;}"))),
            ("no line height", try theme({ var t = $0["type"] as! [String: Any]; t["line_height"] = nil; $0["type"] = t })),
        ]
        for (why, data) in bad {
            try data.write(to: URL(fileURLWithPath: file))
            try assertNoTheme(why)
        }
    }

    /// The Mac app's own file is found by one rule, whoever asks.
    func testTheHostReadsTheFileTheAppReads() throws {
        let host = try SourceText.code("Sources/BaneySpacesCore/NewTabHost.swift")
        XCTAssertTrue(host.contains("NewTabTheme.load(path: PolycarpThemeFile.path())"))
        XCTAssertEqual(PolycarpThemeFile.path(env: ["POLYCARP_CONFIG_DIR": folder.path], home: nil), file)
    }
}
