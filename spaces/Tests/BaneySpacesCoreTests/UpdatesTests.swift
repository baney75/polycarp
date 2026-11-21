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

    func build(_ version: String, _ channel: UpdateChannel?, commit: String = "aaaaaaa") -> BuildInfo {
        BuildInfo(version: version, commit: commit, commitDate: nil, channel: channel)
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

        // A preview copy (0.3.0, choosing Nightly) is offered the first nightly; a 0.3.0 nightly would not be.
        let preview = build("0.3.0", .nightly)
        XCTAssertEqual(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+ccccccc")), channel: .nightly, build: preview)?.tag, "nightly")
        XCTAssertNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.3.0-nightly.20261118070000+ccccccc")), channel: .nightly, build: preview))
        // Each later nightly is offered over the one before; the same or an older one never is.
        let installed = build("0.4.0-nightly.20261118070000+aaaaaaa", .nightly)
        XCTAssertNotNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261119070000+ccccccc")), channel: .nightly, build: installed))
        XCTAssertNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261117070000+ccccccc")), channel: .nightly, build: installed))
        XCTAssertNil(Updates.offer(try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261119070000+ccccccc", commit: "aaaaaaa" + String(repeating: "0", count: 33))), channel: .nightly, build: installed))
        // Stable X.Y.Z is newer than every nightly of X.Y.Z.
        XCTAssertTrue(Updates.isNewerVersion(try XCTUnwrap(feed("stable", "0.4.0")), than: installed))
    }

    func testEachChannelHasItsOwnFeed() {
        XCTAssertEqual(UpdateChannel.stable.feedURL.absoluteString, "https://github.com/baney75/polycarp/releases/latest/download/latest.json")
        XCTAssertEqual(UpdateChannel.nightly.feedURL.absoluteString, "https://github.com/baney75/polycarp/releases/download/nightly/latest.json")
        XCTAssertEqual(UpdateChannel.dev.feedURL.absoluteString, "https://github.com/baney75/polycarp/releases/download/dev/latest.json")
        XCTAssertEqual(UpdateChannel.allCases, [.stable, .nightly, .dev])
        // A choice saved as "preview" follows nightly.
        XCTAssertEqual(UpdateChannel(rawValue: "preview"), .nightly)
        XCTAssertEqual(UpdateChannel(rawValue: "preview")?.feedURL, UpdateChannel.nightly.feedURL)
        XCTAssertNil(UpdateChannel(rawValue: "local"))
    }

    func testAFeedIsReadOnlyWhenItsVersionBelongsToItsChannel() throws {
        let nightly = try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+1a2b3c4"))
        XCTAssertEqual(nightly.release, Release(tag: "nightly", name: "Nightly 2026-11-18", notes: "Notes.", commit: commit))
        XCTAssertEqual(try XCTUnwrap(feed("dev", "0.4.0-dev.20261117131042+9f8e7d6")).release.tag, "dev")
        XCTAssertEqual(try XCTUnwrap(feed("stable", "0.4.0")).release, Release(tag: "v0.4.0", name: "Polycarp 0.4.0", notes: "Notes.", commit: commit))
        XCTAssertNil(feed("stable", "0.4.0-nightly.20261118070000+1a2b3c4"))
        XCTAssertNil(feed("nightly", "0.4.0"))
        XCTAssertNil(feed("dev", "0.4.0-nightly.20261118070000+1a2b3c4"))
        XCTAssertNil(feed("nightly", "0.4.0-nightly.20261118070000", commit: "abc1234"))
        XCTAssertNil(Feed(json: Data(#"{"product":"other","channel":"stable","version":"0.4.0","commit":"\#(commit)","platforms":{}}"#.utf8)))
        XCTAssertTrue(nightly.release.isInstallable)
    }

    func testAChannelIsOfferedOnlyItsOwnBuildForThisMac() throws {
        let nightly = try XCTUnwrap(feed("nightly", "0.4.0-nightly.20261118070000+1a2b3c4"))
        XCTAssertNil(Updates.offer(nightly, channel: .dev, build: build("0.3.0", .nightly)))
        XCTAssertNil(Updates.offer(nightly, channel: .nightly, build: build("0.3.0", .nightly), platform: "darwin-x86_64"))
        let universal = try XCTUnwrap(feed("stable", "0.4.0", platforms: ["darwin-aarch64", "darwin-x86_64"]))
        XCTAssertNotNil(Updates.offer(universal, channel: .stable, build: build("0.3.0", .stable), platform: "darwin-x86_64"))
    }

    func testChangingChannelOffersThatChannelsBuild() throws {
        // dev sorts below nightly, so a nightly copy moving to Dev is offered dev's build by channel, not by
        // version; the app then asks GitHub that it contains this build.
        let dev = try XCTUnwrap(feed("dev", "0.4.0-dev.20261118090000+9f8e7d6"))
        XCTAssertEqual(Updates.offer(dev, channel: .dev, build: build("0.4.0-nightly.20261118070000+aaaaaaa", .nightly))?.tag, "dev")
        XCTAssertFalse(Updates.isNewerVersion(dev, than: build("0.4.0-nightly.20261118070000+aaaaaaa", .nightly)))
        // A copy built on this Mac (no channel) is offered the channel's build too.
        XCTAssertNotNil(Updates.offer(dev, channel: .dev, build: build("0.4.0-dev.0+local.aaaaaaa", nil)))
    }

    func testOnlyPolycarpTagsAreInstallable() {
        for tag in ["v0.4.0", "nightly", "dev"] { XCTAssertTrue(Release(tag: tag, name: "", notes: "", commit: nil).isInstallable, tag) }
        for tag in ["v0.3.0; rm -rf ~", "main", "preview", "0.4.0", "nightly-20261118070000"] {
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
            (UpdateReport(state: .current, build: "0.2.1 (abc1234)", channel: .stable, checks: 2), 0,
             "up to date: Polycarp 0.2.1 (abc1234) is the newest on the stable channel"),
            (UpdateReport(state: .available, build: "0.2.1", channel: .nightly, name: "Nightly", commit: "0123456789abcdef", checks: 1), 100,
             "update available: Nightly (0123456). You have 0.2.1"),
            (UpdateReport(state: .current, build: "0.4.0 Dev (abc1234)", channel: .dev, checks: 1), 0,
             "up to date: Polycarp 0.4.0 Dev (abc1234) is the newest on the dev channel"),
            (UpdateReport(state: .installing, build: "0.2.1", channel: .stable, name: "v0.3.0", checks: 1), 100,
             "an update is installing: v0.3.0. Polycarp restarts when it is done"),
            (UpdateReport(state: .unknown, build: "0.2.1", channel: .stable, checks: 1, problem: "The Internet connection appears to be offline."), 1,
             "could not check for updates: The Internet connection appears to be offline."),
            (UpdateReport(state: .unknown, build: "0.2.1", channel: .stable), 1, "could not check for updates: no check has finished yet"),
        ]
        for (report, code, line) in table {
            XCTAssertEqual(UpdateReport(info: report.info), report, line)
            XCTAssertEqual(report.exitCode, code, line)
            XCTAssertEqual(report.line, line)
        }
        // An older app answers the unknown request with an error and no report: that is not "up to date".
        XCTAssertNil(UpdateReport(info: nil))
        XCTAssertNil(UpdateReport(info: ["version": "0.2.0"]))
        XCTAssertNil(UpdateReport(info: ["state": "fine", "build": "0.2.1", "channel": "stable"]))
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
