import Foundation

/// Why an agent command failed. Every error carries one of these, whether it came from BaneySpaces'
/// own checks or from the engine, so an agent can branch on `code` without reading prose.
public enum HandsErrorCode: String, Codable, CaseIterable, Sendable {
    /// The window isn't on the agent workspace and its app isn't lent.
    case outsideAgentWorkspace = "outside_agent_workspace"
    /// `baneyspaces agent on` hasn't been run, so there is no agent workspace.
    case agentWorkspaceOff = "agent_workspace_off"
    /// No such app running, or none by that name.
    case appNotFound = "app_not_found"
    /// No such window (closed, or never existed).
    case windowNotFound = "window_not_found"
    /// An app-wide request matched more than one window and the caller must say which.
    case ambiguousWindow = "ambiguous_window"
    /// An app name matched more than one running process; name a window or a pid.
    case ambiguous = "ambiguous"
    /// The app belongs to the user, not the agent workspace, and nobody has lent it. Lending is Donovan's
    /// to do (the menu, the launcher, or a terminal he types in); an agent can only ask.
    case needsLend = "needs_lend"
    /// The app exists once per user and holds his data (Safari, Notes, Mail…): agent work on it belongs in
    /// the sandbox (phase 2), never on his Mac.
    case needsSandbox = "needs_sandbox"
    /// An action met an app the user is using (in front, or left the front less than `UserUse.quiet` seconds ago) and the
    /// wait for it ran out. Reads never get it.
    case inUse = "in_use"
    /// The ref isn't known: from another session, or never printed by a snapshot.
    case unknownRef = "unknown_ref"
    /// The ref no longer points at the element it did, or its snapshot expired.
    case staleRef = "stale_ref"
    /// The ref matched more than one plausible element now.
    case ambiguousTarget = "ambiguous_target"
    /// A bare row number (`5`) that could mean a row from an older read of this session.
    /// Nothing was sent; `next_call` is a full snapshot of the window, after which the number means that read's row.
    case staleBareRow = "stale_bare_row"
    /// The element can't do that (no such action, not settable).
    case notSupported = "not_supported"
    /// The engine acted, but what it read back contradicts the request.
    case actionFailed = "action_failed"
    /// Keys or pointer events were posted to the process and nothing read back from the window shows they landed.
    /// Never repeated: they may have landed.
    case unverified = "unverified"
    /// The app didn't answer in time.
    case timeout = "timeout"
    /// BaneySpaces isn't allowed to read or act (Accessibility, Screen Recording).
    case permissionDenied = "permission_denied"
    /// Arguments are missing or wrong.
    case badArguments = "bad_arguments"
    /// BaneySpaces isn't running.
    case notRunning = "not_running"
    /// The engine failed in a way none of the above covers.
    case engineError = "engine_error"

    /// What to do next when the caller has no better idea.
    public var defaultRetry: HandsRetry {
        switch self {
        case .staleRef, .unknownRef, .ambiguousTarget, .ambiguousWindow, .staleBareRow: return .afterSnapshot
        case .timeout, .notRunning, .appNotFound, .windowNotFound, .badArguments, .permissionDenied, .ambiguous, .inUse: return .safe
        case .outsideAgentWorkspace, .agentWorkspaceOff, .notSupported, .actionFailed, .unverified, .engineError, .needsLend, .needsSandbox: return .never
        }
    }
}

/// Whether the same command may be sent again.
public enum HandsRetry: String, Codable, Sendable {
    /// Nothing was delivered; send it again as is (or after fixing what the error names).
    case safe
    /// Take a new snapshot first and use the refs it prints.
    case afterSnapshot = "after_snapshot"
    /// Don't repeat it: it may have landed, or it will be refused again.
    case never
}

public struct HandsError: Codable, Equatable, Error, Sendable {
    public var code: HandsErrorCode
    public var message: String
    public var retry: HandsRetry
    public var suggestion: String
    /// The exact call to make next, `{"tool","arguments"}`: a read, or the same verb with a full ref when nothing was sent.
    public var nextCall: JSONValue?

    enum CodingKeys: String, CodingKey { case code, message, retry, suggestion, nextCall = "next_call" }

    public init(_ code: HandsErrorCode, _ message: String, suggestion: String, retry: HandsRetry? = nil, nextCall: JSONValue? = nil) {
        self.code = code; self.message = message; self.suggestion = suggestion; self.retry = retry ?? code.defaultRetry; self.nextCall = nextCall
    }

    /// `{"tool": "snapshot", "arguments": {...}}`: tool is the MCP name without the `computer_` prefix a connector adds.
    public static func call(_ tool: String, _ arguments: [String: JSONValue]) -> JSONValue {
        .object(["tool": .string(tool.replacingOccurrences(of: "-", with: "_")), "arguments": .object(arguments)])
    }
}

/// What every `baneyspaces agent` command prints, and every MCP tool returns: one JSON object.
/// `{"ok":true,"data":{…}}` or `{"ok":false,"error":{"code","message","retry","suggestion"}}`.
public struct HandsEnvelope: Codable, Equatable, Sendable {
    public var ok: Bool
    public var data: JSONValue?
    public var error: HandsError?

    public static func success(_ data: JSONValue) -> HandsEnvelope { .init(ok: true, data: data, error: nil) }
    public static func failure(_ error: HandsError) -> HandsEnvelope { .init(ok: false, data: nil, error: error) }

    /// One line of JSON, keys sorted.
    public var line: String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? String(data: enc.encode(self), encoding: .utf8)) ?? #"{"ok":false}"#
    }

    public static func decode(_ text: String) -> HandsEnvelope? {
        try? JSONDecoder().decode(HandsEnvelope.self, from: Data(text.utf8))
    }
}

/// How an engine error's own retry verdict (`disposition.retry`: safe, unsafe, unknown, or missing) becomes ours.
public enum EngineVerdict {
    public static func retry(for code: HandsErrorCode, verdict: String?) -> HandsRetry {
        var retry = code.defaultRetry
        // An action that may have landed is never repeated blindly, whatever the code says.
        if verdict == "unsafe" || verdict == "unknown", code != .staleRef { retry = .never }
        if verdict == "safe", retry == .never, code != .notSupported { retry = .safe }
        // A timeout or an unresponsive app without the engine's word that nothing was delivered may have landed.
        if code == .timeout, verdict != "safe" { retry = .never }
        return retry
    }

    /// The suggestion an agent sees for an engine error. The engine's `window_not_found` says "Run 'list-windows' to see
    /// available window IDs.", a command of the engine's own CLI that no Polycarp agent has (seen 11-12 on every window
    /// that quit mid-call): it names ours instead.
    public static func suggestion(_ engine: String) -> String {
        engine.contains("list-windows") ? "Run `polycarp-spaces agent windows` for the current ids." : engine
    }
}
