import Foundation

/// The macOS Dock settings Polycarp changes while the Workspace Dock is on, and how the person's
/// own values are saved and put back. `SystemDock` in the app does the reading and writing.
///
/// `no-bouncing`: an auto-hidden macOS Dock still pops an app's icon above the screen's edge when
/// the app asks for attention, and leaves it there for seconds, once a minute while the app keeps
/// asking (Word, 2026-11-10: `handleDockEventAppNeedsAttention` in the Dock's log at :57.648 each
/// minute). With the Workspace Dock on, that icon is a stray piece of a dock you never see; the
/// Workspace Dock marks the waiting workspace instead (`DockAttention`).
public enum SystemDockSettings {
    /// Long enough that the Dock never slides up by accident while the Workspace Dock is in use.
    public static let hiddenDelay = 1000.0

    /// Each setting and the value Polycarp gives it.
    public static let ours: [String: NSNumber] = [
        "autohide": true as NSNumber,
        "autohide-delay": hiddenDelay as NSNumber,
        "no-bouncing": true as NSNumber,
    ]
    public static var keys: [String] { ours.keys.sorted() }

    /// Which keys a saved record covers. Records from before this list was kept covered these two.
    public static let keysKey = "_keys"
    static let firstKeys = ["autohide", "autohide-delay"]

    /// The record to keep before Polycarp writes its values. `existing` is the record already
    /// saved (nil when none); `current` the Dock's values now (a missing key is absent). A setting
    /// that wasn't there is saved as absent, so restoring removes it again. A key an older record
    /// doesn't cover is saved from its value now, before it is written for the first time.
    public static func record(existing: [String: Any]?, current: [String: NSNumber]) -> [String: Any] {
        guard var rec = existing else {
            var fresh: [String: Any] = [:]
            for key in keys { if let v = current[key] { fresh[key] = v } }
            // Already at Polycarp's own delay (its saved copy was lost: a crash, wiped settings,
            // another copy of the app): those aren't the person's. Save them as absent, which
            // restores the macOS defaults.
            if (fresh["autohide-delay"] as? NSNumber)?.doubleValue == hiddenDelay { fresh = [:] }
            fresh[keysKey] = keys
            return fresh
        }
        let covered = Set(rec[keysKey] as? [String] ?? firstKeys)
        for key in keys where !covered.contains(key) {
            if let v = current[key] { rec[key] = v } else { rec[key] = nil }
        }
        rec[keysKey] = keys
        return rec
    }

    /// What restoring writes, key by key: the saved value, or nil to remove the key. Only a
    /// setting still at Polycarp's value goes back; one the person changed since (⌥⌘D, System
    /// Settings) is their newer choice and stays.
    public static func restore(saved: [String: Any], current: [String: NSNumber]) -> [String: NSNumber?] {
        let covered = Set(saved[keysKey] as? [String] ?? firstKeys)
        var out: [String: NSNumber?] = [:]
        for key in keys where covered.contains(key) && current[key] == ours[key] {
            out[key] = .some(saved[key] as? NSNumber)
        }
        return out
    }
}
