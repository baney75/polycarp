import Foundation

/// What this copy of Polycarp was built from, as stamped into Info.plist by the build.
public struct BuildInfo: Equatable, Sendable {
    /// The full version (`PolycarpVersion`): "0.4.0-nightly.20261118070000+1a2b3c4".
    public let version: String
    public let commit: String?
    public let commitDate: Date?
    /// A published build. A local build (`PolycarpChannel` missing or `local`) is not, so the updater never
    /// takes its version for a release's.
    public let isRelease: Bool

    public init(version: String, commit: String?, commitDate: Date?, isRelease: Bool = false) {
        self.version = version
        self.commit = commit
        self.commitDate = commitDate
        self.isRelease = isRelease
    }

    /// Whether a `PolycarpChannel` value marks a published build. Builds from before one stream say `stable`,
    /// `nightly` or `dev`; today's say `nightly`, and a local one says `local`.
    public static func isRelease(channel: String?) -> Bool { channel.map { !$0.isEmpty && $0 != "local" } ?? false }
}

/// A build the updater can offer and install.
public struct Release: Equatable, Sendable {
    /// The release install.sh downloads it from: always `nightly`.
    public let tag: String
    public let name: String
    public let notes: String
    public let commit: String?

    public init(tag: String, name: String, notes: String, commit: String?) {
        self.tag = tag
        self.name = name
        self.notes = notes
        self.commit = commit
    }

    /// Only tags Polycarp itself publishes, so nothing else ever reaches the installer.
    public var isInstallable: Bool { tag == Updates.tag }
}

/// A release version like `v0.2.1` or `0.2.1`.
public struct Version: Comparable, Sendable {
    public let parts: [Int]

    public init?(_ text: String) {
        let bare = text.hasPrefix("v") ? String(text.dropFirst()) : text
        let parts = bare.split(separator: ".", omittingEmptySubsequences: false)
            .map { $0.isEmpty || !$0.allSatisfy({ $0.isASCII && $0.isNumber }) ? nil : Int($0) }
        guard (2...4).contains(parts.count), parts.allSatisfy({ $0 != nil }) else { return nil }
        self.parts = parts.compactMap { $0 }
    }

    public static func < (a: Version, b: Version) -> Bool {
        for i in 0..<max(a.parts.count, b.parts.count) {
            let x = i < a.parts.count ? a.parts[i] : 0, y = i < b.parts.count ? b.parts[i] : 0
            if x != y { return x < y }
        }
        return false
    }
}

/// A SemVer 2.0 version ordered by precedence: build metadata (after "+") is ignored, a pre-release sorts below
/// its release, and numeric identifiers compare as numbers. So for one base, a local build (`-dev.0`) sorts below a release.
public struct SemVer: Comparable, Sendable, CustomStringConvertible {
    public let major: Int, minor: Int, patch: Int
    public let prerelease: [String]
    public let description: String

    public init?(_ text: String) {
        let halves = text.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
        guard halves.count == 1 || SemVer.identifiers(halves[1]) != nil else { return nil }
        let core = halves[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = core[0].split(separator: ".", omittingEmptySubsequences: false).map { part -> Int? in
            guard SemVer.isNumber(part), part == "0" || !part.hasPrefix("0") else { return nil }
            return Int(part)
        }
        guard numbers.count == 3, let major = numbers[0], let minor = numbers[1], let patch = numbers[2] else { return nil }
        var prerelease: [String] = []
        if core.count == 2 {
            guard let ids = SemVer.identifiers(core[1]),
                  ids.allSatisfy({ !SemVer.isNumber($0) || $0 == "0" || !$0.hasPrefix("0") }) else { return nil }
            prerelease = ids
        }
        self.major = major; self.minor = minor; self.patch = patch
        self.prerelease = prerelease
        description = text
    }

    /// The version without pre-release or build: "0.4.0".
    public var base: String { "\(major).\(minor).\(patch)" }

    private static func isNumber<S: StringProtocol>(_ s: S) -> Bool { !s.isEmpty && s.allSatisfy { $0.isASCII && $0.isNumber } }

    private static func identifiers(_ s: Substring) -> [String]? {
        let ids = s.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        return ids.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") } }) ? ids : nil
    }

    public static func < (a: SemVer, b: SemVer) -> Bool {
        if (a.major, a.minor, a.patch) != (b.major, b.minor, b.patch) { return (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch) }
        if a.prerelease.isEmpty || b.prerelease.isEmpty { return !a.prerelease.isEmpty && b.prerelease.isEmpty }
        for (x, y) in zip(a.prerelease, b.prerelease) where x != y {
            switch (isNumber(x) ? Int(x) : nil, isNumber(y) ? Int(y) : nil) {
            case let (i?, j?): return i < j
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return Array(x.utf8).lexicographicallyPrecedes(Array(y.utf8))
            }
        }
        return a.prerelease.count < b.prerelease.count
    }

    /// Equal precedence: two builds that differ only in build metadata are the same version.
    public static func == (a: SemVer, b: SemVer) -> Bool { !(a < b) && !(b < a) }
}

/// The feed's latest.json (spaces/scripts/write-feed.sh): the one build on offer.
public struct Feed: Equatable, Sendable {
    public let version: SemVer
    public let commit: String
    public let notes: String
    /// The platform keys with a ready-made app: "darwin-aarch64", "darwin-x86_64".
    public let platforms: Set<String>

    /// Nil unless it is Polycarp's feed with a release version (`X.Y.Z-nightly.<time>`).
    public init?(json: Data) {
        guard let o = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any], o["product"] as? String == "polycarp",
              o["channel"] as? String == Updates.tag,
              let version = (o["version"] as? String).flatMap(SemVer.init),
              version.prerelease.count == 2, version.prerelease[0] == Updates.tag,
              let commit = o["commit"] as? String, commit.count == 40, commit.allSatisfy(\.isHexDigit),
              let platforms = o["platforms"] as? [String: Any] else { return nil }
        self.version = version
        self.commit = commit
        notes = o["notes"] as? String ?? ""
        self.platforms = Set(platforms.keys)
    }

    /// This Mac's platform key.
    public static var thisMac: String {
        #if arch(arm64)
        return "darwin-aarch64"
        #else
        return "darwin-x86_64"
        #endif
    }

    /// The build as the updater offers and installs it: "Polycarp 0.4.0 (2026-11-18)".
    public var release: Release {
        // nightly.20261118070000 -> 2026-11-18
        let time = version.prerelease.last ?? ""
        let day = time.count == 14 ? "\(time.prefix(4))-\(time.dropFirst(4).prefix(2))-\(time.dropFirst(6).prefix(2))" : time
        return Release(tag: Updates.tag, name: "Polycarp \(version.base) (\(day))", notes: notes, commit: commit)
    }
}

public enum Updates {
    /// The rolling release every copy updates from (docs/releases.md).
    public static let tag = "nightly"

    /// The feed every copy reads.
    public static let feedURL = URL(string: "https://github.com/baney75/polycarp/releases/download/\(tag)/latest.json")!

    /// The build `feed` offers this Mac, if any. Never the build you have, and never one without a ready-made app
    /// for this Mac. A release build is offered only a newer version. A local build is offered the feed's build,
    /// and the app then asks GitHub whether that build contains this one (`isNewerVersion` decides when GitHub
    /// can't answer), so an update never goes back in time.
    public static func offer(_ feed: Feed, build: BuildInfo, platform: String = Feed.thisMac) -> Release? {
        guard feed.platforms.contains(platform) else { return nil }
        if let mine = build.commit, feed.commit.hasPrefix(mine) || mine.hasPrefix(feed.commit) { return nil }
        if build.isRelease, !isNewerVersion(feed, than: build) { return nil }
        return feed.release
    }

    /// Whether the feed's version sorts above this build's (SemVer precedence).
    public static func isNewerVersion(_ feed: Feed, than build: BuildInfo) -> Bool {
        guard let mine = SemVer(build.version) else { return true }
        return feed.version > mine
    }
}

/// What the app's updater knows, as it crosses the socket for `polycarp-spaces update`. The updater in
/// the app fills it in; the command reads it back and turns it into a line and an exit code.
public struct UpdateReport: Equatable, Sendable {
    public enum State: String, Sendable {
        /// The last check found nothing newer.
        case current
        /// A newer release is on offer.
        case available
        /// The installer is running; the app restarts when it is done.
        case installing
        /// No check has finished since the app started, or the last one failed (`problem`).
        case unknown
    }

    public var state: State
    /// This build, as the app describes it: "0.2.1 (abc1234)".
    public var build: String
    /// The release on offer or installing: its name and, when known, its commit.
    public var name: String?
    public var commit: String?
    /// How many checks have finished since the app started. A caller that asks for a check waits
    /// for this to go up, so it never reads the answer of an older check.
    public var checks: Int
    public var problem: String?

    public init(state: State, build: String, name: String? = nil, commit: String? = nil,
                checks: Int = 0, problem: String? = nil) {
        self.state = state; self.build = build; self.name = name; self.commit = commit
        self.checks = checks; self.problem = problem
    }

    public var info: [String: String] {
        var out = ["state": state.rawValue, "build": build, "checks": String(checks)]
        out["name"] = name
        out["commit"] = commit
        out["problem"] = problem
        return out
    }

    /// Nil when the reply is not an update report (an older app that does not know the request).
    public init?(info: [String: String]?) {
        guard let info, let state = info["state"].flatMap(State.init), let build = info["build"] else { return nil }
        self.init(state: state, build: build, name: info["name"], commit: info["commit"],
                  checks: info["checks"].flatMap { Int($0) } ?? 0, problem: info["problem"])
    }

    /// One line for a person.
    public var line: String {
        let offered = [name, commit.map { "(\($0.prefix(7)))" }].compactMap { $0 }.joined(separator: " ")
        switch state {
        case .current: return "up to date: Polycarp \(build) is the newest build"
        case .available: return "update available: \(offered.isEmpty ? "a newer release" : offered). You have \(build)"
        case .installing: return "an update is installing: \(offered.isEmpty ? "a newer release" : offered). Polycarp restarts when it is done"
        case .unknown: return "could not check for updates: \(problem ?? "no check has finished yet")"
        }
    }

    /// `update --check`: 0 up to date, 100 an update is waiting (or installing), 1 the check failed.
    public var exitCode: Int32 {
        switch state {
        case .current: return 0
        case .available, .installing: return 100
        case .unknown: return 1
        }
    }
}

/// Which build a command inside Polycarp.app belongs to, read from the app's Info.plist on disk.
public enum InstalledBuild {
    /// The `.app` folder that holds `executable` (through any link), or nil outside an app.
    public static func app(holding executable: String) -> URL? {
        var url = URL(fileURLWithPath: executable).resolvingSymlinksInPath()
        while url.path != "/" {
            if url.pathExtension == "app" { return url }
            url.deleteLastPathComponent()
        }
        return nil
    }

    /// "polycarp-spaces 0.2.1 (abc1234)", with "-dirty" after the commit when files had changed, or
    /// "polycarp-spaces (not inside Polycarp.app)" for a bare build.
    public static func line(executable: String, name: String) -> String {
        guard let app = app(holding: executable),
              let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any] else {
            return "\(name) (not inside Polycarp.app)"
        }
        return line(info: info, name: name)
    }

    public static func line(info: [String: Any], name: String) -> String {
        let version = info["CFBundleShortVersionString"] as? String ?? "0"
        guard let commit = info["PolycarpCommit"] as? String, commit.count >= 7, commit.allSatisfy(\.isHexDigit) else { return "\(name) \(version)" }
        let dirty = (info["PolycarpCommitDirty"] as? String) == "1" ? "-dirty" : ""
        return "\(name) \(version) (\(commit.prefix(7))\(dirty))"
    }
}
