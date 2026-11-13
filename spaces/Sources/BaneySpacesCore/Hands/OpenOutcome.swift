import CoreGraphics
import Foundation

/// What `open` does when its wait ends and no window of its launch is on the agent workspace.
///
/// Measured 11-12: Calculator and Font Book each waited the full 7.1 s, answered `window_identified: false`, and their
/// windows stayed drawn on Donovan's workspace. A window of the agent's own copy must never be left there: when Polycarp
/// still can't place it after one more full look, that copy is quit and `open` fails, so the caller retries.
/// Placing failed is enough: it doesn't matter whether the window server draws the copy's window yet. 11-12, PR 172: a copy
/// launched hidden drew nothing while hidden, so `stray` was 0, the check said wait, and the window then showed unplaced
/// on Donovan's screen. A window that isn't drawn yet is drawn a moment later, in the same wrong place.
/// Only a copy this very request started is ever quit: one the agent-started record holds, whose process began after
/// the request did. A copy Donovan started, or one an earlier request started, is left alone.
public enum OpenMiss: Equatable, Sendable {
    /// No pid for the launch: nothing of it can be told from anyone else's.
    case wait
    /// A window of the launch is on the agent workspace: the app is placed, and anything of it elsewhere is its sheet,
    /// panel or child, which `opened` reports. Never quit for it (review 157 F3).
    case placed
    /// The agent's own copy has no window on the agent workspace: quit it.
    case quit(pid: Int32)
    /// Nothing of it is placed, but the process isn't one this request started: never quit it.
    case leave

    /// When the miss check runs.
    public enum When: Equatable, Sendable {
        /// Now, inside the request: the caller waited the full claim, off the main thread.
        case now
        /// On a background queue this many seconds from now: once the claim has passed.
        case after(TimeInterval)
    }

    /// The slack between the request's clock and the kernel's process start record.
    public static let startSlack: TimeInterval = 0.5
    /// How long `open` waits for its window at most: inside the 8 s claim `Spaces.claimNextWindow` holds.
    public static let claimWait: TimeInterval = 7
    /// A window smaller than this either way isn't one a person sees (a status item, a helper's 1 x 1 window).
    public static let minSide: CGFloat = 50

    /// The miss check always runs once the claim window has passed, whatever the caller's `wait` or thread (review 163
    /// second-F5). A caller that waited the full claim off main gets it in its answer. A shorter wait answers now and the
    /// check follows at `claimWait` after the request began, never sooner, so a window about to land isn't quit (157 F2);
    /// on the main thread it never sleeps through the look and the quit (157 F5).
    public static func check(wait: TimeInterval, mainThread: Bool, elapsed: TimeInterval) -> When {
        wait >= claimWait && !mainThread ? .now : .after(max(0, claimWait - elapsed))
    }

    /// When `open` stops waiting for its window: `wait` (at most `claimWait`) after the launch, or after the request
    /// while no launch has been reported. With the open cover on, a launch can start up to `waitForTurn` plus
    /// `captureLimit` (2.3 s) after its request, and its window had that much less time before the miss check quit the
    /// copy (review of PR 232, round 2 second-S2). Seconds since 1970.
    public static func waitEnds(request: TimeInterval, launched: TimeInterval?, wait: TimeInterval) -> TimeInterval {
        max(request, launched ?? request) + min(wait, claimWait)
    }

    /// Whether a window the window server lists is one a person can see: not clear, and over `minSide` both ways (F3).
    public static func visible(alpha: Double, bounds: CGRect) -> Bool {
        alpha > 0 && bounds.width > minSide && bounds.height > minSide
    }

    /// `launched`: the pid the launch's own completion reported. `startedAt`: that process's start, in seconds since 1970.
    /// `requestStart`: when the request began, the same clock. `held`: windows of that pid the agent workspace holds.
    public static func decide(launched: Int32?, agentStarted: Set<Int32>, startedAt: TimeInterval?, requestStart: TimeInterval,
                              held: Int) -> OpenMiss {
        guard let pid = launched else { return .wait }
        guard held == 0 else { return .placed }
        guard agentStarted.contains(pid), let t = startedAt, t >= requestStart - startSlack else { return .leave }
        return .quit(pid: pid)
    }
}

/// Whether `close` closed the window: read back from the window list, not guessed from one early look.
///
/// Measured 11-12: `close` answered `closed: false` three times in three while the window server had dropped the window
/// within 0.3 s. One look 0.2 s after the press caught the model before it heard of the close. It looks until the window
/// is gone or `timeout` passes.
///
/// It polls the window server (`listed`), which answers off the main thread at no cost, not a full Accessibility scan
/// per tick on main (review 157 F9). An app that closes a window but keeps it alive stays listed there, so at the
/// timeout one look at the model (`inModel`) decides. On the main thread it looks once and never sleeps.
public enum CloseReadback {
    public static let timeout: TimeInterval = 2
    public static let interval: TimeInterval = 0.1

    /// True when the window is gone: `listed` said false within `timeout`, or `inModel` says false after it.
    public static func gone(timeout: TimeInterval = timeout, interval: TimeInterval = interval, mainThread: Bool = false,
                            now: () -> Date = Date.init, sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
                            listed: () -> Bool, inModel: () -> Bool) -> Bool {
        let end = now().addingTimeInterval(timeout)
        while !mainThread {
            if !listed() { return true }
            if now() >= end { break }
            sleep(interval)
        }
        if mainThread, !listed() { return true }
        return !inModel()
    }
}
