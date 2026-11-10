import XCTest
@testable import BaneySpacesCore

/// Settings > Silas and the overlay, when dictation can't do what was asked (core/voice core.rs `fail`, `notice`).
final class VoiceProblemsTests: XCTestCase {
    private func state(_ json: String) throws -> VoiceState { try JSONDecoder().decode(VoiceState.self, from: Data(json.utf8)) }

    func testStatusCarriesBothPermissionsAndToleratesOddOrMissingOnes() throws {
        let s = try state(#"{"status":"ready","detail":null,"model":"parakeet-v3","hotkey":"CmdRight","hotkeyLabel":"Right ⌘","enabled":true,"listener":true,"permissions":{"microphone":"denied","accessibility":"granted"}}"#)
        XCTAssertEqual(s.permissions, VoicePermissions(microphone: .denied, accessibility: .granted))
        let odd = try state(#"{"status":"ready","detail":null,"model":null,"hotkey":"CmdRight","hotkeyLabel":"Right ⌘","enabled":true,"listener":true,"permissions":{"microphone":"restricted"}}"#)
        XCTAssertEqual(odd.permissions, VoicePermissions(microphone: .unknown, accessibility: .unknown))
        let old = try state(#"{"status":"ready","detail":null,"model":null,"hotkey":"CmdRight","hotkeyLabel":"Right ⌘","enabled":true,"listener":true}"#)
        XCTAssertNil(old.permissions)
    }

    func testEachPermissionLineHasItsStateAndOneButtonThatMovesItForward() {
        let micOK = VoicePermissionLine.microphone(.granted)
        XCTAssertEqual(micOK.state, "Allowed"); XCTAssertNil(micOK.button); XCTAssertTrue(micOK.allowed)
        // Never asked: macOS's own box, not System Settings (Welcome's rule).
        let micNew = VoicePermissionLine.microphone(.unknown)
        XCTAssertEqual(micNew.button, "Allow"); XCTAssertEqual(micNew.action, .ask)
        // Refused: only the list in System Settings can change it, and the button says so.
        let micNo = VoicePermissionLine.microphone(.denied)
        XCTAssertEqual(micNo.state, "Not allowed")
        XCTAssertEqual(micNo.button, "Open Microphone Settings")
        XCTAssertEqual(micNo.action, .openSettings(Welcome.step(.microphone).settingsURL))
        let axOK = VoicePermissionLine.accessibility(.granted)
        XCTAssertNil(axOK.button); XCTAssertTrue(axOK.allowed)
        for g in [VoiceGrant.denied, .unknown] {
            let ax = VoicePermissionLine.accessibility(g)
            XCTAssertEqual(ax.button, "Open Accessibility Settings")
            XCTAssertEqual(ax.action, .openSettings(Welcome.step(.accessibility).settingsURL))
        }
    }

    /// The core's messages send the person to "Settings > Silas" and name a button there: it must exist.
    func testTheButtonsTheCoresMessagesNameAreTheOnesOnTheLines() {
        let core = [
            "Polycarp can't hear your key yet. Open Settings > Silas and click Open Accessibility Settings, then turn on Polycarp.",
            "Microphone: not allowed. Open Settings > Silas and click Open Microphone Settings, then turn on Polycarp.",
        ]
        XCTAssertTrue(core[0].contains(VoicePermissionLine.accessibility(.denied).button!))
        XCTAssertTrue(core[1].contains(VoicePermissionLine.microphone(.denied).button!))
    }

    func testANoticeDecodesAndStaysUpLongEnoughToRead() throws {
        let n = try JSONDecoder().decode(VoiceNotice.self, from: Data(#"{"kind":"error","message":"No speech heard."}"#.utf8))
        XCTAssertEqual(n, VoiceNotice(kind: .error, message: "No speech heard."))
        XCTAssertEqual(n.seconds, 4)
        XCTAssertTrue(n.keeps)
        XCTAssertEqual(n.announcement, "Silas: No speech heard.")
        XCTAssertFalse(VoiceNotice(kind: .busy, message: "x").keeps)
        XCTAssertFalse(VoiceNotice(kind: .stopped, message: "x").keeps)
        XCTAssertLessThan(VoiceNotice(kind: .busy, message: "x").seconds, n.seconds)
    }

    func testTheLastProblemSaysWhenItHappened() {
        let at = Date(timeIntervalSince1970: 1_000_000)
        let p = VoiceProblem(message: "The microphone stopped.", at: at)
        XCTAssertEqual(p.line(now: at.addingTimeInterval(5)), "Last problem, just now: The microphone stopped.")
        XCTAssertEqual(p.line(now: at.addingTimeInterval(61)), "Last problem, 1 minute ago: The microphone stopped.")
        XCTAssertEqual(p.line(now: at.addingTimeInterval(600)), "Last problem, 10 minutes ago: The microphone stopped.")
        XCTAssertEqual(p.line(now: at.addingTimeInterval(7300)), "Last problem, 2 hours ago: The microphone stopped.")
        XCTAssertEqual(p.line(now: at.addingTimeInterval(90_000)), "Last problem, earlier: The microphone stopped.")
    }

    /// The old help said "Turn dictation on first" even when dictation was on and Accessibility was the reason.
    func testTheKeyHelpNamesTheRealReasonTheListenerIsDown() {
        func help(_ listener: Bool, on: Bool = true, waiting: VoiceGate.Reason? = nil, ax: VoiceGrant? = .granted, key: String = "CmdRight") -> String? {
            VoiceKeyHelp.text(listener: listener, userEnabled: on, waiting: waiting, accessibility: ax, hotkey: key, hasFallback: false)
        }
        XCTAssertNil(help(true))
        XCTAssertTrue(help(true, key: "Dictation")!.hasPrefix("The key with the microphone"))
        XCTAssertEqual(help(false, on: false), "Turn dictation on first to pick another key.")
        XCTAssertTrue(help(false, waiting: .needsModel)!.contains("waiting for a speech model"))
        let ax = help(false, ax: .denied)!
        XCTAssertTrue(ax.contains("Accessibility"), ax)
        XCTAssertFalse(ax.contains("Turn dictation on"), ax)
        XCTAssertFalse(help(false)!.contains("Turn dictation on first"))
    }

    func testAKeyPickEndsInOneOfFourWays() {
        XCTAssertEqual(VoiceCapture.outcome(key: "F13", error: ""), .picked("F13"))
        XCTAssertEqual(VoiceCapture.outcome(key: nil, error: "cancelled"), .cancelled)
        XCTAssertEqual(VoiceCapture.outcome(key: nil, error: "No key pressed"), .timedOut)
        let why = "The A key types text, so it can't be the dictation key. Try Right ⌘, Right ⌥ or F13."
        XCTAssertEqual(VoiceCapture.outcome(key: nil, error: why), .refused(why))
        XCTAssertEqual(VoiceCapture.refused(why).note, why)
        XCTAssertNil(VoiceCapture.cancelled.note)
        XCTAssertNotNil(VoiceCapture.timedOut.note)
    }
}
