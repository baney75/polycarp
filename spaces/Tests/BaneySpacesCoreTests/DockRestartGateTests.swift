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
        XCTAssertFalse(try source("Sources/BaneySpaces/main.swift").contains("DockRestartHelper"))
        XCTAssertTrue(try source("Sources/baneyspaces-cli/main.swift").contains("DockRestartHelper.run(names:"))
        XCTAssertEqual(DockRestartHelper.tool(inBundle: URL(fileURLWithPath: "/A/Polycarp.app")).path, "/A/Polycarp.app/Contents/Resources/bin/polycarp-spaces")
        XCTAssertTrue(try source("scripts/install-app.sh").contains("MacOS/$EXECUTABLE --restart-when-safe"), "an install clears a helper from an older build")
    }

    func testTheToolSeesAFullScreenWindowWithAndWithoutANotch() {
        let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let belowNotch = CGRect(x: 0, y: 37, width: 1512, height: 945)
        XCTAssertTrue(DockRestartHelper.looksFullScreen(top: display, frames: [display, belowNotch]))
        XCTAssertTrue(DockRestartHelper.looksFullScreen(top: belowNotch, frames: [display, belowNotch]))
        XCTAssertFalse(DockRestartHelper.looksFullScreen(top: CGRect(x: 0, y: 37, width: 1512, height: 900), frames: [display, belowNotch]))
        XCTAssertFalse(DockRestartHelper.looksFullScreen(top: nil, frames: [display]), "nothing on screen is an ordinary desktop")
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
