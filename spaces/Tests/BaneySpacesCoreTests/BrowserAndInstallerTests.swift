import XCTest
@testable import BaneySpacesCore


final class BrowserPreviousTests: XCTestCase {
    private func home() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("bp-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    private func write(_ s: String, _ url: URL) {
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(s.utf8).write(to: url)
    }

    func testTheOldManifestAndLauncherAreWrittenDownOnce() throws {
        let h = home(), store = home()
        let chrome = h.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.polycarp.browser.json")
        write("old manifest", chrome)
        write("old launcher", h.appendingPathComponent(".config/tabkyra/host"))
        XCTAssertTrue(BrowserPrevious.record(home: h, store: store))
        let index = try String(contentsOf: store.appendingPathComponent("index.tsv"))
        XCTAssertTrue(index.contains(chrome.path), index)
        XCTAssertTrue(index.contains(".config/tabkyra/host"))
        XCTAssertTrue(index.contains("tabkyra\t-"), "the launcher that wasn't there is recorded as none")
        XCTAssertFalse(index.contains("Brave"), "a browser that isn't installed is not recorded")
        write("{\"path\":\"/Applications/Polycarp.app/x\"}", chrome)
        XCTAssertFalse(BrowserPrevious.record(home: h, store: store), "a second Connect records nothing new")
        XCTAssertEqual(try String(contentsOf: store.appendingPathComponent("index.tsv")), index)
    }

    func testAFileAlreadyPointingIntoPolycarpIsNotRecordedAsPrevious() throws {
        let h = home(), store = home()
        write("exec /Applications/Polycarp.app/Contents/Resources/browser/polycarp-browser", h.appendingPathComponent(".config/tabkyra/host"))
        BrowserPrevious.record(home: h, store: store)
        let index = try String(contentsOf: store.appendingPathComponent("index.tsv"))
        XCTAssertFalse(index.contains("tabkyra/host\t"), index)
    }

    func testUninstallPutsThemBackOrRemovesWhatPolycarpMade() throws {
        let h = home(), store = home()
        let chrome = h.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.polycarp.browser.json")
        let host = h.appendingPathComponent(".config/tabkyra/host")
        let cli = h.appendingPathComponent(".config/tabkyra/tabkyra")
        write("old manifest", chrome); write("old launcher", host)
        BrowserPrevious.record(home: h, store: store)
        write("{\"path\":\"/Applications/Polycarp.app/h\"}", chrome)
        write("exec /Applications/Polycarp.app/h", host)
        write("exec /Applications/Polycarp.app/h", cli)
        let sh = try Repo.text("uninstall.sh")
        let from = try XCTUnwrap(sh.range(of: "# BEGIN restore-browser-previous"))
        let to = try XCTUnwrap(sh.range(of: "# END restore-browser-previous"))
        let block = String(sh[from.upperBound..<to.lowerBound])
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "set -eu; STORE='\(store.path)'; \(block)"]
        p.environment = ["HOME": h.path, "PATH": "/usr/bin:/bin"]
        try p.run(); p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0)
        XCTAssertEqual(try String(contentsOf: chrome), "old manifest")
        XCTAssertEqual(try String(contentsOf: host), "old launcher")
        XCTAssertFalse(FileManager.default.fileExists(atPath: cli.path), "there was none before, so Polycarp's is removed")
    }
}

final class BrowserHostNameTests: XCTestCase {
    private func home() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("bh-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    private func write(_ s: String, _ url: URL) {
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(s.utf8).write(to: url)
    }
    private func hosts(_ h: URL, _ browser: String) -> URL {
        h.appendingPathComponent("Library/Application Support/\(browser)/NativeMessagingHosts")
    }
    private func uninstallBlock(home h: URL, store: URL) throws -> Int32 {
        let sh = try Repo.text("uninstall.sh")
        let from = try XCTUnwrap(sh.range(of: "# BEGIN restore-browser-previous"))
        let to = try XCTUnwrap(sh.range(of: "# END restore-browser-previous"))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "set -eu; STORE='\(store.path)'; \(String(sh[from.upperBound..<to.lowerBound]))"]
        p.environment = ["HOME": h.path, "PATH": "/usr/bin:/bin"]
        try p.run(); p.waitUntilExit()
        return p.terminationStatus
    }

    func testTheHelperRegistersTheNewNameAndTheOldOneIsStillKnown() {
        XCTAssertEqual(BrowserPrevious.hostName, "com.polycarp.browser")
        XCTAssertEqual(BrowserPrevious.hostNames, ["com.polycarp.browser", "ai.tabkyra.bridge"])
        let names = BrowserPrevious.paths(home: URL(fileURLWithPath: "/h")).map(\.lastPathComponent)
        XCTAssertEqual(names.filter { $0 == "com.polycarp.browser.json" }.count, 10)
        XCTAssertEqual(names.filter { $0 == "ai.tabkyra.bridge.json" }.count, 10)
    }

    func testBothNamesAreRecordedAndUninstallPutsTheOldBackAndRemovesTheNew() throws {
        let h = home(), store = home()
        let dir = hosts(h, "Google/Chrome")
        let old = dir.appendingPathComponent("ai.tabkyra.bridge.json"), new = dir.appendingPathComponent("com.polycarp.browser.json")
        write("old manifest", old)
        XCTAssertTrue(BrowserPrevious.record(home: h, store: store))
        let index = try String(contentsOf: store.appendingPathComponent("index.tsv"))
        XCTAssertTrue(index.contains(old.path) && index.contains("\(new.path)\t-"), index)
        write("{\"path\":\"/Applications/Polycarp.app/h\"}", old); write("{\"path\":\"/Applications/Polycarp.app/h\"}", new)
        XCTAssertEqual(try uninstallBlock(home: h, store: store), 0)
        XCTAssertEqual(try String(contentsOf: old), "old manifest")
        XCTAssertFalse(FileManager.default.fileExists(atPath: new.path))
    }

    func testAListFromBeforeTheRenameStillLosesPolycarpsNewManifestButNotAStandaloneOne() throws {
        let h = home(), store = home()
        let chrome = hosts(h, "Google/Chrome").appendingPathComponent("com.polycarp.browser.json")
        let brave = hosts(h, "BraveSoftware/Brave-Browser").appendingPathComponent("com.polycarp.browser.json")
        // An index from before the rename lists only the old name.
        write("\(hosts(h, "Google/Chrome").appendingPathComponent("ai.tabkyra.bridge.json").path)\t-\n", store.appendingPathComponent("index.tsv"))
        write("{\"path\":\"/Applications/Polycarp.app/h\"}", chrome)
        write("{\"path\":\"/Users/x/.config/polycarp/browser/polycarp-host\"}", brave)
        XCTAssertEqual(try uninstallBlock(home: h, store: store), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: chrome.path), "Polycarp's own goes")
        XCTAssertTrue(FileManager.default.fileExists(atPath: brave.path), "a standalone helper's stays")
    }

    func testTurningBrowserOffParksBothNames() throws {
        let h = home()
        let dir = hosts(h, "Vivaldi")
        for name in BrowserPrevious.hostNames { write("{\"path\":\"/Applications/Polycarp.app/x\"}", dir.appendingPathComponent("\(name).json")) }
        XCTAssertEqual(BrowserHosts.setEnabled(false, home: h), 2)
        XCTAssertEqual(BrowserHosts.setEnabled(true, home: h), 2)
    }
}

final class BrowserPathTests: XCTestCase {
    func testTheHelperGetsTheLoginPathThenTheUsualFolders() {
        let p = BrowserBundle.path(base: "/usr/bin:/bin", loginPath: "/Users/x/.nvm/bin:/opt/homebrew/bin:/usr/bin", home: "/Users/x")
        XCTAssertEqual(p, "/Users/x/.nvm/bin:/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin:/usr/local/bin:/bin")
    }
    func testWithoutALoginPathTheUsualFoldersStillComeFirst() {
        XCTAssertEqual(BrowserBundle.path(base: "/usr/bin:/bin", loginPath: nil, home: "/h"), "/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        XCTAssertEqual(BrowserBundle.environment(base: ["PATH": "bin:/usr/bin"], home: "/h")["PATH"], "/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin", "a relative entry is dropped")
    }
}

final class InstallerLoginPathTests: XCTestCase {
    private func temp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("itl-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: d) }
        return d
    }
    /// A test shell, run once untimed before any test times it. 11-12: the first exec of a new unsigned file waits on
    /// Gatekeeper's scan (syspolicyd "GK performScan"), and that scan checks notarization online: with the network slow
    /// or just back from sleep it took over 3 s (cloudkit -1001 at 3.0 s), the shell printed nothing and a timed read
    /// failed 1 run in 4. The scan runs once per file, so after this warm-up the deadlines time only `readLoginPath`.
    /// A real login shell is a signed system binary and never waits like this.
    private func script(_ body: String, at url: URL) {
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data("#!/bin/sh\n[ \"$1\" = warm ] && exit 0\n\(body)\n".utf8).write(to: url)
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        let warm = Process(); warm.executableURL = url; warm.arguments = ["warm"]
        try! warm.run(); warm.waitUntilExit()
        XCTAssertEqual(warm.terminationStatus, 0, "the warm-up exits before the body runs")
    }

    func testTheLoginPathReadsWithinItsDeadlineEvenIfTheProfileLeavesAProcessBehind() {
        let dir = temp()
        let good = dir.appendingPathComponent("good-shell")
        script("printf %s /Users/x/bin:/usr/bin", at: good)
        XCTAssertEqual(BrowserBundle.readLoginPath(shell: good, timeout: 3), "/Users/x/bin:/usr/bin")
        // A profile that starts a background process holding stdout: the shell exits, the pipe stays open.
        let leaky = dir.appendingPathComponent("leaky-shell")
        script("(sleep 6) &\nprintf %s /a:/b", at: leaky)
        let t0 = Date()
        XCTAssertNil(BrowserBundle.readLoginPath(shell: leaky, timeout: 1), "no answer rather than a hang")
        XCTAssertLessThan(Date().timeIntervalSince(t0), 3, "gave up at the deadline")
        let hung = dir.appendingPathComponent("hung-shell")
        script("sleep 6", at: hung)
        let t1 = Date()
        XCTAssertNil(BrowserBundle.readLoginPath(shell: hung, timeout: 1))
        XCTAssertLessThan(Date().timeIntervalSince(t1), 3)
        let failing = dir.appendingPathComponent("failing-shell")
        script("exit 3", at: failing)
        XCTAssertNil(BrowserBundle.readLoginPath(shell: failing, timeout: 3))
    }

    /// 11-12, run 3 of 5 at load 9: the good shell answered nil at its 3 s deadline. The read waited for a thread from the
    /// global pool, which the parallel tests had filled. Every global thread busy here: the answer must still come.
    func testTheLoginPathReadsEvenWhenEveryGlobalThreadIsBusy() {
        let good = temp().appendingPathComponent("good-shell")
        script("printf %s /Users/x/bin:/usr/bin", at: good)
        let release = DispatchSemaphore(value: 0)
        let started = DispatchSemaphore(value: 0)
        for _ in 0..<256 { DispatchQueue.global().async { started.signal(); release.wait() } }
        // At least the pool's width is blocked before the read starts.
        for _ in 0..<32 { _ = started.wait(timeout: .now() + 2) }
        defer { for _ in 0..<256 { release.signal() } }
        let t0 = Date()
        XCTAssertEqual(BrowserBundle.readLoginPath(shell: good, timeout: 3), "/Users/x/bin:/usr/bin")
        XCTAssertLessThan(Date().timeIntervalSince(t0), 3)
    }
}
