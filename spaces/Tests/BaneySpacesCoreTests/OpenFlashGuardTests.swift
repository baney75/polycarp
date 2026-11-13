import XCTest
import CoreGraphics
@testable import BaneySpacesCore

/// 11-12 (Donovan: "random windows keep opening like font book", after "Calculators keep opening also!"): every
/// `agent open` drew its window on his workspace for 0.7 to 1.5 s before it was parked. These pin the cover's rules;
/// `scripts/agent-open-probe.swift` measures the time on screen.
final class OpenFlashGuardTests: XCTestCase {
    let screen = [CGRect(x: 0, y: 0, width: 1512, height: 982)]

    func testItIsOffUnlessAPrototypeIsNamed() {
        XCTAssertEqual(OpenFlashGuard.from(nil), .off)
        XCTAssertEqual(OpenFlashGuard.from(""), .off)
        XCTAssertEqual(OpenFlashGuard.from("hidden"), .off, "an unknown value never turns anything on")
        XCTAssertEqual(OpenFlashGuard.from("fast"), .off, "the dropped prototype")
        XCTAssertEqual(OpenFlashGuard.from("cover"), .cover)
    }

    func testOnlyAnOrdinaryWindowInSightIsGuarded() {
        let w = CGRect(x: 400, y: 300, width: 500, height: 400)
        XCTAssertTrue(OpenFlashGuard.needsGuard(layer: 0, bounds: w, screens: screen))
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 3, bounds: w, screens: screen), "a panel on its own level")
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 0, bounds: CGRect(x: 0, y: 0, width: 40, height: 400), screens: screen), "a sliver")
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 0, bounds: CGRect(x: 1511, y: 981, width: 500, height: 400), screens: screen), "parked already")
    }

    func testTheCoverReachesOverTheShadowAndStaysOnTheScreen() throws {
        let f = try XCTUnwrap(OpenFlashGuard.coverFrame(for: CGRect(x: 400, y: 300, width: 500, height: 400), screens: screen))
        XCTAssertEqual(f, CGRect(x: 352, y: 252, width: 596, height: 496))
        let edge = try XCTUnwrap(OpenFlashGuard.coverFrame(for: CGRect(x: 0, y: 0, width: 500, height: 400), screens: screen))
        XCTAssertEqual(edge, CGRect(x: 0, y: 0, width: 548, height: 448), "clipped to the screen")
        XCTAssertNil(OpenFlashGuard.coverFrame(for: CGRect(x: 3000, y: 0, width: 500, height: 400), screens: screen))
    }

    func testTheHoldSkipsOnlyTheNewCopyAndOnlyForAWhile() {
        let t = Date(timeIntervalSince1970: 1_000)
        let h = OpenFlashGuard.Hold(app: "Font Book", before: [500], now: t)
        XCTAssertTrue(h.holds(pid: 900, name: "Font Book", now: t), "the copy being launched")
        XCTAssertFalse(h.holds(pid: 500, name: "Font Book", now: t), "Donovan's own copy is asked as before")
        XCTAssertFalse(h.holds(pid: 901, name: "Dictionary", now: t), "other apps are asked as before")
        XCTAssertFalse(h.holds(pid: 900, name: "Font Book", now: t.addingTimeInterval(OpenFlashGuard.Hold.holdFor)), "it runs out")
    }

    func testAppKitFramesCountFromTheBottom() {
        XCTAssertEqual(OpenFlashGuard.appKit(CGRect(x: 10, y: 20, width: 100, height: 50), primaryHeight: 982), CGRect(x: 10, y: 912, width: 100, height: 50))
    }

    func testTheLaunchGoesThroughTheCoverAndTheHoldEnds() throws {
        let c = try CursorSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let open = try XCTUnwrap(HandsSourceTests.between("OpenFlashWatch.around(", "starting a separate copy", in: c))
        XCTAssertTrue(open.contains("NSWorkspace.shared.openApplication(at: url"), "the launch runs inside the guard")
        let w = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        XCTAssertTrue(w.contains("guard mode == .cover, !agentShown else { return launch() }"), "off launches as before")
        let start = try XCTUnwrap(HandsSourceTests.between("DispatchQueue.main.async {", "launch()", in: w))
        XCTAssertTrue(start.contains("Windows.hold(OpenFlashGuard.Hold("), "the hold is set before the launch")
        let up = try XCTUnwrap(HandsSourceTests.between("w.orderFrontRegardless(); windows[id] = w", "private func make()", in: w))
        XCTAssertTrue(up.contains("Windows.hold(nil)"), "the hold ends once the cover is up")
        let end = try XCTUnwrap(HandsSourceTests.between("Thread.sleep(forTimeInterval: OpenFlashGuard.interval)", "t.name", in: w))
        XCTAssertTrue(end.contains("Windows.hold(nil)"), "and when the watch ends")
        XCTAssertTrue(w.contains(".nonactivatingPanel"), "a click on the cover doesn't bring Polycarp forward")
        XCTAssertFalse(w.contains("ignoresMouseEvents = true"), "and doesn't pass through to the agent's app")
        XCTAssertFalse(w.contains(".hide()") || w.contains("app.hide"), "no hide: a hidden app lists no windows (PR 172)")
        let r = try CursorSourceTests.code("Sources/BaneySpaces/Windows.swift")
        let ask = try XCTUnwrap(HandsSourceTests.between("static func isResponsive(", "static func markUnresponsive", in: r))
        XCTAssertTrue(ask.contains("held.holds(pid: pid"), "Spaces' asks go through the hold")
    }
}
