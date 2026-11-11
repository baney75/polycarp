import XCTest
@testable import BaneySpacesCore

final class UpdatesTests: XCTestCase {
    let iso = ISO8601DateFormatter()
    func date(_ s: String) -> Date { iso.date(from: s)! }

    func release(_ tag: String, commit: String? = nil, date: String? = nil, pre: Bool = false) -> Release {
        let marker = commit.map { "\n<!-- baneyspaces commit=\($0) date=\(date!) -->" } ?? ""
        return Release(tag: tag, name: tag, notes: "Notes for \(tag).\(marker)", prerelease: pre, url: "")
    }

    func testMarkerIsReadAndHiddenFromNotes() {
        let r = release("nightly", commit: "abc1234def", date: "2026-10-12T07:00:00Z", pre: true)
        XCTAssertEqual(r.commit, "abc1234def")
        XCTAssertEqual(r.commitDate, date("2026-10-12T07:00:00Z"))
        XCTAssertEqual(r.notes, "Notes for nightly.")
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

    func testStableOffersOnlyANewerTaggedRelease() {
        let build = BuildInfo(version: "0.2.1", commit: "aaaaaaa", commitDate: date("2026-10-11T12:00:00Z"))
        let old = release("v0.2.1")
        let next = release("v0.2.2", commit: "bbbbbbb", date: "2026-10-13T12:00:00Z")
        let nightly = release("nightly", commit: "ccccccc", date: "2026-10-14T07:00:00Z", pre: true)
        XCTAssertNil(Updates.offer(from: [old], channel: .stable, build: build))
        XCTAssertEqual(Updates.offer(from: [nightly, next, old], channel: .stable, build: build)?.tag, "v0.2.2")
    }

    func testNightlyOffersTheNewestOfNightlyAndStable() {
        let build = BuildInfo(version: "0.2.1", commit: "aaaaaaa", commitDate: date("2026-10-11T12:00:00Z"))
        let stable = release("v0.2.2", commit: "bbbbbbb", date: "2026-10-13T12:00:00Z")
        let nightly = release("nightly", commit: "ccccccc", date: "2026-10-14T07:00:00Z", pre: true)
        XCTAssertEqual(Updates.offer(from: [nightly, stable], channel: .nightly, build: build)?.tag, "nightly")
        let staleNightly = release("nightly", commit: "ddddddd", date: "2026-10-12T07:00:00Z", pre: true)
        XCTAssertEqual(Updates.offer(from: [staleNightly, stable], channel: .nightly, build: build)?.tag, "v0.2.2")
    }

    func testNeverOffersTheBuildYouHaveOrAnOlderOne() {
        let build = BuildInfo(version: "0.2.1", commit: "ccccccc1234", commitDate: date("2026-10-14T07:00:00Z"))
        let same = release("nightly", commit: "ccccccc", date: "2026-10-14T07:00:00Z", pre: true)
        let older = release("v0.2.2", commit: "bbbbbbb", date: "2026-10-13T12:00:00Z")
        XCTAssertNil(Updates.offer(from: [same, older], channel: .nightly, build: build))
        // Leaving nightly for stable waits for a stable release newer than this build.
        XCTAssertNil(Updates.offer(from: [same, older], channel: .stable, build: build))
    }

    func testOnlyBaneySpacesTagsAreInstallable() {
        XCTAssertTrue(release("v0.3.0").isInstallable)
        XCTAssertTrue(release("nightly").isInstallable)
        XCTAssertFalse(release("v0.3.0; rm -rf ~").isInstallable)
        XCTAssertFalse(release("main").isInstallable)
    }

    func testADraftReleaseIsNeverOffered() {
        // `make release` publishes only after the assets are checked; until then the release is a draft.
        let json = #"[{"tag_name":"v0.3.0","name":"0.3.0","body":"x","prerelease":false,"draft":true,"html_url":"u"}]"#
        let build = BuildInfo(version: "0.2.2", commit: nil, commitDate: nil)
        XCTAssertNil(Updates.offer(from: Release.list(fromGitHubJSON: Data(json.utf8)), channel: .stable, build: build))
    }

    func testGitHubListSkipsDrafts() {
        let json = #"[{"tag_name":"v0.3.0","name":"0.3.0","body":"x","prerelease":false,"draft":true,"html_url":"u"},{"tag_name":"nightly","name":"Nightly","body":"y","prerelease":true,"draft":false,"html_url":"u"}]"#
        XCTAssertEqual(Release.list(fromGitHubJSON: Data(json.utf8)).map(\.tag), ["nightly"])
    }

    // MARK: `polycarp-spaces update` and `--version`

    func testAnUpdateReportSurvivesTheSocketAndSaysWhatToDo() {
        let table: [(UpdateReport, Int32, String)] = [
            (UpdateReport(state: .current, build: "0.2.1 (abc1234)", channel: .stable, checks: 2), 0,
             "up to date: Polycarp 0.2.1 (abc1234) is the newest on the stable channel"),
            (UpdateReport(state: .available, build: "0.2.1", channel: .nightly, name: "Nightly", commit: "0123456789abcdef", checks: 1), 100,
             "update available: Nightly (0123456). You have 0.2.1"),
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
