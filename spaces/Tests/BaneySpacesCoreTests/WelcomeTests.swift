import XCTest
@testable import BaneySpacesCore

final class WelcomeTests: XCTestCase {
    func testPermissionsAreAskedInOrderAndOnlyAccessibilityIsRequired() {
        XCTAssertEqual(Welcome.steps.map(\.kind), [.accessibility, .screenRecording, .inputMonitoring])
        XCTAssertEqual(Welcome.steps.filter(\.isRequired).map(\.kind), [.accessibility])
        XCTAssertEqual(Welcome.next(granted: [], skipped: []), .accessibility)
        XCTAssertEqual(Welcome.next(granted: [.accessibility], skipped: []), .screenRecording)
        XCTAssertEqual(Welcome.next(granted: [.accessibility], skipped: [.screenRecording]), .inputMonitoring)
        XCTAssertNil(Welcome.next(granted: [.accessibility], skipped: [.screenRecording, .inputMonitoring]))
    }

    func testARequiredPermissionCantBeSkippedAndAnOptionalOneDoesntBlock() {
        XCTAssertFalse(Welcome.canSkip(.accessibility))
        XCTAssertTrue(Welcome.canSkip(.screenRecording))
        XCTAssertFalse(Welcome.canStart(granted: [.screenRecording, .inputMonitoring]))
        XCTAssertTrue(Welcome.canStart(granted: [.accessibility]))
    }

    func testEachStepOpensItsOwnSettingsList() {
        XCTAssertTrue(Welcome.step(.accessibility).settingsURL.hasSuffix("Privacy_Accessibility"))
        XCTAssertTrue(Welcome.step(.screenRecording).settingsURL.hasSuffix("Privacy_ScreenCapture"))
        XCTAssertTrue(Welcome.step(.inputMonitoring).settingsURL.hasSuffix("Privacy_ListenEvent"))
        for s in Welcome.steps { XCTAssertTrue(s.settingsURL.hasPrefix("x-apple.systempreferences:com.apple.preference.security?")) }
    }

    func testItReturnsWhenTheRequiredPermissionIsLostAndNeverForASkippedOne() {
        XCTAssertTrue(Welcome.shouldShow(hasFinished: false, granted: [.accessibility], forced: false), "first run")
        XCTAssertFalse(Welcome.shouldShow(hasFinished: true, granted: [.accessibility], forced: false), "skipped optional ones don't return")
        XCTAssertTrue(Welcome.shouldShow(hasFinished: true, granted: [], forced: false), "macOS forgot the permission")
        XCTAssertTrue(Welcome.shouldShow(hasFinished: true, granted: [.accessibility], forced: true))
    }

    func testTheWordsStaySafe() {
        for s in Welcome.steps {
            XCTAssertFalse(s.why.contains("BaneySpaces")); XCTAssertFalse(s.after.contains("BaneySpaces"))
            XCTAssertLessThan(s.why.count, 200, "\(s.kind): short enough to read at a glance")
        }
    }
}
