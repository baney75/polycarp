import CoreGraphics
import ImageIO
import XCTest
@testable import BaneySpacesCore

/// The app icons in the theme's colors (spec/themes.md, "The icons").
final class ThemeIconTests: XCTestCase {
    private func hex(_ s: String) -> RGB { RGB(hex: s)! }

    func testNoThemeOrNoColorsIsTheBrandsGreenIcon() {
        XCTAssertEqual(ThemeIcon.colors(nil, systemDark: false), ThemeIcon.brand)
        XCTAssertEqual(ThemeIcon.colors(nil, systemDark: true), ThemeIcon.brand)
        XCTAssertEqual(ThemeIcon.colors(roles: [:], onAccent: nil), ThemeIcon.brand)
        XCTAssertEqual(ThemeIcon.brand.background.hex, "#59693F")
        XCTAssertEqual(ThemeIcon.brand.mark.hex, "#F6F3E8")
    }

    func testTheAccentWithItsTextComesFirstAndAPairThatDoesNotReadIsPassedOver() {
        let plum = ["accent": hex("#6B3F69"), "surface": hex("#FBF6FA"), "foreground": hex("#2E2330")]
        XCTAssertEqual(ThemeIcon.colors(roles: plum, onAccent: hex("#FBF6FA")),
                       .init(background: hex("#6B3F69"), mark: hex("#FBF6FA")))
        // Text on the accent too close to it: the accent goes on the surface instead.
        XCTAssertEqual(ThemeIcon.colors(roles: plum, onAccent: hex("#7A4F78")),
                       .init(background: hex("#FBF6FA"), mark: hex("#6B3F69")))
        // A pale accent: the text on the surface.
        let pale = ["accent": hex("#EDE6EC"), "surface": hex("#FBF6FA"), "foreground": hex("#2E2330")]
        XCTAssertEqual(ThemeIcon.colors(roles: pale, onAccent: hex("#F4EEF3")),
                       .init(background: hex("#FBF6FA"), mark: hex("#2E2330")))
        // Nothing reads: the brand's.
        XCTAssertEqual(ThemeIcon.colors(roles: ["accent": hex("#777777"), "surface": hex("#808080")], onAccent: hex("#888888")),
                       ThemeIcon.brand)
    }

    func testEveryThemeInThemesHasAMarkThatReadsInBothModes() throws {
        let themes = try BuiltInThemes.all()
        XCTAssertGreaterThanOrEqual(themes.count, 6)
        for (name, modes) in themes {
            for (mode, roles) in modes {
                XCTAssertNotNil(roles["accent"], "\(name) \(mode)")
                let icon = ThemeIcon.colors(roles: roles, onAccent: roles["on_accent"])
                XCTAssertGreaterThanOrEqual(icon.background.contrast(with: icon.mark), ThemeIcon.minimumContrast, "\(name) \(mode)")
                // Taken from the theme, not the fallback.
                XCTAssertTrue([roles["accent"], roles["surface"]].contains(icon.background), "\(name) \(mode)")
            }
        }
        // The default theme's light icon is the one Polycarp ships.
        let polycarp = try XCTUnwrap(themes["polycarp"]?["light"])
        XCTAssertEqual(ThemeIcon.colors(roles: polycarp, onAccent: polycarp["on_accent"]), ThemeIcon.brand)
    }

    /// A theme as `polycarp theme set` writes it: its accent and the text on it, in the mode in force.
    func testAThemeFileGivesItsAccentAndTheTextOnIt() throws {
        let theme = try PolycarpTheme.parse(Data(PolycarpFixtures.still_water.utf8)).get()
        XCTAssertEqual(ThemeIcon.colors(theme, systemDark: false), .init(background: hex("#3F6B6A"), mark: hex("#F1F5F5")))
        XCTAssertEqual(ThemeIcon.colors(theme, systemDark: true), .init(background: hex("#A5CFCB"), mark: hex("#12201F")))
    }

    /// The pixel at (x, y), counted from the top left, as hex.
    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return String(format: "#%02X%02X%02X/%d", bytes[0], bytes[1], bytes[2], bytes[3])
    }

    func testTheIconIsTheBackgroundSquareWithTheMarkOnItAndClearAroundIt() throws {
        let colors = ThemeIcon.Colors(background: hex("#6B3F69"), mark: hex("#FBF6FA"))
        let image = try XCTUnwrap(ThemeIcon.image(colors, pixels: 1024))
        XCTAssertEqual(pixel(image, 20, 20), "#000000/0", "the margin is clear")
        XCTAssertEqual(pixel(image, 130, 512), "#6B3F69/255", "inside the square, left of the mark")
        // The big olive's middle: (40, 44) in the mark's box.
        XCTAssertEqual(pixel(image, 162 + 40 * 700 / 64, 162 + 44 * 700 / 64), "#FBF6FA/255")
        // A leaf, top right: (50, 10).
        XCTAssertEqual(pixel(image, 162 + 50 * 700 / 64, 162 + 10 * 700 / 64), "#FBF6FA/255")
        // Small sizes draw the simpler mark, whose olive sits at (29, 52).
        let small = try XCTUnwrap(ThemeIcon.image(colors, pixels: 32))
        let olive = (x: Int((162 + 29 * 700 / 64.0) / 32), y: Int((162 + 52 * 700 / 64.0) / 32))
        XCTAssertEqual(pixel(small, olive.x, olive.y), "#FBF6FA/255")
    }

    func testTheBrowsersIconFileIsWrittenReplacedAndRemovedOnlyWhenItChanges() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("browser-icon-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("browser-theme/icon.icns")
        XCTAssertFalse(ThemeIcon.syncFile(nil, at: file), "no theme and no file: nothing to build")
        XCTAssertTrue(ThemeIcon.syncFile(Data("plum".utf8), at: file))
        XCTAssertEqual(try Data(contentsOf: file), Data("plum".utf8))
        XCTAssertFalse(ThemeIcon.syncFile(Data("plum".utf8), at: file), "the same icon: no new build")
        XCTAssertTrue(ThemeIcon.syncFile(Data("teal".utf8), at: file))
        XCTAssertEqual(try Data(contentsOf: file), Data("teal".utf8))
        XCTAssertTrue(ThemeIcon.syncFile(nil, at: file))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testTheIcnsHoldsEverySizeAsAPngOfThatSize() throws {
        let data = try XCTUnwrap(ThemeIcon.icns(ThemeIcon.brand))
        XCTAssertEqual(String(decoding: data.prefix(4), as: UTF8.self), "icns")
        func u32(_ at: Int) -> Int { data[at..<at + 4].reduce(0) { $0 << 8 | Int($1) } }
        XCTAssertEqual(u32(4), data.count)
        var at = 8, seen: [String] = []
        while at < data.count {
            let type = String(decoding: data[at..<at + 4], as: UTF8.self), length = u32(at + 4)
            let png = data[(at + 8)..<(at + length)]
            let source = try XCTUnwrap(CGImageSourceCreateWithData(Data(png) as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil), type)
            let want = ThemeIcon.icnsTypes.first { $0.0 == type }!.1
            XCTAssertEqual([image.width, image.height], [want, want], type)
            seen.append(type)
            at += length
        }
        XCTAssertEqual(seen, ThemeIcon.icnsTypes.map(\.0))
        // macOS reads it as an icon file.
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        XCTAssertGreaterThanOrEqual(CGImageSourceGetCount(source), 5)
    }
}

/// The colors of the themes in the repository's `themes/`, read from their TOML with `extends` and
/// `[surface.spaces.*]` applied, as `polycarp theme` does for these keys. Only `key = "#rrggbb"` lines are read.
enum BuiltInThemes {
    static var folder: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../themes").standardized
    }

    typealias Modes = [String: [String: RGB]]

    static func all() throws -> [String: Modes] {
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasSuffix(".toml") }
        var raw: [String: (extends: String?, sections: [String: [String: RGB]])] = [:]
        for file in names {
            let text = try String(contentsOf: folder.appendingPathComponent(file), encoding: .utf8)
            var section = "", extends: String?, sections: [String: [String: RGB]] = [:]
            for line in text.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }) {
                if line.hasPrefix("[") { section = String(line.dropFirst().dropLast()); continue }
                let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                guard parts.count == 2 else { continue }
                // The text between the first two quotes; a comment after them is left out.
                let quoted = parts[1].split(separator: "\"", omittingEmptySubsequences: false)
                guard quoted.count >= 3 else { continue }
                let value = String(quoted[1])
                if section.isEmpty, parts[0] == "extends" { extends = value }
                if let color = RGB(hex: value) { sections[section, default: [:]][parts[0]] = color }
            }
            raw[String(file.dropLast(5))] = (extends, sections)
        }
        func resolve(_ name: String, depth: Int = 0) -> Modes {
            guard let theme = raw[name], depth < 9 else { return [:] }
            var modes = theme.extends.map { resolve($0, depth: depth + 1) } ?? [:]
            for mode in ["light", "dark"] {
                for key in [mode, "surface.spaces.\(mode)"] {
                    modes[mode, default: [:]].merge(theme.sections[key] ?? [:]) { $1 }
                }
            }
            return modes
        }
        return Dictionary(uniqueKeysWithValues: raw.keys.map { ($0, resolve($0)) })
    }
}
