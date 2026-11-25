import CryptoKit
import Foundation

/// The Polycarp theme in force as the browser extension draws it: `surfaces.browser` of `<config>/current/theme.json`, the
/// values `polycarp theme` writes into `browser.css`, as data. The extension builds its own CSS from them (docs/newtab.md),
/// so nothing here is a stylesheet. Anything but a sound theme file is nil: the extension draws its own look.
public struct NewTabTheme: Equatable, Sendable {
    /// Keys are the CSS names, such as `--pc-radius`.
    public let shared, light, dark: [String: String]
    /// `auto` follows the system; `light` or `dark` is fixed.
    public let mode: String

    /// As the `page` and `theme` replies carry it.
    var object: [String: Any] { ["shared": shared, "light": light, "dark": dark, "mode": mode] }

    /// Changes exactly when a value does, so the extension can tell without comparing them all.
    var stamp: String {
        SHA256.hash(data: NewTabHost.json(object)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// The theme in the file at `path`. The file itself may not be a link: a page in the browser must not be what makes
    /// Polycarp read some other file.
    public static func load(path: String?) -> NewTabTheme? {
        guard let path, case .data(let data) = PolycarpThemeFile.bytes(path: path, limit: PolycarpTheme.maxBytes, followLink: false) else { return nil }
        return parse(data)
    }

    /// Checked by the rules the app holds its own surface to (`PolycarpTheme.parse`), then only the named values are taken.
    static func parse(_ data: Data) -> NewTabTheme? {
        guard case .success(let checked) = PolycarpTheme.parse(data, surface: "browser"),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let browser = (root["surfaces"] as? [String: Any])?["browser"] as? [String: Any] else { return nil }
        var shared: [String: String] = [:]
        for v in values {
            switch (browser[v.section] as? [String: Any])?[v.key] {
            case let s as String: shared[v.name] = s
            // Reduced motion is every duration 0, as the CLI exports it and the app draws it.
            case let n as NSNumber: shared[v.name] = (v.unit == "ms" && checked.reduced ? "0" : number(n.doubleValue)) + v.unit
            default: return nil
            }
        }
        // The app checks every other value; it has no use for this one.
        guard let line = shared["--pc-line-height"].flatMap(Double.init), (1...2).contains(line) else { return nil }
        func colors(_ c: PolycarpTheme.Colors) -> [String: String] {
            var out = Dictionary(uniqueKeysWithValues: c.roles.map { ("--pc-" + $0.key, $0.value.hex.lowercased()) })
            out["--pc-on-accent"] = c.onAccent.hex.lowercased()
            return out
        }
        return NewTabTheme(shared: shared, light: colors(checked.light), dark: colors(checked.dark), mode: checked.mode.rawValue)
    }

    /// `shared_vars` in cli/src/theme.rs: each name in `browser.css` that is not a color, and where theme.json has it.
    private static let values: [(name: String, section: String, key: String, unit: String)] = [
        ("--pc-radius-small", "shape", "radius_small", "px"), ("--pc-radius", "shape", "radius", "px"),
        ("--pc-radius-large", "shape", "radius_large", "px"), ("--pc-border-width", "shape", "border_width", "px"),
        ("--pc-blur", "shape", "blur", "px"), ("--pc-shadow", "shape", "shadow", ""),
        ("--pc-density", "shape", "density", ""), ("--pc-indicator", "shape", "indicator", ""),
        ("--pc-font-display", "type", "display", ""), ("--pc-font-ui", "type", "ui", ""), ("--pc-font-mono", "type", "mono", ""),
        ("--pc-font-size", "type", "size", "px"), ("--pc-font-weight", "type", "weight", ""), ("--pc-line-height", "type", "line_height", ""),
        ("--pc-motion-fast", "motion", "fast", "ms"), ("--pc-motion-normal", "motion", "normal", "ms"),
        ("--pc-motion-slow", "motion", "slow", "ms"), ("--pc-motion-easing", "motion", "easing", ""),
        ("--pc-motion-scale-from", "motion", "scale_from", ""),
    ]

    /// A CSS number: never an exponent, and no `.0`.
    private static func number(_ v: Double) -> String {
        guard v.isFinite, abs(v) < 1_000_000 else { return "0" }
        if v == v.rounded() { return String(Int(v)) }
        var s = String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), v)
        while s.hasSuffix("0") { s.removeLast() }
        return s.hasSuffix(".") ? String(s.dropLast()) : s
    }
}
