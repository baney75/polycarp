import BaneySpacesCore
import XCTest

final class LanesTests: XCTestCase {
    func testEachAppIsOneLaneInItsOwnOrder() {
        XCTAssertEqual(Lanes.split([7, 9, 7, 7, 9, 3]), [[0, 2, 3], [1, 4], [5]])
        XCTAssertEqual(Lanes.split([Int]()), [])
    }

    func testAnswersComeInTheItemsOrder() {
        let items = (0..<40).map { (pid: $0 % 5, n: $0) }
        XCTAssertEqual(Lanes.map(items, by: \.pid) { $0.n * 2 }, items.map { $0.n * 2 })
        XCTAssertEqual(Lanes.map([Int](), by: { $0 }) { $0 }, [])
    }

    /// Two calls to one app at once would let a window's move overtake its `AXEnhancedUserInterface` switch.
    func testCallsToOneAppStayInOrderAndNeverOverlap() {
        let items = (0..<24).map { (pid: $0 % 3, n: $0) }
        let lock = NSLock()
        var inside: [Int: Int] = [:], order: [Int: [Int]] = [:], most = 0
        _ = Lanes.map(items, by: \.pid) { item in
            lock.lock()
            inside[item.pid, default: 0] += 1
            most = max(most, inside[item.pid]!)
            order[item.pid, default: []].append(item.n)
            lock.unlock()
            usleep(1000)
            lock.lock(); inside[item.pid]! -= 1; lock.unlock()
        }
        XCTAssertEqual(most, 1, "two calls to one app ran at once")
        for pid in 0..<3 { XCTAssertEqual(order[pid], items.filter { $0.pid == pid }.map(\.n), "app \(pid)'s calls ran out of order") }
    }

    /// Each of two apps answers only once the other was asked, which one after another never is.
    func testTwoAppsAreAskedAtOnce() {
        let asked = [DispatchSemaphore(value: 0), DispatchSemaphore(value: 0)]
        let met = Lanes.map([0, 1], by: { $0 }) { n -> Bool in
            asked[n].signal()
            return asked[1 - n].wait(timeout: .now() + 5) == .success
        }
        XCTAssertEqual(met, [true, true], "the second app waited for the first")
    }

    /// The switch's window reads and moves run in lanes, and read each window's frame once.
    func testASwitchReadsAndMovesWindowsInLanes() throws {
        let moves = try SourceText.code("Sources/BaneySpaces/WindowMoves.swift")
        for f in ["static func targets(", "static func place(", "static func states(", "static func move("] {
            XCTAssertTrue(try XCTUnwrap(SourceText.block(after: f, in: moves)).contains("Lanes.map("), "\(f) asks one app after another")
        }
        let place = try XCTUnwrap(SourceText.block(after: "static func place(", in: moves))
        XCTAssertFalse(place.contains(".frame"), "the frame is read a second time")
        // What the lanes call must be safe off the main thread.
        let windows = try SourceText.code("Sources/BaneySpaces/Windows.swift")
        let write = try XCTUnwrap(SourceText.block(after: "static func write(_ id: WindowID, _ kind", in: windows))
        XCTAssertFalse(write.contains("NSEvent"), "AppKit is main thread only")
    }

    /// A switch asks where its windows are before, every 10 ms while they move and after: for those alone, since the window
    /// server's whole list takes 5 ms.
    func testASwitchAsksTheServerForItsOwnWindowsOnly() throws {
        let moves = try SourceText.code("Sources/BaneySpaces/WindowMoves.swift")
        let bounds = try XCTUnwrap(SourceText.block(after: "static func bounds(of", in: moves))
        XCTAssertTrue(bounds.contains("CGWindowListCreateDescriptionFromArray("))
        XCTAssertFalse(bounds.contains("serverWindows("), "the whole list is read at every look")
    }
}
