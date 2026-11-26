import XCTest
@testable import BaneySpacesCore

final class TilingConfigTests: XCTestCase {
    func testEverySettingReachesTheEngine() {
        var s = Surfaces.defaults.tiling
        s.enabled = true
        s.on = [1, 2]
        s.off = [3]
        s.style = "main"
        (s.inner, s.outer, s.top, s.bottom, s.left, s.right) = (6, 10, 1, 2, 3, 4)
        s.loneWidth = .points(1200)
        s.newWindow = "before"
        s.float = ["app.a"]
        let o = TilingOptions(s, agentWorkspace: 9)
        XCTAssertTrue(o.everywhere)
        XCTAssertEqual(o.on, [1, 2])
        XCTAssertEqual(o.off, [3])
        XCTAssertEqual(o.style, .main)
        XCTAssertEqual(o.gaps, TileGaps(inner: 6, top: 11, bottom: 12, left: 13, right: 14))
        XCTAssertEqual(o.lone, .points(1200))
        XCTAssertEqual(o.side, .before)
        XCTAssertEqual(o.floatApps, ["app.a"])
        XCTAssertEqual(o.agentWorkspace, 9)
        s.loneWidth = .fill
        XCTAssertEqual(TilingOptions(s, agentWorkspace: nil).lone, .fill)
        s.loneWidth = .smart
        XCTAssertEqual(TilingOptions(s, agentWorkspace: nil).lone, .smart)
    }

    /// The names in surfaces.json and the engine's are the same list.
    func testTheSettingsNamesAreTheEngines() {
        func choices(_ path: String) -> [String] {
            guard case .choice(let list) = SurfaceField.all.first(where: { $0.path == path })?.kind else { return [] }
            return list
        }
        XCTAssertEqual(choices("tiling.style"), TileStyle.allCases.map(\.rawValue))
        XCTAssertEqual(choices("tiling.newWindow"), TilingSide.allCases.map(\.rawValue))
        XCTAssertEqual(TilingKeys.all.map(\.name), TilingCommand.named.map(\.name))
        XCTAssertEqual(TilingKeys.all.map(\.title), TilingCommand.named.map(\.title))
    }

    func testOffUntilAPersonTurnsItOn() {
        let o = TilingOptions(Surfaces.defaults.tiling, agentWorkspace: nil)
        for n in 1...9 { XCTAssertFalse(o.tiles(n)) }
    }

    func testToggledNamesAWorkspaceOnlyWhenTheDefaultSaysOtherwise() {
        var o = TilingOptions()
        o = o.toggled(2)
        XCTAssertEqual(o.on, [2])
        XCTAssertTrue(o.tiles(2))
        XCTAssertFalse(o.tiles(1))
        o = o.toggled(2)
        XCTAssertEqual(o, TilingOptions())
        o.everywhere = true
        o = o.toggled(2)
        XCTAssertEqual(o.off, [2])
        XCTAssertFalse(o.tiles(2))
        o = o.toggled(2)
        XCTAssertEqual(o.off, [])
        XCTAssertTrue(o.tiles(2))
        // Named in both lists, as a hand edit can: one press still turns it off.
        o.on = [2]
        o = o.toggled(2)
        XCTAssertFalse(o.tiles(2))
    }
}
