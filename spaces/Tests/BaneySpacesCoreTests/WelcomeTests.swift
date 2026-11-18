import XCTest
@testable import BaneySpacesCore

final class WelcomeTests: XCTestCase {
    func testPermissionsAreAskedInOrderAndOnlyAccessibilityIsRequired() {
        XCTAssertEqual(Welcome.steps.map(\.kind), [.accessibility, .microphone])
        XCTAssertEqual(Welcome.steps.filter(\.isRequired).map(\.kind), [.accessibility])
        XCTAssertEqual(Welcome.next(granted: [], skipped: []), .accessibility)
        XCTAssertEqual(Welcome.next(granted: [.accessibility], skipped: []), .microphone)
        XCTAssertNil(Welcome.next(granted: [.accessibility], skipped: [.microphone]))
    }

    func testARequiredPermissionCantBeSkippedAndAnOptionalOneDoesntBlock() {
        XCTAssertFalse(Welcome.canSkip(.accessibility))
        XCTAssertTrue(Welcome.canSkip(.microphone))
        XCTAssertFalse(Welcome.canStart(granted: [.microphone]))
        XCTAssertTrue(Welcome.canStart(granted: [.accessibility]))
    }

    func testEachStepOpensItsOwnSettingsList() {
        XCTAssertTrue(Welcome.step(.accessibility).settingsURL.hasSuffix("Privacy_Accessibility"))
        XCTAssertTrue(Welcome.step(.microphone).settingsURL.hasSuffix("Privacy_Microphone"))
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
        XCTAssertEqual(Set(Welcome.steps.map(\.kind)), [.accessibility, .microphone], "no Screen Recording or Input Monitoring: nothing here uses them")
    }

    func testStartAtLoginIsALastRowThatIsOnByDefault() {
        XCTAssertEqual(Welcome.StartAtLogin.title, "Start with your Mac")
        XCTAssertTrue(Welcome.StartAtLogin.approval.contains("Login Items"))
        XCTAssertTrue(Welcome.StartAtLogin.shouldRegister(chosen: false, offered: false, registered: false), "on by default")
        XCTAssertFalse(Welcome.StartAtLogin.shouldRegister(chosen: true, offered: false, registered: false), "a decision is kept")
        XCTAssertFalse(Welcome.StartAtLogin.shouldRegister(chosen: false, offered: true, registered: false))
        XCTAssertFalse(Welcome.StartAtLogin.shouldRegister(chosen: false, offered: false, registered: true))
        XCTAssertEqual(Welcome.steps.count, 2, "it is not a permission step")
    }

    func testTheWalkIsPressFlipPressFlip() {
        XCTAssertEqual(Welcome.defaultAction(granted: [], skipped: []), .allow(.accessibility))
        XCTAssertEqual(Welcome.defaultAction(granted: [.accessibility], skipped: []), .allow(.microphone))
        XCTAssertEqual(Welcome.defaultAction(granted: [.accessibility, .microphone], skipped: []), .finish)
        XCTAssertEqual(Welcome.defaultAction(granted: [.accessibility], skipped: [.microphone]), .finish)
    }

    func testTheWordsStaySafe() {
        for s in Welcome.steps {
            XCTAssertFalse(s.why.contains("BaneySpaces")); XCTAssertFalse(s.after.contains("BaneySpaces"))
            XCTAssertLessThanOrEqual(s.why.count, 220, "\(s.kind): short enough to read at a glance")
        }
    }

    func testTheMicrophoneIsOptionalAndSaysWhatTheCodeDoes() {
        let mic = Welcome.step(.microphone)
        XCTAssertFalse(mic.isRequired, "dictation is optional; the window manager is not")
        XCTAssertTrue(Welcome.canStart(granted: [.accessibility]), "no microphone needed to start")
        XCTAssertTrue(Welcome.canSkip(.microphone))
        // Core.start_recording keeps samples in memory only from the key press to its release (or a second tap), transcribes on this Mac, and writes
        // text (never audio) to History. The only network calls are model and device-list downloads.
        XCTAssertTrue(mic.why.contains("only from when you press the key"), mic.why)
        XCTAssertTrue(mic.why.contains("on this Mac"), mic.why)
        XCTAssertTrue(mic.why.contains("isn't saved or sent anywhere"), mic.why)
        XCTAssertFalse(mic.why.lowercased().contains("cloud"))
    }

    func testAllowOnTheMicrophoneOpensSettingsOnlyAfterANo() {
        XCTAssertFalse(Welcome.opensSettingsWhenAllowing(microphone: .notDetermined), "macOS asks for itself")
        XCTAssertFalse(Welcome.opensSettingsWhenAllowing(microphone: .authorized))
        XCTAssertTrue(Welcome.opensSettingsWhenAllowing(microphone: .denied), "macOS never asks twice")
    }
}
