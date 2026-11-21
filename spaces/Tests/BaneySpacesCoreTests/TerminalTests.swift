import Foundation
import XCTest
@testable import BaneySpacesCore

/// The built-in terminal (libghostty): the theme as Ghostty config, the command line a request runs (a device name can
/// never inject a command), the request on the wire, the launcher's rows, the build script's checksum refusal, and the
/// guards that keep the terminal compiled out where libghostty isn't built.
final class GhosttyThemeTests: XCTestCase {
    private func theme(_ fixture: String = PolycarpFixtures.still_water) throws -> PolycarpTheme {
        try PolycarpTheme.parse(Data(fixture.utf8)).get()
    }

    func testAPolycarpThemeBecomesGhosttyKeysInTheModeItDraws() throws {
        let t = try theme()
        XCTAssertEqual(GhosttyTheme.from(t, systemDark: true).configText, """
        # Written by Polycarp from its theme. Loaded after your own Ghostty config; edit the theme, not this file.
        background = #1F2A2D
        foreground = #E8F0F0
        cursor-color = #A5CFCB
        cursor-text = #12201F
        selection-background = #2F4A4B
        selection-foreground = #E8F0F0
        font-family = ""
        font-family = "SF Mono"
        font-family = "Menlo"
        font-family = "Consolas"
        font-size = 13

        """)
        let light = GhosttyTheme.from(t, systemDark: false)
        XCTAssertEqual(light.background.hex, "#F1F5F5")
        XCTAssertEqual(light.cursor.hex, "#3F6B6A")
        XCTAssertEqual(light.cursorText.hex, "#F1F5F5")
    }

    func testAFixedModeThemeIgnoresTheSystem() throws {
        let blocks = try theme(PolycarpFixtures.blocks)
        XCTAssertEqual(GhosttyTheme.from(blocks, systemDark: false).background.hex, "#2B2E26")
    }

    func testTheMonoStackKeepsNamedFontsInOrderAndMapsUIMonospaceToSFMono() {
        XCTAssertEqual(GhosttyTheme.monoFamilies(#"ui-monospace, "SF Mono", Menlo, Consolas, monospace"#), ["SF Mono", "Menlo", "Consolas"])
        XCTAssertEqual(GhosttyTheme.monoFamilies("monospace"), [])
        XCTAssertEqual(GhosttyTheme.monoFamilies(#""JetBrains Mono", ui-monospace"#), ["JetBrains Mono", "SF Mono"])
        // A stack the theme checker refuses gives nothing at all.
        XCTAssertEqual(GhosttyTheme.monoFamilies("url(x)"), [])
    }

    func testFontSizeScalesFromTheUISize() throws {
        var t = GhosttyTheme.from(try theme(), systemDark: true)
        XCTAssertEqual(t.fontSize, 13)
        t.fontSize = 400
        XCTAssertTrue(t.configText.contains("font-size = 72\n"))
        t.fontSize = .nan
        XCTAssertFalse(t.configText.contains("font-size"))
    }

    /// A font name is written inside double quotes; one that could end the line never gets in, so it can't add a key
    /// (a keybind that runs a command, say) of its own.
    func testAFontNameCanNeverStartALineOfItsOwn() throws {
        var t = GhosttyTheme.from(try theme(), systemDark: true)
        t.fontFamilies = ["Menlo\"\nkeybind = ctrl+a=text:rm", "Evil\\", "Line\rBreak", "Fine Mono"]
        let lines = t.configText.split(separator: "\n")
        XCTAssertFalse(lines.contains { $0.hasPrefix("keybind") })
        XCTAssertTrue(lines.contains("font-family = \"Fine Mono\""))
        XCTAssertEqual(lines.filter { $0.hasPrefix("font-family") }.count, 2)
    }

    /// Every line is a comment or one of the keys this writes: a typo'd key would be a silent no-op in Ghostty.
    func testOnlyKnownGhosttyKeysAreWritten() throws {
        let known: Set = ["background", "foreground", "cursor-color", "cursor-text", "selection-background",
                          "selection-foreground", "font-family", "font-size"]
        for line in GhosttyTheme.from(try theme(), systemDark: true).configText.split(separator: "\n") where !line.hasPrefix("#") {
            let key = line.split(separator: "=", maxSplits: 1)[0].trimmingCharacters(in: .whitespaces)
            XCTAssertTrue(known.contains(key), "unknown Ghostty key \(key)")
        }
    }

    func testWithoutAPolycarpThemeThePaletteDrawsAndTheFontStaysGhosttys() {
        let p = Palette(name: "test", isDark: true, colors: ["background": RGB(hex: "#101010")!, "foreground": RGB(hex: "#EEEEEE")!,
                                                             "accent": RGB(hex: "#3366FF")!, "selection": RGB(hex: "#333333")!])
        let g = GhosttyTheme.from(p)
        XCTAssertEqual(g?.cursor.hex, "#3366FF")
        XCTAssertEqual(g?.fontFamilies, [])
        XCTAssertNil(g?.fontSize)
        XCTAssertNil(GhosttyTheme.from(Palette(name: "bare", isDark: true, colors: [:])))
    }
}

final class TerminalLaunchTests: XCTestCase {
    private func parse(_ a: [String]) -> Result<TerminalLaunch, TerminalLaunchError> { TerminalLaunch.parse(a) }

    func testTheTermCommandsArguments() throws {
        XCTAssertEqual(try parse([]).get(), TerminalLaunch())
        XCTAssertEqual(try parse(["claude"]).get(), TerminalLaunch(preset: .claude))
        XCTAssertEqual(try parse(["codex", "--quick"]).get(), TerminalLaunch(preset: .codex, quick: true))
        XCTAssertEqual(try parse(["--cmd", "htop -d 5"]).get(), TerminalLaunch(command: "htop -d 5"))
        XCTAssertEqual(try parse(["--host", "parish1"]).get(), TerminalLaunch(host: "parish1"))
        for bad in [["--cmd"], ["--cmd", "  "], ["vim"], ["claude", "codex"], ["--host", "parish1", "claude"],
                    ["--host", "parish1", "--cmd", "ls"], ["--host", "-oProxyCommand=open -a Calculator"]] {
            if case .success = parse(bad) { XCTFail("\(bad) should be refused") }
        }
    }

    func testTailnetNamesAreAcceptedAndNothingElse() {
        for good in ["parish1", "chapel1", "abbey1.tail1234.ts.net", "donovan@parish1", "root@chapel1", "100.101.102.103",
                     "GIGAPC", "a-b"] {
            XCTAssertTrue(TerminalLaunch.validHost(good), good)
        }
        for bad in ["", "-oProxyCommand=x", "-p", "a b", "a;b", "a&&b", "$(id)", "`id`", "a'b", "a\"b", "a\\b", "host\n",
                    "a..b", ".a", "a.", "host-", "-host", "user@@host", "@host", "user@", "Host_1", "pärish", "a|b", "a>b",
                    "~/x", "a/b", "*", "a,b", String(repeating: "a", count: 64), "user name@host", "-l@host", "User@host"] {
            XCTAssertFalse(TerminalLaunch.validHost(bad), bad)
        }
    }

    func testTheHostCommandIsQuotedAtBothLevels() {
        let ts = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
        XCTAssertEqual(TerminalLaunch(host: "parish1").commandLine(shell: "/bin/zsh", tailscale: ts),
                       #"'/bin/zsh' -l -i -c 'exec '\''/Applications/Tailscale.app/Contents/MacOS/Tailscale'\'' ssh '\''parish1'\'''"#)
        XCTAssertEqual(TerminalLaunch(host: "parish1").commandLine(shell: "/bin/zsh", tailscale: nil),
                       #"'/bin/zsh' -l -i -c 'exec ssh '\''parish1'\'''"#)
        XCTAssertEqual(TerminalLaunch(preset: .claude).commandLine(shell: "/bin/zsh", tailscale: nil), #"'/bin/zsh' -l -i -c 'exec claude'"#)
        XCTAssertNil(TerminalLaunch().commandLine(shell: "/bin/zsh", tailscale: nil))
    }

    /// The proof that matters: /bin/sh reads each quoted word back as exactly the text that went in, whatever it holds.
    func testShellQuotingSurvivesARealShell() throws {
        for s in ["plain", "it's", "'", "''", "$(id)", "`id`", "a; rm -rf ~", "a\nb", "\\", "\"q\"", "$HOME", "*", "", "-n"] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "printf '%s' \(TerminalLaunch.shellQuote(s))"]
            let out = Pipe()
            p.standardOutput = out
            try p.run()
            p.waitUntilExit()
            XCTAssertEqual(String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self), s)
        }
    }

    /// And the whole host command, run through /bin/sh as libghostty would, with the shell swapped for printf: the shell
    /// would get exactly one -c script, and that script names the device as one quoted word.
    func testTheHostCommandLineGivesTheShellOneScript() throws {
        let line = TerminalLaunch(host: "donovan@parish1").commandLine(shell: "/usr/bin/printf", tailscale: nil)!
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        // printf's first argument is its format: "-l" would be read as one, so prefix a format that prints the rest.
        p.arguments = ["-c", line.replacingOccurrences(of: "'/usr/bin/printf' ", with: "'/usr/bin/printf' '[%s]' ")]
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        p.waitUntilExit()
        XCTAssertEqual(String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self),
                       "[-l][-i][-c][exec ssh 'donovan@parish1']")
    }

    func testTheRequestSurvivesTheWireAndABadOneIsRefused() {
        for l in [TerminalLaunch(), TerminalLaunch(preset: .codex, quick: true), TerminalLaunch(command: "make test"),
                  TerminalLaunch(host: "chapel1")] {
            XCTAssertEqual(TerminalLaunch(request: l.request), l)
        }
        XCTAssertNil(TerminalLaunch(request: Wire.Request(op: .terminal, target: "a;b", args: ["shell"])))
        XCTAssertNil(TerminalLaunch(request: Wire.Request(op: .terminal, args: ["bash"])))
        XCTAssertNil(TerminalLaunch(request: Wire.Request(op: .terminal, args: ["shell", "--evil"])))
        XCTAssertNil(TerminalLaunch(request: Wire.Request(op: .terminal)))
        XCTAssertNil(TerminalLaunch(request: Wire.Request(op: .list, args: ["shell"])))
    }

    /// Another machine on the tailnet never gets a shell here, token or not.
    func testAnotherMachineCanNeverOpenATerminal() {
        XCTAssertFalse(Remote.allows(TerminalLaunch().request))
        XCTAssertFalse(Remote.allows(TerminalLaunch(host: "parish1").request))
    }

    func testTheLoginShellIsAbsoluteAndPlain() {
        XCTAssertEqual(TerminalLaunch.loginShell(env: ["SHELL": "/opt/homebrew/bin/fish"]), "/opt/homebrew/bin/fish")
        XCTAssertEqual(TerminalLaunch.loginShell(env: ["SHELL": "zsh"]), "/bin/zsh")
        XCTAssertEqual(TerminalLaunch.loginShell(env: ["SHELL": "/bin/zsh; id"]), "/bin/zsh")
        XCTAssertEqual(TerminalLaunch.loginShell(env: [:]), "/bin/zsh")
    }

    func testTheLauncherOffersTerminalsAndADevicesShell() {
        let p = TerminalProvider()
        let ssh = p.results(for: "ssh parish1")
        XCTAssertEqual(ssh.map(\.action), [.terminal(TerminalLaunch(host: "parish1"))])
        XCTAssertEqual(ssh.first?.placement, .top)
        XCTAssertEqual(p.results(for: "term chapel1").map(\.title), ["Terminal on chapel1"])
        XCTAssertEqual(p.results(for: "ssh $(id)"), [])
        XCTAssertEqual(p.results(for: "ssh -oProxyCommand=x"), [])
        XCTAssertEqual(p.results(for: "claude").map(\.action), [.terminal(TerminalLaunch(preset: .claude))])
        XCTAssertEqual(Set(p.results(for: "term").map(\.id)), ["terminal:shell", "terminal:quick"])
        XCTAssertEqual(p.results(for: "t"), [])
        XCTAssertTrue(LauncherProviders.standard(terminal: true).contains { $0.name == "terminal" })
    }
}

/// scripts/build-ghostty.sh and the files around it.
final class GhosttyBuildTests: XCTestCase {
    static let spaces = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func run(pin: String, tarball: Data?, commit: String) throws -> (code: Int32, err: String, dir: URL) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ghostty-test-\(UUID().uuidString)")
        let dir = tmp.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent(".cache"), withIntermediateDirectories: true)
        let pinURL = tmp.appendingPathComponent("PIN")
        try pin.write(to: pinURL, atomically: true, encoding: .utf8)
        // The tarball is already in the cache, so the script never goes to the network.
        if let tarball { try tarball.write(to: dir.appendingPathComponent(".cache/ghostty-\(commit).tar.gz")) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [Self.spaces.appendingPathComponent("scripts/build-ghostty.sh").path]
        var env = ProcessInfo.processInfo.environment
        env["GHOSTTY_PIN"] = pinURL.path
        env["GHOSTTY_DIR"] = dir.path
        p.environment = env
        let err = Pipe()
        p.standardError = err
        p.standardOutput = Pipe()
        try p.run()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self), dir)
    }

    private func pin(commit: String, sha: String) -> String {
        """
        GHOSTTY_REPO=ghostty-org/ghostty
        GHOSTTY_TAG=v0.0.0-test
        GHOSTTY_COMMIT=\(commit)
        GHOSTTY_SHA256=\(sha)
        GHOSTTY_LICENSE_SHA256=0
        GHOSTTY_ZIG=0.0.0
        """
    }

    /// A tarball whose bytes aren't the pinned ones is refused before anything is unpacked, and deleted.
    func testATarballWithTheWrongChecksumIsRefused() throws {
        let commit = String(repeating: "a", count: 40)
        let r = try run(pin: pin(commit: commit, sha: String(repeating: "0", count: 64)), tarball: Data("not ghostty".utf8), commit: commit)
        XCTAssertEqual(r.code, 1, r.err)
        XCTAssertTrue(r.err.contains("Refusing to build it"), r.err)
        XCTAssertFalse(FileManager.default.fileExists(atPath: r.dir.appendingPathComponent(".cache/ghostty-\(commit).tar.gz").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: r.dir.appendingPathComponent(".src").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: r.dir.appendingPathComponent("lib").path))
    }

    /// The right bytes for the pin, but not the pinned commit inside (a tarball made elsewhere): refused too.
    func testATarballOfAnotherCommitIsRefused() throws {
        let commit = String(repeating: "b", count: 40)
        let src = FileManager.default.temporaryDirectory.appendingPathComponent("ghostty-tar-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: src.appendingPathComponent("x"), withIntermediateDirectories: true)
        try "hi".write(to: src.appendingPathComponent("x/LICENSE"), atomically: true, encoding: .utf8)
        let tar = src.appendingPathComponent("t.tar.gz")
        let t = Process()
        t.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        t.arguments = ["czf", tar.path, "-C", src.path, "x"]
        try t.run(); t.waitUntilExit()
        let data = try Data(contentsOf: tar)
        let r = try run(pin: pin(commit: commit, sha: Self.sha256(data)), tarball: data, commit: commit)
        XCTAssertEqual(r.code, 1, r.err)
        XCTAssertTrue(r.err.contains("not \(commit)"), r.err)
        XCTAssertFalse(FileManager.default.fileExists(atPath: r.dir.appendingPathComponent("lib").path))
    }

    static func sha256(_ d: Data) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/shasum")
        p.arguments = ["-a", "256"]
        let inp = Pipe(), out = Pipe()
        p.standardInput = inp
        p.standardOutput = out
        try! p.run()
        inp.fileHandleForWriting.write(d)
        try! inp.fileHandleForWriting.close()
        p.waitUntilExit()
        return String(String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).prefix(64))
    }

    private func pinValue(_ key: String) throws -> String {
        let text = try String(contentsOf: Self.spaces.appendingPathComponent("ghostty/PIN"), encoding: .utf8)
        let line = try XCTUnwrap(text.split(separator: "\n").first { $0.hasPrefix(key + "=") })
        return String(line.dropFirst(key.count + 1))
    }

    /// The pin is a full commit and checksum, the license text in LICENSES/ is the one it names, and NOTICE says so.
    func testThePinTheLicenseAndTheNoticeAgree() throws {
        let commit = try pinValue("GHOSTTY_COMMIT")
        XCTAssertEqual(commit.count, 40)
        XCTAssertTrue(commit.allSatisfy(\.isHexDigit))
        XCTAssertEqual(try pinValue("GHOSTTY_SHA256").count, 64)
        let license = try Data(contentsOf: Self.spaces.appendingPathComponent("LICENSES/ghostty-MIT.txt"))
        XCTAssertEqual(Self.sha256(license), try pinValue("GHOSTTY_LICENSE_SHA256"))
        let notice = try String(contentsOf: Self.spaces.appendingPathComponent("NOTICE"), encoding: .utf8)
        XCTAssertTrue(notice.contains("Ghostty (MIT License"))
        XCTAssertTrue(notice.contains(commit))
    }

    /// Without libghostty (CI without zig, universal builds) the app must still build: every file that touches libghostty
    /// is wholly inside `#if POLYCARP_TERMINAL`, which Package.swift defines only when it links the library.
    func testTheTerminalCompilesOutWithoutTheLibrary() throws {
        let dir = Self.spaces.appendingPathComponent("Sources/BaneySpaces/Terminal")
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".swift") }
        XCTAssertTrue(files.contains("TerminalFeature.swift"))
        for f in files where f != "TerminalFeature.swift" {
            let src = try String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertTrue(src.hasPrefix("#if POLYCARP_TERMINAL"), "\(f) must start with #if POLYCARP_TERMINAL")
            XCTAssertTrue(src.hasSuffix("#endif"), "\(f) must end with #endif")
        }
        let feature = try String(contentsOf: dir.appendingPathComponent("TerminalFeature.swift"), encoding: .utf8)
        XCTAssertFalse(feature.contains("import CGhostty"))
        XCTAssertTrue(feature.contains("TerminalBuild.notBuilt"))
        // No other app file reaches libghostty.
        let app = Self.spaces.appendingPathComponent("Sources/BaneySpaces")
        for f in try FileManager.default.contentsOfDirectory(atPath: app.path) where f.hasSuffix(".swift") {
            XCTAssertFalse(try String(contentsOf: app.appendingPathComponent(f), encoding: .utf8).contains("import CGhostty"), f)
        }
        let pkg = try String(contentsOf: Self.spaces.appendingPathComponent("Package.swift"), encoding: .utf8)
        XCTAssertTrue(pkg.contains(#"swiftSettings: terminal ? [.define("POLYCARP_TERMINAL")] : []"#))
        XCTAssertTrue(pkg.contains(#"case "0": return false"#))
    }

    /// The not-built line is the one the build script, bundle.sh and the app all say.
    func testOneNotBuiltLine() throws {
        let script = try String(contentsOf: Self.spaces.appendingPathComponent("scripts/build-ghostty.sh"), encoding: .utf8)
        let bundle = try String(contentsOf: Self.spaces.appendingPathComponent("scripts/bundle.sh"), encoding: .utf8)
        XCTAssertTrue(script.contains(TerminalBuild.notBuilt))
        XCTAssertTrue(bundle.contains(TerminalBuild.notBuilt))
        XCTAssertTrue(bundle.contains(TerminalBuild.notBuiltUniversal))
    }
}
