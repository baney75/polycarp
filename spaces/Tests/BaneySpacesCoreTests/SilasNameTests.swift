import CoreGraphics
import XCTest
@testable import BaneySpacesCore

final class SilasNameTests: XCTestCase {
    /// Every visible string of the voice part, as a person reads it.
    private var strings: [String] {
        let mic = Welcome.step(.microphone)
        return [SilasName.description, SilasRetirement.notice, SilasRetirement.stillInstalled, SilasRetirement.button,
                mic.title, mic.why, mic.after, LegacyHandover.silasRunningReason,
                LegacyHandover.alertDetail(running: [Product.Silas.phrase]), LegacyHandover.alertTitle(running: [Product.Silas.phrase]),
                LegacyHandover.continueButton(running: [Product.Silas.phrase]), LegacyHandover.notificationTitle(forBundleID: Product.Silas.bundleID),
                LegacyHandover.notificationBody(forBundleID: Product.Silas.bundleID), SilasName.menuTitle("Ready")]
            + [VoiceGate.Reason.needsModel, .importPending, .silasRunning].compactMap { VoiceGate.message($0) }
    }

    func testTheVoicePartIsCalledSilasNotVoice() throws {
        for s in strings { XCTAssertFalse(s.contains("Voice"), "\"\(s)\" uses Voice as a name") }
        for s in strings { XCTAssertFalse(s.contains("'s dictation"), "\"\(s)\" calls Silas Polycarp's dictation") }
        XCTAssertTrue(LegacyHandover.alertDetail(running: [Product.Silas.phrase]).contains("Silas in Polycarp takes over from here"))
        XCTAssertTrue(LegacyHandover.notificationBody(forBundleID: Product.Silas.bundleID).hasPrefix("Silas in Polycarp is on"))
        XCTAssertEqual(SilasName.description, "Silas: hold a key, speak and it types.")
        XCTAssertEqual(SilasName.menuTitle("Ready · hold Right ⌘ to speak"), "Silas: Ready · hold Right ⌘ to speak")
        XCTAssertTrue(Welcome.step(.microphone).why.hasPrefix(SilasName.description), "the plain description comes first")
        XCTAssertEqual(Welcome.step(.microphone).settingsName, "Microphone", "macOS's own word for the permission")
        XCTAssertTrue(strings.contains { $0.contains("Settings > Silas") })
        let setup = try Repo.text("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("voice = \"Silas\""), "the Settings tab is Silas")
        XCTAssertFalse(setup.contains("voice = \"Voice\""))
        XCTAssertEqual(Welcome.steps.filter { $0.title.contains("Voice") }.count, 0)
        // Dictation is still fine as an activity.
        XCTAssertTrue(VoiceGate.message(.needsModel)!.hasPrefix("Dictation is waiting"))
    }

    func testTheOlderAppIsTheSilasAppWhereTheTwoNeedTellingApart() {
        XCTAssertEqual(SilasRetirement.stillInstalled, "The Silas app is still installed.")
        XCTAssertEqual(SilasRetirement.button, "Move the Silas app to the Trash")
        XCTAssertEqual(LegacyHandover.alertTitle(running: [Product.Silas.phrase]), "The Silas app is running. Polycarp replaces it.")
        XCTAssertTrue(SilasRetirement.notice.contains("The Silas app can go"))
    }

    func testNoMicrophoneSymbolIsLeftForSilas() throws {
        for file in ["Sources/BaneySpaces/Setup.swift", "Sources/BaneySpaces/AppDelegate.swift", "Sources/BaneySpaces/Voice/VoiceSettingsView.swift",
                     "Sources/BaneySpaces/Voice/VoiceOverlay.swift", "Sources/BaneySpaces/Voice/VoiceEngine.swift"] {
            let text = try Repo.text(file)
            for bad in ["\"mic\"", "\"mic.fill\"", "systemName: \"mic", "🎙", "microphone.fill"] {
                XCTAssertFalse(text.contains(bad), "\(file) still draws a microphone (\(bad))")
            }
        }
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/Voice/VoiceSettingsView.swift").contains("SilasMarkView"))
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/Setup.swift").contains("SilasMark.templateImage"))
        XCTAssertTrue(try Repo.text("Sources/BaneySpaces/AppDelegate.swift").contains("SilasMark.templateImage"))
    }

    func testThePenIsSilasNibWithItsCapSlitAndSlots() {
        let pen = SilasMarkGeometry.pen()
        func filled(_ x: CGFloat, _ y: CGFloat) -> Bool { pen.contains(CGPoint(x: x, y: y), using: .evenOdd) }
        XCTAssertTrue(filled(22, 10), "the cap bar")
        XCTAssertFalse(filled(22, 14.5), "the gap between cap and nib")
        XCTAssertTrue(filled(14, 20), "the nib's left side")
        XCTAssertTrue(filled(30, 20), "the nib's right side")
        XCTAssertFalse(filled(22, 30), "the centre slit")
        XCTAssertFalse(filled(17.3, 23), "the left slot")
        XCTAssertFalse(filled(26.6, 23), "the right slot")
        XCTAssertTrue(filled(14.5, 21), "metal between the slot and the edge")
        XCTAssertFalse(filled(5, 5)); XCTAssertFalse(filled(22, 41), "past the tip")
        let box = pen.boundingBoxOfPath
        XCTAssertGreaterThanOrEqual(box.minX, 0); XCTAssertLessThanOrEqual(box.maxX, SilasMarkGeometry.grid)
        XCTAssertGreaterThanOrEqual(box.minY, 0); XCTAssertLessThanOrEqual(box.maxY, SilasMarkGeometry.grid)
        XCTAssertTrue(SilasMarkGeometry.dot().contains(SilasMarkGeometry.dotCenter), "the listening dot")
        XCTAssertFalse(SilasMarkGeometry.dot().boundingBoxOfPath.intersects(CGRect(x: 14, y: 8, width: 15, height: 5.5)), "the dot stays clear of the cap")
    }

    func testTheListeningMarkIsOneTemplateImageNotAnAttachmentInAnUnstyledTitle() throws {
        let delegate = try Repo.text("Sources/BaneySpaces/AppDelegate.swift")
        XCTAssertFalse(delegate.contains("NSTextAttachment"), "an attachment in a plain string doesn't follow a dark menu bar")
        XCTAssertFalse(delegate.contains("attributedTitle = title"))
        XCTAssertTrue(delegate.contains("SilasMenuBarImage.composite(base: base, recording: true)"))
        let image = try Repo.text("Sources/BaneySpaces/Voice/SilasMenuBarImage.swift")
        XCTAssertTrue(image.contains("image.isTemplate = true"), "macOS tints it for the bar")
        XCTAssertTrue(image.contains("SilasMarkGeometry.dot()"))
        // The Settings mark keeps its documented look: the pen in the text color, the dot in the accent.
        XCTAssertFalse(try Repo.text("Sources/BaneySpaces/Voice/VoiceSettingsView.swift").contains("SilasMarkView(live: voice.state?.status.isLive == true).foregroundStyle"))
        // One icon path: the Silas tab has no placeholder symbol.
        let setup = try Repo.text("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains("var symbol: String? {"))
        XCTAssertTrue(setup.contains("case .voice: nil"))
    }
}
