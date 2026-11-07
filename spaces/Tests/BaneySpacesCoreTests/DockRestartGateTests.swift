@testable import BaneySpacesCore
import XCTest

/// 2026-11-06: an install restarted the Dock twice in three seconds with a full-screen app in front, and macOS froze
/// mid-Space-slide. Every Dock restart goes through one gate, and an install doesn't restart it at all.
final class DockRestartGateTests: XCTestCase {
    func testAnOrdinaryQuietDesktopRestartsNow() {
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: false, dockUptime: 60), .restartNow)
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: false, dockUptime: nil), .wait(.dockJustStarted), "between restarts")
    }

    func testItWaitsWhileAFullScreenSpaceShows() {
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: true, switching: false, dockUptime: 600), .wait(.fullScreenShowing))
    }

    func testItWaitsOutASwitch() {
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: true, dockUptime: 600), .wait(.switching))
    }

    func testTwoRestartsCannotLandSecondsApart() {
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: false, dockUptime: 2.9), .wait(.dockJustStarted))
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: false, dockUptime: 3), .restartNow)
    }

    func testASpaceThatJustChangedMayStillBeSliding() {
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: false, dockUptime: 60, sinceSpaceChange: 1), .wait(.spaceJustChanged))
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: false, dockUptime: 60, sinceSpaceChange: 5), .restartNow)
    }

    func testAQuitHandsItsRestartToAHelperAndAnInstallRestoresNothing() throws {
        let app = try source("Sources/BaneySpaces/AppDelegate.swift")
        let quit = try XCTUnwrap(app.range(of: "func applicationWillTerminate").map { String(app[$0.lowerBound...].prefix(2000)) })
        XCTAssertTrue(quit.contains("dock.stop(restoreSystemDock: !forInstall)"))
        XCTAssertTrue(quit.contains("DockRestart.handOffBeforeQuit()"), "what the quit owes outlives it")
        XCTAssertLessThan(try XCTUnwrap(quit.range(of: "DockRestart.isQuitting = true")).lowerBound, try XCTUnwrap(quit.range(of: "dock.stop")).lowerBound)
        XCTAssertFalse(EntryPoint.runsBesideAnotherCopy.contains(DockRestartHelper.argument), "the app no longer runs as the helper")
    }

    func testNothingEverForcesARestartPastTheGate() throws {
        let code = try source("Sources/BaneySpaces/DockRestart.swift")
        XCTAssertFalse(code.contains("giveUp"), "waiting forever beats freezing the screen")
        // The only kill outside the gate's .restartNow is none: `handOffBeforeQuit`'s failure path restarts nothing.
        XCTAssertEqual(code.components(separatedBy: "kill(names)").count - 1, 1)
        XCTAssertFalse(code.contains("kill(pending)"))
    }

    func testAWaitingHelperDoesNotBlockAnInstall() throws {
        let install = try source("scripts/install-app.sh")
        XCTAssertTrue(install.contains("grep -vq -- --restart-when-safe"))
        let uninstall = try source("uninstall.sh")
        XCTAssertTrue(uninstall.contains("grep -vq -- --restart-when-safe"), "the waiting helper doesn't stop an uninstall either")
        XCTAssertFalse(install.contains("pgrep -f \"$DEST/Contents/MacOS/$EXECUTABLE\""), "that matches the helper too")
        XCTAssertTrue(install.contains("app_is_running"))
    }

    func testADockOfUnknownAgeIsNotAMissingDock() {
        // launchDate is nil for the Dock, so the 2026-11-06 build read every Dock as missing and waited forever: the Dock never
        // took the hidden setting, and the macOS Dock and Polycarp's came up together.
        let age = DockRestartGate.uptime(dockRunning: true, started: nil, lastKill: nil)
        XCTAssertEqual(age, .infinity)
        XCTAssertEqual(DockRestartGate.decide(onFullScreenSpace: false, switching: false, dockUptime: age), .restartNow)
        XCTAssertNil(DockRestartGate.uptime(dockRunning: false, started: nil, lastKill: Date()), "no Dock is the only nil")
    }

    func testAYoungDockOrOurOwnLastRestartStillWaits() {
        let now = Date()
        XCTAssertEqual(DockRestartGate.uptime(dockRunning: true, started: now.addingTimeInterval(-1), lastKill: nil, now: now), 1)
        XCTAssertEqual(DockRestartGate.uptime(dockRunning: true, started: now.addingTimeInterval(-500), lastKill: now.addingTimeInterval(-2), now: now), 2)
    }

    func testTheKernelKnowsWhenAProcessStarted() throws {
        let mine = try XCTUnwrap(DockRestartGate.processStart(pid: getpid()))
        XCTAssertLessThan(Date().timeIntervalSince(mine), 24 * 3600)
        XCTAssertGreaterThan(Date().timeIntervalSince(mine), 0)
        let launchd = try XCTUnwrap(DockRestartGate.processStart(pid: 1))
        XCTAssertLessThan(launchd, mine, "launchd came first")
        XCTAssertNil(DockRestartGate.processStart(pid: 999_999), "no such process")
    }

    func testTheDockIsNotAgedByLaunchDate() throws {
        XCTAssertFalse(try source("Sources/BaneySpaces/DockRestart.swift").contains("launchDate"), "nil for anything launchd starts")
    }

    func testTheHelperIsTheToolNotTheApp() throws {
        // A process running the app's own executable makes macOS answer `open` with -600, so Polycarp couldn't start while one
        // waited. That failed an install on 2026-11-06.
        let code = try source("Sources/BaneySpaces/DockRestart.swift")
        XCTAssertTrue(code.contains("DockRestartHelper.tool(inBundle: Bundle.main.bundleURL)"))
        XCTAssertFalse(code.contains("Bundle.main.executableURL"))
        XCTAssertFalse(code.contains("runHelper"))
        let main = try source("Sources/BaneySpaces/main.swift")
        XCTAssertFalse(main.contains("DockRestart.run"), "the app no longer waits as the helper")
        XCTAssertLessThan(try XCTUnwrap(main.range(of: "contains(DockRestartHelper.argument) { exit(0) }")).lowerBound, try XCTUnwrap(main.range(of: "EntryPoint.immediate")).lowerBound, "an older build's request can't start the app")
        XCTAssertTrue(try source("Sources/baneyspaces-cli/main.swift").contains("DockRestartHelper.run(names:"))
        XCTAssertEqual(DockRestartHelper.tool(inBundle: URL(fileURLWithPath: "/A/Polycarp.app")).path, "/A/Polycarp.app/Contents/Resources/bin/polycarp-spaces")
        let install = try source("scripts/install-app.sh")
        XCTAssertTrue(install.contains("MacOS/$EXECUTABLE --restart-when-safe"), "an install clears a helper from an older build")
        XCTAssertTrue(install.contains("--restart-when-safe\" 2>/dev/null || true; }"), "finding none must not end the install under pipefail")
    }

    private func display(_ id: String, type: Int?, space: Int = 1) -> [String: Any] {
        var current: [String: Any] = ["id64": space]
        if let type { current["type"] = type }
        return ["Display Identifier": id, "Current Space": current]
    }

    func testAnOrdinaryDesktopOnEveryDisplayIsSafe() {
        let state = DockSpaces.parse(displays: [display("a", type: 0, space: 1), display("b", type: 0, space: 2)]) { _ in false }
        XCTAssertFalse(state.unsafe)
        XCTAssertFalse(state.animating)
        XCTAssertEqual(state.ids, [1, 2])
    }

    func testFullScreenOnAnyDisplayIsUnsafeWhicheverComesFirst() {
        // Review of #54: judging by the front window called these an ordinary desktop.
        XCTAssertTrue(DockSpaces.parse(displays: [display("a", type: 0), display("b", type: 4)]) { _ in false }.unsafe)
        XCTAssertTrue(DockSpaces.parse(displays: [display("a", type: 4), display("b", type: 0)]) { _ in false }.unsafe)
    }

    func testNotKnowingIsUnsafe() {
        XCTAssertTrue(DockSpaces.parse(displays: []) { _ in false }.unsafe, "no answer, such as a sleeping display")
        XCTAssertTrue(DockSpaces.parse(displays: [display("a", type: nil)]) { _ in false }.unsafe)
        // Review of #54, round 2: a slide can't be seen without the call or a display's identifier.
        XCTAssertTrue(DockSpaces.parse(displays: [display("a", type: 0)], isAnimating: nil).unsafe, "macOS dropped the animation call")
        var unnamed = display("a", type: 0)
        unnamed["Display Identifier"] = nil
        XCTAssertTrue(DockSpaces.parse(displays: [unnamed]) { _ in false }.unsafe, "a display with no identifier")
    }

    func testASlideOnAnyDisplayCounts() {
        let state = DockSpaces.parse(displays: [display("a", type: 0), display("b", type: 0)]) { $0 == "b" }
        XCTAssertTrue(state.animating)
        let afterSlide = DockSpaces.parse(displays: [display("a", type: 0, space: 9)]) { _ in false }
        XCTAssertNotEqual(afterSlide.ids, DockSpaces.parse(displays: [display("a", type: 0, space: 1)]) { _ in false }.ids, "two empty desktops differ")
    }

    func testTheWindowServerAnswersOnThisMac() throws {
        try XCTSkipIf(CGSessionCopyCurrentDictionary() == nil, "no window server session here")
        // It's a private call, so a macOS that drops it should fail here rather than leave every restart waiting.
        XCTAssertFalse(DockSpaces.current().ids.isEmpty, "the window server named the Space on each display")
    }

    func testANewPolycarpOwnsTheRestart() {
        let now = Date()
        let quitting = DockRestartHelper.Running(pid: 10, name: "Polycarp", started: now.addingTimeInterval(-500))
        let reopened = DockRestartHelper.Running(pid: 20, name: "Polycarp", started: now.addingTimeInterval(-30))
        let dock = DockRestartHelper.Running(pid: 30, name: "Dock", started: now.addingTimeInterval(-500))
        XCTAssertFalse(DockRestartHelper.anotherAppOwnsIt(running: [quitting, dock], startedBy: 10, now: now), "the one quitting doesn't")
        XCTAssertFalse(DockRestartHelper.anotherAppOwnsIt(running: [dock], startedBy: 10, now: now))
        XCTAssertTrue(DockRestartHelper.anotherAppOwnsIt(running: [quitting, reopened, dock], startedBy: 10, now: now))
    }

    func testAOneShotDoesNotTakeTheRestartAway() {
        // `Polycarp --check-settings` exits at once. The helper leaving for it would lose the restart.
        let now = Date()
        let oneShot = DockRestartHelper.Running(pid: 20, name: "Polycarp", started: now.addingTimeInterval(-1))
        XCTAssertFalse(DockRestartHelper.anotherAppOwnsIt(running: [oneShot], startedBy: 10, now: now))
    }

    func testTheKernelListsThisUsersProcesses() {
        let mine = DockRestartHelper.runningProcesses()
        let me = mine.first { $0.pid == getpid() }
        XCTAssertNotNil(me)
        XCTAssertNotNil(me?.started)
        XCTAssertFalse(me?.name.isEmpty ?? true)
    }

    func testAnOldInstallMarkerDoesNotSkipARealQuit() {
        XCTAssertTrue(InstallHandoff.isCurrent(markedAt: 1000, now: 1010))
        XCTAssertFalse(InstallHandoff.isCurrent(markedAt: 1000, now: 1200), "left behind by a failed install")
        XCTAssertFalse(InstallHandoff.isCurrent(markedAt: nil, now: 1000))
        XCTAssertFalse(InstallHandoff.isCurrent(markedAt: 2000, now: 1000), "a clock that went backward")
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: Repo.root.appendingPathComponent(path), encoding: .utf8)
    }

    func testNothingKillsTheDockWithoutTheGate() throws {
        for file in ["Sources/BaneySpaces/WorkspaceDock.swift", "Sources/BaneySpaces/MissionControlOverride.swift", "Sources/BaneySpaces/TopDragWatcher.swift"] {
            XCTAssertFalse(try source(file).contains("/usr/bin/killall"), "\(file) kills a process by itself")
        }
        XCTAssertTrue(try source("Sources/BaneySpaces/DockRestart.swift").contains("DockRestartGate.decide"))
    }

    func testAnInstallMarksTheQuitAndTheAppHonorsIt() throws {
        let install = try source("scripts/install-app.sh")
        let mark = try XCTUnwrap(install.range(of: InstallHandoff.key))
        let quit = try XCTUnwrap(install.range(of: "to quit\" >/dev/null"))
        XCTAssertLessThan(mark.lowerBound, quit.lowerBound, "the marker has to be there before the app is asked to quit")
        XCTAssertTrue(try source("Sources/BaneySpaces/AppDelegate.swift").contains("InstallHandoff.isCurrent"))
        XCTAssertTrue(install.contains("restartingForInstall -int"), "a float rounds epoch seconds by minutes")
    }
}
