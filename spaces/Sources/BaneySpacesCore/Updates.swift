import Foundation

/// Which builds an install follows. Stable is each tagged release; nightly is main, rebuilt each
/// night it changed. Nightly also offers a stable release that is newer than the last nightly.
public enum UpdateChannel: String, CaseIterable, Sendable {
    case stable, nightly
}

/// What this copy of BaneySpaces was built from, as stamped into Info.plist by the build.
public struct BuildInfo: Equatable, Sendable {
    public let version: String
    public let commit: String?
    public let commitDate: Date?

    public init(version: String, commit: String?, commitDate: Date?) {
        self.version = version
        self.commit = commit
        self.commitDate = commitDate
    }
}

/// One GitHub release, reduced to what the updater needs.
public struct Release: Equatable, Sendable {
    public let tag: String
    public let name: String
    public let notes: String
    public let prerelease: Bool
    public let url: String
    /// From the marker line the release workflow writes into the notes.
    public let commit: String?
    public let commitDate: Date?

    public init(tag: String, name: String, notes: String, prerelease: Bool, url: String) {
        self.tag = tag
        self.name = name
        self.prerelease = prerelease
        self.url = url
        let marker = Release.marker(in: notes)
        commit = marker.commit
        commitDate = marker.date
        // The marker is for BaneySpaces, not for people.
        self.notes = notes.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.contains("<!-- baneyspaces ") }
            .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Only tags BaneySpaces itself publishes, so nothing else ever reaches the installer.
    public var isInstallable: Bool { tag == "nightly" || Version(tag) != nil }

    public var isNightly: Bool { tag == "nightly" }

    /// `<!-- baneyspaces commit=<sha> date=<ISO 8601> -->`
    static func marker(in notes: String) -> (commit: String?, date: Date?) {
        guard let line = notes.split(separator: "\n").first(where: { $0.contains("<!-- baneyspaces ") }) else { return (nil, nil) }
        var commit: String?, date: Date?
        for field in line.split(separator: " ") {
            let pair = field.split(separator: "=", maxSplits: 1).map(String.init)
            guard pair.count == 2 else { continue }
            if pair[0] == "commit", pair[1].allSatisfy(\.isHexDigit), pair[1].count >= 7 { commit = pair[1] }
            if pair[0] == "date" { date = ISO8601DateFormatter().date(from: pair[1]) }
        }
        return (commit, date)
    }

    /// Releases from the GitHub API's JSON list. Drafts and anything unparsable are skipped.
    public static func list(fromGitHubJSON data: Data) -> [Release] {
        guard let items = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard item["draft"] as? Bool != true, let tag = item["tag_name"] as? String else { return nil }
            return Release(tag: tag, name: item["name"] as? String ?? tag, notes: item["body"] as? String ?? "",
                           prerelease: item["prerelease"] as? Bool ?? false, url: item["html_url"] as? String ?? "")
        }
    }
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

public enum Updates {
    /// Whether installing `release` moves this build forward. Builds and releases that carry
    /// their commit compare by commit date, so nightly and stable can be mixed without ever
    /// offering an older build; otherwise version numbers decide.
    public static func isNewer(_ release: Release, than build: BuildInfo) -> Bool {
        if let commit = release.commit, let built = build.commit, commit.hasPrefix(built) || built.hasPrefix(commit) { return false }
        if let date = release.commitDate, let built = build.commitDate { return date > built }
        guard let v = Version(release.tag), let mine = Version(build.version) else { return false }
        return v > mine
    }

    /// The release to offer on `channel`, if any is newer than `build`.
    public static func offer(from releases: [Release], channel: UpdateChannel, build: BuildInfo) -> Release? {
        candidates(from: releases, channel: channel, build: build).first
    }

    /// Every release on `channel` that looks newer than `build`, newest first. The app confirms
    /// each with GitHub (does it really contain this build?) before offering it.
    public static func candidates(from releases: [Release], channel: UpdateChannel, build: BuildInfo) -> [Release] {
        let stable = releases.filter { !$0.prerelease && Version($0.tag) != nil }
            .max { Version($0.tag)! < Version($1.tag)! }
        var candidates = [stable].compactMap { $0 }
        if channel == .nightly, let nightly = releases.first(where: \.isNightly) { candidates.append(nightly) }
        return candidates.filter { $0.isInstallable && isNewer($0, than: build) }.sorted { a, b in
            if let x = a.commitDate, let y = b.commitDate { return x > y }
            return a.isNightly && !b.isNightly
        }
    }
}

/// What the app's updater knows, as it crosses the socket for `polycarp-spaces update`. The updater in
/// the app fills it in; the command reads it back and turns it into a line and an exit code.
public struct UpdateReport: Equatable, Sendable {
    public enum State: String, Sendable {
        /// The last check found nothing newer on the channel.
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
    public var channel: UpdateChannel
    /// The release on offer or installing: its name and, when known, its commit.
    public var name: String?
    public var commit: String?
    /// How many checks have finished since the app started. A caller that asks for a check waits
    /// for this to go up, so it never reads the answer of an older check.
    public var checks: Int
    public var problem: String?

    public init(state: State, build: String, channel: UpdateChannel, name: String? = nil, commit: String? = nil,
                checks: Int = 0, problem: String? = nil) {
        self.state = state; self.build = build; self.channel = channel; self.name = name; self.commit = commit
        self.checks = checks; self.problem = problem
    }

    public var info: [String: String] {
        var out = ["state": state.rawValue, "build": build, "channel": channel.rawValue, "checks": String(checks)]
        out["name"] = name
        out["commit"] = commit
        out["problem"] = problem
        return out
    }

    /// Nil when the reply is not an update report (an older app that does not know the request).
    public init?(info: [String: String]?) {
        guard let info, let state = info["state"].flatMap(State.init), let build = info["build"],
              let channel = info["channel"].flatMap(UpdateChannel.init) else { return nil }
        self.init(state: state, build: build, channel: channel, name: info["name"], commit: info["commit"],
                  checks: info["checks"].flatMap { Int($0) } ?? 0, problem: info["problem"])
    }

    /// One line for a person.
    public var line: String {
        let offered = [name, commit.map { "(\($0.prefix(7)))" }].compactMap { $0 }.joined(separator: " ")
        switch state {
        case .current: return "up to date: Polycarp \(build) is the newest on the \(channel.rawValue) channel"
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
