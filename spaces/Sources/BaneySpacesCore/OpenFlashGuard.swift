import CoreGraphics
import Foundation

/// How `agent open` keeps an app's first window off Donovan's screen until Spaces parks it on the agent workspace.
/// 11-12 on 639dd5f: every open drew its window on his workspace for 0.7 to 1.5 s, because a launching app doesn't answer
/// Accessibility (Font Book: "didn't answer; asked again in 0.3s"), and the claim waits for that. A hidden launch can't
/// help: a hidden app lists no windows (PR 172, reverted in 174). Moving the window through Accessibility sooner can't
/// either: it waits on the same answer (0.69 and 0.84 s to the claim for Font Book), so that prototype was dropped.
/// The cover needs no answer from the app: the window server lists the new window, and an opaque Polycarp panel
/// painted with the screen as it was goes over it until it is out of sight. Measured by `scripts/agent-open-probe.swift`
/// (seen_ms). Off by default: `defaults write com.baney.polycarp agentOpenFlashGuard cover`.
///
/// Limits (review of PR 209): only the process the launch returned is covered, never one matched by name; never while
/// the agent workspace is shown; never without a shot of every display; and a cover comes down 1.5 s after it went up
/// whether or not the window was parked, since a still image that eats clicks is worse than a late window. Review of
/// PR 212: a cover dies with its moment (any workspace switch, the process gone or replaced, the watch over), the hold
/// ends only after the cover has painted, one guarded open runs at a time, and a capture that takes over 300 ms means
/// no guard. Review of PR 213: the watch lasts while the launch's claim does, and every new ordinary window of the
/// process gets a cover until it is parked; a helper, splash, panel or sliver neither ends the hold nor the watch.
public enum OpenFlashGuard: String, Sendable, CaseIterable {
    case off
    case cover

    public static let defaultsKey = "agentOpenFlashGuard"
    /// The domain the flag is written to, the app's own: `defaults write com.baney.polycarp agentOpenFlashGuard cover`.
    /// The app reads it from `UserDefaults.standard`, which is that domain (a suite named after the app's own bundle id
    /// is unsupported: CFPreferences ignores it). Scripts, which are other processes, read it by this suite name.
    public static let defaultsDomain = Product.bundleID
    /// The flag as `defaults` holds it for this process.
    public static func current(_ d: UserDefaults = .standard) -> OpenFlashGuard { from(d.string(forKey: defaultsKey)) }
    /// The covers' window level, one no other Polycarp window uses (it has 0, 3, 8, 25 and 1000), so the probe can tell a
    /// cover from Polycarp's other windows by owner pid and layer.
    public static let coverLevel = 4
    /// A capture that takes longer than this means no guard: the app opens at once, unguarded.
    public static let captureLimit: Double = 0.3
    /// How long a guarded open waits for the one before it to finish, then opens unguarded.
    public static let waitForTurn: Double = 2
    public static func from(_ raw: String?) -> OpenFlashGuard { raw.flatMap(Self.init(rawValue:)) ?? .off }

    /// How long a launch is watched and its windows covered: the claim on a process the agent started (`claimNextWindow`
    /// within 8 s), counted from when the launch handed back its process.
    public static let claimFor: Double = 8
    /// The watch ends this long after the last of its covered windows was parked, closed or past its cover, with no new
    /// one since: a document chooser parked at 0.6 s and the main window at 2 s both get a cover.
    public static let quietFor: Double = 2.5
    /// A covered window off the list this long has closed. A shorter gap is the park's move (hidden, then moved).
    public static let goneAfter: Double = 0.3
    /// The window server is read this often while a window has a cover or none has come yet.
    public static let interval: Double = 0.004
    /// And this often once every covered window is parked or closed, waiting out `quietFor` for another.
    public static let idleInterval: Double = 0.016
    /// The longest a cover stays up for one window, counted from when it first went up.
    public static let coverLife: Double = 1.5
    /// The longest Spaces' asks to the launching process are held back.
    public static let holdFor: Double = 3
    /// A window's shadow reaches this far past its bounds and shows too, so a cover reaches as far.
    public static let shadow: CGFloat = 48

    /// A window of the new process that must not be seen: an ordinary window bigger than a sliver, still in sight.
    public static func needsGuard(layer: Int, bounds: CGRect, screens: [CGRect]) -> Bool {
        layer == 0 && bounds.width > 50 && bounds.height > 50 && !Geometry.isStranded(bounds, screens: screens)
    }

    /// The covers for a window (global, y down): its bounds and shadow, one part per screen it reaches, each painted from
    /// that screen's own shot.
    public static func coverParts(for bounds: CGRect, screens: [CGRect]) -> [(screen: Int, frame: CGRect)] {
        let reach = bounds.insetBy(dx: -shadow, dy: -shadow)
        return screens.enumerated().compactMap { i, s in
            let part = s.intersection(reach)
            return part.isNull || part.isEmpty ? nil : (i, part)
        }
    }

    /// A rect in the window server's coordinates (y down from the primary display's top) in AppKit's (y up from its
    /// bottom), for an NSWindow frame.
    public static func appKit(_ r: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// One on-screen window from the window server.
    public struct Sighting: Equatable, Sendable {
        public let pid: Int32, id: UInt32, layer: Int, bounds: CGRect
        public init(pid: Int32, id: UInt32, layer: Int, bounds: CGRect) { self.pid = pid; self.id = id; self.layer = layer; self.bounds = bounds }
    }

    /// One launch's watch, bound to the pid its launch returned. Fed the window server's list each tick (time in seconds
    /// since the watch began), it says which windows to cover, when the hold may end and when the watch is over.
    ///
    /// Every new ordinary window of the process in sight gets a cover until it is parked (out of sight), closes (off the
    /// list past `goneAfter`) or reaches `coverLife`. A window that never needed a cover (a helper, a splash or sliver of
    /// 50 pt or less, a floating panel, one already out of sight) is ignored: it neither ends the hold nor the watch. The
    /// watch lasts while the claim does (`claimFor`), and ends sooner only once every covered window is done and no new
    /// one came for `quietFor`.
    public struct Plan: Sendable {
        public let pid: Int32
        /// The launched process's start time: a pid reused by another process isn't this launch's.
        public let incarnation: UInt64
        public let screens: [CGRect]
        /// The windows with a cover now, by id: when it went up.
        private var upAt: [UInt32: Double] = [:]
        /// Windows parked, closed or past their cover: never covered again.
        private var done: Set<UInt32> = []
        /// Covered windows off the list, since when.
        private var missing: [UInt32: Double] = [:]
        private var lastDone: Double?
        private var covered = false
        private var last: [UInt32: CGRect] = [:]

        public struct Step: Equatable, Sendable {
            /// The windows to cover now, by id, at these bounds.
            public var covers: [UInt32: CGRect]
            /// Whether `covers` differs from the last step's: only then does the main thread redraw.
            public var changed: Bool
            /// The hold may end (after `covers` is up): a cover went up, or the hold ran out. Never for a sighting alone.
            public var release: Bool
            /// The watch is over: its process exited or was replaced, the claim ran out, or its covered windows are done
            /// and no new one came for `quietFor`.
            public var end: Bool
            /// Windows whose cover came down at `coverLife` without being parked.
            public var expired: [UInt32]
            /// Nothing is covered and a window was done with: the watch may poll at `idleInterval`.
            public var idle: Bool
        }

        public init(pid: Int32, incarnation: UInt64, screens: [CGRect]) { self.pid = pid; self.incarnation = incarnation; self.screens = screens }

        /// `incarnation` is the pid's start time now, nil once it has exited.
        public mutating func tick(now: Double, windows: [Sighting], incarnation now_: UInt64?) -> Step {
            guard now_ == incarnation, now < OpenFlashGuard.claimFor else {
                defer { last = [:] }
                return Step(covers: [:], changed: !last.isEmpty, release: true, end: true, expired: [], idle: false)
            }
            var want: [UInt32: CGRect] = [:], ran: [UInt32] = []
            let mine = windows.filter { $0.pid == pid }
            for w in mine where !done.contains(w.id) {
                missing[w.id] = nil
                guard OpenFlashGuard.needsGuard(layer: w.layer, bounds: w.bounds, screens: screens) else {
                    // Out of sight now, so a covered window is parked; one that never had a cover is ignored.
                    if upAt[w.id] != nil { finish(w.id, now) }
                    continue
                }
                let up = upAt[w.id] ?? now
                upAt[w.id] = up
                if now - up >= OpenFlashGuard.coverLife { finish(w.id, now); ran.append(w.id); continue }
                want[w.id] = w.bounds
            }
            // A covered window off the list: hidden for the park's move for a moment, or closed once it stays away.
            let listed = Set(mine.map(\.id))
            for id in Array(upAt.keys) where !listed.contains(id) {
                let since = missing[id] ?? now
                missing[id] = since
                if now - since >= OpenFlashGuard.goneAfter { finish(id, now) }
            }
            if !want.isEmpty { covered = true }
            defer { last = want }
            let quiet = upAt.isEmpty && lastDone != nil
            return Step(covers: want, changed: want != last, release: covered || now >= OpenFlashGuard.holdFor,
                        end: quiet && now - lastDone! >= OpenFlashGuard.quietFor, expired: ran.sorted(), idle: quiet)
        }

        private mutating func finish(_ id: UInt32, _ now: Double) {
            upAt[id] = nil; missing[id] = nil; done.insert(id); lastDone = now
        }
    }

    /// What a queued cover was made for. The main thread raises it only if all of it is still true: the launch's watch is
    /// live, no workspace switch came since its shot, and the pid is still the process the launch started.
    public struct Ticket: Equatable, Sendable {
        public let launch: UInt64, workspaces: UInt64, incarnation: UInt64
        public init(launch: UInt64, workspaces: UInt64, incarnation: UInt64) { self.launch = launch; self.workspaces = workspaces; self.incarnation = incarnation }

        public func holds(live: Set<UInt64>, workspaces now: UInt64, incarnation inc: UInt64?) -> Bool {
            live.contains(launch) && workspaces == now && inc == incarnation
        }
    }

    /// What is on screen: the workspace each display shows, and the current one. Two displays that trade workspaces
    /// show the same set of numbers, but a shot of either is stale, so the whole map is compared.
    public struct Showing: Equatable, Sendable {
        public var current: Int
        public var byDisplay: [String: Int]
        public init(current: Int, byDisplay: [String: Int]) { self.current = current; self.byDisplay = byDisplay }
        public func contains(_ n: Int) -> Bool { current == n || byDisplay.values.contains(n) }
    }

    /// Runs `work` on the main thread: at once when already there, else on its next turn. `agent open` arrives on the
    /// hands engine's and the session socket's queues, and the guard's state and AppKit live on main.
    public static func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async { work() } }
    }

    /// Whether the New Window step after a launch still waits: while the launch's hold is on (its cover not up yet), up
    /// to `holdFor`. Asking the app sooner blocks main for up to 0.35 s, when the cover may need to rise.
    public static func newWindowWaits(held: Bool, waited: Double) -> Bool { held && waited < holdFor }

    /// Whether a guarded open may start: alone, after waiting for the one before it, or, past `waitForTurn`, unguarded.
    public enum Turn: Equatable, Sendable { case go, wait, unguarded }
    public static func turn(busy: Bool, waited: Double) -> Turn {
        !busy ? .go : waited >= waitForTurn ? .unguarded : .wait
    }

    /// Spaces asks each app for its windows on the main thread with a 0.25 s timeout, and a starting app doesn't answer:
    /// one such ask blocks the main thread, where the cover is drawn, for a quarter second. So a launching process isn't
    /// asked until its cover is up. One hold per launch, keyed by its pid, so overlapping opens never end each other's.
    /// A held process is skipped, not benched: nothing is left benched when its hold ends, and a skipped ask is
    /// remembered so the release can ask again at once instead of waiting for whatever wakes Spaces next.
    public struct Holds: Sendable {
        private var until: [Int32: Date] = [:]
        private var skipped: Set<Int32> = []

        public init() {}

        public mutating func hold(_ pid: Int32, now: Date) { until[pid] = now.addingTimeInterval(OpenFlashGuard.holdFor) }

        /// Whether Spaces must not ask `pid` now. A skip is remembered for `release`.
        public mutating func skips(_ pid: Int32, now: Date) -> Bool {
            guard let u = until[pid], now < u else { return false }
            skipped.insert(pid)
            return true
        }

        /// Ends `pid`'s hold. True when an ask was skipped while it held, so Spaces should ask again now.
        public mutating func release(_ pid: Int32) -> Bool {
            guard until.removeValue(forKey: pid) != nil else { return false }
            return skipped.remove(pid) != nil
        }

        public func holds(_ pid: Int32, now: Date) -> Bool { until[pid].map { now < $0 } ?? false }
    }
}
