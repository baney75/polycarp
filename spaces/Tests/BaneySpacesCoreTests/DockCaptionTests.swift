import XCTest
@testable import BaneySpacesCore

/// `dock.tileLabel`: what goes under each workspace tile, and the tile's title.
final class DockCaptionTests: XCTestCase {
    func testNumberAndIconsModes() {
        XCTAssertEqual(DockLabel.caption(mode: .number), .number)
        XCTAssertEqual(DockLabel.caption(mode: .icons), .none)
        XCTAssertEqual(Surfaces.TileLabel.allCases, [.number, .icons], "no purpose mode (2026-11-22)")
    }

    func testTitleNamesTheWorkspace() {
        XCTAssertEqual(DockLabel.tileTitle(workspace: 3, apps: [], agent: nil, shown: 0), "Workspace 3 · empty")
        let t = DockLabel.tileTitle(workspace: 1, apps: ["Ghostty"], agent: nil, shown: 1)
        XCTAssertTrue(t.hasPrefix("Workspace 1 · "), t)
        XCTAssertTrue(t.contains("Ghostty"), t)
    }
}
