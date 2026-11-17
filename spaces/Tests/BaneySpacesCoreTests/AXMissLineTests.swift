import BaneySpacesCore
import XCTest

/// 2026-11-17: one Polycarp process benched Ghostty and Terminal for 3 hours ("didn't answer", 5 s up to 10 min), while
/// both answered every call in under 65 ms when asked from outside. The line didn't say which call failed or how, so the
/// cause couldn't be told apart: a timeout, an instant refusal, or the focus observer.
final class AXMissLineTests: XCTestCase {
    func testTheLineNamesTheCallAndTheError() {
        XCTAssertEqual(AXBench.missLine(app: "Ghostty", pid: 26143, call: "AXWindows", error: -25204, delay: 600),
                       "accessibility: Ghostty (pid 26143) didn't answer (AXWindows: -25204 cannot complete (timeout)); asked again in 600.0s")
        XCTAssertEqual(AXBench.missLine(app: "Terminal", pid: 4549, call: "focus observer", error: -25211, delay: 5),
                       "accessibility: Terminal (pid 4549) didn't answer (focus observer: -25211 API disabled); asked again in 5.0s")
    }

    func testASuccessWithTheWrongAnswerAndAnUnknownCodeAreNamed() {
        XCTAssertEqual(AXBench.errorName(0), "0 answer of the wrong kind")
        XCTAssertEqual(AXBench.errorName(-1), "-1 unknown")
    }
}

/// Every path that benches an app says which call it was.
final class AXMissLineWiringTests: XCTestCase {
    func testEveryBenchingPathNamesItsCall() throws {
        let windows = try Repo.code("Sources/BaneySpaces/Windows.swift")
        XCTAssertTrue(windows.contains("AXBench.missLine("), "the trace line comes from the Core helper")
        XCTAssertTrue(windows.contains("markUnresponsive(pid, call: kAXWindowsAttribute, error: error)"), "the scan names the window list and its error")
        XCTAssertFalse(windows.contains("markUnresponsive(pid)"), "no miss without its call and error")
        let focus = try Repo.code("Sources/BaneySpaces/FocusWatcher.swift")
        XCTAssertTrue(focus.contains(#"call: "focus observer""#), "an observer refusal says so")
    }
}
