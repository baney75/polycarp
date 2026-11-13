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
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        let s = p.tick(now: 0.1, windows: [S(pid: 901, id: 5, layer: 0, bounds: w), S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        XCTAssertEqual(s.covers, [6: w], "sol-F1: another copy of the same app, Donovan's, is never covered")
        var q = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertEqual(q.tick(now: 0.1, windows: [S(pid: 901, id: 5, layer: 0, bounds: w)], incarnation: 77).covers, [:])
    }

    func testTheWatchEndsTheMomentItsProcessExits() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        _ = p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        let s = p.tick(now: 0.2, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: nil)
        XCTAssertTrue(s.end, "sol-F1: the agent's copy quit")
        XCTAssertEqual(s.covers, [:]); XCTAssertTrue(s.changed, "its cover comes down"); XCTAssertTrue(s.release)
    }

    func testACoverComesDownAfterOneAndAHalfSecondsParkedOrNot() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertEqual(p.tick(now: 0.2, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).covers, [6: w])
        XCTAssertEqual(p.tick(now: 1.6, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).covers, [6: w])
        let s = p.tick(now: 1.8, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        XCTAssertEqual(s.covers, [:], "first-F4: a missed claim no longer leaves a still image that eats clicks for 7 s")
        XCTAssertEqual(s.expired, [6]); XCTAssertTrue(s.changed)
        XCTAssertEqual(p.tick(now: 1.9, windows: [], incarnation: 77).covers, [:])
        XCTAssertEqual(p.tick(now: 2.0, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).covers, [:], "and it doesn't come back")
    }

    func testOnlyAChangeRedraws() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertTrue(p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).changed)
        XCTAssertFalse(p.tick(now: 0.104, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).changed,
                       "second-F9: nothing moved, so nothing is queued on the main thread")
        XCTAssertTrue(p.tick(now: 0.108, windows: [S(pid: 900, id: 6, layer: 0, bounds: w.offsetBy(dx: 10, dy: 0))], incarnation: 77).changed, "it moved")
    }

    func testTheHoldEndsOnceAWindowIsSeenOrItRunsOut() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertFalse(p.tick(now: 0.1, windows: [], incarnation: 77).release)
        XCTAssertTrue(p.tick(now: 0.2, windows: [S(pid: 900, id: 7, layer: 0, bounds: CGRect(x: 0, y: 0, width: 30, height: 30))], incarnation: 77).release,
                      "first-F1: a window it won't cover doesn't keep the claim waiting")
        var q = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertTrue(q.tick(now: OpenFlashGuard.holdFor, windows: [], incarnation: 77).release)
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

    func testAReusedPidIsNotTheLaunch() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        _ = p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        let s = p.tick(now: 0.2, windows: [S(pid: 900, id: 9, layer: 0, bounds: w)], incarnation: 78)
        XCTAssertTrue(s.end, "sol-F3: the pid now names another process")
        XCTAssertEqual(s.covers, [:])
    }

    func testTheWatchStopsOnceTheWindowIsParkedOrPastItsCover() {
        let parked = CGRect(x: 1511, y: 981, width: 500, height: 400)
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertFalse(p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).end)
        let hidden = p.tick(now: 0.5, windows: [], incarnation: 77)
        XCTAssertFalse(hidden.end, "hidden for the park's move: it may come back in sight")
        XCTAssertTrue(hidden.changed, "its cover comes down while it is out of sight")
        XCTAssertTrue(p.tick(now: 0.6, windows: [S(pid: 900, id: 6, layer: 0, bounds: parked)], incarnation: 77).end, "first-F4: parked, so the 4 ms poll stops")
        var q = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        _ = q.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        XCTAssertTrue(q.tick(now: 1.7, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).end, "past its cover")
        var r = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertFalse(r.tick(now: 0.1, windows: [S(pid: 900, id: 7, layer: 0, bounds: CGRect(x: 400, y: 300, width: 30, height: 30))], incarnation: 77).end,
                       "a splash sliver in sight isn't parked: the main window may still come")
    }

    func testACoverRisesOnlyWhileItsMomentHolds() {
        let t = OpenFlashGuard.Ticket(launch: 3, workspaces: 10, incarnation: 77)
        XCTAssertTrue(t.holds(live: [3], workspaces: 10, incarnation: 77))
        XCTAssertFalse(t.holds(live: [], workspaces: 10, incarnation: 77), "sol-F1: its watch is over")
        XCTAssertFalse(t.holds(live: [3], workspaces: 11, incarnation: 77), "sol-F2, first-F2: a workspace switch since its shot")
        XCTAssertFalse(t.holds(live: [3], workspaces: 10, incarnation: nil), "sol-F1: the process exited")
        XCTAssertFalse(t.holds(live: [3], workspaces: 10, incarnation: 78), "sol-F3: the pid was reused")
    }

    func testOneGuardedOpenAtATime() {
        XCTAssertEqual(OpenFlashGuard.turn(busy: false, waited: 0), .go)
        XCTAssertEqual(OpenFlashGuard.turn(busy: true, waited: 0.5), .wait, "second-S3: the next shot would hold the first's window")
        XCTAssertEqual(OpenFlashGuard.turn(busy: true, waited: OpenFlashGuard.waitForTurn), .unguarded)
    }

    func testTheAppAndTheProbeNameTheSameDomainAndCoverLevel() throws {
        XCTAssertEqual(OpenFlashGuard.defaultsDomain, "com.baney.polycarp", "second-S2: the app's own bundle id")
        let w = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        XCTAssertTrue(w.contains("UserDefaults(suiteName: OpenFlashGuard.defaultsDomain)"), "second-S2: read from that domain")
        let probe = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("scripts/agent-open-probe.swift"), encoding: .utf8)
        XCTAssertTrue(probe.contains("UserDefaults(suiteName: \"com.baney.polycarp\")"))
        XCTAssertTrue(probe.contains("let coverLevel = \(OpenFlashGuard.coverLevel)\n"), "second-S1: the probe knows the covers' level")
        XCTAssertTrue(probe.contains("runningApplications(withBundleIdentifier: \"com.baney.polycarp\")"), "second-S1: and their owner by pid, not name")
        XCTAssertTrue(probe.contains("alpha >= 0.999"), "sol-F4: a translucent window hides nothing")
        XCTAssertTrue(w.contains("w.level = NSWindow.Level(rawValue: OpenFlashGuard.coverLevel)"))
    }

    func testTheWatchIsBoundToTheLaunchAndBoundedInTime() throws {
        let c = try CursorSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let open = try XCTUnwrap(HandsSourceTests.between("OpenFlashWatch.around(", "starting a separate copy", in: c))
        XCTAssertTrue(open.contains("{ app, _ in started(app); finished(app) }"), "sol-F1: the watch gets the pid the launch returned, before the claim")
        let newWindow = try XCTUnwrap(HandsSourceTests.between("DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {", "_ = newWindow(app)", in: c))
        XCTAssertTrue(newWindow.contains("Windows.release(app.processIdentifier)"), "first-F2 (r1): New Window can ask the app")
        let w = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        XCTAssertFalse(w.contains("kCGWindowOwnerName"), "never matched by app name")
        let go = try XCTUnwrap(HandsSourceTests.between("let go: ([CGImage]?, String) -> Void = {", "DispatchQueue.main.asyncAfter(deadline: .now() + OpenFlashGuard.captureLimit)", in: w))
        XCTAssertTrue(go.contains("guard !fired else { return }"), "first-F3: the launch runs once")
        XCTAssertTrue(go.contains("guard let shots, l.workspaces == workspaces else {"), "no shot, or a switch during the capture: unguarded")
        XCTAssertFalse(go.contains("Windows.hold"))
        XCTAssertTrue(w.contains("DispatchQueue.main.asyncAfter(deadline: .now() + OpenFlashGuard.captureLimit) { go(nil,"), "first-F3: a capture past 300 ms opens unguarded")
        XCTAssertTrue(w.contains("mode?.pixelWidth"), "captured at backing pixels")
        let drain = try XCTUnwrap(HandsSourceTests.between("private func drain() {", "func finish(why: String) {", in: w))
        XCTAssertTrue(drain.contains("ticket.holds(live:"), "sol-F1: a queued cover is checked before it rises")
        let flush = try XCTUnwrap(drain.range(of: "if redraw() { CATransaction.flush() }"))
        let release = try XCTUnwrap(drain.range(of: "DispatchQueue.main.async { Windows.release(pid) }"))
        XCTAssertLessThan(flush.lowerBound, release.lowerBound, "first-F1: the cover is committed, then the hold ends on a later turn")
        XCTAssertEqual(w.components(separatedBy: "Windows.release(").count - 1, w.components(separatedBy: "DispatchQueue.main.async { Windows.release(pid) }").count - 1,
                       "first-F1: every release waits a turn, never in the same one as the cover")
        let post = try XCTUnwrap(HandsSourceTests.between("private func post(", "private func drain()", in: w))
        XCTAssertTrue(post.contains("let wake = mailbox == nil"), "sol-F1: one pending drain, holding only the newest step")
        let switched = try XCTUnwrap(HandsSourceTests.between("private static func switched() {", "final class Launch", in: w))
        XCTAssertTrue(switched.contains("workspaces &+= 1") && switched.contains("l.finish("), "sol-F2: any switch ends every launch's covers")
        XCTAssertTrue(w.contains("NSWorkspace.activeSpaceDidChangeNotification"), "first-F2: a macOS Space change too")
        let make = try XCTUnwrap(HandsSourceTests.between("private func make() -> NSPanel {", "return w", in: w))
        let host = try XCTUnwrap(make.range(of: "v.layer = layer")), wants = try XCTUnwrap(make.range(of: "v.wantsLayer = true"))
        XCTAssertLessThan(host.lowerBound, wants.lowerBound, "second-S4: layer-hosting, so AppKit never redraws over the shot")
        XCTAssertTrue(w.contains("case .wait: DispatchQueue.main.asyncAfter"), "second-S3: a second open waits its turn")
        let d = try CursorSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(try XCTUnwrap(HandsSourceTests.between("spaces.onChange = {", "\n        }\n", in: d)).contains("OpenFlashWatch.environmentChanged(showing:"),
                      "sol-F2: every switch reaches the covers")
        XCTAssertTrue(d.contains("Windows.onHoldEnd = { [weak self] pid in self?.spaces.askAgain(pid) }"))
        let r = try CursorSourceTests.code("Sources/BaneySpaces/Windows.swift")
        let ask = try XCTUnwrap(HandsSourceTests.between("static func isResponsive(", "static func markUnresponsive", in: r))
        XCTAssertTrue(ask.contains("holds.skips(pid, now: now)"))
        XCTAssertFalse(ask.contains("NSRunningApplication"))
        XCTAssertTrue(w.contains(".nonactivatingPanel"))
        XCTAssertFalse(w.contains(".hide()") || w.contains("app.hide"), "no hide: a hidden app lists no windows (PR 172)")
    }
}
