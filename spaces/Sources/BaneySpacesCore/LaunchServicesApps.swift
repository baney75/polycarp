#if os(macOS)
import CoreServices
import Foundation

/// What this Mac has, from Launch Services and the disk. Safe off the main thread, where the app asks it.
public final class LaunchServicesApps: InstalledApps {
    private let search: CommandSearch

    public init(search: CommandSearch = .live()) { self.search = search }

    public func appName(_ bundle: String) -> String? { appURL(bundle).map(Self.name) }

    public func systemDefault(_ question: AppRole.SystemQuestion) -> String? {
        let found: URL?
        switch question {
        case let .scheme(s):
            found = URL(string: s + ":").flatMap { LSCopyDefaultApplicationURLForURL($0 as CFURL, .all, nil)?.takeRetainedValue() as URL? }
        case let .type(t):
            found = LSCopyDefaultApplicationURLForContentType(t as CFString, .all, nil)?.takeRetainedValue() as URL?
        }
        return found.flatMap { Bundle(url: $0)?.bundleIdentifier }
    }

    public func commandPath(_ names: [String]) -> String? { search.find(names) }

    /// Where the app is. Launch Services remembers copies in the Trash and on disks that are gone; those aren't installed.
    public func appURL(_ bundle: String) -> URL? {
        guard let all = LSCopyApplicationURLsForBundleIdentifier(bundle as CFString, nil)?.takeRetainedValue() as? [URL] else { return nil }
        return all.first { !$0.path.contains("/.Trash/") && FileManager.default.fileExists(atPath: $0.path) }
    }

    /// The name Finder shows.
    public static func name(_ app: URL) -> String {
        let n = FileManager.default.displayName(atPath: app.path)
        return n.hasSuffix(".app") ? String(n.dropLast(4)) : n
    }
}
#endif
