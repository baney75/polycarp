import BaneySpacesCore
import XCTest

/// Guards for three ledger rows that had none: holding Tab lands on the wrong app (G4), going to an
/// empty workspace pulls you back (G5), and an app opened again here takes you to its old workspace
/// (G6). Each test fails with its fix reverted; the probes in scripts/ do the real gestures.
final class HoldTabLandsOnTheHighlightedAppTests: XCTestCase {
    enum Key { case tabDown(Double), tabRepeat(Double), tabUp, cmdUp }

    /// Plays one gesture the way `WorkspaceSwitcher` does: the first Tab shows the switcher on
    /// `SwitcherSelection.first`, every later step comes from `SwitcherGesture`, and ⌘ coming up
    /// commits the highlight. Returns the card it lands on and how many holds fired.
    func play(_ keys: [Key], cards: Int, mode: SwitcherGesture.Mode = .apps) -> (landed: Int, holds: Int) {
        var gesture = SwitcherGesture()
        var selected: Int?
        var holds = 0
        func apply(_ effect: SwitcherGesture.Effect) {
            switch effect {
            case .step(let forward): selected = SwitcherSelection.advance(selected: selected!, count: cards, forward: forward)
            case .hold: holds += 1
            case .none: break
            }
        }
        for key in keys {
            switch key {
            case .tabDown(let t):
                if selected == nil {
                    gesture.begin(at: t)
                    selected = SwitcherSelection.first(count: cards, forward: true)
                } else {
                    apply(gesture.press(forward: true, at: t, mode: mode))
                }
            case .tabRepeat(let t): apply(gesture.held(at: t, mode: mode))
            case .tabUp: apply(gesture.release())
            case .cmdUp: apply(gesture.release())
            }
        }
        return (selected!, holds)
    }

    /// Tab held from `t` for `seconds`, with macOS's repeats every 33 ms after a 250 ms delay.
    func hold(from t: Double, for seconds: Double) -> [Key] {
        [.tabDown(t)] + stride(from: t + 0.25, through: t + seconds, by: 0.033).map { .tabRepeat($0) }
    }

    func testHoldingTabOnTheThirdAppLandsOnTheThirdApp() {
        // ⌘Tab shows the switcher on the second app; one tap moves to the third; then Tab is held
        // a full second and ⌘ comes up with Tab still down.
        let keys: [Key] = [.tabDown(0), .tabUp, .tabDown(0.4), .tabUp] + hold(from: 0.8, for: 1.0) + [.cmdUp]
        let r = play(keys, cards: 5)
        XCTAssertEqual(r.landed, 2, "a held Tab moved the highlight off the third app")
        XCTAssertEqual(r.holds, 1, "a hold opens the window bar once")
    }

    func testAHoldThenLettingGoOfTabFirstStillLandsOnTheHighlightedApp() {
        let keys: [Key] = [.tabDown(0), .tabUp] + hold(from: 0.4, for: 0.9) + [.tabUp, .cmdUp]
        XCTAssertEqual(play(keys, cards: 4).landed, 1)
    }

    func testTapsStillStepOneCardEach() {
        let keys: [Key] = [.tabDown(0), .tabUp, .tabDown(0.2), .tabUp, .tabDown(0.4), .cmdUp]
        XCTAssertEqual(play(keys, cards: 5).landed, 3, "the last tap steps when ⌘ comes up before Tab")
    }

    func testAShortRepeatDelayIsStillATap() {
        // Repeats under the threshold don't make a hold, and the press still steps when let go.
        let keys: [Key] = [.tabDown(0), .tabUp, .tabDown(0.3), .tabRepeat(0.38), .tabRepeat(0.45), .tabUp, .cmdUp]
        let r = play(keys, cards: 5)
        XCTAssertEqual(r.landed, 2)
        XCTAssertEqual(r.holds, 0)
    }

    func testWorkspacesStepOnThePressAndNeverHold() {
        let keys: [Key] = [.tabDown(0), .tabUp] + hold(from: 0.4, for: 1.0) + [.tabUp, .cmdUp]
        let r = play(keys, cards: 4, mode: .workspaces)
        XCTAssertEqual(r.landed, 2)
        XCTAssertEqual(r.holds, 0)
    }

    /// The switcher takes every step from `SwitcherGesture`, and a repeat goes to the hold check before
    /// anything can step.
    func testTheSwitcherStepsOnlyThroughTheGesture() throws {
        let code = try Repo.code("Sources/BaneySpaces/WorkspaceSwitcher.swift")
        let step = try XCTUnwrap(code.range(of: "func step(forward: Bool").flatMap { start in
            code.range(of: "private func held(").map { String(code[start.lowerBound..<$0.lowerBound]) }
        })
        let firstLine = step.split(separator: "\n").dropFirst().first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        XCTAssertEqual(firstLine?.trimmingCharacters(in: .whitespaces), "if isRepeat { return held(at: time, via: \"repeat\") }")
        XCTAssertEqual(step.components(separatedBy: "advance(").count - 1, 1, "one step, from the gesture's press")
        XCTAssertTrue(step.contains("if case .step(let forward) = gesture.press(forward: forward, at: time, mode: gestureMode) { advance(forward) }"))
        XCTAssertTrue(code.contains("gesture.held(at: time, mode: gestureMode) == .hold"))
        XCTAssertFalse(code.contains("hold.press(") || code.contains("hold.release(") || code.contains("hold.repeated("),
                       "TabHold is reached only through SwitcherGesture")
        XCTAssertTrue(code.contains("Trace.log(\"cmdTab landed wrong:"), "speed-report.sh counts this line")
    }
}

final class EmptyWorkspaceKeepsYouThereTests: XCTestCase {
    func testGoingToAnEmptyWorkspaceHandsFocusAway() {
        // Nothing to focus there: macOS will pick an app on its own.
        XCTAssertTrue(HandOff.handsOff(movesFocus: true, hidesFrontApp: false, leavesParkedFront: false, hasWindowToFocus: false))
        XCTAssertTrue(HandOff.handsOff(movesFocus: true, hidesFrontApp: true, leavesParkedFront: false, hasWindowToFocus: true))
        XCTAssertTrue(HandOff.handsOff(movesFocus: true, hidesFrontApp: false, leavesParkedFront: true, hasWindowToFocus: true))
        XCTAssertFalse(HandOff.handsOff(movesFocus: true, hidesFrontApp: false, leavesParkedFront: false, hasWindowToFocus: true))
        XCTAssertFalse(HandOff.handsOff(movesFocus: false, hidesFrontApp: true, leavesParkedFront: true, hasWindowToFocus: false))
    }

    func testTheAppSpacesHidThatMacOSBringsForwardIsNotFollowed() {
        // Ghostty was in front on 1; going to empty 3 hid it; macOS activated it again 80 ms later.
        XCTAssertTrue(HandOff.cameForwardOnItsOwn(parked: false, hiddenByUs: true, sinceHandOff: 0.08))
        XCTAssertTrue(HandOff.cameForwardOnItsOwn(parked: true, hiddenByUs: false, sinceHandOff: 0.3))
    }

    func testAnAppYouPickLaterOrOneSpacesNeverPutAwayIsFollowed() {
        XCTAssertFalse(HandOff.cameForwardOnItsOwn(parked: false, hiddenByUs: true, sinceHandOff: 0.6))
        XCTAssertFalse(HandOff.cameForwardOnItsOwn(parked: false, hiddenByUs: false, sinceHandOff: 0.05))
        XCTAssertEqual(HandOff.window, 0.5)
    }

    func testFollowFocusAndTheSwitchUseTheseRules() throws {
        let code = try Repo.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(code.contains("if HandOff.cameForwardOnItsOwn(parked: saved.frames[w.id] != nil && parkedPids().contains(pid),"))
        XCTAssertTrue(code.contains("hiddenByUs: saved.hiddenApps.contains(pid),"))
        XCTAssertTrue(code.contains("sinceHandOff: activatedAt.timeIntervalSince(max(leftAt, handedOffAt))"))
        XCTAssertTrue(code.contains("if HandOff.handsOff(movesFocus: moveFocus, hidesFrontApp: !deferred.isEmpty,"))
        XCTAssertTrue(code.contains("leavesParkedFront: leavingParked != nil, hasWindowToFocus: target != nil) { handedOffAt = Date() }"))
        XCTAssertFalse(code.contains("let putAway ="), "the rule lives in HandOff")
    }
}

final class AppOpenedAgainLandsHereTests: XCTestCase {
    func testTheGraceOutlastsGhosttysNewWindow() {
        // Ghostty's new window came 54 ms after it activated (measured 10-13); with no wait you were
        // taken to its old workspace before the window existed.
        XCTAssertGreaterThanOrEqual(NewWindowGrace.seconds, 2 * 0.054)
        // A Dock click on an app elsewhere must still feel immediate.
        XCTAssertLessThanOrEqual(NewWindowGrace.seconds, 0.3)
    }

    func testFollowFocusWaitsTheGraceForANewWindowBeforeLeaving() throws {
        let code = try Repo.code("Sources/BaneySpaces/Spaces.swift")
        let follow = try XCTUnwrap(code.range(of: "private func followFocus()").flatMap { start in
            code.range(of: "private func hideOnceBehind(").map { String(code[start.lowerBound..<$0.lowerBound]) }
        })
        let wait = try XCTUnwrap(follow.range(of: "waitUntil(timeout: NewWindowGrace.seconds, interval: 0.02, {"))
        let leave = try XCTUnwrap(follow.range(of: "switchTo(n, announce: true)"))
        let stay = try XCTUnwrap(follow.range(of: "if showNewWindow(of: pid, besides: known) {", range: wait.upperBound..<follow.endIndex))
        XCTAssertLessThan(wait.lowerBound, stay.lowerBound)
        XCTAssertLessThan(stay.lowerBound, leave.lowerBound, "a new window here is shown before you'd be taken away")
        XCTAssertEqual(follow.components(separatedBy: "switchTo(n, announce: true)").count - 1, 1, "no way to leave before the wait")
    }
}
