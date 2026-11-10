import BaneySpacesCore
import CoreGraphics
import XCTest

/// The cover rule (`WindowCover`): when the window server's list says an agent's cursor may be drawn over its window.
final class WindowCoverTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let w = ScreenWindow(id: 10, pid: 100, bounds: CGRect(x: 200, y: 100, width: 800, height: 600))

    func testAWindowInFrontAtThePointCoversItAndOneElsewhereDoesNot() {
        let x = ScreenWindow(id: 20, pid: 200, bounds: CGRect(x: 150, y: 80, width: 300, height: 300))
        let list = [x, w]
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 300, y: 200), windows: list, displays: [screen]), .covered)
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 800, y: 500), windows: list, displays: [screen]), .visible(CursorWindow(id: 10, frame: w.bounds)))
        // Behind the target it covers nothing.
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 300, y: 200), windows: [w, x], displays: [screen]), .visible(CursorWindow(id: 10, frame: w.bounds)))
    }

    func testTheSameAppsOtherWindowInFrontCoversToo() {
        // A sheet can't be told from a second document window, and drawing over a window the agent isn't using is the bug.
        let other = ScreenWindow(id: 11, pid: 100, bounds: CGRect(x: 300, y: 150, width: 200, height: 200))
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 400, y: 250), windows: [other, w], displays: [screen]), .covered)
    }

    func testWindowsOnAHigherLevelOrClearOrOursNeverCover() {
        // The Dock keeps a clear window the size of the display on level 20 at all times (read on macOS 27.2).
        let dock = ScreenWindow(id: 1, pid: 50, layer: 20, bounds: screen)
        let menuBar = ScreenWindow(id: 2, pid: 51, layer: 24, bounds: CGRect(x: 0, y: 0, width: 1512, height: 33))
        let clear = ScreenWindow(id: 3, pid: 52, bounds: screen, alpha: 0)
        let overlay = ScreenWindow(id: 4, pid: 99, bounds: w.bounds)
        let list = [menuBar, dock, clear, overlay, w]
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 600, y: 400), windows: list, ignoring: [4], displays: [screen]), .visible(CursorWindow(id: 10, frame: w.bounds)))
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 600, y: 400), windows: list, displays: [screen]), .covered, "an overlay not named as ours counts")
    }

    func testAWindowThatIsNotListedOrIsParkedIsNotOnScreen() {
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 600, y: 400), windows: [], displays: [screen]), .notOnScreen, "minimized, closed, another Space")
        let parked = ScreenWindow(id: 10, pid: 100, bounds: CGRect(x: 1511, y: 942, width: 800, height: 600).offsetBy(dx: 10, dy: 50))
        XCTAssertNil(WindowCover.place(10, windows: [parked], displays: [screen]), "parked off every display")
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 600, y: 400), windows: [ScreenWindow(id: 10, pid: 100, bounds: w.bounds, alpha: 0)], displays: [screen]), .notOnScreen)
    }

    func testAPointOutsideItsWindowIsNeverDrawn() {
        XCTAssertEqual(WindowCover.check(10, point: CGPoint(x: 1100, y: 400), windows: [w], displays: [screen]), .outsideWindow)
    }

    func testTheOverlayMustSitDirectlyAboveItsWindow() {
        let x = ScreenWindow(id: 20, pid: 200, bounds: w.bounds)
        let o = ScreenWindow(id: 4, pid: 99, bounds: w.bounds)
        XCTAssertTrue(WindowCover.isDirectlyAbove(4, window: 10, windows: [x, o, w]))
        XCTAssertFalse(WindowCover.isDirectlyAbove(4, window: 10, windows: [o, x, w]), "W was raised over it, or X slipped between")
        XCTAssertFalse(WindowCover.isDirectlyAbove(4, window: 10, windows: [x, w]), "not on screen")
        XCTAssertFalse(WindowCover.isDirectlyAbove(nil, window: 10, windows: [x, o, w]))
    }
}

/// The director with a window list: the guard, following the window, and the veil.
final class CursorWindowTests: XCTestCase {
    var clock = 100.0
    let queue = DispatchQueue(label: "cursor-window-tests")
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let lock = NSLock()
    private var _windows: [ScreenWindow] = []
    var windowReads = 0
    var windows: [ScreenWindow] {
        get { lock.lock(); defer { lock.unlock() }; return _windows }
        set { lock.lock(); _windows = newValue; lock.unlock() }
    }
    let w7 = ScreenWindow(id: 7, pid: 1, bounds: CGRect(x: 100, y: 100, width: 600, height: 500))
    let w8 = ScreenWindow(id: 8, pid: 2, bounds: CGRect(x: 760, y: 100, width: 600, height: 500))

    func make(idle: TimeInterval = 60, veilIdle: TimeInterval? = nil, change: (inout CursorEnvironment) -> Void = { _ in }) -> (CursorDirector, FakeSurface) {
        var host = CursorDirector.Host()
        host.now = { [unowned self] in self.clock }
        host.agent = { session in (session == "b" ? "Grok" : "Claude", .working) }
        host.windows = { [unowned self] in self.lock.lock(); self.windowReads += 1; defer { self.lock.unlock() }; return self._windows }
        let s = FakeSurface()
        let d = CursorDirector(surface: s, queue: queue, host: host, idleAfter: idle, veilIdleAfter: veilIdle)
        var env = CursorEnvironment()
        env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
        change(&env)
        d.setEnvironment(env)
        windows = [w7, w8]
        return (d, s)
    }

    func event(at p: CGPoint, window: UInt32 = 7, session: String = "a", scope: String = "agent_workspace", workspace: Int = 9) -> HandsActionEvent {
        HandsActionEvent(kind: "click", ref: "@s1:e1", window: window, pid: 1, app: "TextEdit", point: p,
                         frame: CGRect(x: p.x - 20, y: p.y - 10, width: 40, height: 20), session: session, scope: scope, workspace: workspace)
    }

    func drain() { queue.sync {} }
    func drew(_ s: FakeSurface) -> Bool { s.calls.contains { if case .appear = $0 { return true }; if case .act = $0 { return true }; return false } }

    // MARK: the guard

    /// Fails on the old rule, which only asked whether the workspace was shown: it drew over the window in front.
    func testNothingIsDrawnWhenAnotherWindowCoversThePoint() {
        let (d, s) = make()
        windows = [ScreenWindow(id: 30, pid: 3, bounds: CGRect(x: 50, y: 50, width: 400, height: 400)), w7, w8]
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertFalse(drew(s), "covered: \(s.calls)")
        d.handsWillAct(event(at: CGPoint(x: 600, y: 520))); drain()
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 600, y: 520))), "an uncovered point in the same window draws")
        XCTAssertEqual(s.drawnIn, [7], "in window 7's overlay")
    }

    /// Fails on the old rule: a minimized window (not in the on-screen list) still got the cursor.
    func testNothingIsDrawnForAWindowThatIsNotOnScreen() {
        let (d, s) = make()
        windows = [w8]
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertTrue(s.calls.isEmpty, "\(s.calls)")
        XCTAssertTrue(s.windowCalls.isEmpty, "no veil either: \(s.windowCalls)")
    }

    func testAPointOutsideTheWindowIsNotDrawn() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 730, y: 300))); drain()   // between windows 7 and 8
        XCTAssertFalse(drew(s))
    }

    /// Fails on the old surface, which glided a cursor across the screen between two windows.
    func testBetweenTwoWindowsTheCursorLandsInTheNewOne() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300), window: 7)); drain()
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 1000, y: 300), window: 8)); drain()
        XCTAssertTrue(s.calls.contains(.jump("a", CGPoint(x: 1000, y: 300))), "\(s.calls)")
        XCTAssertFalse(s.calls.contains(.move("a", CGPoint(x: 1000, y: 300))), "no flight across the gap")
        XCTAssertEqual(s.drawnIn.last, 8)
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 1200, y: 500), window: 8)); drain()
        XCTAssertEqual(s.motions.last?.points.first, CGPoint(x: 1000, y: 300), "inside one window it glides as before")
    }

    // MARK: following the window

    func testTheOverlayFollowsAMovedWindowAndTheNextGlideStartsWhereTheCursorWentWithIt() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        let moved = CGRect(x: 140, y: 130, width: 600, height: 500)
        windows = [ScreenWindow(id: 7, pid: 1, bounds: moved), w8]
        d.checkWindows(); drain()
        XCTAssertEqual(s.windowCalls.last, .place(7, moved, true), "\(s.windowCalls)")
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 600, y: 500))); drain()
        XCTAssertEqual(s.motions.last?.points.first, CGPoint(x: 340, y: 330), "it moved with the window")
    }

    func testARaisedWindowGetsItsOverlayBackOnTop() {
        let (d, s) = make()
        s.overlayIDs[7] = 500
        let overlay = ScreenWindow(id: 500, pid: 99, bounds: w7.bounds)
        windows = [overlay, w7, w8]
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 300, y: 300))), "its own overlay never covers it")
        let places = { s.windowCalls.filter { if case .place = $0 { return true }; return false }.count }
        let before = places()
        d.checkWindows(); drain()
        XCTAssertEqual(places(), before, "directly above and unmoved: nothing to do")
        windows = [w7, overlay, w8]   // W was clicked and raised over its overlay
        d.checkWindows(); drain()
        XCTAssertEqual(s.windowCalls.last, .place(7, w7.bounds, true))
    }

    func testAWindowThatLeavesTakesItsCursorAndVeilWithIt() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        windows = [w8]   // minimized
        d.checkWindows(); drain()
        XCTAssertEqual(s.calls.last, .hide("a"))
        XCTAssertTrue(s.windowCalls.contains(.hideVeil(7)))
        XCTAssertEqual(s.windowCalls.last, .gone(7), "the overlay goes at once")
    }

    func testTheFollowCheckRunsOnlyWhileSomethingIsShown() {
        let (d, s) = make(idle: 0.05, veilIdle: 0.4)
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        let deadline = Date().addingTimeInterval(3)
        repeat { Thread.sleep(forTimeInterval: 0.05); drain() } while !s.windowCalls.contains(.hideVeil(7)) && Date() < deadline
        XCTAssertTrue(s.windowCalls.contains(.hideVeil(7)), "the veil went idle")
        Thread.sleep(forTimeInterval: 0.3); drain()
        lock.lock(); let before = windowReads; lock.unlock()
        Thread.sleep(forTimeInterval: 0.5); drain()
        lock.lock(); let after = windowReads; lock.unlock()
        XCTAssertEqual(before, after, "no window list reads once nothing is shown")
        XCTAssertGreaterThan(before, 1, "it did follow while shown")
    }

    // MARK: the veil

    /// Fails on the old director, which had no veil.
    func testTheVeilShowsOnTheFirstActionAndDoesNotFlickerBetweenActions() {
        let (d, s) = make(idle: 0.05, veilIdle: 0.6)
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertEqual(s.windowCalls.first, .showVeil(7, ["Claude"]))
        // The cursor goes idle between actions (as when an agent thinks); the veil stays.
        Thread.sleep(forTimeInterval: 0.25); drain()
        XCTAssertTrue(s.calls.contains(.hide("a")), "the cursor went idle")
        d.handsWillAct(event(at: CGPoint(x: 400, y: 300))); drain()
        Thread.sleep(forTimeInterval: 0.4); drain()
        XCTAssertFalse(s.windowCalls.contains(.hideVeil(7)), "no flicker: \(s.windowCalls)")
        XCTAssertEqual(s.windowCalls.filter { if case .showVeil = $0 { return true }; return false }.count, 1, "shown once")
        let deadline = Date().addingTimeInterval(3)
        repeat { Thread.sleep(forTimeInterval: 0.05); drain() } while !s.windowCalls.contains(.hideVeil(7)) && Date() < deadline
        XCTAssertTrue(s.windowCalls.contains(.hideVeil(7)), "and fades once the agent is idle")
    }

    func testTwoAgentsInTwoWindowsEachGetTheirOwnVeil() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300), window: 7, session: "a")); drain()
        d.handsWillAct(event(at: CGPoint(x: 1000, y: 300), window: 8, session: "b")); drain()
        XCTAssertTrue(s.windowCalls.contains(.showVeil(7, ["Claude"])))
        XCTAssertTrue(s.windowCalls.contains(.showVeil(8, ["Grok"])))
        d.handsWillAct(event(at: CGPoint(x: 350, y: 300), window: 7, session: "b")); drain()
        XCTAssertTrue(s.windowCalls.contains(.showVeil(7, ["Grok", "Claude"])), "two in one window: both named, newest first")
    }

    func testTheVeilShowsOverACoveredPointAndWithTheCursorOff() {
        let (d, s) = make { $0.settings.enabled = false }
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertFalse(drew(s), "the cursor is off")
        XCTAssertEqual(s.windowCalls.first, .showVeil(7, ["Claude"]), "the veil has its own switch")
    }

    func testTheVeilFollowsItsSwitchAndTheWorkspaceRule() {
        let (d, s) = make { $0.settings.veil = false }
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertTrue(s.windowCalls.isEmpty, "off: \(s.windowCalls)")
        XCTAssertTrue(drew(s), "the cursor still draws")
        let (d2, s2) = make()
        d2.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        var env = CursorEnvironment(); env.current = 2; env.agentWorkspace = 9; env.displays = [screen]
        d2.setEnvironment(env); drain()
        XCTAssertEqual(s2.windowCalls.last, .hideVeil(7), "you left the agent workspace")
        let (d3, s3) = make()
        d3.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        var on = CursorEnvironment(); on.current = 9; on.agentWorkspace = 9; on.displays = [screen]; on.settings.veil = false
        d3.setEnvironment(on); drain()
        XCTAssertTrue(s3.windowCalls.contains(.hideVeil(7)), "turned off in Settings")
    }

    func testReduceMotionAndReduceTransparencyReachTheVeil() {
        let (d, s) = make { $0.reduceMotion = true; $0.reduceTransparency = true }
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertEqual(s.veilLooks.last?.still, true)
        XCTAssertEqual(s.veilLooks.last?.solid, true)
        XCTAssertEqual(s.veilLooks.last?.agents.first?.label, "Claude · working")
    }
}
