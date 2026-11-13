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
        for g in RunSteps.groups(windows) {
            let id = windows[g.lowerBound]
            guard case .success(let (w, _, _)) = target(HandsRequest(verb: "snapshot", args: ["window": .int(id)], session: req.session)) else { stop = .gone; break }
            last = id
            let reply = HandsEngine.shared.transaction(window: w, check: check(w, session: session)) { [self] cancelled in
                var out: [JSONValue] = [], why: RunSteps.Stop?, raised: JSONValue = .null
                for i in g {
                    if cancelled() || Date().timeIntervalSince(started) > RunSteps.deadline { why = .time; break }
                    let env = HandsNextCall.fill(handle(steps[i]), window: id)
                    why = RunSteps.stop(after: env)
                    out.append(RunSteps.line(i + 1, steps[i], env, full: why != nil))
                    if why != nil { raised = env.data?["opened"] ?? .null; break }
                }
                return .ok(.object(["lines": .array(out), "stop": why.map { .string($0.rawValue) } ?? .null, "opened": raised]))
            }
            switch reply {
            case .failed(let e):
                // The transaction didn't start (the window left scope) or outlived its budget; its first step carries why.
                lines.append(RunSteps.line(g.lowerBound + 1, steps[g.lowerBound], .failure(e), full: true))
                stop = .failed
            case .ok(let v):
                lines += v["lines"]?.array ?? []
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
        HandsError(e.code, "step \(i + 1): \(e.message)", suggestion: e.suggestion + ". Nothing ran.", retry: e.retry, nextCall: e.nextCall)
    }
}
