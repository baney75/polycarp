import Foundation

/// The macOS Dock settings Polycarp changed while its Workspace Dock was on (the Workspace Dock was
/// removed on 2026-11-23), and how the person's own values were saved and are put back. `SystemDock`
/// in the app restores them once, at launch, on a Mac where an older build hid the macOS Dock.
///
/// `no-bouncing`: an auto-hidden macOS Dock still pops an app's icon above the screen's edge when
/// the app asks for attention, and leaves it there for seconds, once a minute while the app keeps
/// asking (Word, 2026-11-10: `handleDockEventAppNeedsAttention` in the Dock's log at :57.648 each
/// minute). With the Workspace Dock on, that icon was a stray piece of a dock you never saw.
public enum SystemDockSettings {
    /// Which keys a saved record covers, and the value Polycarp wrote to each. Restoring reads
    /// both from the record alone, so it puts back everything the build that wrote it changed.
    public static let keysKey = "_keys"
    public static let oursKey = "_ours"
    /// What records from before `_keys` and `_ours` were kept covered, and the values written then.
    static let firstKeys = ["autohide", "autohide-delay"]
    static let firstOurs: [String: NSNumber] = ["autohide": true as NSNumber, "autohide-delay": 1000 as NSNumber]

    /// The keys a record covers.
    public static func listed(_ saved: [String: Any]) -> [String] { saved[keysKey] as? [String] ?? firstKeys }

    /// What restoring writes, key by key: the saved value, or nil to remove the key. Only a
    /// setting still at Polycarp's value goes back; one the person changed since (⌥⌘D, System
    /// Settings) is their newer choice and stays.
    /// Reads only the record: the keys it lists and the values it says Polycarp wrote.
    public static func restore(saved: [String: Any], current: [String: NSNumber]) -> [String: NSNumber?] {
        let written = saved[oursKey] as? [String: NSNumber] ?? firstOurs
        var out: [String: NSNumber?] = [:]
        for key in listed(saved) where written[key] != nil && current[key] == written[key] {
            out[key] = .some(saved[key] as? NSNumber)
        }
        return out
    }
}
