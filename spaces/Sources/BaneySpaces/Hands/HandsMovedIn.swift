import Foundation
import BaneySpacesCore

/// The windows agents moved onto the agent workspace (`MovedInWindows`), shared by every router and by the code that sends
/// them back when a lend or Full Access ends (`AppDelegate.sendBackMovedIn`). Any thread.
final class HandsMovedIn {
    static let shared = HandsMovedIn()
    private let lock = NSLock()
    private var book = MovedInWindows()

    func record(window: UInt32, pid: Int32, origin: MovedInWindows.Origin?, from: Int, to: Int) {
        lock.lock(); book.record(window: window, pid: pid, origin: origin, from: from, to: to); lock.unlock()
    }

    func decide(_ w: HandsWindow, base: ScopeDecision, lends: LendBook, now: Date, mode: AgentAccessMode) -> ScopeDecision {
        lock.lock(); defer { lock.unlock() }
        return book.decide(w, base: base, lends: lends, now: now, mode: mode)
    }

    func settle(lends: LendBook, now: Date, mode: AgentAccessMode) -> [MovedInWindows.Entry] {
        lock.lock(); defer { lock.unlock() }
        return book.settle(lends: lends, now: now, mode: mode)
    }
}
