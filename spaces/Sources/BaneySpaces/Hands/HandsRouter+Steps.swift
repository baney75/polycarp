import BaneySpacesCore
import Foundation

extension HandsRouter {
    /// `run-steps`: every step checked and its window found before any runs; each window's consecutive steps in one engine
    /// transaction (the engine runs a step's own calls inline on that queue); a stop at the first failed, unverified or
    /// dialog-raising step; one read at the end.
    func runSteps(_ req: HandsRequest) -> HandsEnvelope {
        var steps: [HandsRequest]
        switch RunSteps.parse(req.args["steps"], session: req.session, wait: req.int("wait")) {
        case .failure(let e): return .failure(e)
        case .success(let s): steps = s
        }
        // Row numbers mean the latest snapshot before the run, resolved now: a step's own reads never shift them.
        var windows: [Int] = []
        for i in steps.indices {
            if let r = steps[i].string("ref") {
                if let e = SnapshotRows.browserRefError(r) { return .failure(stepError(i, e)) }
                if let n = SnapshotRows.bareNumber(r) {
                    switch bareRef(n, steps[i]) {
                    case .success(let full): steps[i].args["ref"] = .string(full)
                    case .failure(let e): return .failure(stepError(i, e))
                    }
                }
            }
            guard let id = windowOf(steps[i]) else {
                return .failure(stepError(i, HandsError(.unknownRef, "Polycarp didn't print \(steps[i].string("ref") ?? "that ref")", suggestion: "Take a snapshot of the window and use the refs it prints", retry: .afterSnapshot)))
            }
            windows.append(id)
        }
        let session = req.session ?? ""
        let started = Date()
        var lines: [JSONValue] = [], stop: RunSteps.Stop?, last = windows[0], opened: JSONValue?
        run: for g in RunSteps.groups(windows) {
            let id = windows[g.lowerBound]
            let w: HandsWindow
            switch target(HandsRequest(verb: "snapshot", args: ["window": .int(id)], session: req.session)) {
            case .success(let (t, _, _)): w = t
            case .failure(let e):
                let (line, why) = RunSteps.refused(e, group: g, steps: steps)
                lines += line.map { [$0] } ?? []
                stop = why
                break run
            }
            last = id
            // The in-use wait, before the transaction takes the app's queue: one wait per step's verb and delivery, none
            // past the deadline. Inside, steps run with wait 0 (251 r1 second-S1).
            let until = started.addingTimeInterval(RunSteps.deadline)
            for i in g {
                let wait = RunSteps.clamped(steps[i], left: until.timeIntervalSinceNow).int("wait")
                if let e = awaitUse(w, verb: steps[i].verb, delivery: RunSteps.delivery(steps[i]), wait: wait, session: session) {
                    let (line, why) = RunSteps.refused(e, group: g, steps: steps)
                    lines += line.map { [$0] } ?? []
                    stop = why
                    break
                }
            }
            if stop != nil { break }
            // Each line is published as its step finishes, so a transaction that outlives its budget still reports what ran.
            let progress = RunSteps.Progress()
            let reply = HandsEngine.shared.transaction(window: w, until: until, check: check(w, session: session)) { [self] cancelled in
                var why: RunSteps.Stop?, raised: JSONValue = .null
                for i in g {
                    let left = until.timeIntervalSinceNow
                    if cancelled() || left <= 0 { why = .time; break }
                    progress.begin(i)
                    let env = HandsNextCall.fill(handle(RunSteps.inTransaction(steps[i])), window: id)
                    why = RunSteps.stop(after: env)
                    progress.finish(RunSteps.line(i + 1, steps[i], env, full: why != nil))
                    if why != nil { raised = env.data?["opened"] ?? .null; break }
                }
                return .ok(.object(["stop": why.map { .string($0.rawValue) } ?? .null, "opened": raised]))
            }
            switch reply {
            case .failed(let e):
                // The transaction didn't start (the window left scope) or outlived its budget: the steps that ran keep their
                // lines, and one still running then may still land.
                let (done, why) = RunSteps.lines(failed: e, progress: progress, group: g, steps: steps)
                lines += done
                stop = why
            case .ok(let v):
                lines += progress.state.lines
                stop = v["stop"]?.string.flatMap(RunSteps.Stop.init(rawValue:))
                opened = v["opened"]
            }
            if stop != nil { break }
        }
        // One read: the dialog a step raised, or what changed in the last window used.
        let dialog = (opened?.array?.first ?? opened)?["window"]?.int
        let readReq = dialog.map { HandsRequest(verb: "snapshot", args: ["window": .int($0), "format": "rows", "max_elements": .int(60)], session: req.session) }
            ?? HandsRequest(verb: "snapshot", args: ["window": .int(last), "since": "latest"], session: req.session)
        let read = handle(readReq)
        return .success(RunSteps.answer(lines: lines, total: steps.count, stop: stop, read: read.data, readError: read.error))
    }

    private func stepError(_ i: Int, _ e: HandsError) -> HandsError {
        HandsError(e.code, "step \(i + 1): \(e.message)", suggestion: RunSteps.nothingRan(e.suggestion), retry: e.retry, nextCall: e.nextCall)
    }
}
