import Foundation
import BaneySpacesCore

/// The windows agents moved onto the agent workspace (`MovedInWindows`), shared by every router and by the code that sends
/// them back when a lend or Full Access ends (`AppDelegate.sendBackMovedIn`). Any thread.
///
/// Saved in `moved-in.json` next to state.json on every change, and loaded and settled (`MovedInWindows.launch`) the first
/// time anything asks, which is before any agent decision: every router's `decide` goes through `shared`, and the app touches
/// it before the session socket starts. Lends are not saved, so after a relaunch a lent window's entry never holds: it is
/// denied at once and sent back.
final class HandsMovedIn {
    static let shared = HandsMovedIn()
    private let lock = NSLock()
    private var book: MovedInWindows
    static var url: URL { Spaces.folder.appendingPathComponent("moved-in.json") }

    private init() {
        let saved = (try? Data(contentsOf: Self.url)).map(MovedInWindows.decode) ?? []
        let launch = MovedInWindows.launch(saved, startTime: { AgentOwned.startTime($0) }, lends: HandsLends.shared.current(),
                                           now: Date(), mode: AgentAccess.shared.current)
        book = launch.book
        if !saved.isEmpty {
            Trace.log("hands: moved-in at launch: \(launch.keep.count) kept, \(launch.sendBack.count) going back, \(launch.drop.count) dropped (process gone)")
        }
        if launch.drop.count > 0 || launch.sendBack.count > 0 { save(book) }
    }

    private func save(_ b: MovedInWindows) {
        try? FileManager.default.createDirectory(at: Spaces.folder, withIntermediateDirectories: true)
        try? b.encoded().write(to: Self.url, options: .atomic)
    }

    private func change<T>(_ f: (inout MovedInWindows) -> T) -> T {
        lock.lock()
        let before = book
        let out = f(&book)
        let after = book
        lock.unlock()
        if after != before { save(after) }
        return out
    }

    func record(window: UInt32, pid: Int32, origin: MovedInWindows.Origin?, from: Int, to: Int) {
        let started = AgentOwned.startTime(pid)
        change { $0.record(window: window, pid: pid, startedAt: started, origin: origin, from: from, to: to) }
    }

    func decide(_ w: HandsWindow, base: ScopeDecision, lends: LendBook, now: Date, mode: AgentAccessMode) -> ScopeDecision {
        lock.lock(); defer { lock.unlock() }
        return book.decide(w, base: base, lends: lends, now: now, mode: mode)
    }

    /// Every entry on its way back (its origin ended now or earlier and it hasn't been read back yet). Entries of a process
    /// that has quit are dropped here.
    func settle(lends: LendBook, now: Date, mode: AgentAccessMode) -> [MovedInWindows.Entry] {
        change { b in
            let back = b.settle(lends: lends, now: now, mode: mode)
            var live: [MovedInWindows.Entry] = []
            for e in back {
                if let was = e.startedAt, let t = AgentOwned.startTime(e.pid), abs(t - was) < 0.5 { live.append(e) } else { b.drop(window: e.window) }
            }
            return live
        }
    }

    func returned(window: UInt32) { change { $0.returned(window: window) } }
}
