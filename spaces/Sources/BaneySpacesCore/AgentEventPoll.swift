import Foundation

/// The MCP `events` tool's buffer for one session (spec/agent-api.md, "Events"): what happened after `since`, waiting up
/// to `wait_ms` for the first. An event stays until a later call's `since` passes it, so a retried call gets the same
/// answer. `seq` has no gaps: past `keep` unread events the rest are counted, not numbered, and one `lagged` follows them.
public final class AgentEventPoll: @unchecked Sendable {
    public static let keep = 256
    public static let longestWait = 5000

    public let types: Set<String>?
    private let cond = NSCondition()
    private var kept: [(seq: Int, event: JSONValue)] = []
    private var seq = 0, missed = 0
    private var readAt: Date

    public init(types: Set<String>?, now: Date = Date()) { self.types = types; readAt = now }

    /// When a caller last asked; a session nobody reads is dropped after a while.
    public var lastRead: Date {
        cond.lock(); defer { cond.unlock() }
        return readAt
    }

    public func push(_ events: [AgentEvents.Event], at: Date) {
        cond.lock(); defer { cond.unlock() }
        for e in events where types?.contains(e.type) ?? true {
            if kept.count >= Self.keep { missed += 1 } else { append(e, at) }
        }
        cond.broadcast()
    }

    private func append(_ e: AgentEvents.Event, _ at: Date) {
        seq += 1
        kept.append((seq, AgentEvents.object(e, seq: seq, at: at)))
    }

    /// The events after `since`, oldest first, and the `since` to pass next. Waits up to `wait` seconds when none is there.
    public func read(since: Int, wait: TimeInterval, now: Date = Date()) -> Result<(events: [JSONValue], next: Int), HandsError> {
        cond.lock(); defer { cond.unlock() }
        readAt = now
        guard since >= 0, since <= seq else {
            return .failure(HandsError(.badArguments, "since \(since) is not an event of this session (the last is \(seq))",
                                       suggestion: "Call events without since to start again: it answers hello with the whole state.", retry: .never))
        }
        kept.removeAll { $0.seq <= since }
        if missed > 0, kept.count < Self.keep {
            append(AgentEvents.Event("lagged", .object(["missed": .int(missed)])), now)
            missed = 0
        }
        let deadline = Date().addingTimeInterval(min(max(wait, 0), Double(Self.longestWait) / 1000))
        while kept.isEmpty, cond.wait(until: deadline) {}
        return .success((kept.map(\.event), kept.last?.seq ?? since))
    }

    /// The tool's answer: `$defs/events_result`, or why `since` was refused.
    public func answer(since: Int, waitMs: Int?) -> HandsEnvelope {
        switch read(since: since, wait: Double(waitMs ?? 0) / 1000) {
        case .failure(let e): return .failure(e)
        case .success(let r): return .success(.object(["version": .int(AgentAPI.version), "events": .array(r.events), "next": .int(r.next)]))
        }
    }
}
