import Foundation

/// Asks each app for its windows on a background queue, so no app's answer is waited on for long on the main thread.
///
/// The scan used to wait on the main thread for every app, up to each app's 0.25 s deadline: 257 slow scans in 8.8 days
/// on Donovan's Mac (median 253 ms), each a visible hitch. Measured on 11-17 at a load of 44 to 56, half the apps answer
/// within 10 ms and some take seconds (p90 595 ms, p99 2.3 s), so waiting for the slowest is never cheap.
///
/// A round starts a read of each app not already being read, then waits at most `wait` for them. What answered by then is
/// the round's; the rest are `pending` and stay unread for the round, like an app that didn't answer (their windows keep
/// their workspace). Each pending read goes on until its app answers or its own deadline passes, then waits in `late`
/// and `onLate` is called (from the read's queue) so the caller can merge it in one short step. An app is never asked
/// twice at once: one whose read is still out is pending for every round until it comes back, so a hung app holds one
/// background thread, not one per scan.
public final class ScanFanOut<Read>: @unchecked Sendable {
    /// What a round got.
    public struct Round {
        /// Every app that answered, this round's reads and late ones from earlier rounds.
        public var answered: [Int32: Read] = [:]
        /// Apps asked and not back: this round's slow ones and any still out from before.
        public var pending: Set<Int32> = []
        /// Reads this round started, and late answers it took.
        public var asked = 0
        public var lateTaken = 0
        /// Seconds the caller waited.
        public var waited: TimeInterval = 0

        public init(answered: [Int32: Read] = [:], pending: Set<Int32> = []) {
            self.answered = answered
            self.pending = pending
        }
    }

    /// The longest a round waits. Unloaded, all 23 of Donovan's apps answer together in about 1 ms; 5 ms takes that group
    /// and leaves the rest of a 16 ms frame for merging what came back.
    public static var wait: TimeInterval { 0.005 }

    private let queue: DispatchQueue
    private let lock = NSLock()
    private var reading = Set<Int32>()
    private var late: [Int32: Read] = [:]
    private let onLate: () -> Void

    /// `onLate` runs on the read's queue each time an answer comes in after its round stopped waiting.
    public init(queue: DispatchQueue = DispatchQueue(label: "com.baney.polycarp.scan", qos: .userInitiated, attributes: .concurrent),
                onLate: @escaping () -> Void) {
        self.queue = queue
        self.onLate = onLate
    }

    /// Whether answers are waiting to be merged.
    public var hasLate: Bool {
        lock.lock(); defer { lock.unlock() }
        return !late.isEmpty
    }

    /// Whether a read of `pid` is out.
    public func isReading(_ pid: Int32) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return reading.contains(pid)
    }

    /// A round over `pids`: late answers for them are taken, each app with no read out is asked, and the caller waits at
    /// most `wait`. Late answers for apps not in `pids` (they quit, or own no window now) are dropped.
    public func round(_ pids: [Int32], wait: TimeInterval = ScanFanOut.wait, read: @escaping (Int32) -> Read) -> Round {
        let start = ProcessInfo.processInfo.systemUptime
        var round = Round()
        let want = Set(pids)
        var ask: [Int32] = []
        lock.lock()
        for pid in want {
            if let r = late.removeValue(forKey: pid) {
                round.answered[pid] = r
                round.lateTaken += 1
            } else if reading.contains(pid) {
                round.pending.insert(pid)
            } else {
                ask.append(pid)
            }
        }
        late = [:]
        reading.formUnion(ask)
        lock.unlock()
        round.asked = ask.count

        let box = Box()
        let group = DispatchGroup()
        for pid in ask {
            group.enter()
            queue.async { [self] in
                let r = read(pid)
                lock.lock()
                reading.remove(pid)
                let inTime = box.open
                if inTime { box.results[pid] = r } else { late[pid] = r }
                lock.unlock()
                group.leave()
                if !inTime { onLate() }
            }
        }
        _ = group.wait(timeout: .now() + wait)
        lock.lock()
        box.open = false
        let got = box.results
        lock.unlock()
        for pid in ask {
            if let r = got[pid] { round.answered[pid] = r } else { round.pending.insert(pid) }
        }
        round.waited = ProcessInfo.processInfo.systemUptime - start
        return round
    }

    /// The late answers alone, asking nobody: for a merge when nothing else changed.
    public func takeLate() -> Round {
        lock.lock(); defer { lock.unlock() }
        var round = Round()
        round.answered = late
        round.lateTaken = late.count
        round.pending = reading
        late = [:]
        return round
    }

    /// One round's answers, open while the round waits. Guarded by the fan-out's lock.
    private final class Box {
        var open = true
        var results: [Int32: Read] = [:]
    }
}

/// What each app's part in a scan round says about its windows.
public struct ScanTally: Equatable {
    /// Answered in full this round: only these may say a window they didn't list is closed.
    public var fresh = Set<Int32>()
    /// Answered with an error (a timeout included).
    public var failed = Set<Int32>()
    /// Asked and not back yet.
    public var pending = Set<Int32>()
    /// Not asked this round (a merge of late answers alone): their last full answer stands, and they judge nothing.
    public var standing = Set<Int32>()

    /// The apps whose windows keep their workspace untouched, as the unplaced check and the retry need to know.
    public var unsure: Set<Int32> { failed.union(pending) }

    public init() {}

    /// Sorts `apps` by `round`. `answeredBefore` are apps whose last answer is kept; `ok` says a read is a full answer.
    /// An app with no answer this round and none before is pending: it is never taken for one that has no windows.
    public static func of<Read>(_ round: ScanFanOut<Read>.Round, apps: Set<Int32>, answeredBefore: Set<Int32>,
                                ok: (Read) -> Bool) -> ScanTally {
        var t = ScanTally()
        for pid in apps {
            if let r = round.answered[pid] {
                if ok(r) { t.fresh.insert(pid) } else { t.failed.insert(pid) }
            } else if round.pending.contains(pid) || !answeredBefore.contains(pid) {
                t.pending.insert(pid)
            } else {
                t.standing.insert(pid)
            }
        }
        return t
    }
}
