import XCTest
@testable import BaneySpacesCore

/// `dock.tileLabel`: what goes under each workspace tile, and the purpose in the tile's title.
final class DockCaptionTests: XCTestCase {
    func testPurposeShowsUnderTheTile() {
        XCTAssertEqual(DockLabel.caption(purpose: "Write", mode: .purpose), .purpose("Write"))
    }

    func testNoPurposeFallsBackToTheNumber() {
        XCTAssertEqual(DockLabel.caption(purpose: nil, mode: .purpose), .number)
        XCTAssertEqual(DockLabel.caption(purpose: "", mode: .purpose), .number)
        XCTAssertEqual(DockLabel.caption(purpose: "  \n ", mode: .purpose), .number)
    }

    func testPurposeWhitespaceFolds() {
        XCTAssertEqual(DockLabel.caption(purpose: "  Read\n the  Word ", mode: .purpose), .purpose("Read the Word"))
    }

    func testNumberAndIconsModesIgnoreThePurpose() {
        XCTAssertEqual(DockLabel.caption(purpose: "Write", mode: .number), .number)
        XCTAssertEqual(DockLabel.caption(purpose: "Write", mode: .icons), .none)
    }

    func testTitleCarriesThePurpose() {
        XCTAssertEqual(DockLabel.tileTitle(workspace: 2, purpose: "Write", apps: [], agent: nil, shown: 0), "Workspace 2 · Write · empty")
        XCTAssertEqual(DockLabel.tileTitle(workspace: 2, purpose: "", apps: [], agent: nil, shown: 0), "Workspace 2 · empty")
        XCTAssertEqual(DockLabel.tileTitle(workspace: 3, apps: [], agent: nil, shown: 0), "Workspace 3 · empty")
    }

    func testTitleWithAppsKeepsThePurposeFirst() {
        let t = DockLabel.tileTitle(workspace: 1, purpose: "Study", apps: ["Ghostty"], agent: nil, shown: 1)
        XCTAssertTrue(t.hasPrefix("Workspace 1 · Study · "), t)
        XCTAssertTrue(t.contains("Ghostty"), t)
    }
}
