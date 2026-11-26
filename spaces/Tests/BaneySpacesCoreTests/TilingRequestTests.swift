import XCTest
@testable import BaneySpacesCore

final class TilingRequestTests: XCTestCase {
    func testWordsReadAsTheRequestTheyAre() {
        func r(_ s: String) -> TilingRequest? { TilingRequest(words: s.split(separator: " ").map(String.init)) }
        XCTAssertEqual(r("status"), .status)
        XCTAssertEqual(r("on"), .turn(on: true, workspace: nil))
        XCTAssertEqual(r("off 3"), .turn(on: false, workspace: 3))
        XCTAssertEqual(r("focus left"), .run(.focus(.left)))
        XCTAssertEqual(r("focus-left"), .run(.focus(.left)), "a key's name works too")
        XCTAssertEqual(r("style columns"), .run(.style(.columns)))
        XCTAssertEqual(r("next display"), .run(.nextDisplay))
        for bad in ["", "on 0", "on 10", "on three", "on 3 4", "status now", "focus", "focus sideways", "toggle 3", "style spiral"] {
            XCTAssertNil(r(bad), bad)
        }
        // Every form the usage shows is one it takes.
        for f in TilingRequest.forms { XCTAssertNotNil(r(f.form.replacingOccurrences(of: " [1-9]", with: "")), f.form) }
        XCTAssertEqual(TilingRequest.forms.count, TilingCommand.named.count + 3)
    }

    func testTheStatusSurvivesTheSocketAndReadsInBothForms() {
        var s = TilingStatus(workspace: 2, tiles: true, style: "dwindle", full: false, windows: [7, 9], focused: 9, tiling: [2, 5])
        XCTAssertEqual(TilingStatus(s.reply), s)
        XCTAssertEqual(s.text, "workspace 2 tiles 2 windows, dwindle; tiling is on for 2, 5")
        XCTAssertEqual(s.value.object?["windows"], .array([.number(7), .number(9)]))
        XCTAssertEqual(s.value.object?["focused"], .number(9))
        s = TilingStatus(workspace: 3, tiles: true, style: "main", full: true, windows: [7], focused: nil, tiling: [3])
        XCTAssertEqual(s.text, "workspace 3 tiles 1 window, main, one at full size; tiling is on for 3")
        s = TilingStatus(workspace: 1, tiles: false, style: "main", full: false, windows: [], focused: nil, tiling: [])
        XCTAssertEqual(TilingStatus(s.reply), s)
        XCTAssertEqual(s.text, "workspace 1 doesn't tile")
        XCTAssertEqual(s.value.object?["focused"], .null)
        XCTAssertNil(TilingStatus(Wire.Reply(ok: false, error: "no")))
        XCTAssertNil(TilingStatus(Wire.Reply(ok: true, info: ["tiling": "{}"])))
    }

    /// Windows move on the person's say-so alone, never another machine's.
    func testNoOtherMachineMayTile() {
        XCTAssertFalse(Remote.allows(Wire.Request(op: .tile, args: ["status"])))
        XCTAssertFalse(Remote.allows(Wire.Request(op: .tile, args: ["on"])))
    }

    /// The MCP tool names the same commands, and the page for people lists every key's command.
    func testTheMCPToolTakesEveryCommand() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let rust = try String(contentsOf: root.appendingPathComponent("cli/src/mcp.rs"), encoding: .utf8)
        let list = try XCTUnwrap(rust.components(separatedBy: "const TILING_COMMANDS: &[&str] = &[").dropFirst().first?.components(separatedBy: "];").first)
        let tool = list.components(separatedBy: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
        let forms = TilingRequest.forms.map { $0.form.replacingOccurrences(of: " [1-9]", with: "") }.filter { $0 != "status" }
        XCTAssertEqual(tool, forms)
    }
}
