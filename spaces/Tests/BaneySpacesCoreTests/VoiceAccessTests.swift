import XCTest
@testable import BaneySpacesCore

final class VoiceAccessTests: XCTestCase {
    func testVoiceOverHearsListeningWritingOnceEach() {
        XCTAssertEqual(VoiceAccess.announcement(from: .ready, to: .recording), "Silas, listening")
        XCTAssertEqual(VoiceAccess.announcement(from: .recording, to: .transcribing), "Silas, writing")
        XCTAssertNil(VoiceAccess.announcement(from: .transcribing, to: .typing), "the same phase, said once")
        XCTAssertEqual(VoiceAccess.announcement(from: .recording, to: .typing), "Silas, writing")
        XCTAssertNil(VoiceAccess.announcement(from: .recording, to: .recording))
        XCTAssertNil(VoiceAccess.announcement(from: .typing, to: .ready))
        XCTAssertEqual(VoiceNotice(kind: .error, message: "No model is loaded").announcement, "Silas: No model is loaded")
    }

    func testTheStillMeterLightsWithTheLevel() {
        XCTAssertEqual(VoiceAccess.lit(level: 0, bars: 16), 0)
        XCTAssertEqual(VoiceAccess.lit(level: 1, bars: 16), 16)
        XCTAssertLessThan(VoiceAccess.lit(level: 0.1, bars: 16), VoiceAccess.lit(level: 0.5, bars: 16))
        XCTAssertEqual(VoiceAccess.lit(level: 5, bars: 16), 16)
    }

    func testTheOverlayPostsAnnouncementsAndStandsStillUnderReduceMotion() throws {
        let code = try Repo.code("Sources/BaneySpaces/Voice/VoiceOverlay.swift")
        XCTAssertTrue(code.contains(".announcementRequested"))
        XCTAssertTrue(code.contains("VoiceAccess.announcement("))
        XCTAssertTrue(code.contains("n.announcement"))
        XCTAssertTrue(code.contains("VoiceAccess.lit("))
    }
}
