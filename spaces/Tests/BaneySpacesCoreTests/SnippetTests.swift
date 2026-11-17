import XCTest
@testable import BaneySpacesCore

final class LauncherTOMLTests: XCTestCase {
    func testTheShapesTheLauncherFilesUse() throws {
        let doc = try LauncherTOML.parse(#"""
        # a comment
        title = "Word Count"   # trailing comment
        timeout = 2.5
        tries = 3
        on = true
        command = ["./run.sh", '--raw\n',
                   "two", ]

        [[snippet]]
        keyword = ";sig"
        text = """
        Thanks,
        D \"B\" \u00e9"""

        [[snippet]]
        keyword = 'lit'
        text = '''C:\path "as is"'''
        """#)
        XCTAssertEqual(doc["title"], .string("Word Count"))
        XCTAssertEqual(doc["timeout"]?.double, 2.5)
        XCTAssertEqual(doc["tries"], .int(3))
        XCTAssertEqual(doc["on"], .bool(true))
        XCTAssertEqual(doc["command"], .array([.string("./run.sh"), .string("--raw\\n"), .string("two")]))
        let snippets = try XCTUnwrap(doc["snippet"]?.array)
        XCTAssertEqual(snippets.count, 2)
        XCTAssertEqual(snippets[0].table?["text"], .string("Thanks,\nD \"B\" é"))
        XCTAssertEqual(snippets[1].table?["text"], .string(#"C:\path "as is""#))
    }

    func testMistakesNameTheirLine() {
        func line(_ s: String) -> Int? {
            do { _ = try LauncherTOML.parse(s); return nil } catch let e as LauncherTOML.ParseError { return e.line } catch { return nil }
        }
        XCTAssertEqual(line("a = 1\nb = \"open"), 2)
        XCTAssertEqual(line("a = 1\na = 2"), 2)
        XCTAssertEqual(line("x.y = 1"), 1)
        XCTAssertEqual(line("t = {a = 1}"), 1)
        XCTAssertEqual(line("d = 2026-11-17"), 1)
        XCTAssertEqual(line("a = 1 b = 2"), 1)
        XCTAssertEqual(line("ok = 1\n\n[[s]]\nk = \"\"\"never closed"), 4)
    }
}

final class SnippetTests: XCTestCase {
    private var dir: URL!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-snip-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func testParsesAndSkipsBadEntriesWithAReason() {
        let (s, problems) = SnippetFile.parse("""
        [[snippet]]
        keyword = ";addr"
        name = "Home address"
        text = "1 Main St"

        [[snippet]]
        keyword = "no text"

        [[snippet]]
        keyword = ";ADDR"
        text = "dup"

        [[snippet]]
        keyword = "two words"
        text = "x"
        """)
        XCTAssertEqual(s, [Snippet(keyword: ";addr", name: "Home address", text: "1 Main St")])
        XCTAssertEqual(problems.count, 3)
        XCTAssertEqual(SnippetFile.parse("[[snippet]\n").snippets, [])
        XCTAssertTrue(SnippetFile.parse("[[snippet]\n").problems[0].contains("line 1"))
    }

    func testTheStarterFileIsValid() {
        let (s, problems) = SnippetFile.parse(SnippetFile.starter)
        XCTAssertEqual(problems, [])
        XCTAssertEqual(s.map(\.keyword), [";date", ";shrug"])
        XCTAssertEqual(s[1].text, #"¯\_(ツ)_/¯"#)
    }

    func testPlaceholdersFillFromTheClock() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        let now = Date(timeIntervalSince1970: 1_794_945_600) // 2026-11-17 15:00 in New York
        let s = Snippet(keyword: "k", name: "n", text: "{date} {time} {weekday} {year} {datetime} {other}")
        XCTAssertEqual(s.expanded(now: now, calendar: cal), "2026-11-17 15:00 Tuesday 2026 2026-11-17 15:00 {other}")
    }

    func testAKeywordIsTheTopRowAndPastesTheExpandedText() throws {
        let file = dir.appendingPathComponent("snippets.toml")
        try "[[snippet]]\nkeyword = \";sig\"\nname = \"Signature\"\ntext = \"\"\"\nThanks,\nD\"\"\"\n"
            .write(to: file, atomically: true, encoding: .utf8)
        let p = SnippetProvider(store: SnippetStore(file: file))
        let rows = p.results(for: ";sig")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].placement, .top)
        XCTAssertEqual(rows[0].action, .paste("Thanks,\nD"))
        // By name, lower down; a single letter never matches.
        XCTAssertEqual(p.results(for: "signa").first?.placement, .normal)
        XCTAssertEqual(p.results(for: "s"), [])
        XCTAssertEqual(p.results(for: "safari"), [])
        // An edit on disk shows on the next keystroke.
        try "[[snippet]]\nkeyword = \";sig\"\ntext = \"Cheers, and a longer one\"\n".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(p.results(for: ";sig").first?.action, .paste("Cheers, and a longer one"))
    }

    func testTheMenuOffersToMakeAndEditTheFile() {
        let file = dir.appendingPathComponent("sub/snippets.toml")
        let p = SnippetProvider(store: SnippetStore(file: file))
        let rows = p.listing("")
        XCTAssertEqual(rows.last?.action, .command(provider: "snippets", id: "edit"))
        XCTAssertEqual(p.perform("edit"), .open(file))
        XCTAssertEqual(SnippetFile.parse(try String(contentsOf: file, encoding: .utf8)).snippets.count, 2)
        XCTAssertEqual(p.listing("").count, 3)
    }

    /// The launcher has them, and pastes a snippet marked transient so clipboard history never keeps it.
    func testTheLauncherPastesThemAsTransient() throws {
        XCTAssertTrue(LauncherProviders.standard(env: ["POLYCARP_CONFIG_DIR": dir.path]).contains { $0.name == "snippets" })
        let src = try String(contentsOfFile: LauncherProviderSeamTests.source("Sources/BaneySpaces/Launcher.swift"), encoding: .utf8)
        for needle in ["case .paste(let text)", "LauncherPasteboard.copy(text, transient: true)", "case .clipboard, .snippets"] {
            XCTAssertTrue(src.contains(needle), needle)
        }
    }

    func testTheDefaultFileIsInTheConfigFolder() {
        XCTAssertEqual(SnippetStore.defaultFile(env: ["POLYCARP_CONFIG_DIR": "/tmp/pc", "HOME": "/Users/x"])?.path, "/tmp/pc/snippets.toml")
        XCTAssertEqual(SnippetStore.defaultFile(env: ["HOME": "/Users/nobody-here"])?.path, "/Users/nobody-here/.config/polycarp/snippets.toml")
    }
}
