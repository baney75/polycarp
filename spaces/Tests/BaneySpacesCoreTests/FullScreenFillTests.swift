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
        XCTAssertEqual(FullScreenFill.target(current: small, fill: fill, record: nil), fill)
        let record = FullScreenFill.Record(from: small, landed: fill)
        XCTAssertEqual(FullScreenFill.target(current: fill, fill: fill, record: record), small)
    }

    func testAnAppThatSnapsItsSizeStillComesBack() {
        // Terminal lands short of the screen, on a character cell. Measuring against the screen would fill it forever.
        let snapped = CGRect(x: 0, y: 34, width: 1490, height: 930)
        let record = FullScreenFill.Record(from: small, landed: snapped)
        XCTAssertEqual(FullScreenFill.target(current: snapped, fill: fill, record: record), small)
    }

    func testAWindowDraggedSinceFillingFillsAgain() {
        let record = FullScreenFill.Record(from: small, landed: fill)
        XCTAssertEqual(FullScreenFill.target(current: CGRect(x: 40, y: 80, width: 900, height: 700), fill: fill, record: record), fill)
    }

    func testOrdinaryClicksNeverAskAnApp() {
        let window = CGRect(x: 100, y: 100, width: 800, height: 600)
        XCTAssertTrue(FullScreenFill.isInButtonCorner(CGPoint(x: 150, y: 110), window: window), "the traffic lights")
        XCTAssertFalse(FullScreenFill.isInButtonCorner(CGPoint(x: 230, y: 110), window: window), "a toolbar button past them")
        XCTAssertFalse(FullScreenFill.isInButtonCorner(CGPoint(x: 500, y: 110), window: window), "the rest of the title bar")
        XCTAssertFalse(FullScreenFill.isInButtonCorner(CGPoint(x: 150, y: 400), window: window), "the content")
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: Repo.root.appendingPathComponent(path), encoding: .utf8)
    }

    func testTheGestureWatcherOnlySwallowsWhatItActsOn() throws {
        let code = try source("Sources/BaneySpaces/FullScreenGestures.swift")
        XCTAssertTrue(code.contains("FullScreenFill.buttonSubrole"), "only the green button")
        XCTAssertTrue(code.contains("isInButtonCorner"), "only a click in the corner asks the app anything")
        XCTAssertTrue(code.contains(".milliseconds(40)"), "a frozen app can't hold a click")
        XCTAssertFalse(code.contains("AXUIElementSetMessagingTimeout(system"), "that would change every Accessibility call in the app")
        XCTAssertTrue(code.contains("frontIsFullScreen"), "the key leaves native full screen, as macOS's own")
        XCTAssertTrue(code.contains("tapDisabledByTimeout"), "macOS turning the tap off is noticed")
        XCTAssertTrue(code.contains("swallowingUp"), "a swallowed press takes its release with it")
    }

    func testAPressAlwaysDoesSomething() {
        // Filled before Polycarp restarted, or sized by hand: no record of where it was. Seven presses of a green button
        // that did nothing (Donovan, 2026-11-07).
        let smaller = FullScreenFill.smaller(fill)
        XCTAssertEqual(FullScreenFill.target(current: fill, fill: fill, record: nil), smaller)
        XCTAssertNotEqual(smaller, fill)
        XCTAssertTrue(fill.contains(smaller))
        // A record that goes nowhere is the same as none.
        let useless = FullScreenFill.Record(from: fill, landed: fill)
        XCTAssertEqual(FullScreenFill.target(current: fill, fill: fill, record: useless), smaller)
    }

    func testARecordSurvivesARestart() throws {
        let record = FullScreenFill.Record(from: small, landed: fill)
        let data = try JSONEncoder().encode([UInt32(59): record])
        XCTAssertEqual(try JSONDecoder().decode([UInt32: FullScreenFill.Record].self, from: data), [59: record])
    }

    func testDraggingAFilledWindowAwayGivesItsSizeBackUnderThePointer() throws {
        let record = FullScreenFill.Record(from: small, landed: fill)
        let moved = fill.offsetBy(dx: 0, dy: 30)
        let grab = CGPoint(x: moved.midX, y: moved.minY + 10)
        let next = try XCTUnwrap(FullScreenFill.unfilled(current: moved, fill: fill, record: record, pointer: grab))
        XCTAssertEqual(next.size, small.size)
        XCTAssertEqual(next.midX, grab.x, accuracy: 1, "the pointer stays over the same share of the title bar")
        XCTAssertEqual(next.minY, moved.minY)
    }

    func testDraggingAWindowMacOSFilledLeavesItToMacOS() {
        // Donovan, 2026-11-12: Helium filled by a drag to the top, then dragged down. macOS put back its old size and Spaces
        // shrank it as well in the same 10 ms, so the window changed size twice and jumped off the pointer.
        let moved = fill.offsetBy(dx: 12, dy: 30)
        XCTAssertNil(FullScreenFill.unfilled(current: moved, fill: fill, record: nil, pointer: CGPoint(x: moved.midX, y: moved.minY + 8)))
    }

    func testAFilledWindowWhoseEarlierSizeWasFullShrinksWhenDragged() throws {
        let record = FullScreenFill.Record(from: fill, landed: fill)
        let moved = fill.offsetBy(dx: 0, dy: 30)
        let next = try XCTUnwrap(FullScreenFill.unfilled(current: moved, fill: fill, record: record, pointer: CGPoint(x: moved.midX, y: moved.minY + 8)))
        XCTAssertEqual(next.size, FullScreenFill.smaller(fill).size)
    }

    func testDraggingAnOrdinaryWindowLeavesItAlone() {
        XCTAssertNil(FullScreenFill.unfilled(current: small, fill: fill, record: nil, pointer: CGPoint(x: small.midX, y: small.minY)))
    }

    func testAWindowItsOwnAppShowsAgainComesToYou() {
        let reappeared = { (shown: Bool, agent: Bool, parked: Bool, hidden: Bool, minimized: Bool, full: Bool, on: Bool) in
            ReappearedWindow.belongsHere(workspaceShown: shown, onAgentWorkspace: agent, parked: parked, appHiddenByUs: hidden,
                                         minimized: minimized, fullScreen: full, onScreen: on)
        }
        XCTAssertTrue(reappeared(false, false, false, false, false, false, true), "a screenshot tool's result window")
        XCTAssertFalse(reappeared(true, false, false, false, false, false, true), "already where you are")
        XCTAssertFalse(reappeared(false, true, false, false, false, false, true), "an agent's window stays on its workspace")
        XCTAssertFalse(reappeared(false, false, true, false, false, false, true), "one Polycarp parked is yours to go to")
        XCTAssertFalse(reappeared(false, false, false, true, false, false, true), "so is one in an app Polycarp hid")
        XCTAssertFalse(reappeared(false, false, false, false, true, false, true), "minimized")
        XCTAssertFalse(reappeared(false, false, false, false, false, true, true), "native full screen has its own Space")
        XCTAssertFalse(reappeared(false, false, false, false, false, false, false), "nothing on screen to bring")
    }

    func testARecordAloneDoesntMakeAWindowAway() {
        // Parked while it showed, hidden by its own app, shown again: the record is still there and the window is in sight.
        XCTAssertFalse(ReappearedWindow.isAway(hasRecord: true, atHidingSpot: false, justSwitched: false))
        XCTAssertTrue(ReappearedWindow.isAway(hasRecord: true, atHidingSpot: true, justSwitched: false))
        XCTAssertTrue(ReappearedWindow.isAway(hasRecord: true, atHidingSpot: false, justSwitched: true), "still on its way out")
        XCTAssertFalse(ReappearedWindow.isAway(hasRecord: false, atHidingSpot: true, justSwitched: true))
    }

    func testFromANativeFullScreenSpaceEveryWindowIsStillParked() throws {
        // The window server lists only that Space then. Reading "not listed" as "hidden by its app" would leave windows out.
        let code = try HandsSourceTests.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(code.contains("let inSight: Set<WindowID>? = DockSpaces.current().unsafe ? nil : Windows.onScreenIDs()"))
        XCTAssertTrue(code.contains("(inSight?.contains(w.id) ?? true)"))
    }
}
