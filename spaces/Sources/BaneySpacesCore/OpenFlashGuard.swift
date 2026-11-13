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
/// no guard.
public enum OpenFlashGuard: String, Sendable, CaseIterable {
    case off
    case cover

    public static let defaultsKey = "agentOpenFlashGuard"
    /// The domain the flag is read from, the app's own: `defaults write com.baney.polycarp agentOpenFlashGuard cover`.
    public static let defaultsDomain = Product.bundleID
    /// The covers' window level, one no other Polycarp window uses (it has 0, 3, 8, 25 and 1000), so the probe can tell a
    /// cover from Polycarp's other windows by owner pid and layer.
    public static let coverLevel = 4
    /// A capture that takes longer than this means no guard: the app opens at once, unguarded.
    public static let captureLimit: Double = 0.3
    /// How long a guarded open waits for the one before it to finish, then opens unguarded.
    public static let waitForTurn: Double = 2
    public static func from(_ raw: String?) -> OpenFlashGuard { raw.flatMap(Self.init(rawValue:)) ?? .off }

    /// How long a launch is watched: past the 8 s claim.
    public static let watchFor: Double = 9
    /// The window server is read this often while watching.
    public static let interval: Double = 0.004
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
    public struct Plan: Sendable {
        public let pid: Int32
        /// The launched process's start time: a pid reused by another process isn't this launch's.
        public let incarnation: UInt64
        public let screens: [CGRect]
        private var upAt: [UInt32: Double] = [:]
        private var expired: Set<UInt32> = []
        private var last: [UInt32: CGRect] = [:]

        public struct Step: Equatable, Sendable {
            /// The windows to cover now, by id, at these bounds.
            public var covers: [UInt32: CGRect]
            /// Whether `covers` differs from the last step's: only then does the main thread redraw.
            public var changed: Bool
            /// The hold may end (after `covers` is up): a window of this launch was seen, or the hold ran out.
            public var release: Bool
            /// The watch is over: its process exited or was replaced, its windows are parked or past their cover, or it ran
            /// its course.
            public var end: Bool
            /// Windows whose cover came down at `coverLife` without being parked.
            public var expired: [UInt32]
        }

        public init(pid: Int32, incarnation: UInt64, screens: [CGRect]) { self.pid = pid; self.incarnation = incarnation; self.screens = screens }

        /// `incarnation` is the pid's start time now, nil once it has exited.
        public mutating func tick(now: Double, windows: [Sighting], incarnation now_: UInt64?) -> Step {
            guard now_ == incarnation, now < OpenFlashGuard.watchFor else {
                defer { last = [:] }
                return Step(covers: [:], changed: !last.isEmpty, release: true, end: true, expired: [])
            }
            var want: [UInt32: CGRect] = [:], ran: [UInt32] = [], seen = false
            for w in windows where w.pid == pid {
                seen = true
                guard !expired.contains(w.id), OpenFlashGuard.needsGuard(layer: w.layer, bounds: w.bounds, screens: screens) else { continue }
                let up = upAt[w.id] ?? now
                upAt[w.id] = up
                if now - up >= OpenFlashGuard.coverLife { expired.insert(w.id); ran.append(w.id); continue }
                want[w.id] = w.bounds
            }
            defer { last = want }
            // Parked or past its cover: the launch has an ordinary window listed, each one is parked (stranded) or past its
            // cover, and every one that had a cover is still listed (not hidden for the park's move) or expired. The poll
            // stops there.
            let present = Dictionary(windows.filter { $0.pid == pid && $0.layer == 0 }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let settled = want.isEmpty && !present.isEmpty
                && present.values.allSatisfy { expired.contains($0.id) || Geometry.isStranded($0.bounds, screens: screens) }
                && upAt.keys.allSatisfy { expired.contains($0) || present[$0] != nil }
            return Step(covers: want, changed: want != last || settled && !last.isEmpty, release: seen || now >= OpenFlashGuard.holdFor, end: settled, expired: ran.sorted())
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
