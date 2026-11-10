import CoreGraphics
import XCTest
@testable import BaneySpacesCore

final class VoiceOverlayPlaceTests: XCTestCase {
    // A laptop (primary, 1512 x 982) with a 2560 x 1440 display to its right, its bottom edge level with the laptop's.
    let laptop = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let external = CGRect(x: 1512, y: 0, width: 2560, height: 1440)

    /// The old overlay always used NSScreen.main (the display with the menu bar's key window), not the one you type in.
    func testThePillGoesToTheDisplayHoldingTheFocusedWindow() {
        let editor = VoiceOverlayPlace.cocoa(CGRect(x: 1700, y: 100, width: 1200, height: 800), primaryHeight: 982)
        XCTAssertEqual(VoiceOverlayPlace.screen(window: editor, pointer: CGPoint(x: 10, y: 10), screens: [laptop, external]), 1)
        // A window across both goes where most of it is.
        let wide = CGRect(x: 1200, y: 100, width: 600, height: 500)
        XCTAssertEqual(VoiceOverlayPlace.screen(window: wide, pointer: .zero, screens: [laptop, external]), 0)
    }

    func testWithNoWindowThePointerDecides() {
        XCTAssertEqual(VoiceOverlayPlace.screen(window: nil, pointer: CGPoint(x: 2000, y: 500), screens: [laptop, external]), 1)
        XCTAssertEqual(VoiceOverlayPlace.screen(window: CGRect(x: -900, y: 0, width: 10, height: 10), pointer: CGPoint(x: 5, y: 5), screens: [laptop, external]), 0)
        XCTAssertEqual(VoiceOverlayPlace.screen(window: nil, pointer: CGPoint(x: -50, y: -50), screens: [laptop, external]), 0)
    }

    func testCoordinatesFlipAgainstThePrimaryDisplay() {
        XCTAssertEqual(VoiceOverlayPlace.cocoa(CGRect(x: 10, y: 0, width: 100, height: 50), primaryHeight: 982), CGRect(x: 10, y: 932, width: 100, height: 50))
        XCTAssertEqual(VoiceOverlayPlace.frame(size: CGSize(width: 260, height: 64), on: external), CGRect(x: 1512 + 1280 - 130, y: 72, width: 260, height: 64))
    }

    /// The overlay follows the theme: it is in the conformance scan, redraws on a theme change, and is placed here.
    func testTheOverlayRedrawsOnAThemeChangeAndUsesThisPlacement() throws {
        let code = try Repo.code("Sources/BaneySpaces/Voice/VoiceOverlay.swift")
        XCTAssertTrue(code.contains("forName: Appearance.didChange"))
        XCTAssertTrue(code.contains("VoiceOverlayPlace.screen("))
        XCTAssertFalse(code.contains("NSScreen.main"))
        XCTAssertTrue(code.contains("Chrome.nsFont(") && code.contains("Chrome.radius(.hudPanel)"))
    }
}
