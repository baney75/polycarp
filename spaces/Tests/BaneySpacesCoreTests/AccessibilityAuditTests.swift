import BaneySpacesCore
import Foundation
import XCTest

/// Gap X4: every control has a role and a name VoiceOver reads, and Reduce Motion makes motion instant.
final class AccessibilityAuditTests: XCTestCase {
    private typealias N = AXAudit.Node

    func testAButtonWithNoNameIsFound() {
        let tree = N(role: "AXGroup", children: [N(role: "AXButton", label: "Go to workspace 2"), N(role: "AXButton")])
        let r = AXAudit.audit(tree, surface: "dock.png")
        XCTAssertEqual(r.controls, 2)
        XCTAssertEqual(r.findings.map(\.description), ["dock.png: AXGroup > AXButton: no name"])
    }

    func testASymbolNameIsNoName() {
        let r = AXAudit.audit(N(role: "AXButton", label: "xmark.circle.fill"), surface: "launcher.png")
        XCTAssertEqual(r.findings.first?.why, "named only by its symbol, \"xmark.circle.fill\"")
        XCTAssertNil(AXAudit.name(N(role: "AXButton", label: "gearshape.2")))
        XCTAssertEqual(AXAudit.name(N(role: "AXButton", label: "Settings…")), "Settings…")
    }

    func testATitleOrPlaceholderNames() {
        XCTAssertEqual(AXAudit.name(N(role: "AXCheckBox", label: "", title: "Open at login")), "Open at login")
        XCTAssertEqual(AXAudit.name(N(role: "AXTextField", placeholder: "Search apps, files and the web")), "Search apps, files and the web")
        XCTAssertNil(AXAudit.name(N(role: "AXTextField", label: "  ")))
    }

    func testTextAndPicturesNeedNoName() {
        let tree = N(role: "AXGroup", children: [N(role: "AXStaticText"), N(role: "AXImage"), N(role: "AXGroup")])
        XCTAssertEqual(AXAudit.audit(tree, surface: "hud.png").controls, 0)
        XCTAssertTrue(AXAudit.audit(tree, surface: "hud.png").findings.isEmpty)
    }

    /// A scroll bar's arrows and pages are AppKit's, named by subrole; a switch beside its shown label is ours.
    func testAScrollBarsPartsAreSkippedButASwitchIsNot() {
        let bar = N(role: "AXScrollBar", children: [N(role: "AXButton"), N(role: "AXButton"), N(role: "AXValueIndicator")])
        let tree = N(role: "AXScrollArea", children: [bar, N(role: "AXStaticText"), N(role: "AXCheckBox")])
        let r = AXAudit.audit(tree, surface: "setup-launcher.png")
        XCTAssertEqual(r.controls, 1)
        XCTAssertEqual(r.findings.map(\.path), ["AXScrollArea > AXCheckBox"])
    }

    func testEveryKindOfControlCounts() {
        for role in ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXTextField", "AXColorWell", "AXLink"] {
            XCTAssertEqual(AXAudit.audit(N(role: role), surface: "s").findings.count, 1, role)
        }
    }

    /// The render runs the audit on every shot it saves and on each Settings pane at full height, and exits with its verdict.
    func testTheRenderAuditsEverySurface() throws {
        let render = try Repo.code("Sources/BaneySpaces/Render.swift")
        XCTAssertTrue(render.contains("AccessibilityAudit.record(host, name)"))
        XCTAssertTrue(render.contains("return AccessibilityAudit.finish(into: folder)"))
        XCTAssertTrue(render.contains("full height"))
        XCTAssertTrue(render.contains("AccessibilityAudit.start()"), "without it SwiftUI builds no tree offscreen and every surface reads 0 controls")
    }

    /// Under Reduce Motion a fade or slide takes no time and a hover grows at once: every duration goes through
    /// `Chrome.duration` or `DockMotion`, never a number of its own. The agent spinner keeps turning, as macOS's own do.
    func testNoAnimationIgnoresReduceMotion() throws {
        let literal = try NSRegularExpression(pattern: #"duration\s*=\s*[0-9.]+"#)
        var found: [String] = []
        let base = Repo.root.appendingPathComponent("Sources/BaneySpaces")
        for case let url as URL in FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil)! where url.pathExtension == "swift" {
            let rel = String(url.path.dropFirst(Repo.root.path.count + 1))
            for (i, line) in try Repo.code(rel).split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let s = String(line)
                guard literal.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil else { continue }
                if rel.hasSuffix("WorkspaceDock.swift"), s.contains("a.duration = 1") { continue }   // the agent spinner's turn
                found.append("\(rel):\(i + 1): \(s.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertEqual(found, [], found.joined(separator: "\n"))
        let dock = try Repo.code("Sources/BaneySpaces/WorkspaceDock.swift")
        XCTAssertTrue(dock.contains("let spring: Animation? = Chrome.reduceMotion ? nil : self.spring"), "HoverScale")
    }
}
