import AppKit
import XCTest
@testable import BaneySpacesCore

final class CalculatorTests: XCTestCase {
    private func calc(_ s: String) -> String? { Calculator.evaluate(s)?.display }

    func testArithmeticFollowsTheUsualOrder() {
        XCTAssertEqual(calc("12*7"), "84")
        XCTAssertEqual(calc("2 + 3 * 4"), "14")
        XCTAssertEqual(calc("(2 + 3) * 4"), "20")
        XCTAssertEqual(calc("2^3^2"), "512") // right to left
        XCTAssertEqual(calc("2**10"), "1024")
        XCTAssertEqual(calc("-2^2"), "-4")
        XCTAssertEqual(calc("10 / 4"), "2.5")
        XCTAssertEqual(calc("7 mod 3"), "1")
        XCTAssertEqual(calc("0.1 + 0.2"), "0.3")
        XCTAssertEqual(calc("1/3"), "0.3333333333")
        XCTAssertEqual(calc("6 × 7"), "42")
        XCTAssertEqual(calc("84 ÷ 2"), "42")
    }

    func testPercentFunctionsConstantsAndGrouping() {
        XCTAssertEqual(calc("15% * 80"), "12")
        XCTAssertEqual(calc("sqrt(16) + 1"), "5")
        XCTAssertEqual(calc("2pi"), Calculator.format(2 * Double.pi))
        XCTAssertEqual(calc("3(4+5)"), "27")
        XCTAssertEqual(calc("1,000 * 2"), "2000")
        XCTAssertEqual(calc("1_000 + 1"), "1001")
        XCTAssertEqual(calc("log(1000)"), "3")
        XCTAssertEqual(calc("2^64"), "1.844674407e+19")
    }

    /// The launcher asks on every keystroke: a bare number, a name or a half-typed sum is not a sum,
    /// so `3` still goes to workspace 3 and `1-password` still finds the app.
    func testThingsThatAreNotSumsGetNoRow() {
        for s in ["3", "-3", "(3)", "pi", "safari", "1-password", "c++", "12*", "2 +", "1/0", "7 mod 0", "ws 3",
                  "1,5 + 1", "go to 3", "apps in dock", "", "   ", "sqrt 4", "foo(2)"] {
            XCTAssertNil(Calculator.evaluate(s), s)
        }
    }

    func testUnitConversions() {
        XCTAssertEqual(calc("5 km in mi"), "3.106855961 mi")
        XCTAssertEqual(calc("5km to mi"), "3.106855961 mi")
        XCTAssertEqual(calc("212 f in c"), "100 °C")
        XCTAssertEqual(calc("0 c to f"), "32 °F")
        XCTAssertEqual(calc("1 GB in MB"), "1000 MB")
        XCTAssertEqual(calc("1 gib in mib"), "1024 MiB")
        XCTAssertEqual(calc("2 cups in ml"), "473.176473 ml")
        XCTAssertEqual(calc("6 ft as cm"), "182.88 cm")
        XCTAssertEqual(calc("5 in in cm"), "12.7 cm")
        XCTAssertEqual(calc("90 min in h"), "1.5 h")
        XCTAssertEqual(calc("2*3 ft in in"), "72 in")
        XCTAssertEqual(calc("1 lb in g"), "453.59237 g")
        XCTAssertEqual(calc("100 km/h in mph"), "62.13711922 mph")
        XCTAssertEqual(calc("1 acre in m2"), "4046.856422 m²")
        // Different kinds of quantity don't convert.
        XCTAssertNil(Calculator.evaluate("5 km in kg"))
        XCTAssertNil(Calculator.evaluate("5 km in parsecs"))
    }

    func testReturnCopiesTheNumberAlone() throws {
        let a = try XCTUnwrap(Calculator.evaluate("5 km in mi"))
        XCTAssertEqual(a.copyText, "3.106855961")
        let rows = CalculatorProvider().results(for: "12*7")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].title, "84")
        XCTAssertEqual(rows[0].action, .copy("84"))
        XCTAssertEqual(rows[0].placement, .top)
        XCTAssertEqual(CalculatorProvider().results(for: "safari"), [])
    }

    /// Copying writes to the pasteboard it's given. A private named one here: a test never touches the
    /// user's clipboard.
    func testCopyWritesTheTextAndOnlyMarksItTransientWhenAsked() {
        let pb = NSPasteboard(name: NSPasteboard.Name("polycarp-test-\(UUID().uuidString)"))
        defer { pb.releaseGlobally() }
        LauncherPasteboard.copy("84", to: pb)
        XCTAssertEqual(pb.string(forType: .string), "84")
        XCTAssertFalse(pb.types?.contains(LauncherPasteboard.transientType) ?? true)
        LauncherPasteboard.copy("hello", transient: true, to: pb)
        XCTAssertEqual(pb.string(forType: .string), "hello")
        XCTAssertTrue(pb.types?.contains(LauncherPasteboard.transientType) ?? false)
    }
}

final class LauncherProviderSeamTests: XCTestCase {
    private final class Fixed: LauncherProvider {
        let name: String
        let rows: [LauncherResult]
        init(_ name: String, _ rows: [LauncherResult]) { self.name = name; self.rows = rows }
        func results(for query: String) -> [LauncherResult] { rows }
    }

    func testTopRowsComeFirstAndEachGroupKeepsProviderOrder() {
        func row(_ id: String, _ p: LauncherResult.Placement) -> LauncherResult {
            LauncherResult(id: id, section: "S", title: id, symbol: "x", placement: p, action: .none)
        }
        let a = Fixed("a", [row("a1", .normal), row("a2", .top)])
        let b = Fixed("b", [row("b1", .top), row("b2", .normal)])
        let r = LauncherProviders.results([a, b], for: "q")
        XCTAssertEqual(r.top.map(\.id), ["a2", "b1"])
        XCTAssertEqual(r.normal.map(\.id), ["a1", "b2"])
        XCTAssertTrue(LauncherProviders.results([a, b], for: "  ").top.isEmpty)
    }

    func testTheLauncherStartsWithTheCalculator() {
        XCTAssertTrue(LauncherProviders.standard().contains { $0.name == "calculator" })
    }

    /// The launcher's model asks the providers in its main search (source check: the app target has
    /// no unit tests).
    func testTheMainSearchAsksTheProviders() throws {
        let src = try String(contentsOfFile: Self.source("Sources/BaneySpaces/Launcher.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("LauncherProviders.results(providers, for: q)"))
        XCTAssertTrue(src.contains("out += provided.top.map(providedItem)"))
    }

    /// Every provider together answers a keystroke in under 1 ms at p95 (it runs on main): an eighth of
    /// the launcher's 8 ms p90 budget per keystroke (`spec/launcher.md`, from the launcher-speed work).
    func testProvidersAnswerAKeystrokeQuickly() {
        let providers = LauncherProviders.standard()
        let queries = ["s", "sa", "saf", "safari", "12*7", "5 km in mi", "2^10 + sqrt(2)", "1 gb in mb", "go to 3", "workspace 4",
                       "move 3", "fill", ";date", "wc hello world"]
        var times: [Double] = []
        for _ in 0..<50 {
            for q in queries {
                let t = DispatchTime.now().uptimeNanoseconds
                _ = LauncherProviders.results(providers, for: q)
                times.append(Double(DispatchTime.now().uptimeNanoseconds - t) / 1000)
            }
        }
        times.sort()
        let p95 = times[times.count * 95 / 100]
        print("launcher providers: p95 \(String(format: "%.1f", p95)) µs per keystroke, \(providers.count) providers, \(times.count) runs")
        XCTAssertLessThan(p95, 1000)
    }

    static func source(_ rel: String) -> String {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(rel).path
    }
}
