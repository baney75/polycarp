@testable import BaneySpacesCore
import Foundation
import XCTest

/// Issue 138, PR 166 round 2 first-F5: the session socket answered text that isn't a HandsRequest with an error that had
/// no `next_call`, though the spec says every error carries one. It now carries `next_call: null`.
final class WireNextCallTests: XCTestCase {
    func testTheNotACommandErrorCarriesANullNextCall() throws {
        let e = try XCTUnwrap(HandsNextCall.notACommand.error)
        XCTAssertEqual(e.code, .badArguments)
        XCTAssertEqual(e.nextCall, .null)
        XCTAssertTrue(HandsNextCall.notACommand.line.contains("\"next_call\":null"), HandsNextCall.notACommand.line)
    }

    func testTheWireAnswersWithIt() throws {
        let src = try String(contentsOf: HandsSourceTests.root.appendingPathComponent("Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        let wire = try XCTUnwrap(HandsSourceTests.block(after: "func handleWire(_ r: Wire.Request) -> Wire.Reply", in: src))
        XCTAssertTrue(wire.contains("env = HandsNextCall.notACommand"), wire)
        XCTAssertFalse(wire.contains("env = .failure("), "every error the wire answers goes through next_call: \(wire)")
    }
}
