import Foundation

/// A pair of colors in a draft theme that is too faint to read: WCAG AA, 4.5:1 for text and 3:1 for marks.
public struct ThemeContrastWarning: Equatable, Sendable, Identifiable {
    /// "light" or "dark".
    public let mode: String
    /// The role drawn on top, such as "muted", or a surface the Mac app draws, such as "panel".
    public let text: String
    /// The role underneath, or nil where the app mixes its own fill.
    public let fill: String?
    public let ratio: Double
    public let needed: Double

    public var id: String { "\(mode).\(text).\(fill ?? "")" }

    /// The values to change to fix it.
    public var paths: [String] {
        if let fill { return ["\(mode).\(text)", "\(mode).\(fill)"] }
        return ["\(mode).foreground"]
    }

    /// "Light: muted on sunken is 3.12:1. AA needs 4.5:1 for text."
    public var message: String {
        let m = mode.prefix(1).uppercased() + mode.dropFirst()
        let what = needed < PolycarpTheme.minContrast ? "for marks" : "for text"
        let r = String(format: "%.2f", (ratio * 100 + 1e-9).rounded(.down) / 100), n = needed == needed.rounded() ? String(Int(needed)) : String(needed)
        if let fill { return "\(m): \(label(text)) on \(label(fill)) is \(r):1. AA needs \(n):1 \(what)." }
        return "\(m): text on the Mac app's \(text) is \(r):1. AA needs \(n):1."
    }

    private func label(_ role: String) -> String { role.replacingOccurrences(of: "_", with: " ") }
}

public enum ThemeEditorContrast {
    /// Every pair the CLI checks (`pairs()` in cli/src/theme.rs) for one mode's colors, worst first. A role that is missing is skipped.
    public static func warnings(_ colors: [String: RGB], mode: String) -> [ThemeContrastWarning] {
        var out: [ThemeContrastWarning] = []
        for (text, fill, min) in PolycarpTheme.cliPairs {
            guard let a = colors[text], let b = colors[fill] else { continue }
            let r = a.contrast(with: b)
            // The same test the CLI makes on Save, so the editor never passes a pair the CLI refuses or the other way.
            if r < min { out.append(ThemeContrastWarning(mode: mode, text: text, fill: fill, ratio: r, needed: min)) }
        }
        return out.sorted { $0.ratio / $0.needed < $1.ratio / $1.needed }
    }

    /// The CLI's pairs in both modes, then the fills only the Mac app draws (which the app would refuse the theme over).
    public static func warnings(_ draft: ThemeDraft) -> [ThemeContrastWarning] {
        var out = warnings(draft.colors("light"), mode: "light") + warnings(draft.colors("dark"), mode: "dark")
        guard out.isEmpty, let theme = draft.preview else { return out }
        for (mode, colors, dark) in [("light", theme.light, false), ("dark", theme.dark, true)] {
            let look = Look(theme: PolycarpTheme.carrier, spec: theme.spec, palette: Palette(name: "polycarp", isDark: dark, colors: colors.roles),
                            polycarp: theme.name, families: nil)
            for p in look.textPairs(accent: colors.roles["accent"]!) {
                let r = p.text.contrast(with: p.fill)
                if r < PolycarpTheme.minContrast, !out.contains(where: { $0.mode == mode && $0.text == p.name }) {
                    out.append(ThemeContrastWarning(mode: mode, text: p.name, fill: nil, ratio: r, needed: PolycarpTheme.minContrast))
                }
            }
        }
        return out
    }
}
