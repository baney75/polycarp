import Foundation

/// How Donovan's use of an app stands right now, from `UserUse`.
public enum InUseState: Equatable, Sendable {
    case free
    /// The app is in front.
    case front
    /// The app left the front `leftAgo` seconds ago and is free in `freeIn` seconds.
    case recent(leftAgo: TimeInterval, freeIn: TimeInterval)

    public var busy: Bool { self != .free }

    /// "<App> is in front" or "<App> left the front N s ago; free in M s". Nil when it is free.
    public func describe(_ app: String) -> String? {
        switch self {
        case .free: return nil
        case .front: return "\(app) is in front"
        case .recent(let ago, let left):
            return "\(app) left the front \(Int(ago.rounded(.down))) s ago; free in \(max(1, Int(left.rounded(.up)))) s"
        }
    }

    /// The short note `windows` puts beside a window of an app in use.
    public func note(_ app: String) -> String? {
        describe(app).map { "\($0). Reads work now; an action on it waits until \(app) is free (up to `wait` seconds)." }
    }
}

/// How an action reaches the app.
public enum InUseDelivery: Equatable, Sendable {
    /// The engine's strict Headless accessibility path: no keyboard focus, no events. `HandsEngine.act` always takes it;
    /// under that policy the engine's `type` writes the element's selected text through accessibility and never posts keys.
    case headlessAX
    /// Keys or pointer events posted to the process (`press`, `click-at`, `drag`), or a launch (`open`).
    case posted
}

/// What an agent may do while Donovan is using an app (Donovan, 2026-11-10: agents work in the background without him
/// babysitting them). Reads never wait. An action waits for the app to be free, except a semantic accessibility verb on a
/// window of the agent workspace that is neither the app's focused window nor its main window.
public enum InUseRule {
    /// The verbs that only read: in use never applies to them.
    public static let reads: Set<String> = ["windows", "workspaces", "snapshot", "find", "get", "shot"]
    /// The verbs that act through accessibility on an element and need no keyboard focus.
    public static let semantic: Set<String> = ["click", "set-value", "select", "toggle", "scroll", "type"]
    /// How long an action waits when the caller says nothing, and the most it may ask for.
    public static let defaultWait: TimeInterval = 20
    public static let maxWait: Int = 120
    /// How often a waiting action looks again.
    public static let poll: TimeInterval = 0.25

    /// The wait an action asked for, in seconds: `wait` clamped to 0...120, 20 when it is missing.
    public static func bound(_ asked: Int?) -> TimeInterval {
        guard let asked else { return defaultWait }
        return TimeInterval(min(max(asked, 0), maxWait))
    }

    public enum Verdict: Equatable, Sendable {
        /// Not in use (or a read): go ahead.
        case proceed
        /// In use, but this action touches a background window of it without focus or events: go ahead.
        case otherWindow
        /// In use: wait until it is free.
        case wait
    }

    /// The one decision, from facts read at the moment it is made. `isFocusedWindow` and `isMainWindow` come from the app's
    /// accessibility (`AXFocusedWindow`, `AXMainWindow`); nil when they could not be read, which never lets an action through.
    public static func decide(verb: String, state: InUseState, onAgentWorkspace: Bool,
                              isFocusedWindow: Bool?, isMainWindow: Bool?, delivery: InUseDelivery) -> Verdict {
        if reads.contains(verb) || !state.busy { return .proceed }
        guard semantic.contains(verb), delivery == .headlessAX, onAgentWorkspace,
              isFocusedWindow == false, isMainWindow == false else { return .wait }
        return .otherWindow
    }
}

/// The wait itself, with the clock and the pause passed in so it can be tested without sleeping. It runs on the caller's
/// own thread (never the main one) before anything is dispatched.
public enum InUseWait {
    public enum Step: Equatable, Sendable {
        case ready
        case busy(InUseState)
        case refused(HandsError)
    }

    public enum Outcome: Equatable, Sendable {
        case ready(waited: TimeInterval)
        case refused(HandsError)
        case timedOut(InUseState, waited: TimeInterval)
    }

    /// One look: Read Only and the scope decision first (either refuses at once, and stops a wait under way), then in use.
    public static func step(mode: AgentAccessMode, scope: ScopeDecision, state: InUseState, verdict: InUseRule.Verdict) -> Step {
        if let e = AgentAccessGate.actingRefusal(mode: mode) { return .refused(e) }
        if case .denied(let e) = scope { return .refused(e) }
        return verdict == .wait ? .busy(state) : .ready
    }

    /// Looks, then pauses `poll` seconds between looks, until `check` is ready or refuses, or `bound` seconds have passed.
    /// A bound of 0 looks once.
    public static func run(bound: TimeInterval, poll: TimeInterval = InUseRule.poll, now: () -> Date,
                           sleep: (TimeInterval) -> Void, check: () -> Step) -> Outcome {
        let start = now()
        while true {
            switch check() {
            case .ready: return .ready(waited: now().timeIntervalSince(start))
            case .refused(let e): return .refused(e)
            case .busy(let s):
                let waited = now().timeIntervalSince(start)
                guard waited < bound else { return .timedOut(s, waited: waited) }
                sleep(poll)
            }
        }
    }

    /// What an agent hears when the app stayed in use. It tells the agent what to do on its own; asking Donovan to leave the
    /// app is for when he wants the result now. `waited` is nil for the check right before delivery, after the wait had
    /// found the app free.
    public static func refusal(app: String, state: InUseState, waited: TimeInterval?) -> HandsError {
        HandsError(.inUse, state.describe(app) ?? "\(app) is in use",
                   suggestion: suggestion(app: app, waited: waited), retry: .safe)
    }

    public static func suggestion(app: String, waited: TimeInterval?) -> String {
        let how: String
        switch waited {
        case nil: how = "Donovan came back to \(app) just before the action was delivered, so nothing was sent."
        case let w? where w < 0.5: how = "Polycarp did not wait (wait was 0)."
        case let w?: how = "Polycarp waited \(Int(w.rounded())) s."
        }
        return how + " Retry later, with a longer `wait` (up to \(InUseRule.maxWait) s), or work on another window meanwhile; reads (snapshot, find, get, shot) work now. "
            + "Do not ask Donovan to switch away from \(app) unless he asked for this result right now."
    }
}

/// One row of `windows`.
public enum HandsWindowList {
    public static func entry(_ w: HandsWindow, scope: ScopeDecision, inUse: InUseState) -> JSONValue {
        var o: [String: JSONValue] = ["id": .int(Int(w.id)), "pid": .int(Int(w.pid)), "app": .string(w.app), "title": .string(w.title),
                                      "workspace": w.workspace.map(JSONValue.int) ?? .null, "scope": .string(scope.reason)]
        if let note = inUse.note(w.app) {
            o["in_use"] = .bool(true)
            o["in_use_note"] = .string(note)
        }
        return .object(o)
    }
}
