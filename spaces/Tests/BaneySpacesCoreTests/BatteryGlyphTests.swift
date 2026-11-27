import XCTest
@testable import BaneySpacesCore

final class BatteryGlyphTests: XCTestCase {
    typealias Look = BarStatus.BatteryLook

    /// R7's case table: (name, percent, charging, on power, Low Power, look). The fill's width is the body's 20 pt
    /// inside its insets, filled to the charge.
    func testTheBatteryCaseTable() {
        let cases: [(String, Int?, Bool, Bool, Bool, Look?, Double)] = [
            ("full", 100, false, false, false, Look(fill: 1, tint: .normal, badge: .none), 20),
            ("half", 50, false, false, false, Look(fill: 0.5, tint: .normal, badge: .none), 10),
            ("5% on battery", 5, false, false, false, Look(fill: 0.05, tint: .critical, badge: .none), 1.5),
            ("10% on battery", 10, false, false, false, Look(fill: 0.1, tint: .critical, badge: .none), 2),
            ("11% on battery", 11, false, false, false, Look(fill: 0.11, tint: .normal, badge: .none), 2.2),
            ("empty", 0, false, false, false, Look(fill: 0, tint: .critical, badge: .none), 0),
            ("Low Power", 72, false, false, true, Look(fill: 0.72, tint: .lowPower, badge: .none), 14.4),
            ("Low Power at 5%", 5, false, false, true, Look(fill: 0.05, tint: .lowPower, badge: .none), 1.5),
            ("charging", 40, true, true, false, Look(fill: 0.4, tint: .normal, badge: .bolt), 8),
            ("charging in Low Power", 80, true, true, true, Look(fill: 0.8, tint: .normal, badge: .bolt), 16),
            ("charging at 5%", 5, true, true, false, Look(fill: 0.05, tint: .normal, badge: .bolt), 1.5),
            ("plugged in and full", 100, false, true, false, Look(fill: 1, tint: .normal, badge: .plug), 20),
            ("plugged in, held low", 8, false, true, false, Look(fill: 0.08, tint: .normal, badge: .plug), 1.6),
            ("over 100", 140, false, false, false, Look(fill: 1, tint: .normal, badge: .none), 20),
            ("no battery (desktop Mac)", nil, false, true, false, nil, 0),
        ]
        for (name, percent, charging, onPower, lowPower, want, width) in cases {
            let got = BarStatus.batteryLook(percent: percent, charging: charging, onPower: onPower, lowPower: lowPower)
            XCTAssertEqual(got, want, name)
            XCTAssertEqual(got?.fillWidth ?? 0, width, accuracy: 0.0001, name)
        }
    }

    /// The glyph is macOS's battery at the bar's size: a 23 by 11 body, a hairline, the fill inset 1.5 with a radius
    /// that follows the outline, and a nub centered on the body.
    func testTheGlyphHasMacOSProportions() {
        XCTAssertEqual(BatteryGlyphSpec.bodyWidth, 23)
        XCTAssertEqual(BatteryGlyphSpec.bodyHeight, 11)
        XCTAssertEqual(BatteryGlyphSpec.line, 1)
        XCTAssertEqual(BatteryGlyphSpec.radius, 3)
        XCTAssertEqual(BatteryGlyphSpec.inset, 1.5)
        XCTAssertEqual(BatteryGlyphSpec.fillRadius, 1.5)
        XCTAssertLessThan(BatteryGlyphSpec.capHeight, BatteryGlyphSpec.bodyHeight / 2)
        XCTAssertEqual(BatteryGlyphSpec.width, 25.5)
        XCTAssertLessThanOrEqual(BatteryGlyphSpec.badgeSize, BatteryGlyphSpec.bodyHeight - 2 * BatteryGlyphSpec.inset, "the badge fits the fill's height")
    }

    func testOnlyMacOSsOwnBatteryIsTheBattery() {
        XCTAssertTrue(BarStatus.isBattery(BarStatus.Item(owner: "com.apple.MenuBarAgent", identifier: "com.apple.menuextra.battery")))
        XCTAssertFalse(BarStatus.isBattery(BarStatus.Item(owner: "com.coconut.battery", label: "Battery")))
    }

    /// The outline keeps macOS's light hairline where that reads, and darkens only as far as 3:1 needs.
    func testTheOutlineIsTheLeastThatReads() {
        let white = RGB(r: 1, g: 1, b: 1), black = RGB(r: 0, g: 0, b: 0)
        XCTAssertEqual(BatteryGlyphSpec.outlineOpacity(ink: white, over: [black]), 0.38, "white on black reads at the hairline")
        let gray = RGB(r: 0.5, g: 0.5, b: 0.5)
        XCTAssertEqual(BatteryGlyphSpec.outlineOpacity(ink: gray, over: [RGB(r: 0.45, g: 0.45, b: 0.45)]), 1, "never past full ink")
        let light = RGB(hex: "#F6F3E8")!, ink = RGB(hex: "#2B2E26")!
        let a = BatteryGlyphSpec.outlineOpacity(ink: ink, inkAlpha: 0.88, over: [light])
        XCTAssertGreaterThan(a, 0.38)
        XCTAssertGreaterThanOrEqual(ink.over(light, alpha: 0.88 * a).contrast(with: light), 3)
        XCTAssertLessThan(ink.over(light, alpha: 0.88 * (a - 0.01)).contrast(with: light), 3, "the least, not more")
    }

    /// R6: in every theme in themes/, light and dark, on an island (`background`) and a solid bar (`surface`), the
    /// outline and the badge (the bar's ink, 0.88 of `foreground`) reach 3:1, and so do the fill's two tints.
    func testEveryThemeReadsAtThreeToOne() throws {
        let themes = try Self.themeColors()
        XCTAssertGreaterThanOrEqual(themes.count, 6, "every file in themes/ is read")
        for (name, modes) in themes {
            for (mode, c) in modes {
                let label = "\(name) \(mode)"
                guard let fg = c["foreground"], let bg = c["background"], let surface = c["surface"],
                      let working = c["working"], let urgent = c["urgent"] else { return XCTFail("\(label) lacks a role") }
                let backs = [bg, surface]
                let a = BatteryGlyphSpec.outlineOpacity(ink: fg, inkAlpha: 0.88, over: backs)
                XCTAssertGreaterThanOrEqual(a, BatteryGlyphSpec.leastOutline, label)
                XCTAssertLessThanOrEqual(a, 0.75, "\(label): the outline stays lighter than the fill")
                for back in backs {
                    XCTAssertGreaterThanOrEqual(fg.over(back, alpha: 0.88 * a).contrast(with: back), 3, "\(label) outline")
                    // The status row draws in 0.88 of the foreground, the battery module in 0.85: the lower holds both.
                    XCTAssertGreaterThanOrEqual(fg.over(back, alpha: 0.85).contrast(with: back), 3, "\(label) badge and fill")
                    XCTAssertGreaterThanOrEqual(working.contrast(with: back), 3, "\(label) Low Power fill")
                    XCTAssertGreaterThanOrEqual(urgent.contrast(with: back), 3, "\(label) nearly empty fill")
                }
            }
        }
    }

    /// Each theme's light and dark colors from its TOML file, with `extends` filled in from the theme it names.
    static func themeColors() throws -> [String: [String: [String: RGB]]] {
        let folder = SourceText.root.deletingLastPathComponent().appendingPathComponent("themes")
        var raw: [String: (extends: String?, modes: [String: [String: RGB]])] = [:]
        for file in try FileManager.default.contentsOfDirectory(atPath: folder.path) where file.hasSuffix(".toml") {
            let text = try String(contentsOf: folder.appendingPathComponent(file), encoding: .utf8)
            var section = "", extends: String?, modes: [String: [String: RGB]] = [:]
            for line in text.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }) {
                if line.hasPrefix("[") { section = line.trimmingCharacters(in: CharacterSet(charactersIn: "[]")); continue }
                let kv = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                guard kv.count == 2 else { continue }
                let value = kv[1].trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                if section.isEmpty, kv[0] == "extends" { extends = value }
                if section == "light" || section == "dark", let rgb = RGB(hex: value) { modes[section, default: [:]][kv[0]] = rgb }
            }
            raw[String(file.dropLast(5))] = (extends, modes)
        }
        func resolved(_ name: String, depth: Int = 0) -> [String: [String: RGB]] {
            guard let t = raw[name], depth < 8 else { return [:] }
            var base = t.extends.map { resolved($0, depth: depth + 1) } ?? [:]
            for (mode, roles) in t.modes { base[mode, default: [:]].merge(roles) { $1 } }
            return base
        }
        return Dictionary(uniqueKeysWithValues: raw.keys.map { ($0, resolved($0)) })
    }

    /// The battery's button is a whole point wide, so the items beside it stay on whole pixels at 1x, and with its
    /// digits on it counts room for "100%".
    func testTheBatteryButtonIsWholePoints() {
        XCTAssertEqual(BarGeometry.battery, 36)
        XCTAssertGreaterThan(BarGeometry.battery, BatteryGlyphSpec.width + 2 * BarGeometry.glyphSide - 0.001)
        XCTAssertEqual(BarGeometry.battery(percentAt: nil), 36)
        XCTAssertEqual(BarGeometry.battery(percentAt: 12), 36 + 34)
        XCTAssertEqual(BarGeometry.battery(percentAt: 12).rounded(), BarGeometry.battery(percentAt: 12))
    }
}
