import BaneySpacesCore
import CoreGraphics
import XCTest

final class DragFrameLogTests: XCTestCase {
    func testWritesLogWhileTheButtonIsDownAndForTwoSecondsAfterARelease() {
        XCTAssertTrue(DragFrameLog.logsWrite(now: 100, buttonDown: true, lastRelease: nil), "a write during a drag")
        XCTAssertTrue(DragFrameLog.logsWrite(now: 101.9, buttonDown: false, lastRelease: 100), "after the drop")
        XCTAssertFalse(DragFrameLog.logsWrite(now: 102.1, buttonDown: false, lastRelease: 100), "long after: a switch parks dozens")
        XCTAssertFalse(DragFrameLog.logsWrite(now: 50, buttonDown: false, lastRelease: nil), "no drag yet")
        XCTAssertFalse(DragFrameLog.logsWrite(now: 99, buttonDown: false, lastRelease: 100), "a clock that went back")
    }

    func testTheWatchRunsTwoSeconds() {
        XCTAssertTrue(DragFrameLog.watching(start: 10, now: 12))
        XCTAssertFalse(DragFrameLog.watching(start: 10, now: 12.05))
    }

    func testAWriteNamesItsWindowFrameAndLine() {
        let line = DragFrameLog.writeLine(window: 75067, kind: .origin, origin: CGPoint(x: 0, y: 33), size: nil,
                                          file: "BaneySpaces/Spaces.swift", line: 861)
        XCTAssertEqual(line, "origin write window=75067 origin=(0,33) by Spaces.swift:861")
        XCTAssertEqual(DragFrameLog.writeLine(window: 1, kind: .frame, origin: CGPoint(x: 0.5, y: 540), size: CGSize(width: 1512, height: 444),
                                              file: "Windows.swift", line: 9),
                       "frame write window=1 origin=(0.5,540) size=1512x444 by Windows.swift:9")
    }

    func testTheWatchLogsOnlyChanges() {
        let filled = CGRect(x: 0, y: 35, width: 1512, height: 949), half = CGRect(x: 0, y: 540, width: 1512, height: 444)
        XCTAssertNil(DragFrameLog.changeLine(window: 7, t: 0.1, frame: filled, previous: filled))
        XCTAssertEqual(DragFrameLog.changeLine(window: 7, t: 0.16, frame: half, previous: filled),
                       "drag watch window=7 +160 ms frame=(0,540 1512x444)")
        XCTAssertEqual(DragFrameLog.changeLine(window: 7, t: 1, frame: nil, previous: half), "drag watch window=7 +1000 ms frame=gone")
    }
}
