import XCTest

/// 2026-11-21 (owner: "switching of windows, and tabs, and search still appears to be glitchy and slow"): trace.log had
/// 50 `slow scan: ... on main` lines in four hours (p50 255 ms, p90 260, max 303), each the main thread waiting on an
/// app's Accessibility answer, and dock opens of 337 ms landed in the same second as one. Scans now run on a background
/// queue and the main thread acts on the last answer. These checks fail if a switch, an overview open, the
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
        try assertAsksNoApp("Sources/BaneySpaces/WorkspaceSwitcher.swift", ["func commit(", "private func go(to w"])
        try assertAsksNoApp("Sources/BaneySpaces/Spaces.swift", ["func switcherWindows()", "func focusWindow("])
        try assertAsksNoApp("Sources/BaneySpaces/Windows.swift", ["static func stacking("])
    }

    /// ⌘Tab's pick waits for a fresh list in the background, never with `refresh()` in the key's own turn.
    func testACommitWaitsForTheWindowListOffMain() throws {
        let s = try SourceText.code("Sources/BaneySpaces/WorkspaceSwitcher.swift")
        for m in ["func commit(", "private func go(to w"] {
            XCTAssertFalse(try XCTUnwrap(SourceText.block(after: m, in: s)).contains("refresh("), "\(m) refreshes on main")
        }
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "private func go(to w", in: s)).contains("spaces.focusWindow(w.id, pid: pid)"))
        let focus = try XCTUnwrap(SourceText.block(after: "func focusWindow(", in: try SourceText.code("Sources/BaneySpaces/Spaces.swift")))
        let held = try XCTUnwrap(SourceText.block(after: "holdUntilFresh(asking: askIfHidden(pid))", in: focus))
        XCTAssertTrue(held.contains("focus(id, on: n)"))
        XCTAssertTrue(held.contains("windowOrder.raised(id"), "the landing time starts at the raise, not at the key")
        let cards = try XCTUnwrap(SourceText.block(after: "func switcherWindows()", in: try SourceText.code("Sources/BaneySpaces/Spaces.swift")))
        XCTAssertTrue(cards.contains("Date() < settleUntil ? expectedFront"), "right after a switch macOS still names the app you left")
        XCTAssertTrue(held.contains("pickApp(pid, on: nil"), "a window closed meanwhile goes to its app")
    }

    func testTheOverviewOpenAsksNoAppOnMain() throws {
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

    /// Review of PR #624 first-F2: the launcher's "Running, no window" rows need every running app read (about 130,
    /// 25 to 30 ms). The open never waits for it: the read runs off the main thread (`RunningApps.prepare`) and the rows
    /// join after the first draw, as files and agents do.
    func testTheRestingRowsAreReadOffMainAfterTheOpenDraws() throws {
        let l = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        let prepare = try XCTUnwrap(SourceText.block(after: "func prepare(scope: Scope)", in: l))
        XCTAssertFalse(prepare.contains("= actions.restingApps()"), "the open waits on the running apps")
        let draw = try XCTUnwrap(prepare.range(of: "rebuild()"))
        let ask = try XCTUnwrap(prepare.range(of: "actions.restingApps {"), "the rows are asked for with a callback")
        XCTAssertLessThan(draw.lowerBound, ask.lowerBound, "the launcher draws before it asks")
        let answer = try XCTUnwrap(SourceText.block(after: "actions.restingApps ", in: prepare))
        XCTAssertTrue(answer.contains("ask == self.restingAsk"), "an answer for an earlier open is dropped")
        XCTAssertTrue(answer.contains("rebuildKeepingSelection()"), "the row you're on stays put when the rows join")
        XCTAssertFalse(prepare.contains("if scope == .root"), "Esc reaches the root from any scope, so every open asks")
        let d = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let resting = try XCTUnwrap(SourceText.block(after: "a.restingApps =", in: d))
        // Round 2 of #681, first-F1: `whenFreshWithHidden` asks which apps are hidden, which read them all on main.
        let first = try XCTUnwrap(resting.range(of: "RunningApps.prepare {"), "the running apps are read off main")
        let scan = try XCTUnwrap(resting.range(of: "whenFreshWithHidden"), "and the windows are as new as the open")
        XCTAssertLessThan(first.lowerBound, scan.lowerBound, "the read comes before anything that needs it")
        XCTAssertNotNil(resting.range(of: "RunningApps.prepare {", range: scan.upperBound..<resting.endIndex), "and again if it has aged")
        for call in asksAnApp { XCTAssertFalse(resting.contains(call), "restingApps calls \(call)") }
        let w = try SourceText.code("Sources/BaneySpaces/Windows.swift")
        let prep = try XCTUnwrap(SourceText.block(after: "static func prepare(then:", in: w))
        XCTAssertTrue(prep.contains("prepareNow(tries:"))
        let now = try XCTUnwrap(SourceText.block(after: "private static func prepareNow(", in: w))
        XCTAssertTrue(now.contains("if seed != started, tries > 1 { return prepareNow(tries: tries - 1) }"), "a stale read is read again off main")
        let off = try XCTUnwrap(SourceText.block(after: "factsQueue.async", in: now))
        XCTAssertTrue(off.contains("readFacts()"), "the read runs on the facts queue")
        XCTAssertTrue(off.contains("DispatchQueue.main.async"), "and answers on main")
        XCTAssertTrue(prep.contains("DispatchQueue.main.async(execute: then)"), "a fresh read still answers after the open draws")
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
        for file in ["AppDelegate", "Viewer", "Launcher", "WorkspaceSwitcher", "FocusWatcher"] {
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

    // Review of PR #574 (2026-11-21): four ways the background scan could drop or misplace work.

    /// first-F1: a follow whose look a switch overtook (one `applyScan` queued, say) is looked at again, never lost.
    func testAFollowASwitchOvertookIsNotLost() throws {
        let s = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        let ask = try XCTUnwrap(SourceText.block(after: "private func ask<T>(", in: s))
        XCTAssertTrue(ask.contains("guard gen == self.generation else { dropped?(); return }"), "ask drops an answer silently")
        let follow = try XCTUnwrap(SourceText.block(after: "private func followFocus()", in: s))
        let dropped = try XCTUnwrap(SourceText.block(after: "} dropped:", in: follow), "followFocus loses a dropped look")
        XCTAssertTrue(dropped.contains("followPending = true"))
        XCTAssertTrue(dropped.contains("if !switching { followIfPending() }"), "a switch already done never looks again")
    }

    /// first-F2: the launcher is built at launch, so its app list is read before the first open, and Return waits for
    /// that list rather than run a web search or file row an app would have topped.
    func testReturnWaitsForTheFirstAppList() throws {
        let d = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let launch = try XCTUnwrap(SourceText.block(after: "func applicationDidFinishLaunching(", in: d))
        XCTAssertTrue(launch.contains("DispatchQueue.main.async { [weak self] in _ = self?.launcher }"), "the launcher waits for its first open")
        let s = try SourceText.code("Sources/BaneySpaces/Launcher.swift")
        let run = try XCTUnwrap(SourceText.block(after: "func runSelected(reveal", in: s))
        let wait = try XCTUnwrap(SourceText.block(after: "guard appsLanded else", in: run), "Return runs before the apps are in")
        XCTAssertTrue(wait.contains("pendingReturn = reveal"))
        XCTAssertTrue(wait.contains("asyncAfter(deadline: .now() + 1)"), "Return can wait forever")
        let took = try XCTUnwrap(SourceText.block(after: "private func took(", in: s))
        XCTAssertTrue(took.contains("appsLanded = true"))
        XCTAssertTrue(took.contains("runSelected(reveal: reveal)"))
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "    func hide()", in: s)).contains("model.pendingReturn = nil"))
    }

    /// first-F3: titles change with every tab, so the ⌘Tab switcher and the app in front read them again, off main.
    func testTheSwitcherAndTheFrontAppReadTitlesAgain() throws {
        let d = try SourceText.code("Sources/BaneySpaces/AppDelegate.swift")
        let tab = try XCTUnwrap(SourceText.block(after: "keys.onCmdTab =", in: d))
        XCTAssertTrue(tab.contains("if !isRepeat { self.spaces.refreshDetails() }"), "⌘Tab shows stale titles")
        let s = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        for m in ["func appActivated(", "private func focusMovedWithin("] {
            XCTAssertTrue(try XCTUnwrap(SourceText.block(after: m, in: s)).contains("refreshDetails(of: pid)"), "\(m) keeps a stale title")
        }
        let read = try XCTUnwrap(SourceText.block(after: "func refreshDetails(of pid", in: s))
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "Spaces.axQueue.async", in: read)).contains("Windows.details(of: list)"))
    }

    /// second-F7: a scan landing mid-move is never applied, waiters or not, and a `whenFresh` body it answers waits for
    /// the switch and looks again.
    func testAScanLandingMidSwitchWaitsForIt() throws {
        let s = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        let landed = try XCTUnwrap(SourceText.block(after: "private func scanLanded(", in: s))
        let skip = try XCTUnwrap(SourceText.block(after: "if switching, !holding", in: landed), "a waited-on scan is applied mid-move")
        XCTAssertFalse(landed.contains("waiters.isEmpty"), "a waited-on scan is applied mid-move")
        XCTAssertTrue(skip.contains("for run in waiters { run() }"))
        XCTAssertTrue(skip.contains("return startScan()"))
        let fresh = try XCTUnwrap(SourceText.block(after: "func whenFresh(", in: s))
        let then = try XCTUnwrap(SourceText.block(after: "asking: asking, then:", in: fresh), "whenFresh runs its body mid-switch")
        XCTAssertTrue(then.contains("if self.switching { self.enqueue"))
    }

    /// The top bar's `app-menus` and `status` ask other apps for their menus and status items each time an app comes
    /// forward and every 15 seconds: both off the main thread.
    func testTheTopBarReadsMenusAndStatusOffMain() throws {
        let s = try SourceText.code("Sources/BaneySpaces/TopBar.swift")
        let menus = try XCTUnwrap(SourceText.block(after: "private func readMenus(", in: s))
        let queued = try XCTUnwrap(SourceText.block(after: "BarReader.queue.async", in: menus), "menus are read on main")
        XCTAssertTrue(queued.contains("BarReader.menus(of: pid)"))
        XCTAssertEqual(count("BarReader.menus(of:", in: s), 1, "menus are read outside the queue")
        XCTAssertTrue(menus.contains("if pid != menuPid { show(BarReader.Menus()) }"),
                      "a click during a switch presses the last app's menu")
        let status = try XCTUnwrap(SourceText.block(after: "private func readStatus(", in: s))
        let background = try XCTUnwrap(SourceText.block(after: "DispatchQueue.global(qos: .utility).async", in: status),
                                       "status items are read on main")
        XCTAssertTrue(background.contains("BarReader.status(of: targets)"))
        XCTAssertEqual(count("BarReader.status(of:", in: s), 1, "status items are read outside the background queue")
        let r = try SourceText.code("Sources/BaneySpaces/TopBarMenus.swift")
        let press = try XCTUnwrap(SourceText.block(after: "static func press(", in: r))
        XCTAssertTrue(press.contains("DispatchQueue.global"), "a press waits on its app on main")
    }
}
