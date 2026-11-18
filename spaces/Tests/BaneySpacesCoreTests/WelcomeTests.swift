import XCTest
@testable import BaneySpacesCore

final class WelcomeTests: XCTestCase {
    func testPermissionsAreAskedInOrderAndOnlyAccessibilityIsRequired() {
        XCTAssertEqual(Welcome.steps.map(\.kind), [.accessibility])
        XCTAssertEqual(Welcome.steps.filter(\.isRequired).map(\.kind), [.accessibility])
        XCTAssertEqual(Welcome.next(granted: [], skipped: []), .accessibility)
        XCTAssertNil(Welcome.next(granted: [.accessibility], skipped: []))
    }

    func testARequiredPermissionCantBeSkipped() {
        XCTAssertFalse(Welcome.canSkip(.accessibility))
        XCTAssertFalse(Welcome.canStart(granted: []))
        XCTAssertTrue(Welcome.canStart(granted: [.accessibility]))
    }

    func testEachStepOpensItsOwnSettingsList() {
        XCTAssertTrue(Welcome.step(.accessibility).settingsURL.hasSuffix("Privacy_Accessibility"))
        for s in Welcome.steps { XCTAssertTrue(s.settingsURL.hasPrefix("x-apple.systempreferences:com.apple.preference.security?")) }
    }

    func testItReturnsWhenTheRequiredPermissionIsLostAndNeverForASkippedOne() {
        XCTAssertTrue(Welcome.shouldShow(hasFinished: false, granted: [.accessibility], forced: false), "first run")
        XCTAssertFalse(Welcome.shouldShow(hasFinished: true, granted: [.accessibility], forced: false), "skipped optional ones don't return")
        XCTAssertTrue(Welcome.shouldShow(hasFinished: true, granted: [], forced: false), "macOS forgot the permission")
        XCTAssertTrue(Welcome.shouldShow(hasFinished: true, granted: [.accessibility], forced: true))
    }

    /// Computer use lives in Tychicus: Polycarp's words promise agents nothing in your apps.
    func testThePermissionWordsAreTrueOfWhatPolycarpDoes() {
        let ax = Welcome.step(.accessibility).why
        XCTAssertFalse(ax.contains("Agents"), ax)
        XCTAssertFalse(ax.contains("can't read what you type"), "not a claim the code guarantees")
        XCTAssertEqual(Set(Welcome.steps.map(\.kind)), [.accessibility], "no Screen Recording, Input Monitoring or Microphone: nothing here uses them")
    }

    func testStartAtLoginIsALastRowThatIsOnByDefault() {
        XCTAssertEqual(Welcome.StartAtLogin.title, "Start with your Mac")
        XCTAssertTrue(Welcome.StartAtLogin.approval.contains("Login Items"))
        XCTAssertTrue(Welcome.StartAtLogin.shouldRegister(chosen: false, offered: false, registered: false), "on by default")
        XCTAssertFalse(Welcome.StartAtLogin.shouldRegister(chosen: true, offered: false, registered: false), "a decision is kept")
        XCTAssertFalse(Welcome.StartAtLogin.shouldRegister(chosen: false, offered: true, registered: false))
        XCTAssertFalse(Welcome.StartAtLogin.shouldRegister(chosen: false, offered: false, registered: true))
        XCTAssertEqual(Welcome.steps.count, 1, "it is not a permission step")
    }

    func testTheWalkIsPressFlipPressFlip() {
        XCTAssertEqual(Welcome.defaultAction(granted: [], skipped: []), .allow(.accessibility))
        XCTAssertEqual(Welcome.defaultAction(granted: [.accessibility], skipped: []), .finish)
    }

    func testTheWordsStaySafe() {
        for s in Welcome.steps {
            XCTAssertFalse(s.why.contains("BaneySpaces")); XCTAssertFalse(s.after.contains("BaneySpaces"))
            XCTAssertLessThanOrEqual(s.why.count, 220, "\(s.kind): short enough to read at a glance")
        }
    }
}
