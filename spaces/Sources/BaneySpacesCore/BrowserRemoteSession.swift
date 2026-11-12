import Foundation

/// What Settings > Browser's remote section remembers between helper answers, and what each answer or click decides: which
/// passcode and connect code to keep, when the Funnel retry runs or pauses, when to ask `remote fix` for a plan.
/// BrowserRemoteModel holds one and carries out the effects (the helper, timers, a page to open). Every decision is here, so
/// it is tested by value, not by reading the model's source (PR 134 review round 2, first-F5).
public struct RemoteSession: Equatable {
    /// The last `remote setup` answer, with its secrets taken out: they live only in `passcode` and `connectCode` (first-F2).
    public private(set) var setup: RemoteReport?
    /// The approval passcode, from the run that made it. Shown until the person says they've saved it.
    public private(set) var passcode: String?
    /// The one-time code that approves a new assistant. Taken only from a run a person pressed.
    public private(set) var connectCode: ConnectCode?
    /// Checks from the internet: setup's proof, then `remote test`, then `remote fix`.
    public private(set) var checks: [RemoteCheck] = []
    /// What `remote fix` would repair. Nil until asked; `available: false` from a helper without it.
    public private(set) var fixPlan: RemoteFixPlan?
    public private(set) var funnel = FunnelRetry()
    /// Views showing the section. The reads and retries run only while one does.
    public private(set) var watchers = 0
    /// `remote test` ran in this visit to the On screen.
    public private(set) var testedThisVisit = false

    public init() {}

    /// What the model does after a decision.
    public enum Effect: Equatable {
        /// Ask `remote fix --dry-run` what it would repair.
        case planFix
        /// Open Tailscale's page for allowing Funnel.
        case open(URL)
        case startFunnelTimer, stopFunnelTimer
        /// Run `remote test` again in a while, if the On screen is waiting on a check.
        case recheckIfWaiting
        /// Nothing shows the section any more: stop the reads, the Funnel timer and the recheck. The retry's clock is kept.
        case pause
    }

    /// Repair has something to be about: a check failed for real, or the answer names `remote fix`. `offerRepair`'s rule
    /// without the plan, so a plan is asked for whenever Repair would be offered (second-F6).
    public var wantsRepair: Bool { checks.contains(where: \.realFailure) || setup?.needsRepair == true }

    /// Repair shows: something to repair, and this helper's `remote fix` has something to do.
    public var offersRepair: Bool { RemoteFlow.offerRepair(checks: checks, plan: fixPlan, answer: setup) }

    // MARK: Watching

    /// A view shows the section. The first one back on a step that still refuses Funnel resumes the retry, without opening
    /// Tailscale's page again.
    public mutating func startWatching(now: Date) -> [Effect] {
        watchers += 1
        guard watchers == 1, funnel.resume(setup: setup, now: now) else { return [] }
        return [.startFunnelTimer]
    }

    /// A view stopped showing it (another tab, or the window closing). The last one pauses everything. The secrets stay: a tab
    /// switch must not lose a passcode shown once, and closing the window clears them (`clearSecrets`).
    public mutating func stopWatching() -> [Effect] {
        // An extra stop (no view was showing it) changes nothing.
        guard watchers > 0 else { return [] }
        watchers -= 1
        guard watchers == 0 else { return [] }
        testedThisVisit = false
        return [.pause]
    }

    /// The Settings window closed: the passcode and connect code are forgotten, wherever they were held.
    public mutating func clearSecrets() {
        passcode = nil; connectCode = nil
        setup?.passcode = nil; setup?.connectCode = nil
    }

    // MARK: Setup

    /// A setup run starts. Returns whether it asks for a connect code: only a press does (PR 133 second-N2). The quiet Funnel
    /// retry records its try and keeps running; a press ends it.
    public mutating func setupStarts(quiet: Bool, now: Date) -> (connectCode: Bool, effects: [Effect]) {
        if quiet { funnel.tried(now: now); return (false, []) }
        funnel.stop()
        return (true, [.stopFunnelTimer])
    }

    /// A setup answer to show. `pressed`: a person pressed Turn on, Try again or Check again; only then is a connect code taken.
    public mutating func take(_ report: RemoteReport, pressed: Bool, now: Date) -> [Effect] {
        passcode = RemoteFlow.keepPasscode(current: passcode, from: report)
        // An answer that needs repair is not on: it brings no code.
        if pressed, report.answerOn, let code = report.connectCode { connectCode = code }
        if !report.checks.isEmpty { checks = report.checks }
        var kept = report
        kept.passcode = nil; kept.connectCode = nil
        setup = kept
        var effects: [Effect] = []
        if report.state == .funnelNotAllowed {
            // The page opens once per refusal run, since allowing Funnel is the step.
            if let page = funnel.refused(admin: report.adminURL, now: now) { effects.append(.open(page)) }
            effects.append(.startFunnelTimer)
        } else {
            funnel.stop()
            effects.append(.stopFunnelTimer)
        }
        if report.answerOn {
            testedThisVisit = true
            if !report.failedChecks.isEmpty { effects.append(.planFix) }
            effects.append(.recheckIfWaiting)
        } else if RemoteSharedCopy.key(state: report.rawState, code: report.code, nextKind: report.nextKind, nextCommand: report.nextCommand) == "check_failed" {
            effects.append(.planFix)
        }
        return effects
    }

    /// One tick of the Funnel retry's clock.
    public mutating func funnelTick(busy: Bool, now: Date) -> FunnelRetry.Tick { funnel.tick(setup: setup, busy: busy, now: now) }

    /// A status read arrived: a setup answer it confirms or outdates ends. True when that changed anything.
    public mutating func settle(status: RemoteReport) -> Bool {
        let kept = RemoteFlow.settle(setup: setup, status: status)
        guard kept != setup else { return false }
        setup = kept
        return true
    }

    /// The person picked a route, or pressed Check again: the last answer no longer speaks for the screen.
    public mutating func forgetSetup(stopRetry: Bool) -> [Effect] {
        setup = nil
        guard stopRetry else { return [] }
        funnel.stop()
        return [.stopFunnelTimer]
    }

    // MARK: Checks and Repair

    /// `remote test` may run now: on Check again (`force`), or once per visit to the On screen.
    public mutating func startTest(force: Bool) -> Bool {
        guard force || !testedThisVisit else { return false }
        testedThisVisit = true
        return true
    }

    /// `remote test` answered.
    public mutating func tested(_ answer: RemoteReport?) -> [Effect] {
        if let answer, !answer.checks.isEmpty { checks = answer.checks }
        // A run that stopped on dns or a failed check is over once this test says the route is on.
        setup = RemoteFlow.settleAfterTest(setup: setup, checks: checks)
        return (checks.contains(where: \.realFailure) ? [.planFix] : []) + [.recheckIfWaiting]
    }

    public mutating func planned(_ plan: RemoteFixPlan) { fixPlan = plan }

    /// `remote fix --yes` answered. The old plan is spent; a new one is asked for whenever Repair would still be offered, so a
    /// Repair that left the step as it was can be pressed again (second-F6).
    public mutating func repaired(_ done: RemoteFixPlan) -> [Effect] {
        if !done.checks.isEmpty { checks = done.checks }
        fixPlan = nil
        return (wantsRepair ? [.planFix] : []) + [.recheckIfWaiting]
    }

    // MARK: Codes and turning off

    public mutating func madePasscode(_ code: String) { passcode = code }
    public mutating func madeConnectCode(_ code: ConnectCode) { connectCode = code }
    public mutating func savedPasscode() { passcode = nil }

    /// `remote off` worked: nothing from the old route is kept.
    public mutating func turnedOff() -> [Effect] {
        setup = nil; passcode = nil; connectCode = nil; checks = []; fixPlan = nil
        funnel.stop()
        return [.stopFunnelTimer]
    }

    /// The render harness's result screen: a made-up code and checks, in memory, never from the helper.
    public mutating func stageForRender(code: ConnectCode?, passcode: String?, checks: [RemoteCheck], plan: RemoteFixPlan?) {
        connectCode = code; self.passcode = passcode; self.checks = checks; fixPlan = plan; testedThisVisit = true
    }
}
