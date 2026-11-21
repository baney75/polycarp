import XCTest
@testable import BaneySpacesCore


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
