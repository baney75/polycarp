import Foundation
import XCTest

/// Gap F3: after an install, every part reports the commit the app was built from, or the install says which one doesn't.
/// On 2026-11-17 the installed app, both commands and the browser helper were at 4fa0e4d while Helium's extension was at
/// 9640a7a, and nothing said so: `polycarp version --check` exited 1, but no build script ran it.
final class InstallSameCommitTests: XCTestCase {
    func testTheInstallChecksEveryPartAfterTheAppStarts() throws {
        let script = try Repo.code("scripts/install-app.sh")
        let launch = try XCTUnwrap(script.range(of: #"open "$DEST""#), "the install opens the app")
        let check = try XCTUnwrap(script.range(of: "version --check --wait"), "the install compares the parts")
        XCTAssertLessThan(launch.lowerBound, check.lowerBound, "after the app has started and copied the extension")
        XCTAssertTrue(script.contains(#"$DEST/Contents/Resources/bin/polycarp" version --check"#), "the polycarp this app carries")
        XCTAssertTrue(script.contains(#"elif [ "$same" != 0 ]; then"#) && script.contains("exit 1"), "a part that differs fails the install")
        XCTAssertTrue(script.contains(#"if [ "$same" = 75 ]; then"#), "a browser that didn't answer is a note, not a failure")
    }
}
