import XCTest
@testable import BaneySpacesCore

// The agent cursor (phase 1b): the glide planner, when it is drawn, the director that drives the overlay, the
// overlay's source rules, and the cost to an action.

final class GlidePlannerTests: XCTestCase {
    let spring = GlideSpring.baneyspaces

    func testAGlideStartsAtTheStartAndSettlesOnTheTarget() {
        let plan = GlidePlan(from: GlideState(position: CGPoint(x: 100, y: 100)), target: CGPoint(x: 700, y: 400), spring: spring)
        XCTAssertEqual(plan.state(at: 0).position, CGPoint(x: 100, y: 100))
        XCTAssertEqual(plan.state(at: plan.duration + 0.01).position, CGPoint(x: 700, y: 400))
        XCTAssertEqual(plan.state(at: plan.duration + 0.01).velocity, .zero)
    }

    func testItArrivesInAboutAHundredAndFiftyMilliseconds() {
        for distance in [60.0, 200, 600, 1500, 3000] {
            let plan = GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: distance, y: 0), spring: spring)
            XCTAssertLessThanOrEqual(plan.arrival, 0.2, "arrives within 200 ms over \(distance) pt")
            XCTAssertGreaterThan(plan.arrival, 0.08, "not a teleport over \(distance) pt")
            XCTAssertLessThanOrEqual(plan.duration, 0.35, "settles quickly over \(distance) pt")
        }
    }

    func testItNeverOvershootsVisibly() {
        let plan = GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: 800, y: 0), spring: spring)
        let peak = plan.samples().map(\.position.x).max()!
        XCTAssertLessThan(peak, 800 * 1.02, "under 2% past the target")
    }

    func testTheClosedFormMatchesItsOwnVelocityForEveryKindOfDamping() {
        for damping in [0.5, 0.85, 1.0, 1.6] {
            let plan = GlidePlan(from: GlideState(position: CGPoint(x: 10, y: 20), velocity: CGVector(dx: 300, dy: -120)),
                                 target: CGPoint(x: 500, y: 90), spring: GlideSpring(response: 0.2, damping: damping))
            for t in [0.01, 0.05, 0.1, 0.2] {
                let h = 1e-5
                let a = plan.state(at: t - h).position, b = plan.state(at: t + h).position
                let v = plan.state(at: t).velocity
                XCTAssertEqual(Double(v.dx), Double(b.x - a.x) / (2 * h), accuracy: 0.5, "dx at \(t) damping \(damping)")
                XCTAssertEqual(Double(v.dy), Double(b.y - a.y) / (2 * h), accuracy: 0.5, "dy at \(t) damping \(damping)")
            }
        }
    }

    func testANewTargetMidGlideKeepsPositionAndVelocity() {
        let first = GlidePlan(from: GlideState(position: CGPoint(x: 50, y: 50)), target: CGPoint(x: 900, y: 200), spring: spring)
        for t in [0.02, 0.05, 0.09] {
            let at = first.state(at: t)
            let next = first.retarget(at: t, to: CGPoint(x: 100, y: 700))
            XCTAssertEqual(next.state(at: 0).position, at.position, "no jump at \(t)")
            XCTAssertEqual(next.state(at: 0).velocity, at.velocity, "no restart at \(t)")
            // A moment later it is still where the old motion carried it, then bends: continuity, not a reset.
            let eps = 0.001
            let moved = next.state(at: eps).position
            XCTAssertEqual(Double(moved.x - at.position.x), Double(at.velocity.dx) * eps, accuracy: 3, "first millisecond follows the old velocity")
            XCTAssertEqual(Double(moved.y - at.position.y), Double(at.velocity.dy) * eps, accuracy: 3)
        }
    }

    func testRetargetingToTheSameTargetDoesNotSlowItDown() {
        let a = GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: 800, y: 0), spring: spring)
        let b = a.retarget(at: 0.05, to: CGPoint(x: 800, y: 0))
        XCTAssertLessThanOrEqual(b.duration + 0.05, a.duration + 0.03, "the same spring, from the same state, settles at the same time")
    }

    func testSamplesRunFromZeroToTheSettleTimeAndEndOnTheTarget() {
        let plan = GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: 500, y: 300), spring: spring)
        let s = plan.samples()
        XCTAssertEqual(s.first?.time, 0)
        XCTAssertEqual(s.last?.time ?? -1, plan.duration, accuracy: 1e-9)
        XCTAssertEqual(s.last?.position, CGPoint(x: 500, y: 300))
        XCTAssertTrue(zip(s, s.dropFirst()).allSatisfy { $0.time < $1.time })
        XCTAssertLessThanOrEqual(s.count, 120, "one short keyframe animation")
    }

    func testAnInstantSpringOrAnAlreadyThereCursorHasNothingToAnimate() {
        XCTAssertEqual(GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: 400, y: 0), spring: .instant).duration, 0)
        XCTAssertEqual(GlidePlan(from: GlideState(position: CGPoint(x: 5, y: 5)), target: CGPoint(x: 5, y: 5), spring: spring).duration, 0)
        XCTAssertEqual(GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: 400, y: 0), spring: .instant).samples().count, 1)
    }

    func testNoGlideRunsLongerThanTheConfigLimit() {
        let slow = GlideSpring(response: 0.6, damping: 2.0)
        XCTAssertLessThanOrEqual(GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: 3000, y: 0), spring: slow).duration, 1.0)
    }

    func testTheSlowestAllowedSpringStillSettlesWithoutASnap() {
        for (response, damping) in [(0.6, 2.0), (0.6, 0.3), (0.6, 1.0), (0.04, 2.0), (0.6, 1.6)] {
            let plan = GlidePlan(from: GlideState(position: .zero), target: CGPoint(x: 3000, y: 0), spring: GlideSpring(response: response, damping: damping))
            let s = plan.samples()
            XCTAssertLessThanOrEqual(plan.duration, GlidePlan.maxDuration)
            let lastStep = hypot(s[s.count - 1].position.x - s[s.count - 2].position.x, s[s.count - 1].position.y - s[s.count - 2].position.y)
            XCTAssertLessThan(lastStep, 3, "the last step is a few points, not a snap (response \(response), damping \(damping))")
            let late = plan.state(at: plan.duration - 0.004).position
            XCTAssertLessThan(abs(late.x - 3000), 3, "within 3 pt of the target at the end (response \(response), damping \(damping))")
        }
    }

    func testTheDefaultSpringIsLeftAlone() {
        XCTAssertEqual(GlideSpring.polycarp.clamped, .polycarp)
        XCTAssertEqual(GlideSpring.baneyspaces.clamped, .baneyspaces)
    }

    func testPresetsAndSpeedShapeTheSpring() {
        XCTAssertEqual(GlideSpring.preset("polycarp"), .polycarp)
        XCTAssertEqual(GlideSpring.preset("baneyspaces"), .baneyspaces)
        XCTAssertNil(GlideSpring.preset("nonsense"))
        var s = CursorSettings()
        XCTAssertEqual(s.spring, .polycarp, "the default is the polycarp preset")
        s.speed = 2
        XCTAssertEqual(s.spring.response, GlideSpring.polycarp.response / 2, accuracy: 1e-9)
        s.speed = 0
        XCTAssertTrue(s.spring.isInstant, "speed 0 is off")
        s = CursorSettings(); s.preset = "off"
        XCTAssertTrue(s.spring.isInstant)
        s = CursorSettings(); s.response = 0.3; s.damping = 1
        XCTAssertEqual(s.spring, GlideSpring(response: 0.3, damping: 1), "animation.cursor.glide overrides the preset")
        s.response = 99
        XCTAssertEqual(s.spring.response, GlideSpring.responseRange.upperBound, "clamped")
    }

    func testReduceMotionSkipsTheGlideUnlessTheyChoseOtherwise() {
        var s = CursorSettings()
        XCTAssertTrue(s.skipsGlide(reduceMotion: true))
        XCTAssertFalse(s.skipsGlide(reduceMotion: false))
        s.respectReduceMotion = false
        XCTAssertFalse(s.skipsGlide(reduceMotion: true))
    }
}

final class CursorVisibilityTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = CGRect(x: 100, y: 100, width: 80, height: 24)

    func decide(enabled: Bool = true, scope: String, window: Int?, current: Int, agent: Int? = 9, frame: CGRect = CGRect(x: 100, y: 100, width: 80, height: 24)) -> CursorVisibility.Decision {
        CursorVisibility.decide(enabled: enabled, scope: scope, windowWorkspace: window, shown: [current], agent: agent,
                                frame: frame, displays: [screen])
    }

    func testItShowsOnTheAgentWorkspaceWhenYouLookAtIt() {
        XCTAssertEqual(decide(scope: "agent_workspace", window: 9, current: 9), .show)
    }

    func testItIsHiddenOffTheAgentWorkspace() {
        for current in 1...8 {
            XCTAssertEqual(decide(scope: "agent_workspace", window: 9, current: current), .hidden(.notWatching), "workspace \(current)")
        }
        XCTAssertEqual(decide(scope: "agent_workspace", window: 9, current: 9, agent: nil), .hidden(.notWatching), "no agent workspace")
        XCTAssertEqual(decide(scope: "agent_workspace", window: 4, current: 9), .hidden(.notWatching), "a window that is not on it")
    }

    func testItShowsOverALentWindowWhileItIsOnYourWorkspace() {
        XCTAssertEqual(decide(scope: "lent", window: 3, current: 3), .show)
        XCTAssertEqual(decide(scope: "lent", window: 3, current: 5), .hidden(.notWatching), "a lent window parked on another workspace")
        XCTAssertEqual(decide(scope: "lent", window: nil, current: 3), .hidden(.notWatching))
        // Full Access (PR #167, Codex review): one of Donovan's windows shows the cursor like a lent one.
        XCTAssertEqual(decide(scope: "full_access", window: 3, current: 3), .show)
        XCTAssertEqual(decide(scope: "full_access", window: 3, current: 5), .hidden(.notWatching))
        XCTAssertTrue(CursorVisibility.wantsFrame(enabled: true, scope: "full_access", windowWorkspace: 3, shown: [2, 3], agent: 9))
    }

    func testAnythingElseIsHidden() {
        XCTAssertEqual(decide(scope: "outside_agent_workspace", window: 9, current: 9), .hidden(.notWatching))
        XCTAssertEqual(decide(scope: "", window: 9, current: 9), .hidden(.notWatching))
    }

    func testTurnedOffIsHiddenEverywhere() {
        XCTAssertEqual(decide(enabled: false, scope: "agent_workspace", window: 9, current: 9), .hidden(.disabled))
        XCTAssertEqual(decide(enabled: false, scope: "lent", window: 3, current: 3), .hidden(.disabled))
    }

    func testAFrameThatIsMissingOrOffEveryDisplayIsHidden() {
        XCTAssertEqual(CursorVisibility.decide(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [9], agent: 9, frame: nil, displays: [screen]), .hidden(.noFrame))
        XCTAssertEqual(decide(scope: "agent_workspace", window: 9, current: 9, frame: CGRect(x: 5000, y: 4000, width: 50, height: 20)), .hidden(.offscreen), "a parked window's frame")
    }

    func testTheAgentWorkspaceOnAnyDisplayCountsAsLookedAt() {
        // Two displays: the focused one shows workspace 2, the other shows the agent workspace.
        XCTAssertEqual(CursorVisibility.decide(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [2, 9], agent: 9, frame: frame, displays: [screen]), .show)
        XCTAssertTrue(CursorVisibility.wantsFrame(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [2, 9], agent: 9))
        XCTAssertFalse(CursorVisibility.wantsFrame(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [2, 3], agent: 9))
        // A lent window on the other display's workspace.
        XCTAssertTrue(CursorVisibility.wantsFrame(enabled: true, scope: "lent", windowWorkspace: 3, shown: [2, 3], agent: 9))
        XCTAssertFalse(CursorVisibility.wantsFrame(enabled: true, scope: "lent", windowWorkspace: 5, shown: [2, 3], agent: 9))
    }

    func testTheWindowServersWordHidesItWhenCoveredGoneOrOutside() {
        func d(_ v: WindowCover.Verdict?) -> CursorVisibility.Decision {
            CursorVisibility.decide(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [9], agent: 9, frame: frame, displays: [screen], cover: v)
        }
        XCTAssertEqual(d(nil), .show, "no list: the workspace and display rules alone")
        XCTAssertEqual(d(.visible(CursorWindow(id: 1, frame: screen))), .show)
        XCTAssertEqual(d(.covered), .hidden(.covered))
        XCTAssertEqual(d(.notOnScreen), .hidden(.notOnScreen))
        XCTAssertEqual(d(.outsideWindow), .hidden(.outsideWindow))
        // The workspace rule still comes first: a parked window is not watched, whatever the window server says.
        XCTAssertEqual(CursorVisibility.decide(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [2], agent: 9, frame: frame, displays: [screen],
                                               cover: .visible(CursorWindow(id: 1, frame: screen))), .hidden(.notWatching))
        XCTAssertFalse(CursorVisibility.veilShown(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [2], agent: 9))
        XCTAssertTrue(CursorVisibility.veilShown(enabled: true, scope: "lent", windowWorkspace: 3, shown: [3], agent: 9))
        XCTAssertFalse(CursorVisibility.veilShown(enabled: false, scope: "lent", windowWorkspace: 3, shown: [3], agent: 9))
    }

    func testTheHandsMeasureTheTargetOnlyWhenItWouldBeDrawn() {
        XCTAssertTrue(CursorVisibility.wantsFrame(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [9], agent: 9))
        XCTAssertFalse(CursorVisibility.wantsFrame(enabled: true, scope: "agent_workspace", windowWorkspace: 9, shown: [2], agent: 9), "no engine call while you are elsewhere")
        XCTAssertFalse(CursorVisibility.wantsFrame(enabled: false, scope: "agent_workspace", windowWorkspace: 9, shown: [9], agent: 9))
    }
}

final class CursorThemeTests: XCTestCase {
    func testTheFourThemesShip() {
        XCTAssertEqual(CursorTheme.names, ["default", "pointer", "minimal", "classic", "omarchy"])
        XCTAssertEqual(CursorTheme.named("OMARCHY")?.name, "omarchy")
        XCTAssertNil(CursorTheme.named("lottie"))
    }

    func testMinimalIsASmallDotAndABadge() {
        let t = CursorTheme.minimal
        XCTAssertEqual(t.glyph, .dot)
        XCTAssertLessThanOrEqual(t.size, 12)
        XCTAssertLessThan(t.size, CursorTheme.standard.size / 2)
    }

    func testOmarchyIsBlockyWithASquareMonospaceBadgeAndFadesOnly() {
        let t = CursorTheme.omarchy
        XCTAssertEqual(t.badgeShape, .square)
        XCTAssertEqual(t.badgeRadius, 0)
        XCTAssertTrue(t.badgeMonospaced)
        XCTAssertEqual(t.focusRadius, 0, "square corners everywhere")
        XCTAssertTrue(t.rippleSquare)
        XCTAssertEqual(t.squish, 1, "no scaling")
        XCTAssertEqual(t.appearScale, 1, "fades only")
        XCTAssertEqual(t.shadowOpacity, 0, "no shadow")
    }

    func testClassicIsTheMacArrowInWhiteAndBlack() {
        XCTAssertEqual(CursorTheme.classic.glyph, .classic)
        XCTAssertEqual(CursorTheme.classic.fill, .light)
    }

    func testEveryThemeHasTheFeaturesTheCompetitionHas() {
        for t in CursorTheme.builtIn {
            XCTAssertGreaterThan(t.rippleDuration, 0, t.name)
            XCTAssertEqual(t.markCount, 3, "the last 3 marks stay: \(t.name)")
            XCTAssertGreaterThan(t.focusWidth, 0, "a focus box: \(t.name)")
            XCTAssertLessThanOrEqual(t.rippleDuration, 1.0, "animations stay under 1000 ms: \(t.name)")
        }
        XCTAssertLessThan(CursorTheme.standard.squish, 1, "a squish on press")
    }

    /// The leaf's point is the hot spot, so it must start exactly at the origin, and nothing may lie above or left of it.
    func testTheLeafIsTheDefaultAndItsPointIsTheOrigin() {
        XCTAssertEqual(CursorTheme.standard.glyph, .leaf)
        XCTAssertEqual(CursorSettings().resolvedTheme, .standard)
        XCTAssertEqual(CursorSettings().spring, GlideSpring.polycarp)
        let leaf = CursorGlyphs.path(.leaf, size: 24)
        XCTAssertEqual(leaf.currentPoint.x, 0, accuracy: 1e-9)
        XCTAssertEqual(leaf.currentPoint.y, 0, accuracy: 1e-9)
        let b = leaf.boundingBoxOfPath
        XCTAssertGreaterThanOrEqual(b.minX, -1e-9); XCTAssertGreaterThanOrEqual(b.minY, -1e-9)
        XCTAssertNotNil(CursorGlyphs.vein(.leaf, size: 24))
        for g in [CursorTheme.Glyph.pointer, .classic, .dot, .block] { XCTAssertNil(CursorGlyphs.vein(g, size: 24)) }
    }

    /// A status name sits in white on its color, and the edge keeps the cursor visible on anything.
    func testStatusColorsCarryWhiteTextAndTheNewGlyphsHaveAWhiteEdge() {
        for s in [DockAgent.State.working, .asking, .failed, .done] {
            XCTAssertGreaterThanOrEqual(CursorPalette.status(s).contrastWithWhite, 4.5, "\(s)")
        }
    }

    /// A short hop doesn't lean. A long one leans toward where it's going, within the limit.
    func testTheCursorLeansOnlyIntoLongMoves() {
        XCTAssertEqual(CursorMotionLean.radians(dx: 40, distance: 40), 0)
        XCTAssertGreaterThan(CursorMotionLean.radians(dx: 900, distance: 900), 0)
        XCTAssertLessThan(CursorMotionLean.radians(dx: -900, distance: 900), 0)
        XCTAssertEqual(CursorMotionLean.radians(dx: 0, distance: 900), 0)
        XCTAssertLessThanOrEqual(abs(CursorMotionLean.radians(dx: 5000, distance: 5000)), CursorMotionLean.maxRadians + 1e-9)
    }

    /// Two colors a person with red-green color blindness may not tell apart by hue have to differ in lightness too, and
    /// the badge says it in text.
    func testFailedIsDistinctWithoutColorAndTheBadgeSaysSo() {
        let working = CursorPalette.status(.working).luminance, failed = CursorPalette.status(.failed).luminance
        XCTAssertGreaterThanOrEqual((max(working, failed) + 0.05) / (min(working, failed) + 0.05), 1.5)
        func look(_ s: DockAgent.State) -> CursorLook { CursorLook(name: "Claude", status: s, identity: RGB(r: 1, g: 1, b: 1), theme: .standard) }
        XCTAssertEqual(look(.working).badgeText, "Claude"); XCTAssertEqual(look(.done).badgeText, "✓ Claude")
        XCTAssertEqual(look(.asking).badgeText, "? Claude"); XCTAssertEqual(look(.failed).badgeText, "! Claude")
    }

    func testAnOldThemeSayingArrowStillDecodes() throws {
        XCTAssertEqual(try JSONDecoder().decode(CursorTheme.Glyph.self, from: Data(#""arrow""#.utf8)), .pointer)
        XCTAssertEqual(try JSONDecoder().decode(CursorTheme.Glyph.self, from: Data(#""leaf""#.utf8)), .leaf)
    }

    func testEdgesAreWhiteExceptForTheThemesThatChooseOtherwise() {
        for g in [CursorTheme.Glyph.leaf, .pointer, .dot] { XCTAssertTrue(CursorGlyphs.hasWhiteEdge(g), "\(g)") }
        for g in [CursorTheme.Glyph.classic, .block] { XCTAssertFalse(CursorGlyphs.hasWhiteEdge(g), "\(g)") }
    }

    /// An app the agent started may bring itself forward as it launches. Its window is still the agent's. A window of the
    /// app you're using stays yours, even with a claim on it: that was Calculator opening on Donovan's screen, 2026-11-05.
    func testAClaimHoldsForAnAgentStartedAppThatBroughtItselfForward() {
        XCTAssertTrue(ClaimRule.applies(windowPid: 7, frontPid: 7, agentStartedProcess: true))
        XCTAssertFalse(ClaimRule.applies(windowPid: 7, frontPid: 7, agentStartedProcess: false))
        XCTAssertTrue(ClaimRule.applies(windowPid: 7, frontPid: 8, agentStartedProcess: false))
        XCTAssertTrue(ClaimRule.applies(windowPid: 7, frontPid: nil, agentStartedProcess: false))
    }

    func testGlyphsPutTheirTipOnTheOrigin() {
        for g in [CursorTheme.Glyph.leaf, .pointer, .classic, .block] {
            let b = CursorGlyphs.path(g, size: 26).boundingBoxOfPath
            XCTAssertEqual(b.minX, 0, accuracy: 1e-9, "\(g)")
            XCTAssertEqual(b.minY, 0, accuracy: 1e-9, "\(g)")
            XCTAssertLessThanOrEqual(b.height, 26 + 1e-6, "\(g)")
            XCTAssertGreaterThan(b.height, 26 * 0.9, "\(g)")
        }
        let dot = CursorGlyphs.path(.dot, size: 10).boundingBoxOfPath
        XCTAssertEqual(dot.midX, 0, accuracy: 1e-9)
        XCTAssertEqual(dot.midY, 0, accuracy: 1e-9)
    }

    func testTheCursorsColorsAreItsOwnAndStable() {
        XCTAssertEqual(CursorPalette.identityColor(for: "/dev/ttys004"), CursorPalette.identityColor(for: "/dev/ttys004"))
        let colors = Set([DockAgent.State.working, .asking, .failed, .done].map { CursorPalette.status($0) })
        XCTAssertEqual(colors.count, 4, "each status has its own color")
        let hues = Set((0..<40).map { CursorPalette.identityColor(for: "session-\($0)") })
        XCTAssertGreaterThan(hues.count, 4, "different agents land on different hues")
    }
}

final class CursorSettingsTests: XCTestCase {
    func testTheVeilIsOnByDefaultAndConfigTomlSwitchesIt() throws {
        XCTAssertTrue(CursorSettings().veil)
        XCTAssertEqual(CursorConfigFile.parse("[behavior.cursor]\nveil = \"off\"\n").veil, false)
        XCTAssertEqual(CursorConfigFile.parse("behavior.cursor.veil = \"on\"\n").veil, true)
        XCTAssertNil(CursorConfigFile.parse("behavior.cursor.veil = \"maybe\"\n").veil, "a bad value is ignored")
        var saved = CursorSettings(); saved.veil = false
        XCTAssertTrue(saved.applying(CursorConfigFile.parse("behavior.cursor.veil = \"on\"\n")).veil, "the file wins over Settings")
        XCTAssertFalse(saved.applying(CursorConfigFile()).veil)
        let d = UserDefaults(suiteName: "cursor-veil-\(UUID().uuidString)")!
        saved.save(to: d)
        XCTAssertFalse(CursorSettings.load(from: d).veil, "saved")
        // A settings record from before the veil existed keeps it on.
        let old = try JSONDecoder().decode(CursorSettings.self, from: Data("{\"enabled\":true,\"theme\":\"leaf\"}".utf8))
        XCTAssertTrue(old.veil)
    }

    func testItIsOnByDefaultWithTheDefaultTheme() {
        let s = CursorSettings()
        XCTAssertTrue(s.enabled)
        XCTAssertEqual(s.resolvedTheme, .standard)
    }

    func testSettingsRoundTripAndAnUnknownThemeFallsBack() throws {
        let d = UserDefaults(suiteName: "cursor-tests-\(UUID().uuidString)")!
        var s = CursorSettings(); s.enabled = false; s.theme = "omarchy"; s.speed = 1.5
        s.save(to: d)
        XCTAssertEqual(CursorSettings.load(from: d), s)
        s.theme = "gone"
        XCTAssertEqual(s.resolvedTheme, .standard)
        XCTAssertEqual(CursorSettings.load(from: UserDefaults(suiteName: "cursor-empty-\(UUID().uuidString)")!), CursorSettings())
    }

    func testTheConfigFileSetsTheCursorsKeys() {
        let f = CursorConfigFile.parse("""
        # comment
        [behavior.cursor]
        enabled = false   # off here
        theme = "minimal"

        [animation]
        preset = "snappy"
        speed = 1.25
        respect_reduce_motion = false

        [animation.cursor.glide]
        curve = "spring"
        response = 0.2
        damping = 0.9
        [other]
        enabled = true
        """)
        XCTAssertEqual(f.ignored, ["behavior.cursor.enabled"], "the file can't turn the cursor off")
        XCTAssertEqual(f.theme, "minimal")
        XCTAssertEqual(f.preset, "snappy")
        XCTAssertEqual(f.speed, 1.25)
        XCTAssertEqual(f.respectReduceMotion, false)
        XCTAssertEqual(f.response, 0.2)
        XCTAssertEqual(f.damping, 0.9)
        let s = CursorSettings().applying(f)
        XCTAssertTrue(s.enabled, "enabled = false in config.toml is not honored: only Settings turns the cursor off")
        XCTAssertEqual(s.theme, "minimal")
    }

    func testABadLineNeverSwitchesTheCursorOff() {
        let f = CursorConfigFile.parse("[behavior.cursor]\ntheme = 7\nnonsense\n[behavior\nspeed = x\n")
        XCTAssertTrue(f.isEmpty)
        XCTAssertEqual(CursorSettings().applying(f), CursorSettings())
    }

    func testDottedKeysAndTheConfigPath() {
        XCTAssertTrue(CursorSettings().applying(CursorConfigFile.parse("behavior.cursor.enabled = false\n")).enabled)
        XCTAssertEqual(CursorConfigFile.path(environment: ["XDG_CONFIG_HOME": "/x"], home: "/h"), "/x/baneyspaces/config.toml")
        XCTAssertEqual(CursorConfigFile.path(environment: [:], home: "/h"), "/h/.config/baneyspaces/config.toml")
    }

    func testEveryScrollDirectionAndActionKindHasAnEffect() {
        XCTAssertEqual(CursorEffect.of(kind: "click", direction: nil), .click)
        XCTAssertEqual(CursorEffect.of(kind: "toggle", direction: nil), .click)
        XCTAssertEqual(CursorEffect.of(kind: "type", direction: nil), .type)
        XCTAssertEqual(CursorEffect.of(kind: "set-value", direction: nil), .type)
        XCTAssertEqual(CursorEffect.of(kind: "scroll", direction: "up"), .scroll(dx: 0, dy: -1))
        XCTAssertEqual(CursorEffect.of(kind: "scroll", direction: "left"), .scroll(dx: -1, dy: 0))
        XCTAssertNil(CursorEffect.of(kind: "press", direction: nil))
    }
}

/// Records what the director asked the overlay to do.
final class FakeSurface: CursorSurface {
    enum Call: Equatable {
        case configure(String, String)
        case appear(String, CGPoint)
        case move(String, CGPoint)
        case jump(String, CGPoint)
        case act(String, CursorEffect, CGPoint, TimeInterval)
        case hide(String)
        case remove(String)
    }
    /// The window side, kept apart so the cursor's own call order stays easy to read.
    enum WindowCall: Equatable {
        case place(UInt32, CGRect, Bool)
        case showVeil(UInt32, [String])
        case hideVeil(UInt32)
        case gone(UInt32)
    }
    private let lock = NSLock()
    private var log: [Call] = []
    private var windowLog: [WindowCall] = []
    /// The window each cursor call drew in.
    private(set) var drawnIn: [UInt32] = []
    var veilLooks: [VeilLook] = []
    /// A pretend overlay window number for each target window that has one.
    var overlayIDs: [UInt32: UInt32] = [:]
    var motions: [CursorMotion] = []
    var looks: [CursorLook] = []
    /// What each call costs, to prove the action doesn't wait for it.
    var cost: TimeInterval = 0
    var calls: [Call] { lock.lock(); defer { lock.unlock() }; return log }
    var windowCalls: [WindowCall] { lock.lock(); defer { lock.unlock() }; return windowLog }
    private func noteWindow(_ c: WindowCall) { lock.lock(); windowLog.append(c); lock.unlock() }
    private func drew(_ w: CursorWindow) { lock.lock(); drawnIn.append(w.id); lock.unlock() }
    private func note(_ c: Call) { if cost > 0 { Thread.sleep(forTimeInterval: cost) }; lock.lock(); log.append(c); lock.unlock() }
    func configure(_ agent: String, look: CursorLook) { lock.lock(); looks.append(look); lock.unlock(); note(.configure(agent, look.name)) }
    func appear(_ agent: String, at point: CGPoint, in window: CursorWindow) { drew(window); note(.appear(agent, point)) }
    func move(_ agent: String, motion: CursorMotion, in window: CursorWindow) { drew(window); lock.lock(); motions.append(motion); lock.unlock(); note(.move(agent, motion.target)) }
    func jump(_ agent: String, to point: CGPoint, in window: CursorWindow) { drew(window); note(.jump(agent, point)) }
    func act(_ agent: String, effect: CursorEffect, point: CGPoint, frame: CGRect, delay: TimeInterval) { note(.act(agent, effect, point, delay)) }
    func hide(_ agent: String) { note(.hide(agent)) }
    func remove(_ agent: String) { note(.remove(agent)) }
    func place(_ window: CursorWindow, reorder: Bool) { noteWindow(.place(window.id, window.frame, reorder)) }
    func showVeil(_ window: CursorWindow, look: VeilLook) { lock.lock(); veilLooks.append(look); lock.unlock(); noteWindow(.showVeil(window.id, look.agents.map(\.name))) }
    func hideVeil(_ window: UInt32) { noteWindow(.hideVeil(window)) }
    func windowGone(_ window: UInt32) { noteWindow(.gone(window)) }
    func overlayWindow(for window: UInt32) -> UInt32? { lock.lock(); defer { lock.unlock() }; return overlayIDs[window] }
    var overlayWindows: Set<UInt32> { lock.lock(); defer { lock.unlock() }; return Set(overlayIDs.values) }
}

final class CursorDirectorTests: XCTestCase {
    var clock = 100.0
    let queue = DispatchQueue(label: "cursor-tests")
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)

    func make(surface: FakeSurface = FakeSurface(), idle: TimeInterval = 60) -> (CursorDirector, FakeSurface) {
        var host = CursorDirector.Host()
        host.now = { [unowned self] in self.clock }
        host.agent = { session in (session == "b" ? "Grok" : "Claude", .working) }
        let d = CursorDirector(surface: surface, queue: queue, host: host, idleAfter: idle)
        var env = CursorEnvironment()
        env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        return (d, surface)
    }

    func event(_ kind: String = "click", at p: CGPoint, session: String = "a", scope: String = "agent_workspace", workspace: Int? = 9, window: UInt32 = 7) -> HandsActionEvent {
        HandsActionEvent(kind: kind, ref: "@s1:e1", window: window, pid: 1, app: "TextEdit", point: p,
                         frame: CGRect(x: p.x - 30, y: p.y - 10, width: 60, height: 20), session: session, scope: scope, workspace: workspace)
    }

    func drain() { queue.sync {} }

    func testTheFirstActionAppearsAtTheTargetThenGlidesFromThereToTheNext() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 900, y: 500))); drain()
        let c = s.calls
        XCTAssertEqual(c.first, .configure("a", "Claude"))
        XCTAssertTrue(c.contains(.appear("a", CGPoint(x: 200, y: 200))))
        XCTAssertTrue(c.contains(.move("a", CGPoint(x: 900, y: 500))))
        XCTAssertEqual(s.motions.last?.points.first, CGPoint(x: 200, y: 200), "the glide starts at the last spot")
        XCTAssertEqual(s.motions.last?.points.last, CGPoint(x: 900, y: 500))
    }

    func testANewTargetMidGlideStartsAtTheCurrentPositionAndVelocity() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 100, y: 100))); drain()
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 1000, y: 400))); drain()
        let first = GlidePlan(from: GlideState(position: CGPoint(x: 100, y: 100)), target: CGPoint(x: 1000, y: 400), spring: .polycarp)
        clock += 0.05
        let expected = first.state(at: 0.05)
        d.handsWillAct(event(at: CGPoint(x: 300, y: 800))); drain()
        let next = s.motions.last!
        XCTAssertEqual(next.points.first!.x, expected.position.x, accuracy: 1e-6, "no jump")
        XCTAssertEqual(next.points.first!.y, expected.position.y, accuracy: 1e-6)
        // The new glide is the old plan retargeted: same position and velocity at the hand-over, so no restart from rest.
        let retargeted = first.retarget(at: 0.05, to: CGPoint(x: 300, y: 800)).samples()
        XCTAssertEqual(next.points.count, retargeted.count)
        for (a, b) in zip(next.points, retargeted.map(\.position)) {
            XCTAssertEqual(a.x, b.x, accuracy: 1e-6); XCTAssertEqual(a.y, b.y, accuracy: 1e-6)
        }
        XCTAssertNotEqual(expected.velocity, .zero, "it was moving when the new target came")
    }

    func testTheRippleWaitsForTheCursorToArrive() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 100, y: 100))); drain()
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 1000, y: 400))); drain()
        guard case .act(_, .click, _, let delay)? = s.calls.last else { return XCTFail("no act") }
        XCTAssertEqual(delay, s.motions.last!.arrival, accuracy: 1e-9)
        XCTAssertGreaterThan(delay, 0.05)
    }

    func testReduceMotionJumpsInsteadOfGliding() {
        let (d, s) = make()
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]; env.reduceMotion = true
        d.setEnvironment(env)
        d.handsWillAct(event(at: CGPoint(x: 100, y: 100))); drain()
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 1000, y: 400))); drain()
        XCTAssertTrue(s.motions.isEmpty)
        XCTAssertTrue(s.calls.contains(.jump("a", CGPoint(x: 1000, y: 400))))
        guard case .act(_, _, _, let delay)? = s.calls.last else { return XCTFail() }
        XCTAssertEqual(delay, 0)
    }

    func testReduceMotionOrPresetOffDrawsTheCursorStill() {
        func drawn(_ change: (inout CursorEnvironment) -> Void) -> CursorLook? {
            let (d, s) = make()
            var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
            change(&env)
            d.setEnvironment(env)
            d.handsWillAct(event(at: CGPoint(x: 100, y: 100))); drain()
            return s.looks.last
        }
        let moving = drawn { _ in }
        XCTAssertEqual(moving?.still, false)
        XCTAssertLessThan(moving?.theme.appearScale ?? 1, 1, "the default theme pops in")
        for look in [drawn { $0.reduceMotion = true }, drawn { $0.settings.preset = "off" }] {
            XCTAssertEqual(look?.still, true)
            XCTAssertEqual(look?.theme.appearScale, 1, "no pop")
            XCTAssertEqual(look?.theme.squish, 1, "no squish")
        }
        let chose = drawn { $0.reduceMotion = true; $0.settings.respectReduceMotion = false }
        XCTAssertEqual(chose?.still, false, "animation.respect_reduce_motion = false keeps the motion")
    }

    func testNothingIsDrawnWhenYouAreNotOnTheAgentWorkspace() {
        let (d, s) = make()
        var env = CursorEnvironment(); env.current = 2; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        XCTAssertFalse(d.handsWantsFrame(scope: "agent_workspace", workspace: 9), "the hands don't even measure the target")
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        XCTAssertTrue(s.calls.isEmpty, "no layers touched while you look elsewhere")
    }

    func testALentWindowShowsTheCursorOnYourWorkspace() {
        let (d, s) = make()
        var env = CursorEnvironment(); env.current = 3; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        XCTAssertTrue(d.handsWantsFrame(scope: "lent", workspace: 3))
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300), scope: "lent", workspace: 3)); drain()
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 300, y: 300))))
    }

    func testLeavingTheAgentWorkspaceHidesTheCursorAtOnce() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        var env = CursorEnvironment(); env.current = 4; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env); drain()
        XCTAssertEqual(s.calls.last, .hide("a"))
        // Coming back, an action appears at its target: where it stood before is no use, the windows were parked.
        env.current = 9
        d.setEnvironment(env)
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 700, y: 300))); drain()
        XCTAssertEqual(s.calls.last.map { if case .act = $0 { return true } else { return false } }, true)
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 700, y: 300))))
    }

    func testTurningItOffHidesItAndStopsMeasuring() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]; env.settings.enabled = false
        d.setEnvironment(env); drain()
        XCTAssertEqual(s.calls.last, .hide("a"))
        XCTAssertFalse(d.handsWantsFrame(scope: "agent_workspace", workspace: 9))
    }

    func testTwoAgentsOnTheSameWorkspaceKeepTheirOwnCursorAndName() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200), session: "a")); drain()
        d.handsWillAct(event(at: CGPoint(x: 600, y: 300), session: "b")); drain()
        XCTAssertTrue(s.calls.contains(.configure("a", "Claude")))
        XCTAssertTrue(s.calls.contains(.configure("b", "Grok")))
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 200, y: 200))))
        XCTAssertTrue(s.calls.contains(.appear("b", CGPoint(x: 600, y: 300))))
    }

    func testAnIdleCursorFadesAndComesBackWhereItStood() {
        let (d, s) = make(idle: 0.05)
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        Thread.sleep(forTimeInterval: 0.2); drain()
        XCTAssertEqual(s.calls.last, .hide("a"))
        clock += 30
        d.handsWillAct(event(at: CGPoint(x: 800, y: 500))); drain()
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 200, y: 200))), "it reappears at its last spot")
        XCTAssertEqual(s.motions.last?.points.first, CGPoint(x: 200, y: 200), "and glides from there")
    }

    func testTheLastMarkIsKeptForShotCursor() {
        let (d, _) = make()
        d.handsWillAct(event(at: CGPoint(x: 250, y: 260), window: 42)); drain()
        XCTAssertEqual(d.lastMark(window: 42)?.point, CGPoint(x: 250, y: 260))
        XCTAssertNil(d.lastMark(window: 43))
        clock += 31
        XCTAssertNil(d.lastMark(window: 42), "only a recent action")
    }

    func testTheNameIsShortenedForTheBadge() {
        var host = CursorDirector.Host()
        host.agent = { _ in (String(repeating: "x", count: 60), .working) }
        let s = FakeSurface()
        let d = CursorDirector(surface: s, queue: queue, host: host)
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        guard case .configure(_, let name)? = s.calls.first else { return XCTFail() }
        XCTAssertLessThanOrEqual(name.count, CursorDirector.maxNameLength)
    }

    // MARK: displays, late frames, idle

    func testACursorIsMadeAgainAfterTheDisplaysChange() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 400, y: 300))); drain()
        let before = s.calls.count
        // The overlay forgot its cursors (the worst case); the displays changed to a new, larger one.
        let bigger = CGRect(x: 0, y: 0, width: 2560, height: 1440)
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [bigger]
        d.setEnvironment(env); drain()
        let after = Array(s.calls[before...])
        XCTAssertTrue(after.contains(.configure("a", "Claude")), "its look is sent again: \(after)")
        XCTAssertTrue(after.contains(.appear("a", CGPoint(x: 400, y: 300))), "and it comes back where it stood: \(after)")
        // And the next action works as before.
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 900, y: 600))); drain()
        XCTAssertTrue(s.calls.contains(.move("a", CGPoint(x: 900, y: 600))))
    }

    func testACursorThatLostItsDisplayIsHiddenNotLeftBehind() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 1300, y: 800))); drain()
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [CGRect(x: 0, y: 0, width: 800, height: 600)]
        d.setEnvironment(env); drain()
        let hidden = try! XCTUnwrap(s.calls.lastIndex(of: .hide("a")), "hidden when its display went: \(s.calls)")
        XCTAssertFalse(s.calls[hidden...].contains(.appear("a", CGPoint(x: 1300, y: 800))), "not brought back where the display was")
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 100, y: 100))); drain()
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 100, y: 100))), "it reappears at the target, not at a place that is gone")
    }

    func testAFrameThatArrivesInTimeIsUsed() {
        let (d, s) = make()
        var e = event(at: .zero)
        e.frame = nil; e.point = nil; e.id = 5; e.frameComing = true
        d.handsWillAct(e); drain()
        XCTAssertTrue(s.calls.isEmpty, "waiting for the frame, not drawing")
        d.handsFrame(actionID: 5, frame: CGRect(x: 600, y: 400, width: 100, height: 40)); drain()
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 650, y: 420))))
    }

    func lateEvent(id: UInt64, window: UInt32) -> HandsActionEvent {
        var e = event(at: .zero, window: window)
        e.frame = nil; e.point = nil; e.id = id; e.frameComing = true
        return e
    }

    func testALateFrameInTheSameWindowLeavesTheCursorAloneAndDrawsNothing() {
        let (d, s) = make()
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200), window: 7)); drain()
        let before = s.calls.count
        d.handsWillAct(lateEvent(id: 6, window: 7))
        Thread.sleep(forTimeInterval: CursorDirector.frameWait + 0.15); drain()
        XCTAssertEqual(s.calls.count, before, "nothing is drawn at a point the action never targeted: \(s.calls)")
        XCTAssertFalse(s.calls.contains(.hide("a")), "and it does not disappear")
        d.handsFrame(actionID: 6, frame: CGRect(x: 900, y: 500, width: 10, height: 10)); drain()
        XCTAssertEqual(s.calls.count, before, "a frame that comes after the wait is dropped")
        // Where it stood is kept: the next action glides from there.
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 700, y: 400), window: 7)); drain()
        XCTAssertEqual(s.motions.last?.points.first, CGPoint(x: 200, y: 200))
    }

    func testANilFrameIsTheSameAsALateOne() {
        var host = CursorDirector.Host()
        host.now = { [unowned self] in self.clock }
        let s = FakeSurface()
        let d = CursorDirector(surface: s, queue: queue, host: host)
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200), window: 7)); drain()
        let before = s.calls.count
        d.handsWillAct(lateEvent(id: 8, window: 7)); drain()
        d.handsFrame(actionID: 8, frame: nil); drain()
        XCTAssertEqual(s.calls.count, before, "no hide, no act: \(Array(s.calls[before...]))")
        // And still shown at its last point: an action elsewhere glides from there.
        clock += 1
        d.handsWillAct(event(at: CGPoint(x: 700, y: 400), window: 7)); drain()
        XCTAssertEqual(s.motions.last?.points.first, CGPoint(x: 200, y: 200))
    }

    func testALateFrameInAnotherWindowGlidesToThatWindowsCenterWithoutAnEffect() {
        var host = CursorDirector.Host()
        host.now = { [unowned self] in self.clock }
        host.windowFrame = { id in id == 12 ? CGRect(x: 800, y: 400, width: 400, height: 300) : nil }
        let s = FakeSurface()
        let d = CursorDirector(surface: s, queue: queue, host: host)
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200), window: 7)); drain()
        clock += 1
        d.handsWillAct(lateEvent(id: 9, window: 12)); drain()
        d.handsFrame(actionID: 9, frame: nil); drain()
        // Between two windows it lands in the new one (it used to glide across the screen to it).
        XCTAssertTrue(s.calls.contains(.jump("a", CGPoint(x: 1000, y: 550))), "to window 12's center: \(s.calls)")
        XCTAssertFalse(s.calls.contains(.move("a", CGPoint(x: 1000, y: 550))), "no flight across the screen")
        XCTAssertEqual(s.drawnIn.last, 12, "drawn in window 12's overlay")
        XCTAssertEqual(s.calls.filter { if case .act = $0 { return true } else { return false } }.count, 1, "only the first action drew an effect")
        XCTAssertNil(d.lastMark(window: 12), "no evidence mark for a point the action never targeted")
        XCTAssertFalse(s.calls.contains(.hide("a")))
    }

    func testALateFrameWithNothingKnownDrawsNothing() {
        let (d, s) = make()
        d.handsWillAct(lateEvent(id: 7, window: 7))
        Thread.sleep(forTimeInterval: CursorDirector.frameWait + 0.15); drain()
        XCTAssertTrue(s.calls.isEmpty)
    }

    func testTheAgentWorkspaceOnASecondDisplayShowsTheCursor() {
        let (d, s) = make()
        var env = CursorEnvironment(); env.shownWorkspaces = [2, 9]; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        XCTAssertTrue(d.handsWantsFrame(scope: "agent_workspace", workspace: 9))
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertTrue(s.calls.contains(.appear("a", CGPoint(x: 300, y: 300))))
    }

    func testLeavingAndComingBackForgetsWhereAnIdleCursorStood() {
        let (d, s) = make(idle: 0.05)
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        Thread.sleep(forTimeInterval: 0.2); drain()
        XCTAssertEqual(s.calls.last, .hide("a"), "idle")
        var env = CursorEnvironment(); env.current = 2; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env); drain()
        env.current = 9
        d.setEnvironment(env); drain()
        clock += 30
        d.handsWillAct(event(at: CGPoint(x: 800, y: 500))); drain()
        let idleAt = s.calls.lastIndex(of: .hide("a"))!
        let later = Array(s.calls[idleAt...])
        XCTAssertTrue(later.contains(.appear("a", CGPoint(x: 800, y: 500))), "at the target: the windows were parked in between")
        XCTAssertFalse(later.contains(.appear("a", CGPoint(x: 200, y: 200))))
    }

    func testAQuietSessionIsRemovedAfterAWhile() {
        var host = CursorDirector.Host()
        host.now = { [unowned self] in self.clock }
        let s = FakeSurface()
        let d = CursorDirector(surface: s, queue: queue, host: host, idleAfter: 0.03, pruneAfter: 0.05)
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
        d.setEnvironment(env)
        d.handsWillAct(event(at: CGPoint(x: 200, y: 200))); drain()
        // The prune runs on a real timer; a loaded CI runner can fire it late (#157), so wait for it
        // with a deadline instead of one fixed sleep.
        let deadline = Date().addingTimeInterval(2)
        repeat { Thread.sleep(forTimeInterval: 0.02); drain() } while !s.calls.contains(.remove("a")) && Date() < deadline
        XCTAssertTrue(s.calls.contains(.remove("a")))
        clock += 1000
        d.handsWillAct(event(at: CGPoint(x: 300, y: 300))); drain()
        XCTAssertEqual(s.calls.filter { if case .configure = $0 { return true } else { return false } }.count, 2, "a returning session is configured again")
    }

    // MARK: the action never waits

    func testTheActionDoesNotWaitForTheGlide() {
        let slow = FakeSurface()
        slow.cost = 0.25   // every draw call takes a quarter second
        let (d, _) = make(surface: slow)
        HandsEvents.setListener(d)
        defer { HandsEvents.setListener(nil) }
        let t0 = ProcessInfo.processInfo.systemUptime
        for i in 0..<5 {
            HandsEvents.willAct(event(at: CGPoint(x: 100 + Double(i) * 100, y: 300)))
        }
        let spent = ProcessInfo.processInfo.systemUptime - t0
        XCTAssertLessThan(spent, 0.05, "five actions reported while the overlay is slow: \(spent) s")
        XCTAssertTrue(slow.calls.count < 3, "the overlay has not caught up yet, and the actions are already on their way")
        drain()
        XCTAssertGreaterThan(slow.calls.count, 5)
    }
}

/// A stand-in for the router's per-action path: some work to resolve and read, the report to the cursor, the target's
/// bounds read on a lane of their own while the action runs, then the action and its readbacks. The engine's time is
/// modelled (spin waits); the cursor's code on the action's thread is the real thing.
private struct FakeHands {
    var resolve: TimeInterval = 0.004
    var boundsRead: TimeInterval = 0.008
    var act: TimeInterval = 0.012
    var readback: TimeInterval = 0.008
    static let lane = DispatchQueue(label: "fake-bounds-lane", attributes: .concurrent)
    /// Actions that asked for the target's bounds, counted so a test can check none did without timing it.
    static var framesWanted = 0

    func spin(_ t: TimeInterval) { let end = ProcessInfo.processInfo.systemUptime + t; while ProcessInfo.processInfo.systemUptime < end {} }

    func run(_ e: HandsActionEvent) {
        spin(resolve)
        var event = e
        let wants = HandsEvents.wantsFrame(scope: e.scope, workspace: e.workspace)
        if wants { Self.framesWanted += 1 }
        let id = wants ? HandsEvents.newActionID() : 0
        event.frame = nil; event.point = nil; event.id = id; event.frameComing = wants
        HandsEvents.willAct(event)
        if wants {
            let frame = e.frame, read = boundsRead
            Self.lane.async { self.spin(read); HandsEvents.frameMeasured(actionID: id, frame: frame) }
        }
        spin(act)
        spin(readback)
    }
}

final class CursorOverheadTests: XCTestCase {
    static func median(_ xs: [Double]) -> Double { xs.sorted()[xs.count / 2] }

    /// Each action without the cursor runs next to one with it, the order alternating, and "added" is the median of
    /// the pairs' differences: load that changes over the run (another build starting) lands on both halves of a pair,
    /// and a stall lands in one pair, which the median drops. Two blocks of 200 in a row let the drift in: the 11-12
    /// logs show the median without the cursor alone at 24.0 to 27.9 ms, so "added" ran from -3.8 to +1.8 ms with
    /// the cursor's code unchanged. A run that is faster or slower for coming second in its pair would make the
    /// differences two clusters, one per order, and one median of both picks an edge of one: so "added" is the mean of
    /// the two orders' medians, and the order's effect cancels (review of PR 206, second-F5). `drain` runs before each
    /// pair, outside its timing: work one pair left behind (the bounds read finishing late on a loaded Mac) would land on
    /// the next pair's first run, which is the one with the cursor in one order and without it in the other, and pull
    /// the two orders' medians apart (11-13 at load 83 to 248: 8.97 against -4.27 ms; drained, 0.06 against 0.04).
    static func paired(_ n: Int, drain: () -> Void = {}, _ timed: (_ i: Int, _ listening: Bool) -> Double) -> (without: Double, with: Double, added: Double, half: Double) {
        var withouts: [Double] = [], withs: [Double] = [], byOrder: [[Double]] = [[], []]
        for i in 0..<n {
            drain()
            let (wo, w): (Double, Double)
            if i % 2 == 0 { wo = timed(i, false); w = timed(i, true) } else { w = timed(i, true); wo = timed(i, false) }
            withouts.append(wo); withs.append(w); byOrder[i % 2].append(w - wo)
        }
        return (median(withouts), median(withs), (median(byOrder[0]) + median(byOrder[1])) / 2, halfWidth(byOrder))
    }

    /// The 95% half-width of a median of differences, from their spread (1.4826 times the median absolute deviation,
    /// each group centred on its own median). On a Mac at load 80 to 250 (10 cores, 11-13) "added" swung 0.4 to 8.8 ms
    /// with no change to the code, and the hidden cursor's test, which reads no bounds, missed its 4 ms by up to 5.5 ms:
    /// a run that noisy can't tell 1 ms from 0 (review of PR 233, first-F1).
    static func halfWidth(_ groups: [[Double]]) -> Double {
        let centred = groups.flatMap { g in g.map { $0 - median(g) } }
        return 1.96 * 1.2533 * 1.4826 * median(centred.map(abs)) / Double(centred.count).squareRoot()
    }

    enum Verdict: Equatable { case under, over, unresolved }
    /// A bar is judged only when the run resolves it, but an "added" over it even at its lower bound fails however
    /// noisy the run: the gate can only hold a verdict back, never pass one.
    static func verdict(_ added: Double, half: Double, bar: Double) -> Verdict {
        if added - half >= bar { return .over }
        if half >= bar { return .unresolved }
        return added < bar ? .under : .over
    }

    /// Judges each bar, printing `CURSOR BAR <what> <bar> ms: judged|skipped` for counting, then skips, never silently,
    /// when any bar was past what the run could resolve.
    static func judge(_ what: String, added: Double, half: Double, bars: [(Double, String)]) throws {
        var load = [Double](repeating: 0, count: 3); getloadavg(&load, 3)
        var unresolved: [String] = []
        for (bar, why) in bars {
            let line = "\(what): added \(String(format: "%.2f", added)) ms ± \(String(format: "%.2f", half)) (95%) against \(bar) ms at load \(String(format: "%.1f", load[0]))"
            let v = verdict(added, half: half, bar: bar)
            print("CURSOR BAR \(what) \(bar) ms: \(v == .unresolved ? "skipped" : "judged")")
            if v == .unresolved { unresolved.append(line) } else { XCTAssertEqual(v, .under, "\(line): \(why)") }
        }
        if !unresolved.isEmpty { throw XCTSkip("too noisy to judge: " + unresolved.joined(separator: "; ")) }
    }

    func testTheGateHoldsBackAVerdictButNeverPassesOne() {
        XCTAssertEqual(Self.verdict(3, half: 5, bar: 1), .unresolved, "a noisy run can't tell")
        XCTAssertEqual(Self.verdict(7, half: 5, bar: 1), .over, "over even at its lower bound: fails however noisy")
        XCTAssertEqual(Self.verdict(0.1, half: 0.05, bar: 1), .under)
        XCTAssertEqual(Self.verdict(1.2, half: 0.1, bar: 1), .over)
        let quiet = Self.halfWidth([[0.01, 0.02, 0.03, 0.02], [0.52, 0.51, 0.53, 0.52]])
        let noisy = Self.halfWidth([[-9, 4, 12, -3], [6, -8, 1, 10]])
        XCTAssertLessThan(quiet, 0.05, "the order's offset is not noise")
        XCTAssertGreaterThan(noisy, 5)
    }

    func testAPairedMeasurementIgnoresLoadThatChangesPartWay() {
        // A modelled action of 24 ms that the cursor makes 0.02 ms slower, on a machine that gets 3 ms slower halfway.
        var clock = 0
        let n = 200
        func action(listening: Bool) -> Double { defer { clock += 1 }; return 24 + (clock >= n ? 3 : 0) + (listening ? 0.02 : 0) }
        let without = Self.median((0..<n).map { _ in action(listening: false) }), with = Self.median((0..<n).map { _ in action(listening: true) })
        XCTAssertEqual(with - without, 3.02, accuracy: 0.001, "two blocks in a row count the slowdown as the cursor's")
        clock = 0
        let r = Self.paired(n) { _, listening in action(listening: listening) }
        XCTAssertEqual(r.added, 0.02, accuracy: 0.001, "pairs count only the cursor")
    }

    func testAPairedMeasurementDrainsBeforeEachPairAndNeverInsideOne() {
        var log: [String] = []
        _ = Self.paired(4, drain: { log.append("drain") }) { _, listening in log.append(listening ? "with" : "without"); return 0 }
        XCTAssertEqual(log, ["drain", "without", "with", "drain", "with", "without", "drain", "without", "with", "drain", "with", "without"])
    }

    func testAPairedMeasurementCancelsTheOrderAndDropsAStall() {
        // The same 24 ms action and 0.02 ms cursor, but a run that comes second in its pair is 1.5 ms faster (warm
        // caches), and one run stalls 50 ms. One median over both orders reads 1.52 ms.
        var calls = 0
        func action(listening: Bool) -> Double {
            defer { calls += 1 }
            return 24 + (calls % 2 == 1 ? -1.5 : 0) + (calls == 137 ? 50 : 0) + (listening ? 0.02 : 0)
        }
        let r = Self.paired(200) { _, listening in action(listening: listening) }
        XCTAssertEqual(r.added, 0.02, accuracy: 0.001, "the order's effect cancels and the stall is dropped")
    }

    func testTheCursorAddsUnderFiveMillisecondsToTheMedianAction() throws {
        let hands = FakeHands()
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let queue = DispatchQueue(label: "overhead")
        let director = CursorDirector(surface: FakeSurface(), queue: queue)
        var env = CursorEnvironment(); env.current = 9; env.agentWorkspace = 9; env.displays = [screen]
        director.setEnvironment(env)
        func timed(_ i: Int, listening: Bool) -> Double {
            HandsEvents.setListener(listening ? director : nil)
            defer { HandsEvents.setListener(nil) }
            let p = CGPoint(x: 100 + Double(i % 20) * 50, y: 200 + Double(i % 7) * 60)
            let e = HandsActionEvent(kind: i % 3 == 0 ? "type" : "click", ref: "@s1:e1", window: 7, pid: 1, app: "TextEdit", point: p,
                                     frame: CGRect(x: p.x - 30, y: p.y - 10, width: 60, height: 20), session: "a", scope: "agent_workspace", workspace: 9)
            let t0 = ProcessInfo.processInfo.systemUptime
            hands.run(e)
            return (ProcessInfo.processInfo.systemUptime - t0) * 1000
        }
        for i in 0..<20 { _ = timed(i, listening: true) }   // warm up
        // The bounds read runs on the fake engine's lane and reports to the director's queue: drain both, in that order.
        let r = Self.paired(200, drain: { FakeHands.lane.sync(flags: .barrier) {}; queue.sync {} }) { timed($0, listening: $1) }
        print("CURSOR OVERHEAD (modelled engine: resolve 4 + act 12 + readback 8 ms, bounds read 8 ms on its own lane; the cursor's own code is real; 200 alternating pairs): median action without the cursor \(String(format: "%.2f", r.without)) ms, with it \(String(format: "%.2f", r.with)) ms, median added per pair \(String(format: "%.2f", r.added)) ms")
        try Self.judge("paired", added: r.added, half: r.half, bars: [(5, "under 5 ms added to the median action"),
                                                                    (1, "the bounds read runs beside the action, so the action pays only the report")])
    }

    func testWithTheCursorHiddenTheActionPaysNothing() throws {
        let hands = FakeHands()
        let director = CursorDirector(surface: FakeSurface(), queue: DispatchQueue(label: "hidden"))
        var env = CursorEnvironment(); env.current = 2; env.agentWorkspace = 9
        director.setEnvironment(env)
        HandsEvents.setListener(director)
        defer { HandsEvents.setListener(nil) }
        XCTAssertFalse(HandsEvents.wantsFrame(scope: "agent_workspace", workspace: 9))
        let e = HandsActionEvent(kind: "click", ref: "r", window: 1, pid: 1, app: "A", point: nil, session: "a", scope: "agent_workspace", workspace: 9)
        // Against a baseline with no listener, measured the same way in the same run: a slow runner
        // slows both (#157). A bounds read would add its modelled 8 ms; jitter stays well under half that.
        // The two sides alternate over rounds and each keeps its fastest: one stall under load (11-12: 41.1 ms against
        // 30.4 ms in a single pass each, at load 9) lands in one round of one side, not in the result.
        func each(listening: Bool) -> Double {
            HandsEvents.setListener(listening ? director : nil)
            let t0 = ProcessInfo.processInfo.systemUptime
            for _ in 0..<20 { hands.run(e) }
            return (ProcessInfo.processInfo.systemUptime - t0) * 50
        }
        FakeHands.framesWanted = 0
        var withouts: [Double] = [], withs: [Double] = []
        for _ in 0..<9 {
            withouts.append(each(listening: false))
            withs.append(each(listening: true))
        }
        let without = withouts.min()!, with = withs.min()!
        HandsEvents.setListener(director)
        // Not timed, so a slow runner can't hide it: a hidden cursor makes no action read bounds.
        XCTAssertEqual(FakeHands.framesWanted, 0, "with the cursor hidden, no action asks for bounds")
        try CursorOverheadTests.judge("hidden", added: with - without, half: CursorOverheadTests.halfWidth([zip(withs, withouts).map { $0 - $1 }]),
                                      bars: [(hands.boundsRead * 1000 / 2, "no bounds read: \(with) ms with the cursor hidden against \(without) ms without it")])
    }
}

final class CursorOffIsDonovansTests: XCTestCase {
    func req(_ args: [String]) -> Wire.Request { Wire.Request(op: .agent, text: "cursor", args: args) }

    func testTheSocketRefusesCursorOff() {
        XCTAssertNotNil(SocketPolicy.refusal(for: req(["off"])))
        XCTAssertNotNil(SocketPolicy.refusal(for: req(["OFF"])))
        XCTAssertNil(SocketPolicy.refusal(for: req(["on"])))
        XCTAssertNil(SocketPolicy.refusal(for: req(["theme", "omarchy"])), "agents may pick the look")
        XCTAssertNil(SocketPolicy.refusal(for: req(["status"])))
    }

    func testTheConfigFileCannotTurnItOffWhoeverWroteIt() {
        var s = CursorSettings()
        s = s.applying(CursorConfigFile.parse("[behavior.cursor]\nenabled = false\n"))
        XCTAssertTrue(s.enabled)
        XCTAssertEqual(CursorConfigFile.parse("[behavior.cursor]\nenabled = false\n").ignored, ["behavior.cursor.enabled"])
    }

    func testOnlySettingsTurnsItOffAndARefusalIsLogged() throws {
        let c = try CursorSourceTests.code("Sources/BaneySpaces/Cursor/CursorController.swift")
        let off = try XCTUnwrap(HandsSourceTests.between("case \"off\":", "case \"theme\":", in: c))
        XCTAssertFalse(off.contains("setEnabled"), "the command never turns it off")
        XCTAssertTrue(off.contains("Trace.log(\"cursor off refused"))
        let setup = try CursorSourceTests.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("cursor.setEnabled($0)"), "Settings does")
        let server = try CursorSourceTests.code("Sources/BaneySpaces/Session/Server.swift")
        XCTAssertTrue(server.contains("Trace.log(\"refused on the socket"))
        let others = try ["Sources/BaneySpaces/Session/SessionController.swift", "Sources/BaneySpaces/AppDelegate.swift", "Sources/baneyspaces-cli/main.swift"].map { try CursorSourceTests.code($0) }.joined()
        XCTAssertFalse(others.contains("setEnabled(false)"))
    }
}

final class CursorSourceTests: XCTestCase {
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static func code(_ path: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false).map { $0.components(separatedBy: "//")[0] }.joined(separator: "\n")
    }
    static let renderer = ["CursorPanel", "AgentCursor", "OverlaySurface", "ShotComposite", "VeilLayer"].map { "Sources/BaneySpacesCursor/\($0).swift" }

    func testTheOverlayCanNeverBecomeKeyOrMainAndIgnoresTheMouse() throws {
        let panel = try Self.code("Sources/BaneySpacesCursor/CursorPanel.swift")
        XCTAssertTrue(panel.contains("final class CursorPanel: NSPanel"))
        XCTAssertTrue(panel.contains("override var canBecomeKey: Bool { false }"))
        XCTAssertTrue(panel.contains("override var canBecomeMain: Bool { false }"))
        XCTAssertTrue(panel.contains("ignoresMouseEvents = true"))
        XCTAssertTrue(panel.contains(".nonactivatingPanel"))
        XCTAssertFalse(panel.contains("ignoresMouseEvents = false"))
        XCTAssertTrue(panel.contains("panel.order(.above, relativeTo: Int(placement.id))"), "shown directly above its window, without activating")
        XCTAssertFalse(panel.contains("canJoinAllSpaces"), "on its window's Space only")
        XCTAssertFalse(panel.contains(".transient"), "`.transient` floats across Spaces and over full-screen apps")
        XCTAssertFalse(panel.contains("moveToActiveSpace"), "it never follows you to another Space")
        XCTAssertTrue(panel.contains("fullScreen ? [.managed, .ignoresCycle, .fullScreenAuxiliary] : [.managed, .ignoresCycle]"),
                      "pinned to one Space, and over a full-screen Space only when its window is full screen")
        XCTAssertFalse(panel.contains(".statusBar"), "at its window's level, not over every window")
        XCTAssertTrue(panel.contains("masksToBounds = true"), "clipped to its window")
        XCTAssertTrue(panel.contains("sharingType = .none"), "out of captures unless `agent shot --cursor`")
    }

    func testTheRendererNeverActivatesRaisesPostsInputOrMovesThePointer() throws {
        let banned = ["makeKey", "makeMain", "NSApp.activate", ".activate(", "activate(ignoringOtherApps", "orderFront(", "makeKeyAndOrderFront", "CGEventPost", "CGEvent(",
                      "CGWarpMouseCursorPosition", "CGDisplayMoveCursorToPoint", "SLEventPost", "postToPid", "AXUIElement", "NSEvent.addGlobalMonitor", "NSEvent.addLocalMonitor",
                      "isKeyWindow", "SetFrontProcess", "NSHostingView", "import SwiftUI"]
        for file in Self.renderer + ["Sources/BaneySpaces/Cursor/CursorController.swift", "Sources/BaneySpacesCore/Cursor/CursorDirector.swift"] {
            let text = try Self.code(file)
            for b in banned { XCTAssertFalse(text.contains(b), "\(file) must not contain \(b)") }
        }
    }

    func testTheOverlayIsDrawnWithCoreAnimationLayersAndNoPerFrameWork() throws {
        for file in Self.renderer {
            let text = try Self.code(file)
            for b in ["CADisplayLink", "CVDisplayLink", "Timer.scheduled", "draw(_ dirtyRect", "needsDisplay", "layoutSubtreeIfNeeded", "NSHostingController"] {
                XCTAssertFalse(text.contains(b), "\(file) must not contain \(b)")
            }
        }
        let layers = try Self.code("Sources/BaneySpacesCursor/AgentCursor.swift")
        XCTAssertTrue(layers.contains("CAShapeLayer()"))
        XCTAssertTrue(layers.contains("CATextLayer()"))
        XCTAssertTrue(layers.contains("CAKeyframeAnimation(keyPath: \"position\")"), "a glide is one keyframe animation for the compositor")
        XCTAssertTrue(layers.contains("shadowPath"), "shadows have a path, so no off-screen pass per frame")
        XCTAssertTrue(layers.contains("markOrder"), "the last few marks are kept")
    }

    func testOnlyTheHandsListenerFeedsTheCursorAndItQueuesInsteadOfWaiting() throws {
        let director = try Self.code("Sources/BaneySpacesCore/Cursor/CursorDirector.swift")
        let will = try XCTUnwrap(HandsSourceTests.block(after: "public func handsWillAct(", in: director))
        XCTAssertTrue(will.contains("queue.async"))
        XCTAssertFalse(will.contains("queue.sync"))
        XCTAssertFalse(will.contains("semaphore"))
    }

    func testTheRouterPassesTheTargetFrameAtDispatchAndMeasuresOnlyOnRequest() throws {
        let router = try Self.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let wants = try XCTUnwrap(router.range(of: "HandsEvents.wantsFrame("))
        let will = try XCTUnwrap(router.range(of: "HandsEvents.willAct("))
        let act = try XCTUnwrap(router.range(of: "HandsEngine.shared.act("))
        XCTAssertTrue(wants.lowerBound < will.lowerBound && will.lowerBound < act.lowerBound)
        XCTAssertTrue(router.contains("frameComing: wantsFrame"))
        XCTAssertTrue(router.contains("scope: scope.reason"))
        XCTAssertTrue(router.contains("HandsEngine.shared.measureBounds("), "the bounds are read on the process queue")
        XCTAssertFalse(router.contains("property: \"bounds\""), "and never by a call this thread waits on")
        XCTAssertTrue(router.contains("within: HandsEngine.Budget.bounds"))
        let engine = try Self.code("Sources/BaneySpaces/Hands/HandsEngine.swift")
        XCTAssertTrue(engine.contains("bounds: TimeInterval = 0.05"), "a read that can't start in 50 ms is dropped")
        let measure = try XCTUnwrap(HandsSourceTests.block(after: "func measureBounds(", in: engine))
        XCTAssertFalse(measure.contains("semaphore") || measure.contains(".wait("), "nobody waits for it")
    }

    func testAShotLeavesTheCursorOutUnlessAskedAndTheOverlayIsOutOfCaptures() throws {
        let router = try Self.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        XCTAssertTrue(router.contains("req.bool(\"cursor\") ? host.cursorMark(w.id) : nil"), "default is out")
        let shot = HandsTools.tool(verb: "shot")
        XCTAssertNotNil(shot?.params.first { $0.name == "cursor" && $0.kind == .boolean })
        XCTAssertFalse(shot?.params.first { $0.name == "cursor" }?.required ?? true)
    }

    func testTheProbeCanFail() throws {
        let probe = try Self.code("scripts/cursor-probe.swift")
        XCTAssertTrue(probe.contains("HandsEvents.setListener(director)"), "the events reach the director")
        XCTAssertTrue(probe.contains("let drew ="), "a run that drew nothing fails")
        XCTAssertTrue(probe.contains("apply.count == index"))
        XCTAssertTrue(probe.contains("var sampler: DispatchSourceTimer?"), "the pointer sampler is held for the whole run")
        XCTAssertTrue(probe.contains("sampler = timer"))
        XCTAssertTrue(probe.contains("shared.samples >= 1000"), "a run that sampled nothing fails")
        XCTAssertTrue(probe.contains("let onPlan ="), "the drawn path is held to the plan")
        XCTAssertTrue(probe.contains("err > 3 + speed * interval"), "tolerance: 3 pt plus one frame of travel")
        XCTAssertTrue(probe.contains("frameComing: true") && probe.contains("HandsEvents.frameMeasured"), "fed the way the router feeds it")
        XCTAssertFalse(probe.contains("--onscreen"), "it always runs on the display: an offscreen panel gets no display link")
        XCTAssertFalse(probe.contains("let far ="))
    }

    func testTheCursorHasASwitchInSettingsAndTheCommandLine() throws {
        let session = try Self.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("case \"cursor\":"))
        XCTAssertTrue(session.contains("CursorController.shared.command(args)"))
        let setup = try Self.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("Show each agent's cursor"))
        let controller = try Self.code("Sources/BaneySpaces/Cursor/CursorController.swift")
        XCTAssertTrue(controller.contains("case \"on\":") && controller.contains("case \"off\":") && controller.contains("case \"theme\":"))
        XCTAssertFalse(controller.contains("force"), "no dead parameter")
    }

    func testTheCursorHidesTheMomentYouLeaveTheAgentWorkspace() throws {
        let app = try Self.code("Sources/BaneySpaces/AppDelegate.swift")
        let hook = try XCTUnwrap(HandsSourceTests.block(after: "spaces.onChange = ", in: app))
        XCTAssertTrue(hook.contains("CursorController.shared.environmentChanged()"))
    }
}

final class FocusReturnTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1000)
    var later: Date { now.addingTimeInterval(8) }

    func testAnAgentAppThatTookTheKeyboardGivesItBack() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later)
        XCTAssertEqual(f.activated(pid: 20, bundle: "calc", agentOwned: true, frontNow: 20, now: now), .returnTo(10))
    }

    /// The app can come forward before its pid reaches us, while only the bundle is known.
    func testItWorksBeforeTheProcessIsKnownAndLeavesYourOwnCopyAlone() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(bundle: "calc", excluding: [30], now: now, until: later)
        XCTAssertEqual(f.activated(pid: 20, bundle: "calc", agentOwned: false, frontNow: 20, now: now), .returnTo(10))
        XCTAssertEqual(f.activated(pid: 30, bundle: "calc", agentOwned: false, frontNow: 30, now: now), .none, "a copy already running is yours")
        XCTAssertEqual(f.lastPerson, 30)
    }

    func testItStopsAfterAFewReturnsSoItCantFightYou() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later)
        for _ in 0..<FocusReturn.maxReturns {
            XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now), .returnTo(10))
        }
        XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now), .none)
    }

    /// A late notification: you've moved on, so nothing is pulled back.
    func testALateNotificationDoesntMoveYou() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later)
        XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 11, now: now), .none)
    }

    /// The target is where you are now, not where you were when the launch began.
    func testItReturnsToTheAppYouMovedToDuringTheLaunch() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later)
        _ = f.activated(pid: 11, bundle: nil, agentOwned: false, frontNow: 11, now: now)
        XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now.addingTimeInterval(1)), .returnTo(11))
    }

    /// Two launches at once: neither agent app is ever the place the keyboard goes back to.
    func testAnAgentAppIsNeverTheReturnTarget() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later); f.watch(pid: 21, now: now, until: later)
        XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now), .returnTo(10))
        XCTAssertEqual(f.activated(pid: 21, bundle: nil, agentOwned: true, frontNow: 21, now: now), .returnTo(10))
        XCTAssertEqual(f.lastPerson, 10)
        var g = FocusReturn(); g.seed(front: 20, agentOwned: true)
        XCTAssertNil(g.lastPerson, "an agent's app in front isn't yours")
    }

    /// A second launch of the same app doesn't turn the first launch's process into one of yours.
    func testASecondLaunchKeepsTheFirstLaunchWatched() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(bundle: "calc", excluding: [30], now: now, until: later)
        f.watch(bundle: "calc", excluding: [30, 20], now: now, until: later)
        XCTAssertEqual(f.activated(pid: 20, bundle: "calc", agentOwned: false, frontNow: 20, now: now), .returnTo(10))
        XCTAssertEqual(f.activated(pid: 30, bundle: "calc", agentOwned: false, frontNow: 30, now: now), .none)
    }

    /// Two launches of the same app, the first one's watch over before the second starts, with no activation between:
    /// the second must not inherit the first's list, or the new process (also on it) would count as yours.
    func testAnEndedWatchIsNotMergedIntoTheNextLaunch() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(bundle: "calc", excluding: [30], now: now, until: later)
        // 20 seconds on, nobody activated anything. The second launch ran with 20 and 30 already running.
        let t2 = now.addingTimeInterval(20)
        f.watch(bundle: "calc", excluding: [30, 20], now: t2, until: t2.addingTimeInterval(8))
        XCTAssertEqual(f.activated(pid: 21, bundle: "calc", agentOwned: false, frontNow: 21, now: t2.addingTimeInterval(1)), .returnTo(10))
        XCTAssertEqual(f.activated(pid: 20, bundle: "calc", agentOwned: false, frontNow: 20, now: t2.addingTimeInterval(1)), .none,
                       "20 was running when the second launch began: yours")
    }

    /// A process that used up its returns gets a new count when it is watched again.
    func testANewWatchStartsTheReturnCountAgain() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later)
        for _ in 0..<FocusReturn.maxReturns { _ = f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now) }
        XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now), .none)
        f.watch(pid: 20, now: now.addingTimeInterval(1), until: later.addingTimeInterval(1))
        XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now.addingTimeInterval(2)), .returnTo(10))
    }

    /// Counts go when their watch ends, so a reused pid isn't held to an old tally.
    func testCountsGoWhenTheWatchExpires() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later)
        for _ in 0..<FocusReturn.maxReturns { _ = f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: now) }
        let t = later.addingTimeInterval(5)
        _ = f.activated(pid: 99, bundle: nil, agentOwned: false, frontNow: 99, now: t)   // expires the old watch and its count
        f.watch(bundle: "t", excluding: [], now: t, until: t.addingTimeInterval(8))
        XCTAssertEqual(f.activated(pid: 20, bundle: "t", agentOwned: true, frontNow: 20, now: t.addingTimeInterval(1)), .returnTo(99))
    }

    func testTheWatchEnds() {
        var f = FocusReturn(lastPerson: 10)
        f.watch(pid: 20, now: now, until: later)
        XCTAssertEqual(f.activated(pid: 20, bundle: nil, agentOwned: true, frontNow: 20, now: later.addingTimeInterval(1)), .none)
    }
}
