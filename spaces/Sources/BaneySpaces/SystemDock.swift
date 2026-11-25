import AppKit
import BaneySpacesCore

/// The macOS Dock settings an older Polycarp changed. Builds up to 2026-11-23 had a Workspace Dock that hid the macOS
/// Dock while it was on, saving the Dock's own settings first. The Workspace Dock is gone,
/// so nothing hides the macOS Dock any more: a launch puts back what an older build saved, once, and so do
/// `--restore-dock`, the crash-loop guard and the uninstaller. Saved values survive a crash, so a later launch still
/// restores the right ones.
enum SystemDock {
    private static let domain = "com.apple.dock" as CFString
    private static let savedKey = "systemDockSaved"

    /// Whether an older build left the macOS Dock hidden and saved how it was.
    static var isHiddenByUs: Bool { UserDefaults.standard.dictionary(forKey: savedKey) != nil }

    /// Puts back every key the record lists, from the record alone (`SystemDockSettings.restore`), and drops the record
    /// only once each write reads back; otherwise it stays for the next try. With no record it does nothing.
    static func restore() {
        guard let saved = UserDefaults.standard.dictionary(forKey: savedKey) else { return }
        let plan = SystemDockSettings.restore(saved: saved, current: current(SystemDockSettings.listed(saved)))
        var changed = false
        for (key, value) in plan { changed = write(key, value) || changed }
        let landed = plan.allSatisfy { key, value in read(key) == value }
        if landed {
            UserDefaults.standard.removeObject(forKey: savedKey)
            Trace.log("dock restore: the macOS Dock is back as it was before the Workspace Dock")
        } else {
            Trace.log("dock restore: a macOS Dock setting didn't read back; keeping the saved record for the next try")
        }
        if changed { DockRestart.request() }
    }

    /// The settings an older build left from the Workspace Dock, read once at launch: the record, and the settings
    /// themselves. A record means the macOS Dock may still be hidden, so it comes back now.
    static func restoreLeftover() {
        guard isHiddenByUs else { return }
        Trace.log("dock restore: an older Polycarp hid the macOS Dock for the Workspace Dock, which is gone; putting it back")
        restore()
    }

    private static func current(_ keys: [String]) -> [String: NSNumber] {
        var out: [String: NSNumber] = [:]
        for key in keys { if let v = read(key) { out[key] = v } }
        return out
    }

    private static func read(_ key: String) -> NSNumber? {
        CFPreferencesCopyAppValue(key as CFString, domain) as? NSNumber
    }

    /// Writes a setting (nil removes it); whether anything changed.
    private static func write(_ key: String, _ value: NSNumber?) -> Bool {
        guard read(key) != value else { return false }
        CFPreferencesSetAppValue(key as CFString, value, domain)
        CFPreferencesAppSynchronize(domain)
        return true
    }
}
