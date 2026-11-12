import Foundation

/// The one call to make after an error (item 3): always a read, never an action in front of the user, or an explicit
/// none (`next_call: null`) when only the user, or a different request, can move things on.
public enum HandsNextCall {
    /// What an agent should call next after `code`, for the window the request named (nil: not known).
    public static func after(_ code: HandsErrorCode, window: Int?) -> JSONValue {
        let snapshot = window.map { HandsError.call("snapshot", ["window": .int($0)]) } ?? HandsError.call("windows", [:])
        let since = window.map { HandsError.call("snapshot", ["window": .int($0), "since": "latest"]) } ?? HandsError.call("windows", [:])
        switch code {
        case .outsideAgentWorkspace, .appNotFound, .windowNotFound, .ambiguousWindow, .ambiguous, .engineError:
            return HandsError.call("windows", [:])
        case .unknownRef, .staleRef, .ambiguousTarget, .staleBareRow, .inUse:
            return snapshot
        // It may have landed: read what changed before anything else.
        case .actionFailed, .unverified, .timeout:
            return since
        // Only the user can change these (a lend, the agent workspace, a permission), or the request itself is wrong.
        case .agentWorkspaceOff, .needsLend, .needsSandbox, .permissionDenied, .badArguments, .notSupported, .notRunning:
            return .null
        }
    }

    /// The envelope with `error.next_call` filled in where it has none.
    public static func fill(_ env: HandsEnvelope, window: Int?) -> HandsEnvelope {
        guard var e = env.error, e.nextCall == nil else { return env }
        e.nextCall = after(e.code, window: window)
        return .failure(e)
    }
}
