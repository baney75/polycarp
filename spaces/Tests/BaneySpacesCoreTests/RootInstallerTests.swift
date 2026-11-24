import XCTest

/// The root install.sh (the one `curl | bash` runs) as text. The real run through a pipe is in the pull request.
final class RootInstallerTests: XCTestCase {
    private func installer() throws -> String { try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent("install.sh"), encoding: .utf8) }
    private func at(_ s: String, in t: String) throws -> String.Index { try XCTUnwrap(t.range(of: s)?.lowerBound, "missing: \(s)") }

    func testEverythingRunsFromMainCalledOnTheLastLine() throws {
        let t = try installer()
        let lines = t.split(separator: "\n", omittingEmptySubsequences: true)
        XCTAssertEqual(lines.last, "main \"$@\"", "a partial download defines functions and runs nothing")
        XCTAssertTrue(t.contains("\nmain() {\n"))
        // Nothing but definitions between set -e and main(): no step runs at the top of the file.
        let afterSet = try at("set -euo pipefail", in: t), mainDef = try at("\nmain() {", in: t)
        XCTAssertFalse(t[afterSet..<mainDef].contains("step "))
    }

    func testNoStepCanReadTheScriptFromStdin() throws {
        let t = try installer()
        XCTAssertTrue(t.contains(#"if "$@" </dev/null >>"$LOG" 2>&1; then"#))
        XCTAssertTrue(t.contains("xcode-select --install >/dev/null 2>&1 </dev/null"))
        XCTAssertTrue(t.contains("2>/dev/null </dev/null || true)\" = 1"), "the defaults read, too")
        // Every `open` and `osascript` the installer runs goes through step.
        for line in t.split(separator: "\n") where line.contains("osascript") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("#") {
            XCTAssertTrue(line.contains("step "), "osascript outside step reads stdin: \(line)")
        }
    }

    func testTheOrderNeverLeavesNeitherApp() throws {
        let t = try installer()
        let build = try at(#"step "Building Polycarp"#, in: t)
        let quit = try at(#"step "Quitting BaneySpaces""#, in: t)
        let install = try at(#"step "Installing Polycarp""#, in: t)
        let watchdog = try at(#"step "Stopping BaneySpaces' watchdog""#, in: t)
        let trash = try at(#"step "Moving BaneySpaces to the Trash"#, in: t)
        let open = try at(#"step "Opening Polycarp""#, in: t)
        XCTAssertTrue(build < quit && quit < install && install < watchdog && watchdog < trash && trash < open,
                      "build, quit, install, then retire, then open")
        XCTAssertTrue(t.contains("export BANEYSPACES_NO_LAUNCH=1"), "the install doesn't open it; the last step does")
        XCTAssertTrue(t.contains("BaneySpaces is still installed; open it again from Applications."), "an install that fails says an app is left")
    }

    func testTrashMovesAreCheckedAndUnique() throws {
        let t = try installer()
        XCTAssertTrue(t.contains(#"mkdir -p "$trash""#))
        XCTAssertTrue(t.contains(#"while [ -e "$dest" ]"#), "a name no other item has")
        XCTAssertTrue(t.contains(#"if ! mv "$app" "$dest"; then"#), "each move is checked")
        XCTAssertTrue(t.contains("could not be moved to the Trash. Drag these to the Trash yourself"))
        XCTAssertFalse(t.contains("&& mv \"$app\""), "the old unchecked move")
    }

    func testTheClosingLineDependsOnWhetherTheWelcomeWindowIsDone() throws {
        let t = try installer()
        XCTAssertTrue(t.contains("defaults read com.baney.polycarp welcomeFinished"))
        XCTAssertTrue(t.contains("Polycarp is updated."))
        XCTAssertTrue(t.contains("needs one switch from you"))
        let upd = try at("Polycarp is updated.", in: t), one = try at("needs one switch from you", in: t)
        XCTAssertLessThan(try at("welcomeFinished", in: t), upd)
        XCTAssertLessThan(upd, one, "the first-run message is the else branch")
    }

    /// The Linux desktop is retired: run there, the installer prints one line saying so, exits 0 and writes
    /// nothing, not even its log. A `uname` on PATH that answers Linux stands in for the machine.
    func testOnLinuxItSaysTheDesktopIsRetiredAndInstallsNothing() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("root-installer-\(UUID().uuidString)")
        let home = dir.appendingPathComponent("home"), bin = dir.appendingPathComponent("bin")
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let uname = bin.appendingPathComponent("uname")
        try "#!/bin/sh\necho Linux\n".write(to: uname, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: uname.path)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [Repo.root.deletingLastPathComponent().appendingPathComponent("install.sh").path]
        p.environment = ["HOME": home.path, "PATH": "\(bin.path):/usr/bin:/bin"]
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        try p.run()
        let said = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let errors = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, errors)
        XCTAssertEqual(said, "Polycarp runs on macOS and Windows. The Linux desktop is retired.\n")
        XCTAssertEqual(errors, "")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: home.path), [], "a Linux run wrote into HOME")
        XCTAssertFalse(try installer().contains("theme follow omarchy"), "the Omarchy theme follow left with Linux")
    }

    /// The browser extension was removed from Polycarp: asked for by name, the installer prints one line saying so, exits 0 and writes nothing, not even its log or the parts file, whatever else is named with it. A `uname`
    /// that answers Darwin stands in for a Mac.
    func testAskingForTheBrowserNamesWhereItWentAndInstallsNothing() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("root-installer-\(UUID().uuidString)")
        let home = dir.appendingPathComponent("home"), bin = dir.appendingPathComponent("bin")
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let uname = bin.appendingPathComponent("uname")
        try "#!/bin/sh\necho Darwin\n".write(to: uname, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: uname.path)
        let removed = "The browser extension was removed from Polycarp.\n"
        let silas = "  voice is Silas now, its own app: https://github.com/baney75/silas\n"
        for (features, line, note) in [("browser", removed, ""), ("browser,voice", removed, silas)] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [Repo.root.deletingLastPathComponent().appendingPathComponent("install.sh").path]
            p.environment = ["HOME": home.path, "PATH": "\(bin.path):/usr/bin:/bin", "POLYCARP_FEATURES": features]
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            p.standardInput = FileHandle.nullDevice
            try p.run()
            let said = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            let errors = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0, errors)
            XCTAssertEqual(said, line, features)
            XCTAssertEqual(errors, note)
            XCTAssertEqual(try fm.contentsOfDirectory(atPath: home.path), [], "asking for \(features) wrote into HOME")
        }
        let t = try installer()
        XCTAssertFalse(t.contains("setup-siblings") || t.contains("command -v bun"), "a source build needs no browser siblings or Bun")
    }

    /// Only the browser stops the install: naming workspaces or voice carries on, voice with one line saying where Silas
    /// is. Sourced for its functions, so nothing is installed.
    func testOnlyTheBrowserStopsTheInstall() throws {
        // `workspaces,browser` was the old documented non-interactive answer: it gets the removed line and still installs.
        let removed = "The browser extension was removed from Polycarp.\n"
        for both in ["workspaces,browser", "workspaces, browser", "browser workspaces"] {
            let (out, rc) = try functions("moved_notes '\(both)'; echo \"rc=$?\"")
            XCTAssertEqual(rc, 0, out)
            XCTAssertEqual(out, removed + "rc=0\n", both)
        }
        let (said, code) = try functions("moved_notes 'workspaces,voice'; echo \"rc=$?\"; moved_notes browser || echo stop")
        XCTAssertEqual(code, 0, said)
        XCTAssertEqual(said, "  voice is Silas now, its own app: https://github.com/baney75/silas\nrc=0\nThe browser extension was removed from Polycarp.\nstop\n")
        let main = try installer()
        XCTAssertTrue(main.contains("  moved_notes \"${POLYCARP_FEATURES:-}\" || return 0\n"), "main stops only when moved_notes says so")
    }

    /// The step that runs install-app.sh shows only a check mark and keeps its output in the log, so the retire step's
    /// lines about the remote connector are printed from the log right after it. A log without them prints nothing.
    func testTheConnectorLinesReachTheTerminal() throws {
        let fm = FileManager.default
        let log = fm.temporaryDirectory.appendingPathComponent("install-log-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: log) }
        let off = "Your remote connector ran on the browser helper that left Polycarp, so it is off now."
        try "building\nretired com.polycarp.serve: it ran x\n\(off)\ndone\n".write(to: log, atomically: true, encoding: .utf8)
        let (said, code) = try functions("connector_notice '\(log.path)'; echo; connector_notice /nonexistent; echo end")
        XCTAssertEqual(code, 0, said)
        XCTAssertEqual(said, "  \(off)\n\nend\n")
        let main = try installer()
        let step = try XCTUnwrap(main.range(of: "step \"Installing Polycarp\""))
        XCTAssertTrue(main[step.upperBound...].contains("\n  connector_notice \"$LOG\"\n"), "the notice comes after the install step")
    }

    // Polycarp can install its companions, Silas and Shotate, each from its own installer, only when asked (Donovan,
    // 2026-11-24).
    func testCompanionsAreChosenByNameOrNumberAndNothingIsTheDefault() throws {
        let (said, code) = try functions("""
            companion_list 'Shotate, silas'; echo '|'; companion_list '2 1'; echo '|'; companion_list 'silas,Silas 1'; echo '|'
            companion_list ''; echo '|'; companion_list all; echo '|'; companion_list 'zoom' 2>&1; echo '|'
            printf '\\n' | ask_companions 2>/dev/null; echo '|'
            """)
        XCTAssertEqual(code, 0, said)
        let parts = said.components(separatedBy: "|\n")
        XCTAssertEqual(parts[0], "silas shotate")
        XCTAssertEqual(parts[1], "silas shotate", "the question's numbers, in the listed order")
        XCTAssertEqual(parts[2], "silas", "each companion once")
        XCTAssertEqual(parts[3], "", "nothing named, nothing installed")
        XCTAssertEqual(parts[4], "silas shotate")
        XCTAssertTrue(parts[5].contains("Not a companion: zoom"), parts[5])
        XCTAssertEqual(parts[6], "", "Return alone at the question means none")
    }

    func testEachCompanionUsesItsOwnOfficialInstaller() throws {
        let (said, code) = try functions("for c in $COMPANIONS; do companion_command $c; done")
        XCTAssertEqual(code, 0, said)
        XCTAssertEqual(said.split(separator: "\n").map(String.init), [
            "curl -fsSL https://raw.githubusercontent.com/baney75/silas/main/install.sh | sh",
            "curl -fsSL https://raw.githubusercontent.com/baney75/shotate/main/install.sh | bash",
        ])
        let main = try installer()
        XCTAssertTrue(main.contains("step_soft \"Installing $(companion_name \"$c\")\""), "a companion failing never stops Polycarp's install")
        XCTAssertTrue(main.contains("[ -z \"$asked_with\" ] && [ -z \"$test_mode\" ] && [ -t 1 ]"), "the question is asked only at a terminal, outside test mode, when nothing was named")
    }

    // Review of #646: a failed download must fail the companion, not run an empty script and report success.
    func testACompanionWhoseDownloadFailsFailsAndOneThatDownloadsRuns() throws {
        let stub = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-curl-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stub, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stub) }
        let curl = stub.appendingPathComponent("curl")
        func stubCurl(_ body: String) throws {
            try ("#!/bin/bash\n" + body + "\n").write(to: curl, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: curl.path)
        }
        try stubCurl("exit 22")
        var (said, code) = try functions("PATH=\"\(stub.path):$PATH\"; if companion_install silas; then echo installed; else echo failed; fi")
        XCTAssertEqual(code, 0, said)
        XCTAssertEqual(said.trimmingCharacters(in: .whitespacesAndNewlines), "failed", "a 404 or no network is a failure")
        try stubCurl("echo 'echo the installer ran'")
        (said, code) = try functions("PATH=\"\(stub.path):$PATH\"; for c in $COMPANIONS; do companion_install $c || echo failed; done")
        XCTAssertEqual(code, 0, said)
        XCTAssertEqual(said.components(separatedBy: "the installer ran").count - 1, 2, said)
        XCTAssertFalse(said.contains("failed"), said)
    }

    func testAnAnswerIsReadAsWordsNotFileNames() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-glob-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        FileManager.default.createFile(atPath: dir.appendingPathComponent("all").path, contents: Data())
        let (said, code) = try functions("cd \"\(dir.path)\"; companion_list '*' 2>/dev/null; echo '|'")
        XCTAssertEqual(code, 0, said)
        XCTAssertEqual(said, "|\n", "* is not a companion, even beside a file named all")
    }

    func testCompanionsInstallAfterPolycarpOpens() throws {
        let main = try installer()
        let open = try XCTUnwrap(main.range(of: "step \"Opening Polycarp\""))
        let companions = try XCTUnwrap(main.range(of: "companion_install \"$c\""))
        XCTAssertLessThan(open.lowerBound, companions.lowerBound, "Polycarp's own install finishes and opens first")
        XCTAssertTrue(main.contains("polycarp install --local-studio (log: $LOG)"), "a failed Local Studio plugin step says how to retry")
    }

    /// Runs `script` in bash with install.sh sourced for its functions only, under the script's own `set -euo pipefail`.
    private func functions(_ script: String) throws -> (String, Int32) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        let path = Repo.root.deletingLastPathComponent().appendingPathComponent("install.sh").path
        p.arguments = ["-c", "POLYCARP_INSTALL_FUNCTIONS_ONLY=1 source \"\(path)\"; \(script)"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        p.standardInput = FileHandle.nullDevice
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (String(decoding: data, as: UTF8.self), p.terminationStatus)
    }

    func testTestModeNeverQuitsOrOpensAnything() throws {
        let t = try installer()
        XCTAssertTrue(t.contains(#"if [ -z "$test_mode" ]; then"#))
        // Test mode leaves out /Applications and skips a real home, so it can't touch a real copy.
        XCTAssertTrue(t.contains(#"[ -n "$1" ] || printf '%s\n' "/Applications/BaneySpaces.app""#))
        XCTAssertTrue(t.contains(#"pgrep -f "$a/Contents/MacOS/BaneySpaces""#))
        XCTAssertFalse(t.contains("pgrep -x BaneySpaces"))
    }
}
