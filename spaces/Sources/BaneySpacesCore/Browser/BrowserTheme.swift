import Foundation

/// Polycarp Browser's frame, tabs, toolbar, address bar and built-in pages in the Polycarp theme in force: a theme
/// extension's manifest, which the browser reads when it starts (spec/browser.md R-B16).
public enum BrowserTheme {
    /// Each of Chromium's theme colors, the theme role it takes, and for text the color it must read on.
    static let map: [(key: String, role: String, on: String?)] = [
        ("frame", "sunken", nil), ("frame_inactive", "sunken", nil),
        ("toolbar", "surface", nil), ("omnibox_background", "background", nil), ("ntp_background", "background", nil),
        ("tab_text", "foreground", "toolbar"), ("tab_background_text", "muted", "frame"),
        ("tab_background_text_inactive", "muted", "frame_inactive"), ("bookmark_text", "foreground", "toolbar"),
        ("toolbar_text", "foreground", "toolbar"), ("toolbar_button_icon", "foreground", "toolbar"),
        ("omnibox_text", "foreground", "omnibox_background"), ("ntp_text", "foreground", "ntp_background"),
        ("ntp_link", "accent", "ntp_background"),
    ]
    /// Text under 4.5 to 1 on its color takes the first of these that reads, else black or white, whichever reads better.
    static let instead = ["muted": ["foreground", "strong"], "foreground": ["strong"], "accent": ["foreground", "strong"]]

    /// Every color, as Chromium names it.
    public static func colors(_ c: PolycarpTheme.Colors) -> [String: RGB] {
        var out: [String: RGB] = [:]
        for m in map {
            guard let ground = m.on.flatMap({ out[$0] }) else { out[m.key] = c.roles[m.role]; continue }
            let tries = ([m.role] + (instead[m.role] ?? [])).compactMap { c.roles[$0] }
            out[m.key] = tries.first { $0.contrast(with: ground) >= PolycarpTheme.minContrast } ?? ground.bestText
        }
        return out
    }

    /// The manifest for this theme as the system now shows it: `auto` takes the mode in force when it is written.
    public static func manifest(_ theme: PolycarpTheme, systemDark: Bool) -> Data {
        manifest(theme.isDark(systemDark: systemDark) ? theme.dark : theme.light)
    }

    /// The manifest for these colors, each channel rounded to the nearest of 0 to 255.
    static func manifest(_ c: PolycarpTheme.Colors) -> Data {
        let colors = colors(c).mapValues { c in
            [c.r, c.g, c.b].map { Int(($0 * 255).rounded()) }
        }
        let o: [String: Any] = ["manifest_version": 3, "name": "Polycarp theme", "version": "1.0",
                                "description": "The Polycarp theme in force, written by Polycarp.", "theme": ["colors": colors]]
        return (try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    }
}
