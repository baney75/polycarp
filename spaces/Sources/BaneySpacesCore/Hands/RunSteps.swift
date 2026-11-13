import Foundation

/// `run-steps`: several act verbs in one call. Every step is checked before any runs; the steps on one window run in one
/// transaction on its process's queue, so no other action lands between them; the run stops at the first step that
/// fails, isn't verified or raises a dialog or sheet; one read of what changed ends it.
public enum RunSteps {
    public static let maxSteps = 32
    /// What a step may be: the verbs that act on one window. Not open, close, move or arrange (they manage windows and run
    /// their own serial work), not reads (the run reads once at the end), and never run-steps itself.
    public static let verbs: Set<String> = ["click", "type", "set-value", "press", "click-at", "drag", "scroll", "select", "toggle", "menu"]
    /// No new step starts after this many seconds, well inside the transaction's budget.
    public static let deadline: TimeInterval = 40

    /// Every step as a request, or the first step that is wrong. `{"tool": "click", "args": {"ref": "5"}}`; the tool may
    /// carry the `computer_` prefix, and the arguments may sit beside `tool` instead of in `args`. A step without its own
    /// `wait` gets the run's.
    public static func parse(_ steps: JSONValue?, session: String?, wait: Int?) -> Result<[HandsRequest], HandsError> {
        guard let list = steps?.array, !list.isEmpty else { return .failure(bad("steps is missing: pass a list of {tool, args}")) }
        if list.count > maxSteps { return .failure(bad("at most \(maxSteps) steps, not \(list.count)")) }
        var out: [HandsRequest] = []
        for (i, step) in list.enumerated() {
            let n = i + 1
            guard var o = step.object, let raw = o.removeValue(forKey: "tool")?.string else { return .failure(bad("step \(n) has no tool")) }
            var name = raw.hasPrefix("computer_") ? String(raw.dropFirst("computer_".count)) : raw
            name = name.replacingOccurrences(of: "_", with: "-")
            guard verbs.contains(name) else {
                return .failure(bad("step \(n): \(raw) can't be a step; steps are \(verbs.sorted().joined(separator: ", "))"))
            }
            var args = o.removeValue(forKey: "args")?.object ?? [:]
            for (k, v) in o { args[k] = v }
            if args["wait"] == nil, let wait { args["wait"] = .int(wait) }
            switch HandsParse.call(name: name, arguments: args, session: session) {
            case .failure(let e): return .failure(HandsError(.badArguments, "step \(n) (\(name)): \(e.message)", suggestion: nothingRan(e.suggestion), retry: .safe, nextCall: .null))
            case .success(let r): out.append(r)
            }
        }
        return .success(out)
    }

    /// Consecutive steps on the same window, as index ranges: each range is one transaction.
    public static func groups(_ windows: [Int]) -> [Range<Int>] {
        guard !windows.isEmpty else { return [] }
        var out: [Range<Int>] = []
        var start = 0
        for i in 1...windows.count where i == windows.count || windows[i] != windows[start] {
            out.append(start..<i)
            start = i
        }
        return out
    }

    public enum Stop: String, Sendable { case failed, unverified, opened, time, gone, landing }

    /// The step as it runs `left` seconds before the deadline: its in-use wait never goes past the deadline, so a step that
    /// starts inside it can't outlive the transaction by waiting.
    public static func clamped(_ step: HandsRequest, left: TimeInterval) -> HandsRequest {
        var s = step
        let room = max(0, Int(left.rounded(.down)))
        s.args["wait"] = .int(min(Int(InUseRule.bound(step.int("wait"))), room))
        return s
    }

    /// How a step reaches its app, for the in-use wait done before its group's transaction: keys, pointer events, the
    /// menu bar and a right click are posted; every other step is the engine's headless accessibility path.
    public static func delivery(_ step: HandsRequest) -> InUseDelivery {
        if ["press", "click-at", "drag", "menu"].contains(step.verb) { return .posted }
        if step.verb == "click", step.string("button")?.lowercased() == "right" { return .posted }
        return .headlessAX
    }

    /// The step as it runs inside its group's transaction: it never waits there, since the transaction holds its app's
    /// queue and every read of that app would wait behind it. The group waited before it started (251 r1 second-S1).
    public static func inTransaction(_ step: HandsRequest) -> HandsRequest {
        var s = step
        s.args["wait"] = .int(0)
        return s
    }

    /// A group refused before it started (its window couldn't be targeted, or the app stayed in use): gone only when the
    /// window or ref is, else that refusal is the group's first step's line, with its code and next call (251 r1 second-S2).
    public static func refused(_ e: HandsError, group: Range<Int>, steps: [HandsRequest]) -> (line: JSONValue?, stop: Stop) {
        if [.windowNotFound, .staleRef].contains(e.code) { return (nil, .gone) }
        return (line(group.lowerBound + 1, steps[group.lowerBound], .failure(e), full: true), .failed)
    }

    /// `suggestion` and then "Nothing ran.", one period between them (251 r1 first-F4).
    public static func nothingRan(_ suggestion: String) -> String {
        var s = suggestion.trimmingCharacters(in: .whitespaces)
        while s.hasSuffix(".") { s.removeLast() }
        return s.isEmpty ? "Nothing ran." : s + ". Nothing ran."
    }

    /// What a group's transaction has done so far, under a lock: when the transaction outlives its budget its reply is
    /// dropped, and this is what the router can still read.
    public final class Progress: @unchecked Sendable {
        private let lock = NSLock()
        private var done: [JSONValue] = []
        private var running: Int?
        public init() {}
        /// Step `i` (0-based) starts.
        public func begin(_ i: Int) { lock.lock(); running = i; lock.unlock() }
        /// The running step finished, with its line.
        public func finish(_ line: JSONValue) { lock.lock(); done.append(line); running = nil; lock.unlock() }
        public var state: (lines: [JSONValue], running: Int?) { lock.lock(); defer { lock.unlock() }; return (done, running) }
    }

    /// The lines of a group whose transaction failed with `e`: the steps that finished, and the one still running then,
    /// which may still land. Only when no step began does the group's first step carry `e`: then nothing ran.
    public static func lines(failed e: HandsError, progress: Progress, group: Range<Int>, steps: [HandsRequest]) -> (lines: [JSONValue], stop: Stop) {
        let (done, running) = progress.state
        if let i = running {
            let why = HandsError(e.code, "step \(i + 1) was still running when the run ran out of time, so it may still land",
                                 suggestion: "Read the window (the read below) before you send it again", retry: .never)
            var o = line(i + 1, steps[i], .failure(why), full: true).object ?? [:]
            o["may_land"] = .bool(true)
            return (done + [.object(o)], .landing)
        }
        if let last = done.last { return (done, last["ok"]?.bool == false ? .failed : .time) }
        return ([line(group.lowerBound + 1, steps[group.lowerBound], .failure(e), full: true)], .failed)
    }

    /// Why the run stops after this step's answer, or nil to go on.
    public static func stop(after env: HandsEnvelope) -> Stop? {
        if !env.ok { return .failed }
        if env.data?["opened"].map({ $0 != .null }) == true { return .opened }
        if env.data?["verified"]?.bool == false { return .unverified }
        return nil
    }

    /// One step's line in the answer: short, unless it is the step the run stopped on, which keeps its whole answer.
    public static func line(_ n: Int, _ req: HandsRequest, _ env: HandsEnvelope, full: Bool) -> JSONValue {
        var o: [String: JSONValue] = ["step": .int(n), "tool": .string(req.verb), "ok": .bool(env.ok)]
        if let e = env.error { o["error"] = .object(["code": .string(e.code.rawValue), "message": .string(e.message), "suggestion": .string(e.suggestion)]) }
        if let d = env.data {
            for k in ["verified", "landed", "opened"] { if let v = d[k] { o[k] = v } }
            if let v = d["evidence"]?["value"] { o["value"] = v }
            if full { o["result"] = d }
        }
        return .object(o)
    }

    /// The whole answer. `read`: the closing read, rows of what changed (or the dialog's rows when one opened).
    public static func answer(lines: [JSONValue], total: Int, stop: Stop?, read: JSONValue?, readError: HandsError?) -> JSONValue {
        let done = lines.filter { $0["ok"]?.bool == true }.count
        var o: [String: JSONValue] = ["steps": .array(lines), "done": .int(done), "of": .int(total), "complete": .bool(stop == nil && done == total)]
        if let stop {
            o["stopped"] = .string(stop.rawValue)
            o["note"] = .string(note(stop, at: lines.count, total: total))
        }
        if let read { o["read"] = read }
        if let readError { o["read_error"] = .string(readError.message) }
        return .object(o)
    }

    static func note(_ stop: Stop, at n: Int, total: Int) -> String {
        let rest = total - n
        let left = rest > 0 ? "; the \(rest) after it did not run" : ""
        switch stop {
        case .failed: return "step \(n) failed\(left). Its error says what to do."
        case .unverified: return "step \(n) ran but nothing read back shows it landed\(left). Check the read below before going on."
        case .opened: return "step \(n) raised a dialog or sheet\(left). Answer it (the read below shows it), then continue."
        case .time: return "the run reached \(Int(deadline)) s, so the last \(rest) did not start. Read, then send them again."
        case .gone: return "the window of step \(n + 1) went away, so the last \(rest) did not run."
        case .landing: return "step \(n) was still running when the run ran out of time and may still land\(left). Read the window before sending it again."
        }
    }

    static func bad(_ why: String) -> HandsError {
        HandsError(.badArguments, why, suggestion: #"Example: {"steps":[{"tool":"click","args":{"ref":"5"}},{"tool":"type","args":{"ref":"7","text":"hi"}}]}"#, retry: .safe, nextCall: .null)
    }
}
