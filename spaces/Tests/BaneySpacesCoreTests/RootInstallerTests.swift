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

    /// On Omarchy, Polycarp matches the system theme from the install on, and never overrides a choice already made.
    func testLinuxInstallsTheCommandAndFollowsOmarchyOnlyIfFresh() throws {
        let t = try installer()
        XCTAssertTrue(t.contains("theme follow omarchy --if-fresh"))
        XCTAssertTrue(t.contains(#"[ "$(uname -s)" = Linux ]"#))
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
