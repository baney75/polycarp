import Foundation

/// Ties an agent `open` to the process its own launch started. The router sets `current` on the main thread around its
/// call into the session's `open`, which captures it synchronously into the launch's completion; the completion reports the
/// pid for that token. So a pending `open` matches only windows of its own launch's process (`SessionWindows.OpenRequest`).
final class AgentLaunches {
    static let shared = AgentLaunches()
    private let lock = NSLock()
    private var next = 0
    private var pids: [Int: Int32] = [:]
    /// The request whose launch is being started right now. Main thread only.
    var current: Int?

    func newToken() -> Int { lock.lock(); defer { lock.unlock() }; next += 1; return next }

    func launched(_ token: Int?, pid: Int32) {
        guard let token else { return }
        lock.lock(); pids[token] = pid; if pids.count > 256 { pids.removeValue(forKey: pids.keys.min()!) }; lock.unlock()
    }

    func pid(_ token: Int) -> Int32? { lock.lock(); defer { lock.unlock() }; return pids[token] }
}
