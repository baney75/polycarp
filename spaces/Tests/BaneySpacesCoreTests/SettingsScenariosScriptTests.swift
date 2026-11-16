import XCTest

/// The live System Settings scenarios (#387) judged by the CLI's own shapes. On 2026-11-16 the script failed S1 and S3
/// against a working build and passed S2 against a refused one, because it read keys and flags the CLI does not have.
final class SettingsScenariosScriptTests: XCTestCase {
    func testTheScriptReadsWhatTheCLIAnswers() throws {
        let s = try Repo.text("scripts/system-settings-scenarios.sh")
        XCTAssertTrue(s.contains(#"str(x.get("id"))==sys.argv[1]"#), "agent windows rows carry the window as id")
        XCTAssertFalse(s.contains(#"x.get("window")"#))
        XCTAssertTrue(s.contains("--role textfield --name Search"), "the search field is a textfield named Search")
        XCTAssertTrue(s.contains(#"agent set-value "$REF" "Keyboard""#), "set-value takes the ref and value as words")
        XCTAssertFalse(s.contains("set-value --ref"))
        XCTAssertTrue(s.contains(#"field data.complete)" = True ] && ok "S2"#), "run-steps is ok with complete false when a step fails")
    }
}
