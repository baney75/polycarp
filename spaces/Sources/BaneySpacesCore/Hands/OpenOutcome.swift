import CoreGraphics
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
    /// How long `open` waits for its window at most: inside the 8 s claim `Spaces.claimNextWindow` holds.
    public static let claimWait: TimeInterval = 7
    /// A window smaller than this either way isn't one a person sees (a status item, a helper's 1 x 1 window).
    public static let minSide: CGFloat = 50

    /// Whether a miss gets the extra look and may quit the copy. Only when the caller waited the full claim window: a
    /// shorter wait ends while the claim may still place the window, and quitting then would kill a copy whose window
    /// was about to land (review 157 F2). Never on the main thread: the extra look and the quit sleep (F5).
    public static func looksAgain(wait: TimeInterval, mainThread: Bool) -> Bool { wait >= claimWait && !mainThread }

    /// Whether a window the window server draws is one a person can see: not clear, and over `minSide` both ways (F3).
    public static func visible(alpha: Double, bounds: CGRect) -> Bool {
        alpha > 0 && bounds.width > minSide && bounds.height > minSide
    }

    /// `launched`: the pid the launch's own completion reported. `startedAt`: that process's start, in seconds since 1970.
    /// `requestStart`: when the request began, the same clock. `stray`: visible windows of that pid the window server
    /// draws that the agent workspace doesn't hold. `held`: windows of that pid the agent workspace holds: when it holds
    /// any, the app is placed and a stray one is its sheet, panel or child, which `opened` reports; never quit for it (F3).
    public static func decide(launched: Int32?, agentStarted: Set<Int32>, startedAt: TimeInterval?, requestStart: TimeInterval,
                              stray: Int, held: Int) -> OpenMiss {
        guard let pid = launched, stray > 0, held == 0 else { return .wait }
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
