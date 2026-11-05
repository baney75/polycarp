import Foundation

/// Which agent actions are running, or just finished, so BaneySpaces' follow-the-focus logic can tell an
/// activation an action caused from the user picking an app. An action holds its mark from before it
/// is queued until a short tail after it ends; the mark is for one window of one process, so the user's
/// own windows of the same app are never ignored. An app the agent launched itself is marked for the
/// whole process (every window it makes at launch is the agent's).
public struct FocusGuard: Equatable, Sendable {
    /// How long a mark outlasts the action that set it.
    public static let tail: TimeInterval = 1.5

    struct Key: Hashable, Sendable { var pid: Int32; var window: UInt32 }
    private var running: [Int: Key] = [:]
    private var tailUntil: [Key: Date] = [:]
    private var launchPid: [Int32: Date] = [:]
    struct LaunchMark: Equatable, Sendable { var until: Date; var excluding: Set<Int32> }
    private var launchBundle: [String: LaunchMark] = [:]
    private var nextToken = 1

    public init() {}

    /// An action on `window` of `pid` is starting (before it waits for the engine).
    public mutating func begin(pid: Int32, window: UInt32) -> Int {
        let t = nextToken; nextToken += 1
        running[t] = Key(pid: pid, window: window)
        return t
    }

    /// The action ended: its mark lasts `tail` longer.
    public mutating func end(_ token: Int, now: Date, tail: TimeInterval = FocusGuard.tail) {
        guard let k = running.removeValue(forKey: token) else { return }
        let until = now.addingTimeInterval(tail)
        if (tailUntil[k] ?? .distantPast) < until { tailUntil[k] = until }
    }

    /// The agent started this process (or is about to start this bundle): all its windows are the agent's for a while.
    public mutating func markLaunch(pid: Int32, now: Date, for window: TimeInterval) {
        launchPid[pid] = max(launchPid[pid] ?? .distantPast, now.addingTimeInterval(window))
    }
    /// Until the launch's own process is known (`markLaunch(pid:)` then `clearLaunch(bundle:)`): any process of the
    /// bundle except the ones already running, which are Donovan's.
    public mutating func markLaunch(bundle: String, excluding running: Set<Int32>, now: Date, for window: TimeInterval) {
        launchBundle[bundle] = LaunchMark(until: now.addingTimeInterval(window), excluding: running)
    }
    public mutating func clearLaunch(bundle: String) { launchBundle[bundle] = nil }

    /// Whether an activation of `pid` that put `window` in focus is the agent's doing.
    public func caused(pid: Int32, window: UInt32?, bundle: String?, now: Date) -> Bool {
        if (launchPid[pid] ?? .distantPast) > now { return true }
        if let b = bundle, let l = launchBundle[b], l.until > now, !l.excluding.contains(pid) { return true }
        guard let window else { return false }
        let k = Key(pid: pid, window: window)
        return running.values.contains(k) || (tailUntil[k] ?? .distantPast) > now
    }

    /// Whether any action on any window of this process is running, just ended, or is a launch of it.
    public func causedByAnyAction(pid: Int32, bundle: String?, now: Date) -> Bool {
        if caused(pid: pid, window: nil, bundle: bundle, now: now) { return true }
        return running.values.contains { $0.pid == pid } || tailUntil.contains { $0.key.pid == pid && $0.value > now }
    }

    public mutating func prune(now: Date) {
        tailUntil = tailUntil.filter { $0.value > now }
        launchPid = launchPid.filter { $0.value > now }
        launchBundle = launchBundle.filter { $0.value.until > now }
    }
    public var activeCount: Int { running.count }
}

/// The shared guard: the hands begin and end every action here, the focus logic asks.
public final class AgentActivity: @unchecked Sendable {
    public static let shared = AgentActivity()
    private let lock = NSLock()
    private var guardrail = FocusGuard()
    private let clock: () -> Date

    public init(clock: @escaping () -> Date = Date.init) { self.clock = clock }

    /// Holds the mark for the whole action. Always pair with `end`.
    public func begin(pid: Int32, window: UInt32) -> Int {
        lock.lock(); defer { lock.unlock() }
        guardrail.prune(now: clock())
        return guardrail.begin(pid: pid, window: window)
    }

    public func end(_ token: Int) {
        lock.lock(); defer { lock.unlock() }
        guardrail.end(token, now: clock())
    }

    /// The agent is launching this process or bundle.
    public func markLaunch(pid: Int32, for window: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        guardrail.markLaunch(pid: pid, now: clock(), for: window)
    }
    public func markLaunch(bundle: String, excluding running: Set<Int32>, for window: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        guardrail.markLaunch(bundle: bundle, excluding: running, now: clock(), for: window)
    }
    public func clearLaunch(bundle: String) {
        lock.lock(); defer { lock.unlock() }
        guardrail.clearLaunch(bundle: bundle)
    }

    /// Whether an agent's action or launch is on this process at all (for telling his use of an app from theirs).
    public func causedByAnyAction(pid: Int32, bundle: String? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return guardrail.causedByAnyAction(pid: pid, bundle: bundle, now: clock())
    }

    /// Whether this activation is an agent's: false for any window the agent isn't working on.
    public func caused(pid: Int32, window: UInt32?, bundle: String? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return guardrail.caused(pid: pid, window: window, bundle: bundle, now: clock())
    }
}

/// Whether a claim on a new window holds. A window of the app you are in is yours, because you may have just pressed
/// New Window in it. The exception is an app the agent itself just started: some apps bring themselves forward as
/// they launch, even when asked not to, and that must not put the agent's window on your screen.
public enum ClaimRule {
    public static func applies(windowPid: Int32, frontPid: Int32?, agentStartedProcess: Bool) -> Bool {
        agentStartedProcess || windowPid != frontPid
    }
}

/// Keeps your keyboard yours while an agent starts an app. Some apps bring themselves forward as they launch, even when
/// told not to, and your typing would go to the agent's app. For a few seconds after an agent starts one, that app can't
/// hold the keyboard: each time it comes forward, the keyboard goes back to the app you were last in.
///
/// It doesn't try to guess whether you switched there on purpose. Modifier and click signals can't tell that (a ⌘ held for
/// a copy looks the same, and another agent can post them), and the cost of no guess is small: the app's window is on the
/// agent's workspace, and after `maxReturns` it is left alone, so nothing fights you for long. Plain state, so it can be tested.
public struct FocusReturn: Equatable, Sendable {
    public enum Decision: Equatable, Sendable {
        case none
        /// Give the keyboard back to this app.
        case returnTo(Int32)
    }

    public static let maxReturns = 3

    private struct BundleWatch: Equatable, Sendable { var until: Date; var excluding: Set<Int32> }
    /// The app you were last in, never one an agent started.
    public private(set) var lastPerson: Int32?
    private var pids: [Int32: Date] = [:]
    private var bundles: [String: BundleWatch] = [:]
    private var returns: [Int32: Int] = [:]

    public init(lastPerson: Int32? = nil) { self.lastPerson = lastPerson }

    public mutating func seed(front: Int32?, agentOwned: Bool) {
        if lastPerson == nil, !agentOwned { lastPerson = front }
    }

    public mutating func watch(pid: Int32, until: Date) { pids[pid] = until }

    /// Before the launch's own process is known. Copies already running are yours and aren't watched. A second launch
    /// of the same app keeps the first one's list, so the first launch's process stays watched.
    public mutating func watch(bundle: String, excluding running: Set<Int32>, until: Date) {
        let earlier = bundles[bundle]?.excluding
        bundles[bundle] = BundleWatch(until: until, excluding: earlier.map { $0.intersection(running) } ?? running)
    }

    /// `frontNow`: what's frontmost as this runs. The notification can arrive late, and if the agent's app has already
    /// lost the front there's nothing to give back.
    public mutating func activated(pid: Int32, bundle: String?, agentOwned: Bool, frontNow: Int32?, now: Date) -> Decision {
        pids = pids.filter { $0.value > now }
        bundles = bundles.filter { $0.value.until > now }
        let byBundle = bundle.flatMap { bundles[$0] }.map { !$0.excluding.contains(pid) } ?? false
        guard pids[pid] != nil || byBundle else {
            if !agentOwned { lastPerson = pid }
            return .none
        }
        guard frontNow == pid, let target = lastPerson, target != pid else { return .none }
        let count = returns[pid, default: 0]
        guard count < Self.maxReturns else { return .none }
        returns[pid] = count + 1
        return .returnTo(target)
    }
}
