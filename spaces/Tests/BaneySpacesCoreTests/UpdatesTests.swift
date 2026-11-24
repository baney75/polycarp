import XCTest
@testable import BaneySpacesCore

final class UpdatesTests: XCTestCase {
    let commit = String(repeating: "c", count: 40)

    /// A latest.json as spaces/scripts/write-feed.sh writes it.
    func feed(_ channel: String, _ version: String, commit: String? = nil, platforms: [String] = ["darwin-aarch64"]) -> Feed? {
        let p = platforms.map { #""\#($0)":{"url":"u","signature":"","sha256":"s","requirement":"r"}"# }.joined(separator: ",")
        let json = #"{"product":"polycarp","channel":"\#(channel)","version":"\#(version)","commit":"\#(commit ?? self.commit)","pub_date":"2026-11-18T07:00:00Z","notes":"Notes.","protocol":1,"platforms":{\#(p)}}"#
        return Feed(json: Data(json.utf8))
    }

    func build(_ version: String, release: Bool = true, commit: String = "aaaaaaa") -> BuildInfo {
        BuildInfo(version: version, commit: commit, commitDate: nil, isRelease: release)
    }

    /// Nightly took over from preview, whose builds all carried the plain base version (0.3.0). A nightly of
    /// that base sorts below it, which is why main went to 0.4.0 at the rename (docs/releases.md).
    func testVersionsSortDevNightlyStableAndNightlySortsAbovePreview() throws {
        let order = ["0.3.0-dev.20261117131042+9f8e7d6", "0.3.0-nightly.20261116070000+1a2b3c4", "0.3.0",
                     "0.4.0-dev.0+local.9f8e7d6", "0.4.0-dev.20261117131042+9f8e7d6", "0.4.0-nightly.9",
                     "0.4.0-nightly.20261118070000+1a2b3c4", "0.4.0", "0.4.1", "0.10.0"]
        let versions = try order.map { try XCTUnwrap(SemVer($0), $0) }
        for (lower, higher) in zip(versions, versions.dropFirst()) {
            XCTAssertLessThan(lower, higher, "\(lower) < \(higher)")
            XCTAssertFalse(higher < lower, "\(higher) < \(lower)")
        }
        // Build metadata never orders; numeric identifiers compare as numbers.
        XCTAssertEqual(SemVer("0.4.0-nightly.20261118070000+aaaaaaa"), SemVer("0.4.0-nightly.20261118070000+bbbbbbb"))
        XCTAssertLessThan(SemVer("0.4.0-nightly.9")!, SemVer("0.4.0-nightly.10")!)
        for bad in ["0.4", "v0.4.0", "0.4.0-", "0.4.0+", "01.4.0", "0.4.0-nightly.01", "0.4.0-night ly.1", "preview"] {
            XCTAssertNil(SemVer(bad), bad)
        }

        // A preview copy (0.3.0) is offered the first nightly; a 0.3.0 nightly would not be.
        let preview = build("0.3.0")
        XCTAssertEqual(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+ccccccc")), build: preview)?.tag, "nightly")
        XCTAssertNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.3.0-nightly.20261118070000+ccccccc")), build: preview))
        // Each later build is offered over the one before; the same or an older one never is.
        let installed = build("0.4.0-nightly.20261118070000+aaaaaaa")
        XCTAssertNotNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261119070000+ccccccc")), build: installed))
        XCTAssertNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261117070000+ccccccc")), build: installed))
        XCTAssertNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261119070000+ccccccc", commit: "aaaaaaa" + String(repeating: "0", count: 33))), build: installed))
    }

    /// One feed for every copy, and the choice copies from before one stream saved is dropped, never read.
    func testEveryCopyReadsTheOneFeed() throws {
        XCTAssertEqual(Updates.feedURL.absoluteString, "https://github.com/baney75/polycarp/releases/download/nightly/latest.json")
        let updater = try Repo.code("Sources/BaneySpaces/Updater.swift")
        XCTAssertTrue(updater.contains("URLRequest(url: Updates.feedURL,"))
        XCTAssertEqual(updater.components(separatedBy: "\"updateChannel\"").count - 1, 1)
        XCTAssertTrue(updater.contains("UserDefaults.standard.removeObject(forKey: \"updateChannel\")"))
        // Settings and the command name no channel.
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        for gone in ["Picker(\"Follow\"", "Stable:", "Nightly:", "Dev:"] { XCTAssertFalse(setup.contains(gone), gone) }
        XCTAssertFalse(try Repo.code("Sources/baneyspaces-cli/main.swift").contains("--channel"))
    }

    /// A build carries `PolycarpChannel`: today's releases say nightly, older ones stable, nightly or dev, and a
    /// build made here says local or nothing. Only a local build skips the version check.
    func testALocalBuildIsNeverTakenForARelease() throws {
        for value in ["nightly", "dev", "stable"] { XCTAssertTrue(BuildInfo.isRelease(channel: value), value) }
        for value in ["local", "", nil] { XCTAssertFalse(BuildInfo.isRelease(channel: value), value ?? "nil") }
        let next = try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+1a2b3c4"))
        // A local build of a newer base is still offered the feed's build; the app asks GitHub whether it contains this one.
        XCTAssertNotNil(Updates.offer(next, build: build("0.5.0-dev.0+local.aaaaaaa", release: false)))
        XCTAssertNil(Updates.offer(next, build: build("0.5.0-nightly.20261118070000+aaaaaaa")))
        // A dev build from before one stream (dev sorts below nightly) is offered the next build.
        XCTAssertNotNil(Updates.offer(next, build: build("0.4.0-dev.20261118090000+aaaaaaa")))
    }

    func testAFeedIsReadOnlyWhenItIsAReleaseFeed() throws {
        let nightly = try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+1a2b3c4"))
        XCTAssertEqual(nightly.release, Release(tag: "nightly", name: "Polycarp 0.4.0 (2026-11-18)", notes: "Notes.", commit: commit))
        XCTAssertNil(feed("dev", "0.4.0-dev.20261117131042+9f8e7d6"))
        XCTAssertNil(feed("stable", "0.4.0"))
        XCTAssertNil(feed("nightly", "0.4.0"))
        XCTAssertNil(feed("dev", "0.4.0-nightly.20261118070000+1a2b3c4"))
        XCTAssertNil(feed("nightly", "0.4.0-nightly.20261118070000", commit: "abc1234"))
        XCTAssertNil(Feed(json: Data(#"{"product":"other","channel":"nightly","version":"0.4.0-nightly.20261118070000","commit":"\#(commit)","platforms":{}}"#.utf8)))
        XCTAssertTrue(nightly.release.isInstallable)
    }

    func testOnlyABuildForThisMacIsOffered() throws {
        let nightly = try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+1a2b3c4"))
        XCTAssertNil(Updates.offer(nightly, build: build("0.3.0"), platform: "darwin-x86_64"))
        let both = try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+1a2b3c4", platforms: ["darwin-aarch64", "darwin-x86_64"]))
        XCTAssertNotNil(Updates.offer(both, build: build("0.3.0"), platform: "darwin-x86_64"))
    }

    func testOnlyTheReleaseTagIsInstallable() {
        XCTAssertTrue(Release(tag: "nightly", name: "", notes: "", commit: nil).isInstallable)
        for tag in ["v0.4.0", "dev", "v0.3.0; rm -rf ~", "main", "preview", "0.4.0", "nightly-20261118070000"] {
            XCTAssertFalse(Release(tag: tag, name: "", notes: "", commit: nil).isInstallable, tag)
        }
    }

    func testVersionsCompareNumerically() {
        XCTAssertLessThan(Version("v0.2.9")!, Version("v0.2.10")!)
        XCTAssertLessThan(Version("0.2")!, Version("0.2.1")!)
        XCTAssertNil(Version("nightly"))
        XCTAssertNil(Version("v1.2.x"))
        XCTAssertNil(Version("v+1.0"))
        XCTAssertNil(Version("-1.2"))
        XCTAssertNil(Version("v1..2"))
    }

    // MARK: `polycarp-spaces update` and `--version`

    func testAnUpdateReportSurvivesTheSocketAndSaysWhatToDo() {
        let table: [(UpdateReport, Int32, String)] = [
            (UpdateReport(state: .current, build: "0.4.0 (abc1234)", checks: 2), 0,
             "up to date: Polycarp 0.4.0 (abc1234) is the newest build"),
            (UpdateReport(state: .available, build: "0.4.0", name: "Polycarp 0.4.0 (2026-11-25)", commit: "0123456789abcdef", checks: 1), 100,
             "update available: Polycarp 0.4.0 (2026-11-25) (0123456). You have 0.4.0"),
            (UpdateReport(state: .installing, build: "0.4.0", name: "Polycarp 0.4.0 (2026-11-25)", checks: 1), 100,
             "an update is installing: Polycarp 0.4.0 (2026-11-25). Polycarp restarts when it is done"),
            (UpdateReport(state: .unknown, build: "0.4.0", checks: 1, problem: "The Internet connection appears to be offline."), 1,
             "could not check for updates: The Internet connection appears to be offline."),
            (UpdateReport(state: .unknown, build: "0.4.0"), 1, "could not check for updates: no check has finished yet"),
        ]
        for (report, code, line) in table {
            XCTAssertEqual(UpdateReport(info: report.info), report, line)
            XCTAssertEqual(report.exitCode, code, line)
            XCTAssertEqual(report.line, line)
        }
        // An older app answers the unknown request with an error and no report: that is not "up to date".
        XCTAssertNil(UpdateReport(info: nil))
        XCTAssertNil(UpdateReport(info: ["version": "0.2.0"]))
        XCTAssertNil(UpdateReport(info: ["state": "fine", "build": "0.2.1"]))
        // An app from before one stream also sends its channel; the report reads without it.
        XCTAssertEqual(UpdateReport(info: ["state": "current", "build": "0.4.0", "channel": "dev", "checks": "1"])?.line,
                       "up to date: Polycarp 0.4.0 is the newest build")
    }

    func testTheCommandReadsItsBuildFromTheAppItSitsIn() {
        let info: [String: Any] = ["CFBundleShortVersionString": "0.2.1", "PolycarpCommit": "abc1234def5678", "PolycarpCommitDirty": "0"]
        XCTAssertEqual(InstalledBuild.line(info: info, name: "polycarp-spaces"), "polycarp-spaces 0.2.1 (abc1234)")
        var dirty = info
        dirty["PolycarpCommitDirty"] = "1"
        XCTAssertEqual(InstalledBuild.line(info: dirty, name: "polycarp-spaces"), "polycarp-spaces 0.2.1 (abc1234-dirty)")
        // "unknown" is what the build writes outside a git checkout.
        XCTAssertEqual(InstalledBuild.line(info: ["CFBundleShortVersionString": "0.2.1", "PolycarpCommit": "unknown"], name: "polycarp-spaces"), "polycarp-spaces 0.2.1")

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-build-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let bin = root.appendingPathComponent("Polycarp.app/Contents/Resources/bin")
        try? FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        XCTAssertTrue((info as NSDictionary).write(to: root.appendingPathComponent("Polycarp.app/Contents/Info.plist"), atomically: true))
        let exe = bin.appendingPathComponent("polycarp-spaces").path
        FileManager.default.createFile(atPath: exe, contents: Data())
        XCTAssertEqual(InstalledBuild.line(executable: exe, name: "polycarp-spaces"), "polycarp-spaces 0.2.1 (abc1234)")
        // Through a link in ~/.local/bin it is still the app's build.
        let link = root.appendingPathComponent("polycarp-spaces").path
        try? FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: exe)
        XCTAssertEqual(InstalledBuild.line(executable: link, name: "polycarp-spaces"), "polycarp-spaces 0.2.1 (abc1234)")
        XCTAssertEqual(InstalledBuild.line(executable: root.appendingPathComponent("loose").path, name: "polycarp-spaces"), "polycarp-spaces (not inside Polycarp.app)")
    }
}
