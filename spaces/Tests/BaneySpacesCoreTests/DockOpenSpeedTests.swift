@testable import BaneySpacesCore
import Foundation
import XCTest

/// The Workspace Dock opens in under 33 ms at the p90 (two frames at 60 Hz), from the reveal to laid out and drawn.
/// On the owner's Mac, 2026-11-21, `open dock=` ran 62 to 256 ms. The bench is the app's own (`DockOpenTiming`, run
/// as `Polycarp --render` with `BANEYSPACES_RENDER_DOCK_OPEN`): the dock's real panel, model and SwiftUI view, 6
/// workspaces of 25 apps with real icons and a 21-app Background tile, and this Mac's window server and running
/// apps for the reads an open makes. CI runners are slower and shared, so they get a looser budget.
final class DockOpenSpeedTests: XCTestCase {
    static let budgetMs = ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" ? 100.0 : DockOpenPhases.budgetMs

    func testTheDockOpensWithinBudget() throws {
        // `swift test` builds the app beside the test bundle.
        let app = Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("BaneySpaces")
        guard FileManager.default.isExecutableFile(atPath: app.path) else {
            return XCTFail("no app at \(app.path): build it first (swift build)")
        }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("dock-open-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: out) }
        let p = Process()
        p.executableURL = app
        p.arguments = ["--render", out.path]
        var env = ProcessInfo.processInfo.environment
        env["BANEYSPACES_RENDER_DOCK_OPEN"] = "40"
        env["BANEYSPACES_DOCK_OPEN_BUDGET"] = String(Self.budgetMs)
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        try p.run()
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        print(text)
        XCTAssertTrue(text.contains("dock open: 40 opens, 25 apps on 6 workspaces, 21 in the background"), text)
        XCTAssertEqual(p.terminationStatus, 0, "the dock's p90 open must stay under \(Self.budgetMs) ms:\n\(text)")
    }
}

/// The trace.log line an open over budget writes, so a slow one says which phase was slow.
final class DockOpenPhasesTests: XCTestCase {
    func testAnOpenOverBudgetNamesItsSlowPhasesSlowestFirst() {
        var t = 0.0
        let phases = DockOpenPhases(now: { t })
        for (name, ms) in [("reset", 0.2), ("refresh", 4.0), ("tiles", 9.0), ("background", 26.0), ("layout", 9.0), ("draw", 14.0)] {
            t += ms
            phases.mark(name)
        }
        XCTAssertEqual(phases.slow, ["background", "draw", "tiles", "layout"])
        t += 1; phases.mark("fit")
        XCTAssertEqual(phases.line(),
                       "dock open slow: 63 ms (budget 33), slow: background, draw, tiles, layout; "
                       + "reset 0, refresh 4, tiles 9, background 26, layout 9, draw 14, fit 1")
    }

    func testAnOpenWithinBudgetWritesNothing() {
        var t = 0.0
        let phases = DockOpenPhases(now: { t })
        t = 20; phases.mark("tiles")
        t = 33; phases.mark("draw")
        XCTAssertNil(phases.line())
    }

    func testAPhaseMarkedTwiceAddsUp() {
        var t = 0.0
        let phases = DockOpenPhases(now: { t })
        t = 5; phases.mark("layout")
        t = 6; phases.mark("fit")
        t = 9; phases.mark("layout")
        XCTAssertEqual(phases.ms("layout"), 8)
        XCTAssertEqual(phases.phases.map(\.name), ["layout", "fit"])
    }

    func testPercentileIsNearestRank() {
        let v = (1...10).map(Double.init)
        XCTAssertEqual(DockOpenPhases.percentile(v, 50), 5)
        XCTAssertEqual(DockOpenPhases.percentile(v, 90), 9)
        XCTAssertEqual(DockOpenPhases.percentile([], 90), 0)
    }

    /// The live dock marks every phase and writes the line; the bench reads the same phases.
    func testTheDockTimesEachPhaseOfAnOpen() throws {
        let dock = try SourceText.code("Sources/BaneySpaces/WorkspaceDock.swift")
        for phase in ["reset", "details", "hidden", "panel", "layout", "fit", "order", "draw"] {
            XCTAssertTrue(dock.contains("phases.mark(\"\(phase)\")"), "show(on:) marks \(phase)")
        }
        for phase in ["refresh", "tiles", "background"] { XCTAssertTrue(dock.contains("phases?.mark(\"\(phase)\")"), "load marks \(phase)") }
        XCTAssertTrue(dock.contains("if let line = phases.line() { Trace.log(line) }"))
    }
}
