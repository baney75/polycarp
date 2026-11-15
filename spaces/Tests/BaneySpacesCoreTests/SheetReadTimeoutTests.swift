import Foundation
import XCTest

/// #124 round 1 first-F4: the sheet read set its 0.25 s timeout only on the window element. Each sheet and descendant read
/// through `HandsAXTree.copy` waited the system default, so a hung app with a sheet up held the main thread for seconds.
final class SheetReadTimeoutTests: XCTestCase {
    func testEveryTreeReadSetsTheShortTimeoutFirst() throws {
        let ax = try HandsSourceTests.code("Sources/BaneySpaces/Hands/ChildWindowsAX.swift")
        XCTAssertTrue(ax.contains("static let timeout: Float = 0.25"))
        let body = try XCTUnwrap(HandsSourceTests.block(after: "private static func copy(_ e: AXUIElement, _ attribute: String) -> (CFTypeRef?, AXError) ", in: ax))
        let set = try XCTUnwrap(body.range(of: "AXUIElementSetMessagingTimeout(e, timeout)"), "the element read sets its own timeout")
        let read = try XCTUnwrap(body.range(of: "AXUIElementCopyAttributeValue(e,"))
        XCTAssertLessThan(set.lowerBound, read.lowerBound, "the timeout is set before the read")
    }

    func testTheTreeReadsGoThroughThatCopy() throws {
        let ax = try HandsSourceTests.code("Sources/BaneySpaces/Hands/ChildWindowsAX.swift")
        let tree = try XCTUnwrap(HandsSourceTests.block(after: "enum HandsAXTree ", in: ax))
        XCTAssertEqual(tree.components(separatedBy: "AXUIElementCopyAttributeValue(").count, 2, "one raw read, in copy")
        XCTAssertTrue(tree.contains("string: { string($0, $1) }, children: { children($0) }"), "node reads through copy")
    }
}
