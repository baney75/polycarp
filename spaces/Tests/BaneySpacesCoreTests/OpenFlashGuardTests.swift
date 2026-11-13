import XCTest
import CoreGraphics
@testable import BaneySpacesCore

/// 11-12 (Donovan: "random windows keep opening like font book", after "Calculators keep opening also!"): every
/// `agent open` drew its window on his workspace for 0.7 to 1.5 s before it was parked. These pin the cover's rules and
/// the limits from the review of PR 209 (finding ids in each message); `scripts/agent-open-probe.swift` measures the time
/// on screen.
final class OpenFlashGuardTests: XCTestCase {
    typealias S = OpenFlashGuard.Sighting
    let screen = [CGRect(x: 0, y: 0, width: 1512, height: 982)]
    let w = CGRect(x: 400, y: 300, width: 500, height: 400)

    func testItIsOffUnlessTheCoverIsNamed() {
        XCTAssertEqual(OpenFlashGuard.from(nil), .off)
        XCTAssertEqual(OpenFlashGuard.from("hidden"), .off, "an unknown value never turns anything on")
        XCTAssertEqual(OpenFlashGuard.from("fast"), .off, "the dropped prototype")
        XCTAssertEqual(OpenFlashGuard.from("cover"), .cover)
    }

    func testOnlyAnOrdinaryWindowInSightIsGuarded() {
        XCTAssertTrue(OpenFlashGuard.needsGuard(layer: 0, bounds: w, screens: screen))
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 3, bounds: w, screens: screen), "a panel on its own level")
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 0, bounds: CGRect(x: 0, y: 0, width: 40, height: 400), screens: screen), "a sliver")
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 0, bounds: CGRect(x: 1511, y: 981, width: 500, height: 400), screens: screen), "parked already")
    }

    func testEachScreenGetsItsOwnPartOfTheCover() {
        XCTAssertEqual(OpenFlashGuard.coverParts(for: w, screens: screen).map(\.frame), [CGRect(x: 352, y: 252, width: 596, height: 496)])
        XCTAssertEqual(OpenFlashGuard.coverParts(for: CGRect(x: 0, y: 0, width: 500, height: 400), screens: screen).map(\.frame),
                       [CGRect(x: 0, y: 0, width: 548, height: 448)], "clipped to the screen")
        XCTAssertTrue(OpenFlashGuard.coverParts(for: CGRect(x: 3000, y: 0, width: 500, height: 400), screens: screen).isEmpty)
        // sol-F4: diagonal displays, where the union's midpoint (1150, 200) is on neither.
        let diagonal = [CGRect(x: 0, y: 0, width: 1000, height: 800), CGRect(x: 1000, y: -800, width: 1000, height: 800)]
        let parts = OpenFlashGuard.coverParts(for: CGRect(x: 900, y: 0, width: 500, height: 400), screens: diagonal)
        XCTAssertEqual(parts.map(\.screen), [0, 1], "sol-F4, second-F10: one part per display, each from its own shot")
        XCTAssertEqual(parts.map(\.frame), [CGRect(x: 852, y: 0, width: 148, height: 448), CGRect(x: 1000, y: -48, width: 448, height: 48)])
    }

    func testAppKitFramesCountFromTheBottom() {
        XCTAssertEqual(OpenFlashGuard.appKit(CGRect(x: 10, y: 20, width: 100, height: 50), primaryHeight: 982), CGRect(x: 10, y: 912, width: 100, height: 50))
    }

    func testOnlyTheLaunchedProcessIsCovered() {
        var p = OpenFlashGuard.Plan(pid: 900, screens: screen)
        let s = p.tick(now: 0.1, windows: [S(pid: 901, id: 5, layer: 0, bounds: w), S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true)
        XCTAssertEqual(s.covers, [6: w], "sol-F1: another copy of the same app, Donovan's, is never covered")
        var q = OpenFlashGuard.Plan(pid: 900, screens: screen)
        XCTAssertEqual(q.tick(now: 0.1, windows: [S(pid: 901, id: 5, layer: 0, bounds: w)], alive: true).covers, [:])
    }

    func testTheWatchEndsTheMomentItsProcessExits() {
        var p = OpenFlashGuard.Plan(pid: 900, screens: screen)
        _ = p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true)
        let s = p.tick(now: 0.2, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: false)
        XCTAssertTrue(s.end, "sol-F1: the agent's copy quit")
        XCTAssertEqual(s.covers, [:]); XCTAssertTrue(s.changed, "its cover comes down"); XCTAssertTrue(s.release)
    }

    func testACoverComesDownAfterOneAndAHalfSecondsParkedOrNot() {
        var p = OpenFlashGuard.Plan(pid: 900, screens: screen)
        XCTAssertEqual(p.tick(now: 0.2, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true).covers, [6: w])
        XCTAssertEqual(p.tick(now: 1.6, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true).covers, [6: w])
        let s = p.tick(now: 1.8, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true)
        XCTAssertEqual(s.covers, [:], "first-F4: a missed claim no longer leaves a still image that eats clicks for 7 s")
        XCTAssertEqual(s.expired, [6]); XCTAssertTrue(s.changed)
        XCTAssertEqual(p.tick(now: 1.9, windows: [], alive: true).covers, [:])
        XCTAssertEqual(p.tick(now: 2.0, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true).covers, [:], "and it doesn't come back")
    }

    func testOnlyAChangeRedraws() {
        var p = OpenFlashGuard.Plan(pid: 900, screens: screen)
        XCTAssertTrue(p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true).changed)
        XCTAssertFalse(p.tick(now: 0.104, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], alive: true).changed,
                       "second-F9: nothing moved, so nothing is queued on the main thread")
        XCTAssertTrue(p.tick(now: 0.108, windows: [S(pid: 900, id: 6, layer: 0, bounds: w.offsetBy(dx: 10, dy: 0))], alive: true).changed, "it moved")
    }

    func testTheHoldEndsOnceAWindowIsSeenOrItRunsOut() {
        var p = OpenFlashGuard.Plan(pid: 900, screens: screen)
        XCTAssertFalse(p.tick(now: 0.1, windows: [], alive: true).release)
        XCTAssertTrue(p.tick(now: 0.2, windows: [S(pid: 900, id: 7, layer: 0, bounds: CGRect(x: 0, y: 0, width: 30, height: 30))], alive: true).release,
                      "first-F1: a window it won't cover doesn't keep the claim waiting")
        var q = OpenFlashGuard.Plan(pid: 900, screens: screen)
        XCTAssertTrue(q.tick(now: OpenFlashGuard.holdFor, windows: [], alive: true).release)
    }

    func testOverlappingLaunchesHoldAndReleaseOnlyTheirOwn() {
        var h = OpenFlashGuard.Holds()
        let t = Date(timeIntervalSince1970: 1_000)
        h.hold(900, now: t); h.hold(950, now: t)
        _ = h.release(900)
        XCTAssertFalse(h.skips(900, now: t))
        XCTAssertTrue(h.skips(950, now: t), "sol-F2, first-F3: the first launch's release leaves the second's hold")
        XCTAssertFalse(h.skips(951, now: t), "a process with no hold is asked as before")
        XCTAssertFalse(h.skips(950, now: t.addingTimeInterval(OpenFlashGuard.holdFor)), "it runs out")
    }

    func testAnAskSkippedByTheHoldIsAskedAgainWhenItEnds() {
        var h = OpenFlashGuard.Holds()
        let t = Date(timeIntervalSince1970: 1_000)
        h.hold(900, now: t); h.hold(950, now: t)
        XCTAssertTrue(h.skips(900, now: t))
        XCTAssertTrue(h.release(900), "second-F7: a scan skipped it, so the release asks again")
        XCTAssertFalse(h.release(950), "no scan skipped this one: nothing to ask again")
        XCTAssertFalse(h.release(900), "released once")
    }

    func testTheWatchIsBoundToTheLaunchAndBoundedInTime() throws {
        let c = try CursorSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let open = try XCTUnwrap(HandsSourceTests.between("OpenFlashWatch.around(", "starting a separate copy", in: c))
        XCTAssertTrue(open.contains("{ app, _ in started(app); finished(app) }"), "sol-F1: the watch gets the pid the launch returned, before the claim")
        let newWindow = try XCTUnwrap(HandsSourceTests.between("DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {", "_ = newWindow(app)", in: c))
        XCTAssertTrue(newWindow.contains("Windows.release(app.processIdentifier)"), "first-F2: New Window can ask the app")
        let w = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        XCTAssertFalse(w.contains("kCGWindowOwnerName"), "sol-F1: never matched by app name")
        XCTAssertTrue(w.contains("guard let shots else {"), "first-F1, sol-F5: no shot of every display, no hold and no cover")
        let noShot = try XCTUnwrap(HandsSourceTests.between("guard let shots else {", "let l = Launch(", in: w))
        XCTAssertFalse(noShot.contains("Windows.hold"))
        XCTAssertTrue(w.contains("mode?.pixelWidth"), "first-F5: captured at backing pixels")
        let redraw = try XCTUnwrap(HandsSourceTests.between("func redraw() {", "private func paint(", in: w))
        XCTAssertTrue(redraw.contains("if !agentShown() {"), "sol-F3: never covers while the agent workspace is shown")
        XCTAssertTrue(redraw.contains("p.frame == part.frame { continue }"), "second-F9: re-cropped only when the window moved")
        let d = try CursorSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(try XCTUnwrap(HandsSourceTests.between("spaces.onChange = {", "}\n", in: d)).contains("OpenFlashWatch.environmentChanged()"),
                      "sol-F3: a switch to the agent workspace takes the covers down")
        XCTAssertTrue(d.contains("Windows.onHoldEnd = { [weak self] pid in self?.spaces.askAgain(pid) }"), "second-F7")
        let r = try CursorSourceTests.code("Sources/BaneySpaces/Windows.swift")
        let ask = try XCTUnwrap(HandsSourceTests.between("static func isResponsive(", "static func markUnresponsive", in: r))
        XCTAssertTrue(ask.contains("holds.skips(pid, now: now)"), "Spaces' asks go through the hold")
        XCTAssertFalse(ask.contains("NSRunningApplication"), "first-F6: no name read per ask")
        XCTAssertTrue(w.contains(".nonactivatingPanel"), "a click on the cover doesn't bring Polycarp forward")
        XCTAssertFalse(w.contains(".hide()") || w.contains("app.hide"), "no hide: a hidden app lists no windows (PR 172)")
    }
}
