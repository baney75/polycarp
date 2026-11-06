import Foundation

/// Polycarp opened from somewhere it shouldn't live (the disk image, Downloads, or the odd read-only place macOS runs an app
/// from the first time) asks once to move itself to Applications. The decision, the places and the words are here, with the
/// folders passed in, so every case is tested without moving anything. The app does the copying and relaunching.
public enum MoveToApplications {
    public enum Location: Equatable, Sendable {
        /// Directly in /Applications or ~/Applications.
        case installed
        /// On a mounted disk image or other volume (/Volumes/...). The volume's folder is `volume`.
        case disk(volume: URL)
        /// In the person's Downloads folder.
        case downloads
        /// macOS ran it from a temporary read-only copy (…/AppTranslocation/…), which happens to apps opened from Downloads.
        case translocated
        /// Anywhere else: a build folder, a project, a folder the person chose. Left alone.
        case elsewhere
    }

    /// Where is this copy of the app?
    public static func classify(bundle: URL, home: URL) -> Location {
        let path = bundle.standardizedFileURL.resolvingSymlinksInPath().path
        let raw = bundle.standardizedFileURL.path
        for p in [raw, path] {
            if p.contains("/AppTranslocation/") { return .translocated }
        }
        let apps = ["/Applications", home.appendingPathComponent("Applications").path]
        if apps.contains((raw as NSString).deletingLastPathComponent) || apps.contains((path as NSString).deletingLastPathComponent) { return .installed }
        if raw.hasPrefix("/Volumes/") {
            let parts = raw.split(separator: "/", omittingEmptySubsequences: true)
            if parts.count >= 2 { return .disk(volume: URL(fileURLWithPath: "/Volumes/\(parts[1])", isDirectory: true)) }
        }
        let downloads = home.appendingPathComponent("Downloads").path + "/"
        if raw.hasPrefix(downloads) || path.hasPrefix(downloads) { return .downloads }
        return .elsewhere
    }

    /// The relaunched copy carries this, so it can never ask again, whatever happens to its path.
    public static let movedFlag = "--after-move"

    /// Ask only for a normal start from the disk image, Downloads or a translocated path. Never for `--version`, `--help`
    /// and the one-shots (`EntryPoint.needsExclusiveCopy` is false for them), and never the copy that was just moved.
    /// Runs that do one thing and exit (the uninstaller's calls): they must never open an alert.
    public static let oneShots: Set<String> = ["--restore-shortcuts", "--restore-dock", "--check-settings", "--unregister-login", "--version", "--help", "-v", "-h"]

    public static func shouldAsk(arguments: [String], bundle: URL, home: URL) -> Bool {
        guard EntryPoint.needsExclusiveCopy(arguments: arguments), !arguments.contains(movedFlag),
              Set(arguments.dropFirst()).isDisjoint(with: oneShots) else { return false }
        switch classify(bundle: bundle, home: home) {
        case .disk, .downloads, .translocated: return true
        case .installed, .elsewhere: return false
        }
    }

    /// /Applications when the person can write there, else ~/Applications.
    public static func destination(home: URL, canWrite: (URL) -> Bool) -> URL {
        let system = URL(fileURLWithPath: "/Applications", isDirectory: true)
        let folder = canWrite(system) ? system : home.appendingPathComponent("Applications", isDirectory: true)
        return folder.appendingPathComponent(Product.name + ".app", isDirectory: true)
    }

    /// What the app does, in order, for a copy at `source`.
    public struct Plan: Equatable, Sendable {
        public var source: URL
        public var destination: URL
        /// The disk image to eject after relaunching, when that's where it ran from.
        public var eject: URL?
        /// A copy is already at `destination`: it is replaced only after it has quit.
        public var replacesExisting: Bool
    }

    public static func plan(bundle: URL, home: URL, canWrite: (URL) -> Bool, exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> Plan {
        let dest = destination(home: home, canWrite: canWrite)
        var eject: URL?
        if case .disk(let volume) = classify(bundle: bundle, home: home) { eject = volume }
        return Plan(source: bundle, destination: dest, eject: eject, replacesExisting: exists(dest))
    }

    /// The disk image is let go by a separate, short-lived process after this one has exited (an app can't eject the disk
    /// it is running from). A system tool, run by path.
    public static func ejectCommand(volume: URL) -> [String] {
        ["/bin/sh", "-c", "sleep 2; /usr/bin/hdiutil detach \"$1\" -quiet || /usr/bin/hdiutil detach \"$1\" -force -quiet", "sh", volume.path]
    }

    /// Takes the "downloaded from the internet" mark off the copy and everything in it, so the copy opens without the
    /// first-open question the original had to answer. Returns how many items had it.
    @discardableResult
    public static func clearDownloadMark(at url: URL) -> Int {
        let name = "com.apple.quarantine"
        var cleared = 0
        func strip(_ u: URL) {
            if removexattr(u.path, name, XATTR_NOFOLLOW) == 0 { cleared += 1 }
        }
        strip(url)
        if let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil, options: []) {
            for case let u as URL in e { strip(u) }
        }
        return cleared
    }

    /// Whether a running copy at `destination` is still there: the plan waits for it to quit.
    public static let waitForQuit: TimeInterval = 10

    // Words. Plain, with nothing a person would have to look up.
    public static let askTitle = "Move Polycarp to Applications?"
    public static let askDetail = "Polycarp works best from your Applications folder, where your Mac keeps its apps. It will copy itself there and open again."
    public static let moveButton = "Move and Open"
    public static let quitButton = "Quit"
    public static let stillOpenTitle = "Polycarp is already open."
    public static let stillOpenDetail = "Close the Polycarp that is open, then open this one again."
    public static let failedTitle = "Polycarp couldn't move itself."
    public static let failedDetail = "Drag Polycarp to your Applications folder yourself, then open it from there."
    /// All of them, for the test that keeps jargon out.
    public static var strings: [String] {
        [askTitle, askDetail, moveButton, quitButton, stillOpenTitle, stillOpenDetail, failedTitle, failedDetail]
    }
}
