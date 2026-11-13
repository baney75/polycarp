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
public enum OpenFlashGuard: String, Sendable, CaseIterable {
    case off
    case cover

    public static let defaultsKey = "agentOpenFlashGuard"
    public static func from(_ raw: String?) -> OpenFlashGuard { raw.flatMap(Self.init(rawValue:)) ?? .off }

    /// How long a launch is watched: past the 8 s claim.
    public static let watchFor: Double = 9
    /// The window server is read this often while watching.
    public static let interval: Double = 0.004
    /// A window's shadow reaches this far past its bounds and shows too, so a cover reaches as far.
    public static let shadow: CGFloat = 48

    /// A window of the new process that must not be seen: an ordinary window bigger than a sliver, still in sight.
    public static func needsGuard(layer: Int, bounds: CGRect, screens: [CGRect]) -> Bool {
        layer == 0 && bounds.width > 50 && bounds.height > 50 && !Geometry.isStranded(bounds, screens: screens)
    }

    /// The cover for a window (global, y down): its bounds and shadow, clipped to the screens it is on.
    public static func coverFrame(for bounds: CGRect, screens: [CGRect]) -> CGRect? {
        let reach = bounds.insetBy(dx: -shadow, dy: -shadow)
        let parts = screens.map { $0.intersection(reach) }.filter { !$0.isNull && !$0.isEmpty }
        return parts.isEmpty ? nil : parts.dropFirst().reduce(parts[0]) { $0.union($1) }
    }

    /// A rect in the window server's coordinates (y down from the primary display's top) in AppKit's (y up from its
    /// bottom), for an NSWindow frame.
    public static func appKit(_ r: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// Spaces asks each app for its windows on the main thread with a 0.25 s timeout, and a starting app doesn't answer:
    /// one such ask blocks the main thread, where the cover is drawn, for a quarter second. So the launching process
    /// isn't asked until its cover is up: by app name (its pid isn't known until it runs) and not one of the copies
    /// that ran before. A hold ends when the cover is up, or after `holdFor` whatever happens.
    public struct Hold: Sendable, Equatable {
        public let app: String
        public let before: Set<Int32>
        public let until: Date
        public static let holdFor: TimeInterval = 3

        public init(app: String, before: Set<Int32>, now: Date) {
            self.app = app; self.before = before; until = now.addingTimeInterval(Self.holdFor)
        }

        public func holds(pid: Int32, name: String?, now: Date) -> Bool {
            now < until && name == app && !before.contains(pid)
        }
    }
}
