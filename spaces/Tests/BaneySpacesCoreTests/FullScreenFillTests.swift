@testable import BaneySpacesCore
import XCTest

/// 2026-11-06: with an app in macOS full screen, every workspace switch played macOS's slide. The green button and ⌃⌘F fill the
/// screen on the window's workspace instead.
final class FullScreenFillTests: XCTestCase {
    private let fill = CGRect(x: 0, y: 34, width: 1512, height: 948)
    private let small = CGRect(x: 100, y: 100, width: 800, height: 600)

    func testItIsOnUnlessTurnedOff() {
        XCTAssertTrue(FullScreenFill.isEnabled(stored: nil))
        XCTAssertTrue(FullScreenFill.isEnabled(stored: true))
        XCTAssertFalse(FullScreenFill.isEnabled(stored: false))
    }

    func testOnlyTheStandardKeysCount() {
        let key = { (code: Int64, c: Bool, m: Bool, s: Bool, o: Bool, f: Bool) in
            FullScreenFill.isFullScreenKey(code: code, control: c, command: m, shift: s, option: o, fn: f)
        }
        XCTAssertTrue(key(3, true, true, false, false, false), "⌃⌘F")
        XCTAssertTrue(key(3, false, false, false, false, true), "fn-F")
        XCTAssertFalse(key(3, false, true, false, false, false), "⌘F is Find")
        XCTAssertFalse(key(3, true, false, false, false, false), "⌃F")
        XCTAssertFalse(key(3, true, true, true, false, false), "⌃⌘⇧F belongs to the app")
        XCTAssertFalse(key(3, true, true, false, true, false))
        XCTAssertFalse(key(4, true, true, false, false, false), "another letter")
        XCTAssertFalse(key(3, false, false, false, false, false), "plain f")
    }

    func testOptionClickStaysMacOSsZoom() {
        XCTAssertTrue(FullScreenFill.isPlainClick(command: false, control: false, shift: false, option: false))
        XCTAssertFalse(FullScreenFill.isPlainClick(command: false, control: false, shift: false, option: true))
    }

    func testThePressTogglesAndComesBackWhereItWas() {
        XCTAssertEqual(FullScreenFill.target(current: small, fill: fill, saved: nil), fill)
        XCTAssertEqual(FullScreenFill.target(current: fill, fill: fill, saved: small), small)
        XCTAssertEqual(FullScreenFill.target(current: fill, fill: fill, saved: nil), fill, "nothing saved: it stays")
    }

    func testAWindowThatMovedSinceFillingFillsAgain() {
        XCTAssertEqual(FullScreenFill.target(current: small, fill: fill, saved: CGRect(x: 1, y: 1, width: 2, height: 2)), fill)
    }

    func testAppsThatRoundTheirSizeStillCountAsFilling() {
        XCTAssertTrue(FullScreenFill.isFilling(CGRect(x: 0, y: 34, width: 1510, height: 946), fill))
        XCTAssertFalse(FullScreenFill.isFilling(CGRect(x: 0, y: 34, width: 1400, height: 948), fill))
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: Repo.root.appendingPathComponent(path), encoding: .utf8)
    }

    func testTheGestureWatcherOnlySwallowsWhatItActsOn() throws {
        let code = try source("Sources/BaneySpaces/FullScreenGestures.swift")
        XCTAssertTrue(code.contains("FullScreenFill.buttonSubrole"), "only the green button")
        XCTAssertTrue(code.contains("AXUIElementSetMessagingTimeout"), "a frozen app can't hold up clicks")
        XCTAssertTrue(code.contains("tapDisabledByTimeout"), "macOS turning the tap off is noticed")
        XCTAssertTrue(code.contains("swallowingUp"), "a swallowed press takes its release with it")
    }
}
