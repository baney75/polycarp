import XCTest

/// 2026-11-21 (owner: "switching of windows, and tabs, and search still appears to be glitchy and slow"): trace.log had
/// 50 `slow scan: ... on main` lines in four hours (p50 255 ms, p90 260, max 303), each the main thread waiting on an
/// app's Accessibility answer, and dock opens of 337 ms landed in the same second as one. Scans now run on a background
/// queue and the main thread acts on the last answer. These checks fail if a switch, a dock or overview open, the
/// launcher, a key press in its search, or a focus change asks an app on the main thread again.
final class MainThreadScanTests: XCTestCase {
    /// Calls that wait on another app's answer.
    private let asksAnApp = ["Windows.all(", "AXUIElementCopyAttributeValue", "refreshNow(", "Windows.focused(",
                             "newWindowItem(", "Windows.standardIDs(", "Windows.listedIDs(", "Windows.details(", "Windows.look("]

    private func assertAsksNoApp(_ path: String, _ markers: [String], file: StaticString = #filePath, line: UInt = #line) throws {
        let s = try SourceText.code(path)
        for m in markers {
            let b = try XCTUnwrap(SourceText.block(after: m, in: s), "\(m) not found in \(path)", file: file, line: line)
            for call in asksAnApp where b.contains(call) {
                XCTFail("\(path) \(m) calls \(call) on the main thread", file: file, line: line)
            }
        }
    }

    private func count(_ needle: String, in s: String) -> Int { s.components(separatedBy: needle).count - 1 }

    func testTheSwitchAsksNoAppOnMain() throws {
        try assertAsksNoApp("Sources/BaneySpaces/Spaces.swift", [
            "func switchTo(_ n: Int, takeFocus", "private func plan(_ n: Int, moveFocus", "private func refresh(full: Bool, asking",
            "private func scanStart(full", "private func scanLanded(", "private func applyScan(", "func finish()",
        ])
        try assertAsksNoApp("Sources/BaneySpaces/WorkspaceSwitcher.swift", ["func commit("])
    }

    func testDockAndOverviewOpenAskNoAppOnMain() throws {
        try assertAsksNoApp("Sources/BaneySpaces/WorkspaceDock.swift", ["private func show(on screen: NSScreen", "func load(from spaces: Spaces)"])
        try assertAsksNoApp("Sources/BaneySpaces/Viewer.swift", ["func open()", "func load(from spaces: Spaces)"])
        try assertAsksNoApp("Sources/BaneySpaces/Spaces.swift", ["func entries(on n: Int)", "func entry(for id: WindowID)",
                                                                 "func backgroundApps()", "func rememberFocus()"])
    }

    func testTheLauncherAndItsSearchAskNoAppOnMain() throws {
        try assertAsksNoApp("Sources/BaneySpaces/Launcher.swift", [
            "func prepare(scope: Scope)", "private func rebuild()", "private func appItems(", "private func appItem(",
            "private func opensHere(", "private func open(_ a: AppEntry)",
        ])
        let d = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let byApp = try XCTUnwrap(SourceText.block(after: "a.workspacesByApp =", in: d))
        for call in asksAnApp { XCTAssertFalse(byApp.contains(call), "workspacesByApp calls \(call)") }
        let open = try XCTUnwrap(SourceText.block(after: "a.openWindowHere =", in: d))
        XCTAssertFalse(open.contains("newWindowItem("))
        // The New Window look reads the app's menus: off the main thread, answered back on it.
        let can = try XCTUnwrap(SourceText.block(after: "a.canOpenWindow =", in: d))
        let off = try XCTUnwrap(SourceText.block(after: "Spaces.axQueue.async", in: can))
        XCTAssertTrue(off.contains("Windows.newWindowItem(pid)"))
        XCTAssertTrue(off.contains("DispatchQueue.main.async"))
    }

    /// The app list is read from disk off the main thread, and a key press compares precomputed keys.
    func testTheAppListIsAnIndexBuiltOffMain() throws {
        let s = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        let scans = count("AppEntry.scan()", in: s)
        XCTAssertGreaterThan(scans, 0)
        XCTAssertEqual(count("DispatchQueue.global(qos: .userInitiated).async { [weak self] in\n            let fresh = AppEntry.scan()", in: s), scans,
                       "an app list read on the main thread")
        let items = try XCTUnwrap(SourceText.block(after: "private func appItems(", in: s))
        XCTAssertTrue(items.contains("Fuzzy.score(folded: folded, key: a.key)"))
        XCTAssertFalse(items.contains("Fuzzy.score(q, a.name)"), "a key press folds every app name again")
        XCTAssertFalse(items.contains("runningApplications"), "a key press walks the running apps")
    }

    /// Focus moving to another app or another of its windows reads the app off the main thread (`ask`).
    func testFocusChangesAskOffMain() throws {
        let s = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        for m in ["private func followFocus()", "private func focusMovedWithin("] {
            let b = try XCTUnwrap(SourceText.block(after: m, in: s))
            XCTAssertEqual(count("Windows.look(", in: b), count("ask({ Windows.look(", in: b), "\(m) reads the app on main")
            XCTAssertGreaterThan(count("ask({ Windows.look(", in: b), 0)
        }
        let ask = try XCTUnwrap(SourceText.block(after: "private func ask<T>(", in: s))
        XCTAssertTrue(ask.contains("Spaces.axQueue.async"))
    }

    /// The whole-list Accessibility scan runs in two places: the background scan, and the one at launch and quit that
    /// must finish before Polycarp places or lets go of windows.
    func testTheScanRunsOnlyOffMainOrAtLaunchAndQuit() throws {
        let s = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertEqual(count("Windows.all(", in: s), 2)
        let bg = try XCTUnwrap(SourceText.block(after: "private func startScan()", in: s))
        XCTAssertEqual(count("Windows.all(", in: try XCTUnwrap(SourceText.block(after: "Spaces.scanQueue.async", in: bg))), 1)
        XCTAssertEqual(count("Windows.all(", in: try XCTUnwrap(SourceText.block(after: "private func refreshNow()", in: s))), 1)
        XCTAssertEqual(count("refreshNow()", in: s), 3, "refreshNow is called from somewhere new")
        XCTAssertEqual(count("refreshNow()", in: try XCTUnwrap(SourceText.block(after: "func start()", in: s))), 1)
        XCTAssertEqual(count("refreshNow()", in: try XCTUnwrap(SourceText.block(after: "func restoreAll()", in: s))), 1)
        for file in ["AppDelegate", "WorkspaceDock", "Viewer", "Launcher", "WorkspaceSwitcher", "FocusWatcher"] {
            let other = try SourceText.code("Sources/BaneySpaces/\(file).swift")
            XCTAssertFalse(other.contains("Windows.all("), "\(file) scans every app")
        }
        let q = try XCTUnwrap(SourceText.between("static let scanQueue", "\n", in: s))
        XCTAssertTrue(q.contains("DispatchQueue("), q)
    }

    /// The background scan times itself and says "off main"; the launch and quit scan says "on main".
    func testEachScanTimesItselfAndSaysWhere() throws {
        let s = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        let bg = try XCTUnwrap(SourceText.block(after: "private func startScan()", in: s))
        let queued = try XCTUnwrap(SourceText.block(after: "Spaces.scanQueue.async", in: bg))
        XCTAssertTrue(queued.contains("let fresh = Windows.all(asking: plan.ask)"))
        XCTAssertTrue(queued.contains("ScanCheck.slowScanLine(seconds: ProcessInfo.processInfo.systemUptime - started"))
        XCTAssertTrue(queued.contains("onMain: false"))
        let now = try XCTUnwrap(SourceText.block(after: "private func refreshNow()", in: s))
        XCTAssertTrue(now.contains("ScanCheck.slowScanLine(seconds: ProcessInfo.processInfo.systemUptime - started"))
        XCTAssertTrue(now.contains("onMain: true"))
    }
}
