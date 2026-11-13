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
        XCTAssertEqual(s.covers, [:]); XCTAssertTrue(s.changed, "its cover comes down")
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

    func testOverlappingLaunchesHoldAndReleaseOnlyTheirOwn() {
        var h = OpenFlashGuard.Holds()
        h.hold(900, at: 0); h.hold(950, at: 0)
        _ = h.release(900)
        XCTAssertFalse(h.skips(900, now: 1))
        XCTAssertTrue(h.skips(950, now: 1), "sol-F2, first-F3: the first launch's release leaves the second's hold")
        XCTAssertFalse(h.skips(951, now: 1), "a process with no hold is asked as before")
    }

    func testAnAskSkippedByTheHoldIsAskedAgainWhenItEnds() {
        var h = OpenFlashGuard.Holds()
        h.hold(900, at: 0); h.hold(950, at: 0)
        XCTAssertTrue(h.skips(900, now: 1))
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

    // Review of PR 213: the watch and the hold follow the launch's claim, and each new ordinary window gets a cover
    // until it is parked. These each fail on 909894c7.
    let parked = CGRect(x: 1511, y: 981, width: 500, height: 400)

    // Review of PR 232: each of these fails on 971826bf.
    func testALaunchWithNoCoverUpByThreeSecondsIsAskedForNewWindow() {
        var h = OpenFlashGuard.Holds()
        h.hold(900, at: 10)
        XCTAssertTrue(h.skips(900, now: 11), "no window yet: a scan is skipped")
        XCTAssertFalse(OpenFlashGuard.newWindowWaits(held: h.holds(900, now: 13), waited: 3))
        XCTAssertFalse(h.skips(900, now: 13), "first-F1, sol-F1: at 3 s New Window's ask reaches the app")
        XCTAssertEqual(h.lapse(now: 13), [900], "and the scan it skipped runs again")
        XCTAssertEqual(h.lapse(now: 14), [])
        h.hold(950, at: 10)
        _ = h.covered(950, true); _ = h.covered(950, false)
        XCTAssertTrue(h.skips(950, now: 14), "a launch that had a cover keeps its hold for later windows")
        XCTAssertEqual(h.lapse(now: 14), [])
    }

    func testACoverReportALaterDrainOvertookLetsNoAskThrough() {
        var h = OpenFlashGuard.Holds(), r = OpenFlashGuard.CoverReports()
        h.hold(900, at: 0)
        XCTAssertTrue(h.skips(900, now: 0.2))
        var main: [() -> Void] = [], painted = false, uncovered = false
        func drain(_ cover: Bool) {
            painted = cover
            if let count = r.change(to: cover) { main.append { if r.current(count), h.covered(900, cover), !painted { uncovered = true } } }
        }
        func runMain() { let q = main; main = []; q.forEach { $0() } }
        drain(true); drain(false)   // sol-F2: a drain queued ahead takes the cover down before the report runs
        runMain()
        XCTAssertFalse(uncovered, "no ask is let through with nothing painted")
        XCTAssertTrue(h.skips(900, now: 0.3), "nothing is up, so the hold goes on")
        drain(true); r.end(); painted = false   // the watch ends before the report runs
        runMain()
        XCTAssertFalse(uncovered)
    }

    func testNewWindowClaimsOnlyOnceThereIsACommandToPress() throws {
        let c = try CursorSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let nw = try XCTUnwrap(HandsSourceTests.between("func newWindow(_ app: NSRunningApplication) -> Bool {", "func claimLaunch(", in: c))
        let item = try XCTUnwrap(nw.range(of: "Windows.newWindowItem(")), claim = try XCTUnwrap(nw.range(of: "h.claim("))
        XCTAssertLessThan(item.lowerBound, claim.lowerBound, "sol-F1: a lookup that finds no command leaves the launch's claim")
    }

    // Review of PR 225: each of these fails on cf29bd93.
    func testTheHoldEndsOnlyOnACoverMainPainted() {
        var h = OpenFlashGuard.Holds()
        h.hold(900, at: 0)
        XCTAssertTrue(h.skips(900, now: 1))
        XCTAssertFalse(h.covered(900, false), "sol-F1: a window seen, then gone before the drain: nothing painted")
        XCTAssertTrue(h.skips(900, now: 1), "sol-F1: so the hold goes on")
        XCTAssertTrue(h.covered(900, true), "painted after a skip: Spaces asks now, to park it")
        XCTAssertFalse(h.skips(900, now: 1), "while a cover is up the park may ask")
        XCTAssertFalse(h.covered(900, false))
        XCTAssertTrue(h.skips(900, now: 1), "first-F2: parked, the watch live: no ask blocks main before a later window's cover")
        XCTAssertTrue(h.holds(900, now: 1))
        XCTAssertTrue(h.release(900), "first-F2: the skipped ask runs when the watch ends")
        XCTAssertFalse(h.skips(900, now: 1))
        XCTAssertFalse(h.covered(900, true), "after the watch, a late paint changes nothing")
    }

    func testTwoOpensOneSecondApartAreBothGuarded() {
        var a = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertTrue(OpenFlashGuard.slotBusy([nil]), "first-F1: capturing or starting holds the slot")
        XCTAssertFalse(OpenFlashGuard.slotBusy([a.tick(now: 0.1, windows: [], incarnation: 77)]), "no window yet: nothing to cover")
        XCTAssertTrue(OpenFlashGuard.slotBusy([a.tick(now: 0.5, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)]), "a cover up")
        let parked = a.tick(now: 0.8, windows: [S(pid: 900, id: 6, layer: 0, bounds: self.parked)], incarnation: 77)
        XCTAssertFalse(parked.end, "the watch goes on for a later window")
        XCTAssertEqual(OpenFlashGuard.turn(busy: OpenFlashGuard.slotBusy([parked]), waited: 0), .go, "first-F1: the open at 1 s is guarded")
        var c = OpenFlashGuard.Plan(pid: 901, incarnation: 78, screens: screen)
        let covering = c.tick(now: 0.9, windows: [S(pid: 901, id: 9, layer: 0, bounds: w)], incarnation: 78)
        XCTAssertEqual(OpenFlashGuard.turn(busy: OpenFlashGuard.slotBusy([parked, covering]), waited: 0.1), .wait)
        let done = c.tick(now: 1.4, windows: [S(pid: 901, id: 9, layer: 0, bounds: self.parked)], incarnation: 78)
        XCTAssertEqual(OpenFlashGuard.turn(busy: OpenFlashGuard.slotBusy([parked, done]), waited: 0.5), .go, "parked: the next one goes, guarded")
    }

    func testNoCoverIsPaintedFromAShotOlderThanItsLife() throws {
        XCTAssertTrue(OpenFlashGuard.shotFresh(age: 1.4))
        XCTAssertTrue(OpenFlashGuard.shotFresh(age: OpenFlashGuard.shotLife))
        XCTAssertFalse(OpenFlashGuard.shotFresh(age: 1.51), "second-S1: what it shows may have changed")
        let wch = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        let drain = try XCTUnwrap(HandsSourceTests.between("private func drain() {", "func finish(why: String) {", in: wch))
        let gate = try XCTUnwrap(drain.range(of: "if !OpenFlashGuard.shotFresh(age: age)")), paint = try XCTUnwrap(drain.range(of: "if redraw()"))
        XCTAssertLessThan(gate.lowerBound, paint.lowerBound, "second-S1: checked before any paint")
        XCTAssertTrue(drain.contains("\"unguarded: stale shot"))
        XCTAssertTrue(wch.contains("l.shotAt = ProcessInfo.processInfo.systemUptime\n            var fired = false"), "timed from before the capture")
    }

    func testAClearWindowGetsNoCover() {
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 0, alpha: 0, bounds: w, screens: screen), "sol-F2")
        XCTAssertFalse(OpenFlashGuard.needsGuard(layer: 0, alpha: 0.09, bounds: w, screens: screen))
        XCTAssertTrue(OpenFlashGuard.needsGuard(layer: 0, alpha: 0.1, bounds: w, screens: screen))
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        let clear = S(pid: 900, id: 7, layer: 0, alpha: 0, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982))
        let s = p.tick(now: 0.2, windows: [clear], incarnation: 77)
        XCTAssertEqual(s.covers, [:], "sol-F2: a clear helper gets no cover")
        XCTAssertTrue(s.idle, "and holds no slot")
        XCTAssertEqual(p.tick(now: 0.5, windows: [clear, S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).covers, [6: w], "the app's window does")
    }

    func testNothingCoveredPollsSlowly() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        let first = p.tick(now: 0.004, windows: [], incarnation: 77)
        XCTAssertTrue(first.idle, "second-S2: no window covered or pending, from the start")
        XCTAssertTrue(first.changed, "the first step reaches main, so the slot is known")
        XCTAssertTrue(p.tick(now: 0.5, windows: [S(pid: 900, id: 8, layer: 3, bounds: w)], incarnation: 77).idle, "second-S2: a helper panel only")
    }

    func testOnlyTheWatchOwnsAHoldAndItsSkippedAsk() throws {
        let c = try CursorSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertFalse(c.contains("Windows.release("), "first-F3: New Window never consumes the skipped ask")
        let wch = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        let post = try XCTUnwrap(HandsSourceTests.between("private func post(", "private func drain()", in: wch))
        XCTAssertFalse(post.contains("release"), "sol-F1: a newer step never carries an older one's release")
        XCTAssertFalse(wch.contains("step.release"))
        XCTAssertTrue(wch.contains("let up = !panels.isEmpty\n            if let count = reports.change(to: up) {"), "sol-F1: the hold follows the panels main drew")
        XCTAssertTrue(wch.contains("alpha: alpha, bounds: b)"), "sol-F2: the window server's alpha reaches the plan")
        XCTAssertTrue(wch.contains("OpenFlashGuard.turn(busy: OpenFlashGuard.slotBusy(live.values.map(\\.step))"), "first-F1")
        let probe = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("scripts/agent-open-probe.swift"), encoding: .utf8)
        XCTAssertTrue(probe.contains("if gapInvalid(sampler.worstGapMs) {"), "sol-F3: a gap over 16 ms makes the run invalid")
        XCTAssertTrue(probe.contains("if failures.isEmpty && invalid.isEmpty && opens > 0 { print(\"agent-open-probe: pass\")"))
    }

    func testAHelperWindowNeverEndsTheWatch() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        let splash = S(pid: 900, id: 7, layer: 0, bounds: CGRect(x: 400, y: 300, width: 30, height: 30))
        for t in stride(from: 0.1, to: OpenFlashGuard.claimFor - 0.1, by: 0.5) {
            let s = p.tick(now: t, windows: [splash, S(pid: 900, id: 8, layer: 3, bounds: w)], incarnation: 77)
            XCTAssertFalse(s.end, "sol-F1: at \(t) s")
            XCTAssertTrue(s.idle, "second-S2 (PR 225): the slow poll, at \(t) s")
        }
        XCTAssertTrue(p.tick(now: OpenFlashGuard.claimFor, windows: [splash], incarnation: 77).end, "the claim ran out")
    }

    func testALaterWindowOfTheLaunchGetsACover() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        XCTAssertEqual(p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).covers, [6: w])
        let atPark = p.tick(now: 0.6, windows: [S(pid: 900, id: 6, layer: 0, bounds: parked)], incarnation: 77)
        XCTAssertEqual(atPark.covers, [:], "parked: its cover comes down")
        XCTAssertFalse(atPark.end, "second-F7, sol-F3: the claim is still on, so another window may come")
        XCTAssertTrue(atPark.idle, "nothing covered: the slower poll")
        XCTAssertFalse(p.tick(now: 1.9, windows: [S(pid: 900, id: 6, layer: 0, bounds: parked)], incarnation: 77).end)
        let second = p.tick(now: 2.0, windows: [S(pid: 900, id: 6, layer: 0, bounds: parked), S(pid: 900, id: 11, layer: 0, bounds: w)], incarnation: 77)
        XCTAssertEqual(second.covers, [11: w], "the main window after a chooser gets its own cover")
        XCTAssertFalse(second.idle)
        _ = p.tick(now: 2.4, windows: [S(pid: 900, id: 11, layer: 0, bounds: parked)], incarnation: 77)
        XCTAssertFalse(p.tick(now: 2.4 + OpenFlashGuard.quietFor - 0.1, windows: [], incarnation: 77).end)
        XCTAssertTrue(p.tick(now: 2.4 + OpenFlashGuard.quietFor, windows: [], incarnation: 77).end, "quiet since the last park")
    }

    func testAClosedWindowLeavesThePendingSet() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        _ = p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        let hidden = p.tick(now: 0.5, windows: [], incarnation: 77)
        XCTAssertTrue(hidden.changed, "off the list: its cover comes down")
        XCTAssertFalse(hidden.idle, "hidden for the park's move for a moment: still pending")
        XCTAssertTrue(p.tick(now: 0.5 + OpenFlashGuard.goneAfter, windows: [], incarnation: 77).idle, "first-F4: away past goneAfter, it closed")
        XCTAssertTrue(p.tick(now: 0.5 + OpenFlashGuard.goneAfter + OpenFlashGuard.quietFor, windows: [], incarnation: 77).end,
                      "first-F4: a closed splash doesn't keep the poll going to the end of the claim")
        var q = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        _ = q.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        _ = q.tick(now: 0.2, windows: [], incarnation: 77)
        XCTAssertFalse(q.tick(now: 0.3, windows: [S(pid: 900, id: 6, layer: 0, bounds: parked)], incarnation: 77).end, "back out of sight within goneAfter: parked")
        XCTAssertTrue(q.tick(now: 0.3, windows: [], incarnation: 77).idle)
    }

    func testAWindowPastItsCoverIsDoneButTheWatchGoesOn() {
        var p = OpenFlashGuard.Plan(pid: 900, incarnation: 77, screens: screen)
        _ = p.tick(now: 0.1, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        let s = p.tick(now: 1.7, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77)
        XCTAssertEqual(s.expired, [6])
        XCTAssertFalse(s.end)
        XCTAssertTrue(p.tick(now: 1.7 + OpenFlashGuard.quietFor, windows: [S(pid: 900, id: 6, layer: 0, bounds: w)], incarnation: 77).end)
    }

    func testTwoDisplaysTradingWorkspacesIsASwitch() {
        let before = OpenFlashGuard.Showing(current: 1, byDisplay: ["A": 1, "B": 2])
        let traded = OpenFlashGuard.Showing(current: 1, byDisplay: ["A": 2, "B": 1])
        XCTAssertNotEqual(before, traded, "sol-F2, second-F8: the same numbers on other displays")
        XCTAssertEqual(Set(before.byDisplay.values), Set(traded.byDisplay.values), "which a set of numbers missed")
        XCTAssertNotEqual(before, OpenFlashGuard.Showing(current: 2, byDisplay: ["A": 1, "B": 2]), "the current one moving counts too")
        XCTAssertTrue(before.contains(2) && !before.contains(9))
    }

    func testTheFlagIsReadFromTheAppsStandardDefaults() throws {
        let d = UserDefaults.standard, key = OpenFlashGuard.defaultsKey, old = d.object(forKey: key)
        defer { d.set(old, forKey: key) }
        d.set("cover", forKey: key)
        XCTAssertEqual(OpenFlashGuard.current(), .cover, "first-F3: the app's own domain is .standard")
        d.removeObject(forKey: key)
        XCTAssertEqual(OpenFlashGuard.current(), .off)
        let plist = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("Resources/Info.plist"), encoding: .utf8)
        XCTAssertTrue(plist.contains("<key>CFBundleIdentifier</key><string>\(OpenFlashGuard.defaultsDomain)</string>"),
                      "so `defaults write com.baney.polycarp` is the domain the running app reads")
        let w = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        XCTAssertFalse(w.contains("UserDefaults(suiteName:"), "first-F3: a suite named after the app's own id is unsupported")
        XCTAssertTrue(w.contains("OpenFlashGuard.current()"))
    }

    func testWorkFromABackgroundQueueRunsOnMain() {
        let done = expectation(description: "ran")
        DispatchQueue.global(qos: .userInitiated).async {
            OpenFlashGuard.onMain {
                XCTAssertTrue(Thread.isMainThread, "first-F1: the guard's state and AppKit stay on main")
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
        var ranNow = false
        OpenFlashGuard.onMain { ranNow = true }
        XCTAssertTrue(ranNow, "already on main: at once")
    }

    func testTheGuardedOpenRunsOnMain() throws {
        let w = try CursorSourceTests.code("Sources/BaneySpaces/Session/OpenFlashWatch.swift")
        let around = try XCTUnwrap(HandsSourceTests.between("static func around(", "private static func guarded(", in: w))
        let flag = try XCTUnwrap(around.range(of: "guard mode == .cover else")), hop = try XCTUnwrap(around.range(of: "OpenFlashGuard.onMain {"))
        XCTAssertLessThan(flag.lowerBound, hop.lowerBound)
        XCTAssertFalse(around.contains("showing()"), "first-F1: Spaces' model is read only after the hop")
        for f in ["private static func guarded(", "private static func waitTurn(", "func started(", "private func drain()", "func finish(why: String)", "static func environmentChanged("] {
            let body = try XCTUnwrap(HandsSourceTests.between(f, "\n        }\n", in: w) ?? HandsSourceTests.between(f, "\n    }\n", in: w), f)
            XCTAssertTrue(body.contains("dispatchPrecondition(condition: .onQueue(.main))"), "first-F1: \(f) is main-only")
        }
        XCTAssertTrue(w.contains("Thread.sleep(forTimeInterval: step.idle ? OpenFlashGuard.idleInterval : OpenFlashGuard.interval)"))
        let d = try CursorSourceTests.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(d.contains("OpenFlashWatch.environmentChanged(showing: self.showing)"), "sol-F2: the display map, not a set")
        XCTAssertTrue(d.contains("byDisplay: spaces.model.shown"))
    }

    func testTheNewWindowStepWaitsForTheCover() throws {
        XCTAssertTrue(OpenFlashGuard.newWindowWaits(held: true, waited: 1.5), "first-F2: the cover isn't up, so the app isn't asked")
        XCTAssertFalse(OpenFlashGuard.newWindowWaits(held: true, waited: OpenFlashGuard.holdFor), "up to the hold's length")
        XCTAssertFalse(OpenFlashGuard.newWindowWaits(held: false, waited: 1.5), "no hold: as before")
        let c = try CursorSourceTests.code("Sources/BaneySpaces/Session/SessionController.swift")
        let check = try XCTUnwrap(HandsSourceTests.between("func newWindowCheck(waited: Double) {", "_ = newWindow(app)", in: c))
        XCTAssertTrue(check.contains("OpenFlashGuard.newWindowWaits(held: Windows.isHeld(pid), waited: waited)"))
    }

    func testAgentsMdNamesOneDomainForTheAppsSettings() throws {
        let a = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("AGENTS.md"), encoding: .utf8)
        XCTAssertFalse(a.contains("com.baney.baneyspaces"), "first-F5, first-F4 (PR 225): the app reads .standard and logs as com.baney.polycarp")
        XCTAssertTrue(a.contains("defaults write com.baney.polycarp crashLoopLimit"))
        XCTAssertTrue(a.contains("com.baney.polycarp agentOpenFlashGuard cover"))
        XCTAssertFalse(a.contains("is the retired app's"))
    }

    func testTheProbeSelftestClassifiesWithItsFixturePid() throws {
        let probe = try String(contentsOf: CursorSourceTests.root.appendingPathComponent("scripts/agent-open-probe.swift"), encoding: .utf8)
        XCTAssertTrue(probe.contains("func seen(_ i: Int, in list: [Seen], displays: [CGRect], cover: pid_t = polycarpPid)"), "sol-F4")
        XCTAssertTrue(probe.contains("$0.hides(cover: cover)"))
        XCTAssertTrue(probe.contains("let owners = polycarpPid > 0 ? [polycarpPid, 4242] : [4242]"), "sol-F4: run with and without Polycarp")
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
        XCTAssertTrue(c.contains("DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { newWindowCheck(waited: 1.5) }"), "first-F2 (r1): New Window can ask the app")
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
        let release = try XCTUnwrap(drain.range(of: "DispatchQueue.main.async { [self] in if reports.current(count) { Windows.covered(pid, up) } }"))
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
        XCTAssertTrue(ask.contains("holds.skips(pid, now:"))
        XCTAssertFalse(ask.contains("NSRunningApplication"))
        XCTAssertTrue(w.contains(".nonactivatingPanel"))
        XCTAssertFalse(w.contains(".hide()") || w.contains("app.hide"), "no hide: a hidden app lists no windows (PR 172)")
    }
}
