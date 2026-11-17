import Foundation
import XCTest

/// The product is Polycarp. The old name, BaneySpaces, stays only where existing installs or the build depend on it, never
/// in what a person reads: the docs, the skill agents load, and the strings the app and its command show (gap X3).
///
/// What keeps the old name, and why (none of it is shown as the product's name):
/// - The Swift modules and targets (`BaneySpaces`, `BaneySpacesCore`, `BaneySpacesCursor`, `baneyspaces-cli`): the build
///   graph and every test import them.
/// - `BANEYSPACES_*` environment variables: scripts, CI and agents set them.
/// - The `baneyspaces` command alias and the `baneyspaces://` URL scheme: agents and hooks on other machines call them.
/// - `com.baney.baneyspaces` and `~/Library/Application Support/BaneySpaces`: the import from the old app reads them.
/// - The theme id `baneyspaces`: saved settings and theme files name it (its label is "Polycarp").
/// - Installed file names (`~/.claude/skills/baneyspaces`, `~/.grok/hooks/baneyspaces.json`,
///   `settings.json.baneyspaces-backup`, `~/.config/baneyspaces`, the Linux binary): existing setups have them.
final class OldNameTests: XCTestCase {
    /// The repository's top folder (`Repo.root` is `spaces/`).
    private var top: URL { Repo.root.deletingLastPathComponent() }

    /// The old name as a product name: not a module (`BaneySpacesCore`), not a source path (`Sources/BaneySpaces/`).
    private let oldName = try! NSRegularExpression(pattern: #"(?<![\w/])BaneySpaces(?![\w/])|baney75/baneyspaces"#)

    /// Docs that are not for the people who use Polycarp, or not this part's to change.
    private func skipped(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        if ["AGENTS.md", "CLAUDE.md", "CHANGELOG.md"].contains(name) { return true }   // agent rules and history
        if path == "PLAN.md" { return true }                                               // the merge plan names the old apps
        for dir in ["browser/", "voice/", "core/", "cli/",                               // other parts, their own docs
                    "spaces/platforms/",                                                   // Linux and Windows, where the binary is still `baneyspaces`
                    "spaces/bench/results/"] where path.hasPrefix(dir) { return true }     // dated records of past runs
        return false
    }

    /// Lines that talk about the old app itself, or record what someone said on a date. Each names its file and a phrase.
    private let allowed: [(file: String, phrase: String)] = [
        ("README.md", "It grew from three apps"),
        ("README.md", "If you have BaneySpaces"),
        ("README.md", "If you used BaneySpaces"),
        ("docs/guide.md", "If you have BaneySpaces"),
        ("spaces/spec/config.md", "Donovan, 2026-11-01"),
        ("spaces/spec/config.md", #"%APPDATA%\BaneySpaces"#),   // the Windows config folder, decided with the Windows work
    ]

    private func markdownFiles() throws -> [String] {
        let git = Process()
        git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        git.arguments = ["-C", top.path, "ls-files", "*.md"]
        let out = Pipe()
        git.standardOutput = out
        try git.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        git.waitUntilExit()
        return String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
    }

    private func hits(in text: String, file: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).enumerated().compactMap { i, line in
            let s = String(line)
            guard oldName.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil else { return nil }
            if allowed.contains(where: { $0.file == file && s.contains($0.phrase) }) { return nil }
            return "\(file):\(i + 1): \(s.prefix(160))"
        }
    }

    func testNoDocForPeopleUsesTheOldName() throws {
        let files = try markdownFiles().filter { !skipped($0) }
        XCTAssertTrue(files.contains("spaces/README.md") && files.contains("README.md"), "git ls-files found the docs")
        let found = try files.flatMap { try hits(in: String(contentsOf: top.appendingPathComponent($0), encoding: .utf8), file: $0) }
        XCTAssertEqual(found, [], "Say Polycarp, or add the line to `allowed` with why:\n" + found.joined(separator: "\n"))
    }

    /// Every string literal in the app and its command, comments left out. `Product.Legacy` lives in Core, not here.
    func testNoStringTheAppShowsUsesTheOldName() throws {
        var found: [String] = []
        for dir in ["Sources/BaneySpaces", "Sources/baneyspaces-cli"] {
            let base = Repo.root.appendingPathComponent(dir)
            let files = FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
            XCTAssertFalse(files.isEmpty, dir)
            for url in files {
                let rel = dir + url.path.dropFirst(base.path.count)
                for (i, line) in try String(contentsOf: url, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                    let code = line.components(separatedBy: "//")[0]
                    for literal in code.split(separator: "\"", omittingEmptySubsequences: false).enumerated().filter({ $0.offset % 2 == 1 }) {
                        let s = String(literal.element)
                        if oldName.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil { found.append("\(rel):\(i + 1): \"\(s)\"") }
                    }
                }
            }
        }
        XCTAssertEqual(found, [], found.joined(separator: "\n"))
    }

    /// The images the READMEs show carry the name too; they are drawn from the app (`--render`) and `make-brand.swift`.
    func testTheBrandScriptDrawsTheNewName() throws {
        let script = try Repo.text("scripts/make-brand.swift")
        XCTAssertTrue(script.contains(#"text("Polycarp""#))
        XCTAssertFalse(script.contains(#"text("BaneySpaces""#))
    }
}
