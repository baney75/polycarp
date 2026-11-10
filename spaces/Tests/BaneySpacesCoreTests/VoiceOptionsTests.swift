import XCTest
@testable import BaneySpacesCore

final class VoiceOptionsTests: XCTestCase {
    func testTheSpeedsAreTheOnesTheCoreKnowsAndSayWhenToPickSteady() {
        XCTAssertEqual(VoiceOptions.speeds.map(\.value), ["steady", "fast", "instant"])
        XCTAssertTrue(VoiceOptions.speedHelp.contains("Steady"))
    }

    func testTheMicrophonePickerKeepsAnUnpluggedChoiceVisible() {
        let m = VoiceOptions.microphones(["MacBook Pro Microphone", "Shure MV7"], current: "Yeti")
        XCTAssertEqual(m.first, .init(nil, "System default"))
        XCTAssertEqual(m.last, .init("Yeti", "Yeti (not connected)"))
        XCTAssertEqual(VoiceOptions.microphones(["Shure MV7"], current: "Shure MV7").count, 2)
        XCTAssertEqual(VoiceOptions.microphones([], current: nil), [.init(nil, "System default")])
    }

    func testLanguagesIncludeTheDefault() {
        XCTAssertEqual(VoiceOptions.languages.first?.value, "en")
        XCTAssertEqual(Set(VoiceOptions.languages.map(\.id)).count, VoiceOptions.languages.count)
    }

    /// The core learns only on a U.S. layout (focus.rs `us_layout`); the setting says so.
    func testLearningSaysItNeedsAUSLayout() throws {
        XCTAssertTrue(VoiceOptions.learnHelp.contains("U.S. or ABC"))
        XCTAssertTrue(try Repo.text("../core/voice/src/core.rs").contains("crate::focus::us_layout()"), "the limit is still real")
    }

    func testImportSaysWhatItAdded() {
        XCTAssertEqual(VoiceOptions.imported(before: 4, after: 4), "Imported. Everything was already here.")
        XCTAssertEqual(VoiceOptions.imported(before: 4, after: 5), "Imported 1 entry.")
        XCTAssertEqual(VoiceOptions.imported(before: 4, after: 9), "Imported 5 entries.")
    }

    func testTheMenuOffersStartOrStopOnlyWhenAClickCanDoIt() {
        XCTAssertEqual(VoiceOptions.menuToggle(status: .ready, enabled: true, listener: true), "Start Dictation")
        XCTAssertEqual(VoiceOptions.menuToggle(status: .recording, enabled: true, listener: true), "Stop Dictation")
        XCTAssertNil(VoiceOptions.menuToggle(status: .typing, enabled: true, listener: true))
        XCTAssertNil(VoiceOptions.menuToggle(status: .needsModel, enabled: true, listener: true))
        XCTAssertNil(VoiceOptions.menuToggle(status: .ready, enabled: false, listener: true))
        XCTAssertNil(VoiceOptions.menuToggle(status: .ready, enabled: true, listener: false))
        let delegate = try? Repo.code("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertTrue(delegate?.contains("VoiceOptions.menuToggle") == true)
        XCTAssertTrue(delegate?.contains("#selector(toggleDictation)") == true)
    }

    /// Every setting the core has gets a control in Settings > Silas (the old tab had no speed, space, Shift+Return,
    /// language or microphone).
    func testSettingsHasAControlForEachSetting() throws {
        let view = try Repo.code("Sources/BaneySpaces/Voice/VoiceSettingsView.swift")
        for key in ["typingSpeed", "trailingSpace", "newlineAsShiftEnter", "language", "microphone", "learnFromEdits"] {
            XCTAssertTrue(view.contains("$0.\(key) ="), "no control sets \(key)")
        }
        XCTAssertTrue(view.contains("importDictionary"))
    }
}
