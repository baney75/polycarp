import Foundation

/// Which apps an Accessibility scan has to ask, and how scans are queued, now that no scan runs on the main thread.
///
/// Until 2026-11-21 every scan asked every app with a window, on the main thread, with a 0.25 s timeout each. Some app
/// nearly always timed out (Word, PowerPoint, Ghostty, Maps, Preview, TextEdit...), so the scan cost the whole timeout:
/// trace.log had 50 `slow scan: 254 ms on main` lines in four hours (p50 255 ms, max 303), and the dock, the launcher
/// and every key press waited behind them. Now scans run on a background queue, and each asks only the apps whose
/// windows changed since the last one; the rest keep their last answer.
public enum ScanPlan {
    /// The apps to ask. `owners` are the regular apps that own an app window now. `now` and `before` map each app window
    /// the window server lists to its app, now and at the last scan (nil: there was none, so everyone is asked).
    /// `offscreenNow` and `offscreenBefore` are the known windows of shown apps that were off screen (one joining them
    /// may have closed). `complete` are the apps whose last answer was whole: an app missing from it (new, or one that
    /// didn't answer or answered in part) is asked again. `extra` are apps a caller wants asked anyway.
    public static func appsToAsk(full: Bool, owners: Set<Int32>, now: [WindowID: Int32], before: [WindowID: Int32]?,
                                 offscreenNow: Set<WindowID>, offscreenBefore: Set<WindowID>,
                                 complete: Set<Int32>, extra: Set<Int32> = []) -> Set<Int32> {
        guard !full, let before else { return owners }
        var ask = owners.subtracting(complete).union(extra)
        let a = byApp(now), b = byApp(before)
        for pid in owners where a[pid] != b[pid] { ask.insert(pid) }
        for id in offscreenNow.symmetricDifference(offscreenBefore) {
            if let pid = now[id] ?? before[id] { ask.insert(pid) }
        }
        return ask.intersection(owners)
    }

    /// Each app's windows.
    public static func byApp(_ windows: [WindowID: Int32]) -> [Int32: Set<WindowID>] {
        var out: [Int32: Set<WindowID>] = [:]
        for (id, pid) in windows { out[pid, default: []].insert(id) }
        return out
    }

    /// Why a scan runs, for timing.log and the slow-scan line: `apps` (an app launched or quit), `windows+A-R` (A app
    /// windows came, R went), `offscreen` (a known window left the screen), `unplaced` (an on-screen window had no
    /// workspace), `asked` (a caller asked particular apps).
    public static func reason(pidsChanged: Bool, added: Int, removed: Int, offscreenChanged: Bool, asked: Bool) -> String {
        if pidsChanged { return "apps" }
        if added > 0 || removed > 0 { return "windows+\(added)-\(removed)" }
        if offscreenChanged { return "offscreen" }
        return asked ? "asked" : "unplaced"
    }
}

/// What a background scan read about one window besides its number, so the dock, the overview and the launcher can
/// show titles without asking the app on the main thread.
public struct WindowDetails: Equatable {
    public var title: String
    public var minimized: Bool
    public init(title: String, minimized: Bool) {
        self.title = title
        self.minimized = minimized
    }
}

/// Scan requests, coalesced. At most one scan runs at a time; requests that arrive meanwhile wait as one (`full` if any
/// asked for it, the union of the apps asked for). A waiter (code that must act on a window list at least as new as
/// its request) runs when the first scan that started after its request lands, never an older one, whose snapshot
/// could predate the window it needs.
public struct ScanRequests<Waiter> {
    public struct Ask: Equatable {
        public var full: Bool
        public var pids: Set<Int32>
        public init(full: Bool, pids: Set<Int32>) {
            self.full = full
            self.pids = pids
        }
    }

    public private(set) var pending: Ask?
    private var pendingWaiters: [Waiter] = []
    /// The scan running now, by ticket.
    public private(set) var inFlight: Int?
    private var inFlightWaiters: [Waiter] = []
    private var tickets = 0

    public init() {}

    /// Whether a scan is waiting to start that some code waits on.
    public var pendingIsWaitedOn: Bool { pending != nil && !pendingWaiters.isEmpty }

    public mutating func request(full: Bool, pids: Set<Int32> = [], waiter: Waiter? = nil) {
        var ask = pending ?? Ask(full: false, pids: [])
        ask.full = ask.full || full
        ask.pids.formUnion(pids)
        pending = ask
        if let waiter { pendingWaiters.append(waiter) }
    }

    /// The next scan to run, or nil while one runs or none is asked for. `onlyIfWaitedOn` (mid-switch: a scan whose
    /// answer would be thrown away) starts one only when code waits on it.
    public mutating func start(onlyIfWaitedOn: Bool = false) -> (ticket: Int, ask: Ask)? {
        guard inFlight == nil, let ask = pending else { return nil }
        if onlyIfWaitedOn, pendingWaiters.isEmpty { return nil }
        tickets += 1
        inFlight = tickets
        inFlightWaiters = pendingWaiters
        pending = nil
        pendingWaiters = []
        return (tickets, ask)
    }

    /// Code that can use the scan running now (it started from the same window list the caller sees) waits on that one
    /// instead of the next, so a switch that arrives mid-scan doesn't wait for two. False when none runs.
    @discardableResult
    public mutating func join(_ waiter: Waiter) -> Bool {
        guard inFlight != nil else { return false }
        inFlightWaiters.append(waiter)
        return true
    }

    /// The scan with `ticket` landed: the waiters it answers. A ticket that isn't the one running answers none.
    public mutating func landed(_ ticket: Int) -> [Waiter] {
        guard inFlight == ticket else { return [] }
        inFlight = nil
        defer { inFlightWaiters = [] }
        return inFlightWaiters
    }

    /// Everything dropped (Polycarp stopped managing windows): the waiters that will never run.
    @discardableResult
    public mutating func reset() -> [Waiter] {
        let dropped = inFlightWaiters + pendingWaiters
        pending = nil
        pendingWaiters = []
        inFlightWaiters = []
        inFlight = nil
        return dropped
    }
}
