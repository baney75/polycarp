import Foundation

/// Windows of the workspace you are on that are still parked out of sight, because their app didn't answer when the
/// switch moved them home.
///
/// A switch skips a window whose app is benched or times out (`Spaces.bringHome`): it keeps its record and "the next
/// switch tries again". Until then the window is gone from the workspace it belongs to, and its app answering a second
/// later changed nothing (2026-11-24: "windows randomly disappear"). Now the app is asked again as soon as it may be,
/// and once it answers the workspace is applied again.
public enum LeftAway {
    /// How many times a workspace is applied again for one window. A window that still won't come after that waits for
    /// the next switch, as before: an app that refuses every move mustn't have the workspace applied over and over.
    public static let most = 3

    /// The windows to bring home. `parked` have a parked record, `shown` are on a workspace in sight, `frames` is where
    /// the window server has each window now, `tries` how often each was tried. A window already in sight, a minimized
    /// one and one tried `most` times are left alone.
    public static func windows(parked: Set<WindowID>, shown: Set<WindowID>, frames: [WindowID: CGRect], screens: [CGRect],
                               minimized: Set<WindowID>, tries: [WindowID: Int] = [:]) -> Set<WindowID> {
        parked.intersection(shown).subtracting(minimized).filter { id in
            guard let f = frames[id], tries[id, default: 0] < most else { return false }
            return Geometry.isStranded(f, screens: screens)
        }
    }

    /// The tries to remember: one more for each window `tried`, none for a window that has no parked record any more.
    public static func counted(_ tries: [WindowID: Int], tried: Set<WindowID>, parked: Set<WindowID>) -> [WindowID: Int] {
        var out = tries.filter { parked.contains($0.key) }
        for id in tried { out[id, default: 0] += 1 }
        return out
    }

    /// The trace line for windows a switch left away.
    public static func line(apps: [String], windows: Int, workspace: Int) -> String {
        "left away: \(windows) window(s) of \(apps.sorted().joined(separator: ", ")) on workspace \(workspace); asked again when they answer"
    }
}
