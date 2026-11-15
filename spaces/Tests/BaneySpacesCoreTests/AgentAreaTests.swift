import BaneySpacesCore
import CoreGraphics
import XCTest

/// #124 second-S2 (round 1) and first-F5 (round 2): with the agent workspace on the second display, `arrange` and
/// `move --frame` lay windows out there, not on the main display Donovan is working on.
final class AgentAreaTests: XCTestCase {
    let main = CGRect(x: 0, y: 25, width: 1512, height: 919)
    let second = CGRect(x: 1512, y: 0, width: 1920, height: 1055)
    var displays: [(key: DisplayKey, visible: CGRect)] { [("main", main), ("second", second)] }

    func testTheDisplayShowingTheAgentWorkspaceIsTheArea() {
        XCTAssertEqual(AgentArea.visible(displays: displays, showing: "second", focused: "main"), second)
        XCTAssertEqual(AgentArea.visible(displays: displays, showing: "main", focused: "second"), main)
    }

    /// Parked: the windows take their place when it is shown, which is on the display ⌘1 to ⌘9 change.
    func testAParkedAgentWorkspaceUsesTheDisplayItIsShownOnNext() {
        XCTAssertEqual(AgentArea.visible(displays: displays, showing: nil, focused: "second"), second)
    }

    func testOneDisplayOrUnknownKeysUseTheMainOne() {
        XCTAssertEqual(AgentArea.visible(displays: displays, showing: nil, focused: nil), main)
        XCTAssertEqual(AgentArea.visible(displays: displays, showing: "gone", focused: "gone too"), main)
        XCTAssertEqual(AgentArea.visible(displays: [], showing: "second", focused: nil), .zero)
    }
}
