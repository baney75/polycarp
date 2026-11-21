import Foundation
import XCTest
@testable import BaneySpacesCore

/// PR #577 review round 1: each test fails on de3a572e. The app target (where libghostty is called) can't be imported
/// here and is compiled out without the library, so those paths are checked in their source, as the repo's other source
/// checks do; what lives in BaneySpacesCore is checked by behavior.
final class TerminalReviewTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        try String(contentsOf: GhosttyBuildTests.spaces.appendingPathComponent(path), encoding: .utf8)
    }

    /// The text of the first function whose declaration contains `signature`, up to the next declaration at its
    /// indentation (or the end of its type).
    private func function(_ signature: String, in path: String) throws -> String {
        let text = try source(path)
        let start = try XCTUnwrap(text.range(of: signature), "\(signature) isn't in \(path)")
        let lineStart = text[..<start.lowerBound].lastIndex(of: "\n").map { text.index(after: $0) } ?? text.startIndex
        let indent = String(text[lineStart..<start.lowerBound].prefix { $0 == " " })
        let rest = text[start.upperBound...]
        let end = rest.range(of: "\n\(indent)}\n")?.upperBound ?? rest.endIndex
        return String(text[start.lowerBound..<end])
    }

    // MARK: first-F1 (high): nothing runs inside a libghostty callback

    /// libghostty calls `close_surface_cb` from inside `ghostty_app_tick` (a plain shell's `exit`). Work done right there
    /// freed the surface under its own callback. Every callback's work goes to the next turn of the main queue.
    func testCallbackWorkNeverRunsInsideTheCallback() throws {
        let onMain = try function("static func onMain(", in: "Sources/BaneySpaces/Terminal/GhosttyRuntime.swift")
        XCTAssertFalse(onMain.contains("Thread.isMainThread"), "onMain must not run its body inline on the main thread:\n\(onMain)")
        XCTAssertTrue(onMain.contains("DispatchQueue.main.async"), onMain)
    }

    /// The deferred work holds the view itself (resolved before the hop), so a window that closed in between leaves no
    /// dangling userdata pointer, and it checks the surface is still there.
    func testCloseSurfaceResolvesItsViewBeforeTheHop() throws {
        let f = try function("static func closeSurface(", in: "Sources/BaneySpaces/Terminal/GhosttyRuntime.swift")
        let resolve = try XCTUnwrap(f.range(of: "view(ud)"), f)
        let hop = try XCTUnwrap(f.range(of: "onMain"), f)
        XCTAssertLessThan(resolve.lowerBound, hop.lowerBound, "resolve the view before hopping:\n\(f)")
        XCTAssertTrue(f.contains(".surface != nil") || f.contains(".surface == nil"), f)
    }

    /// A modal loop inside a callback re-entered `ghostty_app_tick` (the wakeup's async tick ran in the modal loop).
    /// The terminal's questions are sheets with a completion, never `runModal`.
    func testNoModalLoopInTheTerminalsCallbacksOrWindows() throws {
        for f in ["Sources/BaneySpaces/Terminal/GhosttyRuntime.swift", "Sources/BaneySpaces/Terminal/TerminalWindows.swift"] {
            XCTAssertFalse(try source(f).contains("runModal("), "\(f) runs a modal loop")
        }
    }

    // MARK: second-F6 (high): quitting asks while a terminal runs a program

    func testQuittingAsksWhenATerminalRunsAProgram() throws {
        let delegate = try source("Sources/BaneySpaces/AppDelegate.swift")
        let should = try function("func applicationShouldTerminate(", in: "Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(delegate.contains("func applicationShouldTerminate("))
        XCTAssertTrue(should.contains("TerminalFeature.shouldTerminate()"), should)
        XCTAssertTrue(try source("Sources/BaneySpaces/Terminal/GhosttyRuntime.swift").contains("ghostty_app_needs_confirm_quit"))
        let feature = try function("static func shouldTerminate(", in: "Sources/BaneySpaces/Terminal/TerminalFeature.swift")
        XCTAssertTrue(feature.contains("InstallHandoff"), "an install's own quit is told apart:\n\(feature)")
    }

    /// An update quits Polycarp. Update Now asks first; `update --now` (often unattended) refuses instead of waiting on
    /// a question nobody may answer.
    func testAnUpdateDoesNotEndTerminalProgramsUnasked() throws {
        let answer = try function("func answer(_ what: String)", in: "Sources/BaneySpaces/Updater.swift")
        XCTAssertTrue(answer.contains("TerminalFeature.busyCount()"), answer)
        let offer = try function("func offer(_ release: Release)", in: "Sources/BaneySpaces/Updater.swift")
        XCTAssertFalse(offer.contains("self?.install(release)"), "Update Now must check the terminals first:\n\(offer)")
    }

    // MARK: first-F2: the quick terminal stays down while its own question is up

    func testTheQuickTerminalStaysWhileItsQuestionIsUp() throws {
        let w = try source("Sources/BaneySpaces/Terminal/TerminalWindows.swift")
        let hook = try XCTUnwrap(w.range(of: "onResignKey = "), "no onResignKey hook")
        let line = w[hook.lowerBound...].prefix { $0 != "\n" }
        XCTAssertTrue(line.contains("attachedSheet") && line.contains("modalWindow"), String(line))
    }

    // MARK: first-F3: ⌃` only after start, only with the terminal, and it can be turned off

    func testTheQuickKeyIsRegisteredAfterStartAndCanBeTurnedOff() throws {
        let reg = try function("private func registerShortcuts()", in: "Sources/BaneySpaces/AppDelegate.swift")
        let guardStarted = try XCTUnwrap(reg.range(of: "guard started else { return }"), reg)
        let quick = try XCTUnwrap(reg.range(of: "TerminalFeature.registerQuickKey"), reg)
        XCTAssertGreaterThan(quick.lowerBound, guardStarted.lowerBound, "⌃` before `guard started`:\n\(reg)")
        let feature = try function("static func registerQuickKey(", in: "Sources/BaneySpaces/Terminal/TerminalFeature.swift")
        XCTAssertTrue(feature.contains("quickKeyOn"), feature)
        let setup = try source("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("quickTerminalKey"), "no Settings switch for ⌃`")
    }

    // MARK: sol-F1 / second-F8: a quick launch that names a program runs it

    func testAQuickLaunchWithAProgramIsNeverDropped() throws {
        let w = try source("Sources/BaneySpaces/Terminal/TerminalWindows.swift")
        XCTAssertFalse(w.contains("quick ?? makeQuick(runtime, commandLine: commandLine)"), "an open quick terminal drops the command")
        XCTAssertTrue(w.contains("placement(quickOpen:"), "TerminalWindows doesn't ask where a launch goes")
    }

    // MARK: sol-F2: no surface, no window, and the open fails

    func testANilSurfaceFailsTheOpen() throws {
        let view = try source("Sources/BaneySpaces/Terminal/TerminalSurfaceView.swift")
        XCTAssertTrue(view.contains("init?(app:"), "TerminalSurfaceView must fail when ghostty_surface_new does")
        let w = try source("Sources/BaneySpaces/Terminal/TerminalWindows.swift")
        XCTAssertEqual(w.components(separatedBy: "guard let view = TerminalSurfaceView(").count - 1, 2,
                       "both the window and the quick panel need a surface before they show")
    }

    // MARK: second-F7: no terminal rows where the terminal isn't built

    func testNoTerminalRowsUnlessTheTerminalIsBuilt() throws {
        XCTAssertFalse(LauncherProviders.standard().contains { $0.name == "terminal" })
        XCTAssertTrue(try source("Sources/BaneySpaces/Launcher.swift").contains("LauncherProviders.standard(terminal: TerminalFeature.built)"))
    }

    // MARK: The rules behind them, by behavior

    func testQuitAsksWhileAProgramRunsExceptForAnInstallsOwnQuit() {
        XCTAssertNil(TerminalQuit.question(busy: 0, forInstall: false))
        XCTAssertEqual(TerminalQuit.question(busy: 1, forInstall: false), "Quit Polycarp and end what's running in a terminal window?")
        XCTAssertEqual(TerminalQuit.question(busy: 3, forInstall: false), "Quit Polycarp and end what's running in 3 terminal windows?")
        XCTAssertNil(TerminalQuit.question(busy: 2, forInstall: true), "the update asked before it started")
        XCTAssertNil(TerminalQuit.updateQuestion(busy: 0))
        XCTAssertNotNil(TerminalQuit.updateQuestion(busy: 1))
        XCTAssertNil(TerminalQuit.updateRefusal(busy: 0))
        XCTAssertTrue(TerminalQuit.updateRefusal(busy: 2)?.hasPrefix("not updating: a program is running in 2 terminal windows") == true)
    }

    func testWhereAQuickLaunchOpens() {
        XCTAssertEqual(TerminalLaunch().placement(quickOpen: true), .window)
        XCTAssertEqual(TerminalLaunch(quick: true).placement(quickOpen: false), .quick)
        XCTAssertEqual(TerminalLaunch(quick: true).placement(quickOpen: true), .quick, "a plain ⌃` shows the open one")
        XCTAssertEqual(TerminalLaunch(preset: .codex, quick: true).placement(quickOpen: false), .quick)
        for l in [TerminalLaunch(preset: .codex, quick: true), TerminalLaunch(command: "htop", quick: true),
                  TerminalLaunch(host: "parish1", quick: true)] {
            XCTAssertEqual(l.placement(quickOpen: true), .window, "\(l) would be dropped")
        }
    }

    /// fetch-zig.sh, offline: a download that fails is exit 3 (ship without the terminal); wrong bytes are exit 1.
    func testFetchZigTellsADownloadFailureFromWrongBytes() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("zig-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let pin = tmp.appendingPathComponent("PIN")
        try "GHOSTTY_ZIG=0.0.0-test\nGHOSTTY_ZIG_SHA256=\(String(repeating: "0", count: 64))\n".write(to: pin, atomically: true, encoding: .utf8)
        let fake = tmp.appendingPathComponent("zig.tar.xz")
        try Data("not zig".utf8).write(to: fake)
        func run(_ url: String) throws -> (Int32, String) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [GhosttyBuildTests.spaces.appendingPathComponent("scripts/fetch-zig.sh").path]
            var env = ProcessInfo.processInfo.environment
            env["GHOSTTY_PIN"] = pin.path
            env["GHOSTTY_DIR"] = tmp.appendingPathComponent("work").path
            env["GHOSTTY_ZIG_URL"] = url
            p.environment = env
            let err = Pipe()
            p.standardError = err
            p.standardOutput = Pipe()
            try p.run()
            p.waitUntilExit()
            return (p.terminationStatus, String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
        }
        let missing = try run("file://\(tmp.path)/nowhere.tar.xz")
        XCTAssertEqual(missing.0, 3, missing.1)
        XCTAssertTrue(missing.1.contains("terminal not built: zig 0.0.0-test couldn't be downloaded"), missing.1)
        let wrong = try run("file://\(fake.path)")
        XCTAssertEqual(wrong.0, 1, wrong.1)
        XCTAssertTrue(wrong.1.contains("Refusing to use it"), wrong.1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmp.appendingPathComponent("work/.zig/zig-aarch64-macos-0.0.0-test.tar.xz").path))
    }

    // MARK: Lows

    /// first-F5: a universal build says why it has no terminal, not that a toolchain is missing.
    func testAUniversalBuildSaysItsOwnReason() throws {
        let bundle = try source("scripts/bundle.sh")
        XCTAssertTrue(bundle.contains("terminal not built: universal and Intel builds leave it out"), "universal reason")
        XCTAssertFalse(bundle.contains("$TERMINAL_NOT_BUILT, and an Apple silicon only build"))
    }

    /// first-F4: zig that can't be downloaded is "can't build here" (exit 3), which a channel build ships without.
    func testAZigDownloadFailureIsCantBuildHere() throws {
        let f = try source("scripts/fetch-zig.sh")
        XCTAssertTrue(f.contains("exit 3"), "fetch-zig.sh has no can't-build exit")
        let channel = try source("../.github/workflows/channel-build.yml")
        XCTAssertFalse(channel.contains(#"PATH="$(scripts/fetch-zig.sh):$PATH""#), "a fetch failure fails the publish")
    }

    /// second-F9: the first `term` of a run starts libghostty; the CLI waits for it, and a late reply isn't "not running".
    func testTheTermCommandWaitsAndTellsALateReplyApart() throws {
        let cli = try source("Sources/baneyspaces-cli/main.swift")
        let start = try XCTUnwrap(cli.range(of: "case \"term\", \"terminal\":"))
        let body = cli[start.lowerBound...].prefix(1400)
        XCTAssertTrue(body.contains("Wire.send("), String(body))
    }

    /// second-F10: ⌃` with a terminal that can't start says so, as the launcher does.
    func testTheQuickKeySaysWhyItCantOpen() throws {
        let toggle = try function("func toggleQuick()", in: "Sources/BaneySpaces/Terminal/TerminalWindows.swift")
        XCTAssertTrue(toggle.contains("TerminalFeature.open("), toggle)
    }
}
