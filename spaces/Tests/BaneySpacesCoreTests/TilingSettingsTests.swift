import XCTest
@testable import BaneySpacesCore

final class TilingSettingsTests: XCTestCase {
    private func surfaces(_ tiling: String) -> Result<Surfaces.Checked, SurfacesErrors> {
        guard case .success(let v) = SurfaceValue.parse(Data(#"{"tiling":\#(tiling)}"#.utf8)) else { return Surfaces.check(.null) }
        return Surfaces.check(v)
    }

    private func errors(_ tiling: String) -> [String] {
        if case .failure(let e) = surfaces(tiling) { return e.issues.map(\.description) }
        return []
    }

    func testItIsOffUntilTurnedOn() throws {
        let t = Surfaces.defaults.tiling
        XCTAssertFalse(t.enabled)
        XCTAssertFalse(t.anywhere)
        XCTAssertEqual(t.style, "dwindle")
        XCTAssertEqual([t.inner, t.outer, t.top, t.bottom, t.left, t.right], [8, 8, 0, 0, 0, 0])
        XCTAssertEqual(t.loneWidth, .smart)
        XCTAssertEqual(t.float, ["com.apple.calculator", "com.apple.Stickies"])
        let one = try surfaces(#"{"on":["3"],"loneWidth":"points:1200","floatModifier":"none"}"#).get().surfaces.tiling
        XCTAssertTrue(one.anywhere)
        XCTAssertEqual(one.on, [3])
        XCTAssertEqual(one.loneWidth, .points(1200))
        XCTAssertEqual(one.floatModifier, .none)
    }

    func testWhatAFieldDoesNotTakeSaysWhy() {
        XCTAssertEqual(errors(#"{"on":["0"]}"#).count, 1)
        XCTAssertEqual(errors(#"{"gaps":{"inner":65}}"#).count, 1)
        XCTAssertEqual(errors(#"{"loneWidth":"points:12"}"#).count, 1)
        XCTAssertTrue(errors(#"{"float":["com.apple.Stickies","bad id"]}"#)[0].contains("tiling.float[1]"))
        XCTAssertTrue(errors(#"{"float":["a","a"]}"#)[0].contains("twice"))
        for k in ["cmd+Q", "cmd+shift+P", "opt+shift+E", "F5", "ctrl+F5", "cmd+F5"] {
            XCTAssertTrue(errors(#"{"keys":{"float":"\#(k)"}}"#).first?.contains("in front") ?? false, k)
        }
        XCTAssertTrue(errors(#"{"keys":{"float":"ctrl+cmd+K"}}"#)[0].contains("launcher"))
        XCTAssertTrue(errors(#"{"keys":{"float":"cmd+shift+3"}}"#)[0].contains("workspaces"))
    }

    func testEveryDefaultKeyReadsAndIsOneCommandsOnly() {
        let keys = TilingKeys.all.map(\.key).filter { !$0.isEmpty }
        for k in keys { XCTAssertEqual(KeyChord(k)?.text, k) }
        XCTAssertEqual(Set(keys).count, keys.count)
        XCTAssertEqual(Surfaces.defaults.tiling.keys.count, keys.count)
        XCTAssertEqual(KeyChord("ctrl+opt+T")?.symbols, "\u{2303}\u{2325}T")
        XCTAssertEqual(Set(TilingKeys.all.map(\.name)).count, TilingKeys.all.count)
    }

    func testAChosenKeyTakesItFromTheCommandThatHasItByDefault() throws {
        let t = try surfaces(#"{"keys":{"float":"ctrl+opt+b"}}"#).get().surfaces.tiling
        XCTAssertEqual(t.keys["float"], KeyChord("ctrl+opt+B"))
        XCTAssertNil(t.keys["balance"], "its default is the person's now")
        XCTAssertNotNil(t.keys["flip"])
        let same = try surfaces(#"{"keys":{"balance":"ctrl+opt+B"}}"#).get().surfaces.tiling
        XCTAssertEqual(same.keys, Surfaces.defaults.tiling.keys, "naming a command's own default changes nothing")
        XCTAssertNil(try surfaces(#"{"keys":{"toggle":""}}"#).get().surfaces.tiling.keys["toggle"])
        XCTAssertTrue(errors(#"{"keys":{"float":"ctrl+opt+Z","full":"opt+ctrl+z"}}"#)[0].contains("already tiling.keys."))
    }

    func testAChordIsReadInAnySpelling() {
        XCTAssertEqual(KeyChord("Command + Option + left"), KeyChord("opt+cmd+Left"))
        XCTAssertNotNil(KeyChord("cmd+opt+Left"))
        XCTAssertEqual(KeyChord("alt+control+f5")?.text, "ctrl+opt+F5")
        XCTAssertEqual(KeyChord("ctrl+shift+F13")?.keyCode, 105)
        XCTAssertEqual(KeyChord("cmd+ctrl+Left")?.parts, ["ctrl", "cmd", "\u{2190}"])
        for bad in ["", "ctrl+opt+", "T", "ctrl+T", "shift+T", "shift+cmd+Left", "F13", "ctrl+ctrl+T", "hyper+opt+T", "ctrl+opt+Escape", "ctrl+opt+TT"] { XCTAssertNil(KeyChord(bad), bad) }
    }
}
