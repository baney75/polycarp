import XCTest

/// T6: every color and every animation duration in `Sources` comes from the theme (spec/themes.md, "Every surface uses
/// the theme"). This fails on a hard-coded color (`Color(red:…)`, `NSColor(white:…)`, `CGColor(srgbRed:…)`, `RGB(r: 0.2…)`,
/// a `"#rrggbb"` string, a named color such as `Color.red` or `NSColor.systemBlue`) or a hard-coded animation duration
/// (`.duration = 0.2`, `.easeOut(duration: 0.2)`, `.spring(response: 0.25…)`) in any file outside the theme module.
/// Genuine exceptions are in `spec/theme-literals-allow.txt`, one per line with the reason. A line there that matches
/// nothing fails too, so the list only shrinks.
final class ThemeLiteralLintTests: XCTestCase {
    /// Where colors and durations are defined, read from themes, or edited: the theme module. Path prefixes.
    static let themeModule = [
        "Sources/BaneySpacesCore/Theme",            // Theme, ThemeData, ThemeSurface, ThemeChoice, ThemeEditor*
        "Sources/BaneySpacesCore/PolycarpTheme.swift",
        "Sources/BaneySpacesCore/Appearance.swift",
        "Sources/BaneySpaces/Theming.swift",         // Chrome
        "Sources/BaneySpaces/Appearance.swift",
        "Sources/BaneySpaces/Appearance/",           // the theme editor
    ]

    static let patterns: [(String, String)] = [
        ("color", #"\b(NS|CG|UI)?Color\((red|white|srgbRed|calibratedRed|calibratedWhite|deviceRed|deviceWhite|genericRed|genericGrayGamma2_2Gray|hue|displayP3Red|gray)\s*:\s*[0-9.]"#),
        ("color", #"\bRGB\(r:\s*[0-9.]"#),
        ("color", ##""#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?""##),
        ("color", #"#colorLiteral"#),
        // A selected row filled with a wash of the accent instead of `Chrome.lit`, the theme's `selection`.
        ("color", #"\b(selected|on)\s*\?\s*Chrome\.accent\.opacity"#),
        ("color", #"\b(NSColor|Color|CGColor)\.(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|cyan|brown|mint|teal|indigo|magenta|darkGray|lightGray|system(Red|Green|Blue|Yellow|Orange|Purple|Pink|Gray|Teal|Indigo|Brown|Mint|Cyan))\b"#),
        ("duration", #"\.duration\s*=\s*[0-9]"#),
        ("duration", #"\.(easeIn|easeOut|easeInOut|linear|smooth|snappy|bouncy)\(duration:\s*[0-9]"#),
        ("duration", #"\.(spring|interactiveSpring)\((response|duration):\s*[0-9]"#),
        ("duration", #"animationDuration\s*=\s*[0-9]"#),
    ]

    struct Hit: Equatable { let file: String; let line: Int; let kind: String; let text: String }
    struct Allow { let file: String; let fragment: String; let why: String }

    static func allowList() throws -> [Allow] {
        try Repo.text("spec/theme-literals-allow.txt").split(separator: "\n").compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { return nil }
            let parts = line.components(separatedBy: " | ")
            guard parts.count == 3, !parts[2].trimmingCharacters(in: .whitespaces).isEmpty else {
                XCTFail("allow list line is not `file | code | why`: \(line)"); return nil
            }
            return Allow(file: parts[0], fragment: parts[1], why: parts[2])
        }
    }

    static func exempt(_ rel: String) -> Bool { themeModule.contains { rel.hasPrefix($0) } }

    /// Every hit in `Sources`, line comments dropped, the theme module skipped.
    static func hits() throws -> [Hit] {
        let root = Repo.root
        guard let walk = FileManager.default.enumerator(at: root.appendingPathComponent("Sources"), includingPropertiesForKeys: nil) else { return [] }
        let regexes = try patterns.map { ($0.0, try NSRegularExpression(pattern: $0.1)) }
        var out: [Hit] = []
        for case let url as URL in walk where url.pathExtension == "swift" {
            let rel = String(url.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))
            if exempt(rel) { continue }
            for (i, line) in try Repo.code(rel).split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let s = String(line)
                let range = NSRange(s.startIndex..., in: s)
                if let (kind, _) = regexes.first(where: { $0.1.firstMatch(in: s, range: range) != nil }) {
                    out.append(Hit(file: rel, line: i + 1, kind: kind, text: s.trimmingCharacters(in: .whitespaces)))
                }
            }
        }
        return out.sorted { ($0.file, $0.line) < ($1.file, $1.line) }
    }

    func testNoHardCodedColorOrDurationOutsideTheThemeModule() throws {
        let allow = try Self.allowList()
        let found = try Self.hits()
        XCTAssertFalse(found.isEmpty, "the walk reached the sources (the allowed literals are hits too)")
        let loose = found.filter { h in !allow.contains { $0.file == h.file && h.text.contains($0.fragment) } }
        XCTAssertTrue(loose.isEmpty, "take these from the theme (Chrome, the look's roles, Chrome.seconds or Chrome.duration) or add "
                      + "a reason to spec/theme-literals-allow.txt:\n" + loose.map { "\($0.file):\($0.line) [\($0.kind)] \($0.text)" }.joined(separator: "\n"))
        let stale = allow.filter { a in !found.contains { $0.file == a.file && $0.text.contains(a.fragment) } }
        XCTAssertTrue(stale.isEmpty, "these allow lines match nothing any more; remove them:\n"
                      + stale.map { "\($0.file) | \($0.fragment)" }.joined(separator: "\n"))
    }

    /// The lint itself: each pattern catches what it is for and leaves theme-driven code alone.
    func testThePatternsCatchLiteralsAndPassThemeReads() throws {
        let caught = ["Color(red: 0.2, green: 0.3, blue: 0.4)", "NSColor(white: 0, alpha: 0.5)", "CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)",
                      "let hex = \"#ff8800\"", "NSColor.systemBlue", ".foregroundStyle(Color.red)", "a.duration = 0.2",
                      "NSAnimationContext.runAnimationGroup({ $0.duration = 0.25 })", "withAnimation(.easeOut(duration: 0.2))",
                      ".spring(response: 0.25, dampingFraction: 0.7)", "window.animationDuration = 0.3", "RGB(r: 0.1, g: 0.2, b: 0.3)",
                      ".fill(selected ? Chrome.accent.opacity(0.22) : .clear)", ".fill(on ? Chrome.accent.opacity(0.2) : Color.clear)"]
        let passed = ["Chrome.accent", "Appearance.color(look.color(\"accent\"))", "a.duration = Chrome.duration(0.25, .panelOut)",
                      ".easeOut(duration: Chrome.seconds(0.2, .row))", ".spring(response: Chrome.seconds(0.25, .row), dampingFraction: 0.72)",
                      "Color.clear", "NSColor.clear", "Color(nsColor: .windowBackgroundColor)",
                      ".fill(selected ? Chrome.lit(Chrome.accent, 0.22) : .clear)",
                      "NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1)", "RGB(r: x, g: y, b: z)"]
        let regexes = try Self.patterns.map { try NSRegularExpression(pattern: $0.1) }
        func hit(_ s: String) -> Bool { regexes.contains { $0.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil } }
        for s in caught { XCTAssertTrue(hit(s), "should be caught: \(s)") }
        for s in passed { XCTAssertFalse(hit(s), "should pass: \(s)") }
        XCTAssertTrue(Self.exempt("Sources/BaneySpacesCore/ThemeEditorPalette.swift"))
        XCTAssertFalse(Self.exempt("Sources/BaneySpaces/Launcher.swift"))
    }
}
