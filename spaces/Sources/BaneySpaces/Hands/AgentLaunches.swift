import Foundation

/// Ties an agent `open` to the process its own launch started. The router sets `current` on the main thread around its
/// call into the session's `open`, which captures it synchronously into the launch's completion; the completion reports the
/// pid for that token. So a pending `open` matches only windows of its own launch's process (`SessionWindows.OpenRequest`).
final class AgentLaunches {
    static let shared = AgentLaunches()
    private let lock = NSLock()
    private var next = 0
    private var pids: [Int: Int32] = [:], times: [Int: Date] = [:]
    /// The request whose launch is being started right now. Main thread only.
    var current: Int?

    func newToken() -> Int { lock.lock(); defer { lock.unlock() }; next += 1; return next }

    func launched(_ token: Int?, pid: Int32) {
        guard let token else { return }
        lock.lock()
        pids[token] = pid; times[token] = Date()
        if pids.count > 256 { let old = pids.keys.min()!; pids[old] = nil; times[old] = nil }
        lock.unlock()
    }

    func pid(_ token: Int) -> Int32? { lock.lock(); defer { lock.unlock() }; return pids[token] }
    /// When the launch handed back its process: the open cover can hold a launch back after its request (`OpenMiss.waitEnds`).
    func launchedAt(_ token: Int) -> Date? { lock.lock(); defer { lock.unlock() }; return times[token] }
}
