import AppKit
import BaneySpacesCore
import XCTest
@testable import BaneySpacesCursor

/// The overlay's real layers. The panels are built but never put on screen (`ordersFront: false`), so nothing flashes
/// on the machine running the tests.
final class OverlayTests: XCTestCase {
    let first = CursorDisplaySpec(globalFrame: CGRect(x: 0, y: 0, width: 1000, height: 700), panelFrame: CGRect(x: 40000, y: 0, width: 1000, height: 700), scale: 2)
    let second = CursorDisplaySpec(globalFrame: CGRect(x: 1000, y: 0, width: 800, height: 600), panelFrame: CGRect(x: 42000, y: 0, width: 800, height: 600), scale: 2)
    let look = CursorLook(name: "Claude", status: .working, identity: CursorPalette.identityColor(for: "a"), theme: .standard)
    /// A window on each display.
    let w1 = CursorWindow(id: 71, frame: CGRect(x: 20, y: 20, width: 900, height: 600))
    let w2 = CursorWindow(id: 72, frame: CGRect(x: 1100, y: 50, width: 600, height: 500))

    override func setUp() {
        _ = NSApplication.shared
    }

    func surface() -> OverlaySurface { OverlaySurface(displays: [first, second], ordersFront: false, primaryTop: { 700 }) }

    func testAMarkIsInsideItsContainerAfterTheFirstAttach() {
        let s = surface()
        s.configure("a", look: look)
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        XCTAssertTrue(s.marksAreAttached("a"), "the last-3 marks have somewhere to show")
        s.act("a", effect: .click, point: CGPoint(x: 100, y: 100), frame: CGRect(x: 80, y: 90, width: 40, height: 20), delay: 0)
        XCTAssertTrue(s.marksAreAttached("a"))
    }

    func testMovingToAnotherWindowLandsThereAndKeepsTheMarks() {
        let s = surface()
        s.configure("a", look: look)
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        let plan = GlidePlan(from: GlideState(position: CGPoint(x: 100, y: 100)), target: CGPoint(x: 1400, y: 300), spring: .polycarp)
        s.move("a", motion: CursorMotion(plan: plan, start: ProcessInfo.processInfo.systemUptime), in: w2)
        XCTAssertEqual(s.window(of: "a"), 72, "drawn in the new window's overlay")
        XCTAssertFalse(s.isGliding("a"), "it lands instead of flying across the screen")
        XCTAssertTrue(s.isShown("a"))
        XCTAssertTrue(s.marksAreAttached("a"), "marks survive the move to the other window")
        s.act("a", effect: .type, point: CGPoint(x: 1400, y: 300), frame: CGRect(x: 1380, y: 290, width: 40, height: 20), delay: 0)
        XCTAssertTrue(s.marksAreAttached("a"))
    }

    func testACursorSurvivesAChangeOfDisplays() {
        let s = surface()
        s.configure("a", look: look)
        s.configure("b", look: CursorLook(name: "Grok", status: .asking, identity: .init(r: 1, g: 0, b: 0), theme: .omarchy))
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        s.appear("b", at: CGPoint(x: 1400, y: 300), in: w2)
        s.setDisplays([second, first])   // plugged in a different order, same places
        XCTAssertEqual(s.cursorCount, 2, "the overlay keeps its cursors")
        XCTAssertTrue(s.isShown("a") && s.isShown("b"), "and they stay where they stood")
        XCTAssertTrue(s.marksAreAttached("a") && s.marksAreAttached("b"))
        s.setDisplays([first])   // one display unplugged: "b" stood on it
        XCTAssertEqual(s.cursorCount, 2)
        XCTAssertTrue(s.isShown("a"))
        XCTAssertFalse(s.isShown("b"), "a cursor on a display that is gone is hidden")
        s.appear("b", at: CGPoint(x: 200, y: 200), in: w1)
        XCTAssertTrue(s.isShown("b"), "and can be drawn again by its next action")
        XCTAssertTrue(s.marksAreAttached("b"))
    }

    func testRemovingACursorTakesItsLayersOff() {
        let s = surface()
        s.configure("a", look: look)
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        XCTAssertGreaterThan(s.stageLayerCount(71), 0)
        s.remove("a")
        XCTAssertEqual(s.cursorCount, 0)
        XCTAssertEqual(s.stageLayerCount(71), 0)
    }

    func testThePanelsCanNeverBecomeKeyOrMainAndIgnoreTheMouse() {
        let s = surface()
        s.configure("a", look: look)
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        s.showVeil(w2, look: VeilLook(agents: [VeilLook.Agent(look)]))
        XCTAssertEqual(s.panels.count, 2, "one overlay per window")
        for p in s.panels {
            XCTAssertFalse(p.canBecomeKey)
            XCTAssertFalse(p.canBecomeMain)
            XCTAssertTrue(p.ignoresMouseEvents, "click-through: Donovan's clicks and keys reach the window")
            XCTAssertFalse(p.isKeyWindow)
            XCTAssertEqual(p.sharingType, .none)
            XCTAssertTrue(p.styleMask.contains(.nonactivatingPanel))
        }
    }

    /// Fails on the old panel: one per display, the display's size, on the status bar level, joined to every Space.
    func testAnOverlayIsItsWindowsFrameAndLevelOnOneSpaceAndClipsToIt() {
        let s = surface()
        s.configure("a", look: look)
        let floating = CursorWindow(id: 73, frame: CGRect(x: 300, y: 100, width: 400, height: 300), layer: 3)
        s.appear("a", at: CGPoint(x: 400, y: 200), in: floating)
        let p = try! XCTUnwrap(s.panel(for: 73))
        XCTAssertEqual(p.frame, CGRect(x: 300, y: 700 - 400, width: 400, height: 300), "the window's frame in AppKit's coordinates")
        XCTAssertEqual(p.level.rawValue, 3, "the window's own level, so it can sit directly above it")
        XCTAssertFalse(p.collectionBehavior.contains(.canJoinAllSpaces), "the window's Space only")
        XCTAssertTrue(s.clipsToWindow(73), "a cursor never draws outside its window")
        // The window moves and resizes from the bottom-right: the panel follows, and the cursor stays put in the window.
        s.place(CursorWindow(id: 73, frame: CGRect(x: 340, y: 130, width: 500, height: 380), layer: 3), reorder: false)
        XCTAssertEqual(p.frame, CGRect(x: 340, y: 700 - 510, width: 500, height: 380))
        s.jump("a", to: CGPoint(x: 440, y: 230), in: CursorWindow(id: 73, frame: CGRect(x: 340, y: 130, width: 500, height: 380), layer: 3))
        XCTAssertEqual(s.pointInPanel("a"), CGPoint(x: 100, y: 380 - 100), "100 pt in from the left, 100 pt down from the top of the window")
    }

    func testAGlideIsOneKeyframeAnimationEndingOnTheTarget() {
        let s = surface()
        s.configure("a", look: look)
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        let plan = GlidePlan(from: GlideState(position: CGPoint(x: 100, y: 100)), target: CGPoint(x: 600, y: 400), spring: .baneyspaces)
        s.move("a", motion: CursorMotion(plan: plan, start: ProcessInfo.processInfo.systemUptime), in: w1)
        XCTAssertTrue(s.isGliding("a"), "one animation on the cursor layer, run by the compositor")
    }

    func testSwitchingToStillCancelsScaleRippleAndSquish() {
        let s = surface()
        s.configure("a", look: CursorLook(name: "Claude", status: .working, identity: look.identity, theme: .standard, still: false))
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        s.act("a", effect: .click, point: CGPoint(x: 100, y: 100), frame: CGRect(x: 80, y: 90, width: 40, height: 20), delay: 0.05)
        XCTAssertFalse(s.motionAnimationKeys("a").isEmpty, "a click under motion schedules scale/ripple/squish")
        s.configure("a", look: CursorLook(name: "Claude", status: .working, identity: look.identity, theme: .standard, still: true))
        XCTAssertEqual(s.motionAnimationKeys("a"), [], "applying a still look cancels in-flight motion animations")
    }

    func testWithMotionOffNothingScalesGrowsOrSquishes() {
        func scheduled(still: Bool) -> [String] {
            let s = surface()
            s.configure("a", look: CursorLook(name: "Claude", status: .working, identity: look.identity, theme: .standard, still: still))
            s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
            s.act("a", effect: .click, point: CGPoint(x: 100, y: 100), frame: CGRect(x: 80, y: 90, width: 40, height: 20), delay: 0.1)
            s.act("a", effect: .scroll(dx: 0, dy: 1), point: CGPoint(x: 300, y: 300), frame: CGRect(x: 280, y: 290, width: 40, height: 20), delay: 0)
            return s.motionAnimationKeys("a")
        }
        XCTAssertFalse(scheduled(still: false).isEmpty, "the default theme pops, squishes, grows a ripple and draws a trail")
        XCTAssertEqual(scheduled(still: true), [], "with motion off only fades run")
    }

    func testAMarkOutsideTheCaptureDrawsNothing() throws {
        let space = CGColorSpace(name: CGColorSpace.displayP3)!
        let ctx = CGContext(data: nil, width: 200, height: 100, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)!
        let image = try XCTUnwrap(ctx.makeImage())
        let mark = CursorMark(look: look, point: CGPoint(x: 5000, y: 5000), windowFrame: CGRect(x: 0, y: 0, width: 100, height: 50), at: 0)
        XCTAssertNil(ShotComposite.draw(mark, onto: image, windowFrame: CGRect(x: 0, y: 0, width: 100, height: 50), scale: 2))
        let inside = CursorMark(look: look, point: CGPoint(x: 40, y: 20), windowFrame: CGRect(x: 0, y: 0, width: 100, height: 50), at: 0)
        let drawn = try XCTUnwrap(ShotComposite.draw(inside, onto: image, windowFrame: CGRect(x: 0, y: 0, width: 100, height: 50), scale: 2))
        XCTAssertEqual(drawn.width, 200)
        XCTAssertEqual(drawn.colorSpace?.name, image.colorSpace?.name, "the capture keeps its color space")
        XCTAssertEqual(drawn.bitmapInfo, image.bitmapInfo)
    }

    // MARK: the veil

    func agent(_ name: String, _ status: DockAgent.State = .working, _ key: String = "a") -> VeilLook.Agent {
        VeilLook.Agent(name: name, status: status, identity: CursorPalette.identityColor(for: key))
    }

    func testTheVeilTravelsUnlessMotionIsOffAndDropsItsScrimForReduceTransparency() {
        let s = surface()
        s.showVeil(w1, look: VeilLook(agents: [agent("Claude")]))
        XCTAssertTrue(s.veilShown(71))
        XCTAssertTrue(s.veilMotionKeys(71).contains(VeilLayer.travelKey), "the light travels around the edge")
        XCTAssertTrue(s.veilScrimShown(71))
        s.showVeil(w1, look: VeilLook(agents: [agent("Claude")], still: true, solid: true))
        XCTAssertEqual(s.veilMotionKeys(71), [], "Reduce Motion: a still edge, nothing travels or pulses")
        XCTAssertFalse(s.veilScrimShown(71), "Reduce Transparency: no scrim")
        s.hideVeil(71)
        XCTAssertFalse(s.veilShown(71))
    }

    func testEachAgentInAWindowGetsAPillAndTwoWindowsGetTheirOwnVeils() {
        let s = surface()
        s.showVeil(w1, look: VeilLook(agents: [agent("Claude"), agent("Grok", .asking, "b")]))
        s.showVeil(w2, look: VeilLook(agents: [agent("Codex", .working, "c")]))
        XCTAssertEqual(s.veilPillCount(71), 2)
        XCTAssertEqual(s.veilPillCount(72), 1)
        XCTAssertTrue(s.veilShown(71) && s.veilShown(72))
        s.showVeil(w1, look: VeilLook(agents: (0..<5).map { agent("A\($0)", .working, "\($0)") }))
        XCTAssertEqual(s.veilPillCount(71), VeilLook.maxPills + 1, "three named, the rest counted")
        XCTAssertEqual(agent("Claude").label, "Claude · working")
        XCTAssertEqual(agent("Grok", .asking).label, "Grok · needs you")
    }

    func testTheEdgePathGoesAroundTheWindowFromTheTopCenter() {
        let size = CGSize(width: 800, height: 500)
        let path = VeilLayer.edge(size, inset: 1.5)
        XCTAssertEqual(path.currentPoint.x, 400, accuracy: 0.01)
        XCTAssertEqual(path.currentPoint.y, 500 - 1.5, accuracy: 0.01)
        let box = path.boundingBoxOfPath
        XCTAssertEqual(box.minX, 1.5, accuracy: 0.01); XCTAssertEqual(box.maxX, 798.5, accuracy: 0.01)
        let lap = VeilLayer.perimeter(size, inset: 1.5)
        XCTAssertLessThan(lap, 2 * (797 + 497))
        XCTAssertGreaterThan(lap, 2 * (797 + 497) - 8 * VeilLayer.corner)
    }

    func testAWindowThatLeavesTakesItsOverlayAway() {
        let s = surface()
        s.configure("a", look: look)
        s.appear("a", at: CGPoint(x: 100, y: 100), in: w1)
        s.showVeil(w1, look: VeilLook(agents: [agent("Claude")]))
        s.hide("a")
        s.windowGone(71)
        XCTAssertNil(s.panel(for: 71), "the overlay is let go")
        s.appear("a", at: CGPoint(x: 200, y: 200), in: w1)
        XCTAssertTrue(s.isShown("a"), "and made again for the next action")
    }
}
