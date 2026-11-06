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

    /// A translocated copy ran from a temporary read-only path; where it really came from decides what to eject and what to
    /// tidy up. `resolve` is the system's answer (`SecTranslocateCreateOriginalPathForURL`, passed in so this stays testable).
    public static func original(of bundle: URL, resolve: (URL) -> URL?) -> URL {
        guard classify(bundle: bundle, home: URL(fileURLWithPath: "/nonexistent-home")) == .translocated else { return bundle }
        return resolve(bundle) ?? bundle
    }

    /// Where a copy of the app is installed already: both Applications folders are looked at.
    public static func installedCopies(home: URL, exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> [URL] {
        [URL(fileURLWithPath: "/Applications", isDirectory: true), home.appendingPathComponent("Applications", isDirectory: true)]
            .map { $0.appendingPathComponent(Product.name + ".app", isDirectory: true) }.filter(exists)
    }

    /// The folder that already has a copy, so there is never one in each; else /Applications when writable, else ~/Applications.
    public static func destination(home: URL, canWrite: (URL) -> Bool, installed: [URL] = []) -> URL {
        if let have = installed.first { return have }
        let system = URL(fileURLWithPath: "/Applications", isDirectory: true)
        let folder = canWrite(system) ? system : home.appendingPathComponent("Applications", isDirectory: true)
        return folder.appendingPathComponent(Product.name + ".app", isDirectory: true)
    }

    /// Dotted version numbers compared by number: "0.10.0" is newer than "0.9.0". Missing parts count as 0.
    public static func isNewer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    /// What the app does, in order.
    public struct Plan: Equatable, Sendable {
        /// What is copied (the running bundle: for a translocated run, its temporary path, which reads fine).
        public var source: URL
        public var destination: URL
        /// Every copy already installed; each running one is asked to quit before anything changes.
        public var existing: [URL]
        /// The installed copy is this version or newer: it is only opened, never replaced, never downgraded.
        public var openInstalledOnly: Bool
        /// The disk image to eject, once the copy has opened, when that's where it came from and it really is a mounted image.
        public var eject: URL?
        /// The original in Downloads goes to the Trash once the copy has opened. Only Downloads, nothing else.
        public var trashOriginal: URL?
    }

    /// - `original`: where the app came from (see `original(of:resolve:)`); defaults to the bundle itself.
    /// - `mountedImages`: mount points `hdiutil info -plist` lists; only one of those is ever ejected.
    public static func plan(bundle: URL, original: URL? = nil, home: URL, canWrite: (URL) -> Bool,
                            installed: [URL], installedVersion: (URL) -> String?, thisVersion: String,
                            mountedImages: Set<String>) -> Plan {
        let origin = original ?? bundle
        let dest = destination(home: home, canWrite: canWrite, installed: installed)
        var eject: URL?, trash: URL?
        switch classify(bundle: origin, home: home) {
        case .disk(let volume): if mountedImages.contains(volume.path) { eject = volume }
        case .downloads: trash = origin
        default: break
        }
        let newest = installed.compactMap { installedVersion($0) }.first { !isNewer(thisVersion, than: $0) }
        // Same or newer installed: that is the copy to open, the newest of them, never an older one beside it.
        var open = dest
        if newest != nil {
            let versions = installed.compactMap { app in installedVersion(app).map { (app, $0) } }
            if let best = versions.reduce(nil as (URL, String)?, { acc, cur in acc.map { isNewer(cur.1, than: $0.1) ? cur : $0 } ?? cur }) { open = best.0 }
        }
        return Plan(source: bundle, destination: open, existing: installed, openInstalledOnly: newest != nil, eject: eject, trashOriginal: trash)
    }

    /// Mount points of the disk images `hdiutil info -plist` lists. A folder on an external or network drive is not in this
    /// list, so it is never detached.
    public static func mountedImages(infoPlist: Data) -> Set<String> {
        guard let root = try? PropertyListSerialization.propertyList(from: infoPlist, format: nil) as? [String: Any],
              let images = root["images"] as? [[String: Any]] else { return [] }
        var out = Set<String>()
        for image in images {
            for entity in (image["system-entities"] as? [[String: Any]]) ?? [] {
                if let mount = entity["mount-point"] as? String { out.insert(mount) }
            }
        }
        return out
    }

    /// Waits until `isGone`, up to `limit` seconds. False if it didn't finish in time. The clock and the wait are passed in.
    public static func wait(until isGone: () -> Bool, limit: TimeInterval = waitForQuit, now: () -> Date = Date.init, pause: () -> Void) -> Bool {
        let deadline = now().addingTimeInterval(limit)
        while !isGone() {
            if now() >= deadline { return false }
            pause()
        }
        return true
    }

    /// An install that stopped after the old copy was set aside (`.Polycarp-old.app`) but before the new one arrived leaves no
    /// Polycarp in that folder. Put the old one back. If a Polycarp is there, the set-aside one is left where it is (it is never
    /// deleted here). Returns true when it restored one.
    @discardableResult
    public static func recoverInterruptedInstall(in folder: URL, fileManager fm: FileManager = .default) -> Bool {
        let aside = folder.appendingPathComponent(".\(Product.name)-old.app")
        let app = folder.appendingPathComponent(Product.name + ".app")
        guard fm.fileExists(atPath: aside.path), !fm.fileExists(atPath: app.path) else { return false }
        return (try? fm.moveItem(at: aside, to: app)) != nil
    }

    /// The disk image is let go by a separate, short-lived process after this one has exited (an app can't eject the disk
    /// it is running from). A system tool, run by path.
    public static func ejectCommand(volume: URL) -> [String] {
        ["/bin/sh", "-c", "sleep 2; /usr/bin/hdiutil detach \"$1\" -quiet", "sh", volume.path]
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
    public static let waitForQuit: TimeInterval = 15

    // Words. Plain, with nothing a person would have to look up.
    public static let askTitle = "Move Polycarp to Applications?"
    public static let askDetail = "Polycarp works best from your Applications folder, where your Mac keeps its apps. It will copy itself there and open again."
    public static let moveButton = "Move and Open"
    public static let quitButton = "Quit"
    public static let stillOpenTitle = "Polycarp is already open."
    public static let stillOpenDetail = "Close the Polycarp that is open, then open this one again. Nothing was changed."
    public static let didNotOpenTitle = "Polycarp is in Applications, but it didn't open."
    public static let didNotOpenDetail = "Open it from your Applications folder."
    public static let failedTitle = "Polycarp couldn't move itself."
    public static let failedDetail = "Drag Polycarp to your Applications folder yourself, then open it from there."
    /// All of them, for the test that keeps jargon out.
    public static var strings: [String] {
        [askTitle, askDetail, moveButton, quitButton, stillOpenTitle, stillOpenDetail, didNotOpenTitle, didNotOpenDetail, failedTitle, failedDetail]
    }
}
