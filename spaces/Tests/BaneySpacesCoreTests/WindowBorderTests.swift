import XCTest
@testable import BaneySpacesCore

/// T5: themed window borders. The style comes from the look in force, only ordinary windows on a display get one, the
/// border follows every display frame while a window moves, and the switch is off until the person turns it on.
final class WindowBorderTests: XCTestCase {
    private func polycarp(_ fixture: String) throws -> Look {
        try PolycarpTheme.parse(Data(fixture.utf8)).get().look(systemDark: true)
    }

    // MARK: Style

    func testAPolycarpThemeGivesItsAccentBorderColorWidthAndLargeRadius() throws {
        let look = try polycarp(PolycarpFixtures.still_water)
        let s = WindowBorderStyle(look)
        XCTAssertEqual(s.focused, look.color("accent"))
        XCTAssertEqual(s.unfocused, look.color("border"))
        XCTAssertEqual(s.width, 1.5, "border_width 1, focused 1.5 times")
        XCTAssertEqual(s.radius, 16, "radius_large, the dock bar's")
        let blocks = WindowBorderStyle(try polycarp(PolycarpFixtures.blocks))
        XCTAssertEqual(blocks.width, 3)
        XCTAssertEqual(blocks.radius, 0, "a square theme draws square borders")
    }

    func testALookWithNoBorderWidthGetsTheDefaultAndWidthsStayInRange() {
        let look = AppearanceSettings().look(systemAccent: RGB(hex: "#3366ff")!)
        let s = WindowBorderStyle(look)
        if look.spec.border.focusedWidth == 0 && look.spec.border.width == 0 {
            XCTAssertEqual(s.width, WindowBorderStyle.defaultWidth)
        }
        XCTAssertTrue(WindowBorderStyle.widthRange.contains(s.width))
        XCTAssertGreaterThanOrEqual(s.radius, 0)
    }

    func testTheBorderIsDrawnWhollyOutsideTheWindow() {
        let s = WindowBorderStyle(focused: RGB(r: 1, g: 0, b: 0), unfocused: RGB(r: 0, g: 0, b: 1), width: 4, radius: 10)
        let window = CGRect(x: 100, y: 200, width: 640, height: 480)
        let panel = s.panelFrame(window)
        XCTAssertEqual(panel, CGRect(x: 96, y: 196, width: 648, height: 488))
        let stroke = s.stroke(in: panel.size)
        // The stroke's inner edge is the window's edge: centre line half a width out.
        XCTAssertEqual(stroke.rect, CGRect(x: 2, y: 2, width: 644, height: 484))
        XCTAssertEqual(stroke.radius, 12, "the window's own corner plus half the width, so the curves stay parallel")
        XCTAssertEqual(WindowBorderStyle(focused: s.focused, unfocused: s.unfocused, width: 4, radius: 0).stroke(in: panel.size).radius, 0)
    }

    // MARK: Which windows

    private let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    private let me: Int32 = 99

    func testOnlyOrdinaryWindowsOnADisplayGetABorder() {
        let ok = BorderCandidate(id: 1, pid: 10, frame: CGRect(x: 40, y: 60, width: 800, height: 600))
        XCTAssertTrue(WindowBorderPlan.eligible(ok, selfPID: me, screens: [screen]))
        var w = ok; w.layer = 3
        XCTAssertFalse(WindowBorderPlan.eligible(w, selfPID: me, screens: [screen]), "a floating panel or menu")
        w = ok; w.alpha = 0
        XCTAssertFalse(WindowBorderPlan.eligible(w, selfPID: me, screens: [screen]), "a recorder's clear overlay")
        w = ok; w.pid = me
        XCTAssertFalse(WindowBorderPlan.eligible(w, selfPID: me, screens: [screen]), "Polycarp's own panels")
        w = ok; w.frame.size = CGSize(width: 30, height: 600)
        XCTAssertFalse(WindowBorderPlan.eligible(w, selfPID: me, screens: [screen]), "a sliver")
        w = ok; w.frame = screen
        XCTAssertFalse(WindowBorderPlan.eligible(w, selfPID: me, screens: [screen]), "a full-screen window")
        w = ok; w.frame.origin = CGPoint(x: 1490, y: 970)
        XCTAssertFalse(WindowBorderPlan.eligible(w, selfPID: me, screens: [screen]), "parked in the corner, almost all off the display")
        w = ok; w.frame.origin = CGPoint(x: -6000, y: 200)
        XCTAssertFalse(WindowBorderPlan.eligible(w, selfPID: me, screens: [screen]), "off every display")
    }

    func testTheFocusedBorderGoesOnTheFrontWindowOfTheAppInFront() {
        let list = [
            BorderCandidate(id: 5, pid: 20, frame: CGRect(x: 0, y: 0, width: 300, height: 30), layer: 25),  // its menu
            BorderCandidate(id: 6, pid: 30, frame: CGRect(x: 10, y: 10, width: 400, height: 300)),           // another app above
            BorderCandidate(id: 7, pid: 20, frame: CGRect(x: 50, y: 50, width: 700, height: 500)),
            BorderCandidate(id: 8, pid: 20, frame: CGRect(x: 90, y: 90, width: 700, height: 500)),
        ]
        let t = WindowBorderPlan.targets(list, frontPID: 20, selfPID: me, screens: [screen], others: false)
        XCTAssertEqual(t.focused, 7)
        XCTAssertEqual(t.others, [], "other windows only with the second switch")
        let all = WindowBorderPlan.targets(list, frontPID: 20, selfPID: me, screens: [screen], others: true)
        XCTAssertEqual(all.focused, 7)
        XCTAssertEqual(all.others, [6, 8], "front first, the menu left out")
        XCTAssertNil(WindowBorderPlan.targets(list, frontPID: 40, selfPID: me, screens: [screen], others: false).focused,
                     "an app with no window on screen (Finder on an empty desktop) has nothing to border")
    }

    func testNoMoreThanTheLimitAreDrawn() {
        let list = (0..<100).map { BorderCandidate(id: UInt32($0), pid: Int32($0), frame: CGRect(x: 20, y: 20, width: 400, height: 300)) }
        let t = WindowBorderPlan.targets(list, frontPID: 0, selfPID: me, screens: [screen], others: true)
        XCTAssertEqual(t.focused, 0)
        XCTAssertEqual(t.others.count + 1, WindowBorderPlan.limit)
    }

    // MARK: Following

    func testABorderFollowsEveryFrameWhileAButtonIsDownOrRightAfterAMove() {
        var pace = BorderPace()
        XCTAssertFalse(pace.look(moved: false, buttonDown: false, now: 10), "still: idle looks only")
        XCTAssertTrue(pace.look(moved: false, buttonDown: true, now: 10.1), "a press: a drag may start")
        XCTAssertTrue(pace.look(moved: true, buttonDown: false, now: 10.2), "a keyboard move or a resize")
        XCTAssertTrue(pace.look(moved: false, buttonDown: false, now: 10.2 + BorderPace.settle - 0.01))
        XCTAssertFalse(pace.look(moved: false, buttonDown: false, now: 10.2 + BorderPace.settle + 0.01), "settled")
    }

    func testLagIsFromTheWindowMovingToItsBorderMovingAndASkippedPlaceCountsUntilCaughtUp() {
        typealias M = BorderLag.Move
        let window = [M(t: 0.000, at: CGPoint(x: 0, y: 0)), M(t: 0.008, at: CGPoint(x: 4, y: 0)),
                      M(t: 0.016, at: CGPoint(x: 8, y: 0)), M(t: 0.024, at: CGPoint(x: 12, y: 0)),
                      M(t: 0.032, at: CGPoint(x: 0, y: 0))]   // back where it started: matched to this move, not the first
        let border = [M(t: 0.002, at: CGPoint(x: 0, y: 0)),
                      M(t: 0.009, at: CGPoint(x: 4, y: 0)),
                      M(t: 0.027, at: CGPoint(x: 12, y: 0))]   // skipped 8: caught up 11 ms after it, 3 ms after 12
        let lags = BorderLag.lags(window: window, border: border, end: 0.040).map { ($0 * 1000).rounded() }
        XCTAssertEqual(lags, [2, 1, 11, 3, 8], "the last place never reached counts until the end")
    }

    // MARK: Off until turned on

    func testBordersAreOffByDefaultAndAnOlderSavedBlobKeepsThemOff() throws {
        XCTAssertFalse(AppearanceSettings().windowBorders)
        XCTAssertFalse(AppearanceSettings().otherWindowBorders)
        let old = try JSONDecoder().decode(AppearanceSettings.self, from: Data("{}".utf8))
        XCTAssertFalse(old.windowBorders)
        var on = AppearanceSettings()
        on.windowBorders = true; on.otherWindowBorders = true
        let back = try JSONDecoder().decode(AppearanceSettings.self, from: JSONEncoder().encode(on))
        XCTAssertTrue(back.windowBorders && back.otherWindowBorders)
    }
}
