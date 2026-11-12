import Foundation

/// What `open` does when its wait ends and no window of its launch is on the agent workspace.
///
/// Measured 11-12: Calculator and Font Book each waited the full 7.1 s, answered `window_identified: false`, and their
/// windows stayed drawn on Donovan's workspace. A window of the agent's own copy must never be left there: when Polycarp
/// still can't place it after one more full look, that copy is quit and `open` fails, so the caller retries.
/// Only a copy this very request started is ever quit: one the agent-started record holds, whose process began after
/// the request did. A copy Donovan started, or one an earlier request started, is left alone.
public enum OpenMiss: Equatable, Sendable {
    /// Nothing of the launch is drawn: its window may still come, and the pending open takes it.
    case wait
    /// The agent's own copy drew a window outside the agent workspace: quit it.
    case quit(pid: Int32)
    /// A window is drawn outside the agent workspace, but the process isn't one this request started: never quit it.
    case leave

    /// The slack between the request's clock and the kernel's process start record.
    public static let startSlack: TimeInterval = 0.5

    /// `launched`: the pid the launch's own completion reported. `startedAt`: that process's start, in seconds since 1970.
    /// `requestStart`: when the request began, the same clock. `stray`: windows of that pid the window server draws that
    /// the agent workspace doesn't hold.
    public static func decide(launched: Int32?, agentStarted: Set<Int32>, startedAt: TimeInterval?, requestStart: TimeInterval,
                              stray: Int) -> OpenMiss {
        guard let pid = launched, stray > 0 else { return .wait }
        guard agentStarted.contains(pid), let t = startedAt, t >= requestStart - startSlack else { return .leave }
        return .quit(pid: pid)
    }
}

/// Whether `close` closed the window: read back from the window list, not guessed from one early look.
///
/// Measured 11-12: `close` answered `closed: false` three times in three while the window server had dropped the window
/// within 0.3 s. One look 0.2 s after the press caught the model before it heard of the close. It looks until the window
/// is gone or `timeout` passes.
public enum CloseReadback {
    public static let timeout: TimeInterval = 2
    public static let interval: TimeInterval = 0.1

    /// Polls `present` until it says false or `timeout` passes. True when the window is gone.
    public static func gone(timeout: TimeInterval = timeout, interval: TimeInterval = interval, now: () -> Date = Date.init,
                            sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }, present: () -> Bool) -> Bool {
        let end = now().addingTimeInterval(timeout)
        while true {
            if !present() { return true }
            if now() >= end { return false }
            sleep(interval)
        }
    }
}
