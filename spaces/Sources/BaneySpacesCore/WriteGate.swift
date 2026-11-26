import Foundation

/// Which window writes off the main thread may still go. Whatever moves windows on the main thread shuts it, or cuts it
/// for one move; a pass of writes that started before stops at its next message, so a window never has two writers.
public final class WriteGate: @unchecked Sendable {
    private let lock = NSLock()
    private var shut = false
    private var number = 0

    public init() {}

    /// The number a pass that starts now goes by.
    public var pass: Int { lock.withLock { number } }

    public func open(_ pass: Int) -> Bool { lock.withLock { !shut && number == pass } }

    /// Shutting ends every pass there is, also once it opens again.
    public func set(shut now: Bool) {
        lock.withLock {
            if now, !shut { number += 1 }
            shut = now
        }
    }

    /// Ends every pass there is, for one write. A new pass may start at once.
    public func cut() { lock.withLock { number += 1 } }
}
