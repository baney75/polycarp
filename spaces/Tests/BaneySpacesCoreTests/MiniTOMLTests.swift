@testable import BaneySpacesCore
import XCTest

/// The TOML `spaces.toml` is written in (`spec/config.md`): what the spec shows reads back, and a mistake names its line.
final class MiniTOMLTests: XCTestCase {
    func testMiniTOMLReadsWhatTheSpecShows() throws {
        let t = try MiniTOML.parse("""
        a = 1 # one
        [behavior]
        workspace_names = { 1 = "Main", 2 = "School" }
        speed = 1.5
        on = true
        list = ["x", 'y']
        [[rules]]
        app = "Mail"
        [[rules]]
        app = "Ghostty\\u0021"
        """)
        XCTAssertEqual(t["a"], .integer(1))
        XCTAssertEqual(t["behavior"]?.table?["workspace_names"]?.table?["2"], .string("School"))
        XCTAssertEqual(t["behavior"]?.table?["speed"], .float(1.5))
        XCTAssertEqual(t["behavior"]?.table?["list"], .array([.string("x"), .string("y")]))
        XCTAssertEqual(t["rules"]?.array?.compactMap { $0.table?["app"]?.string }, ["Mail", "Ghostty!"])
        XCTAssertEqual(t["behavior"]?.table?.line(of: "speed"), 4)
    }

    func testAMistakeNamesItsLine() {
        let cases: [(String, Int, String)] = [
            ("a = 1\na = 2\n", 2, "a is already set on line 1"),
            ("a = \"open\n", 1, "not closed"),
            ("a = '''x'''\n", 1, "multi-line"),
            ("[a]\nb = 1\n[a]\n", 3, "appears twice"),
            ("x = yes\n", 1, "yes is not a value (strings need quotes)"),
            ("x = 1 2\n", 1, "unexpected text"),
            ("a = 1\r\nb = \"\\q\"\r\n", 2, "unknown escape"),
        ]
        for (text, line, want) in cases {
            XCTAssertThrowsError(try MiniTOML.parse(text), text) { e in
                let e = e as? TOMLError
                XCTAssertEqual(e?.line, line, text)
                XCTAssertTrue(e?.reason.contains(want) ?? false, "\(text): \(String(describing: e))")
            }
        }
    }
}
