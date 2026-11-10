import Foundation

/// Colors taken from a picture, fitted to a theme so every pair still reads. Nothing changes until the person accepts it.
public struct ThemePaletteProposal: Equatable, Sendable {
    /// The picture's strongest color, as found.
    public let found: RGB
    /// Up to five main colors of the picture, most common first, to show beside the proposal.
    public let swatches: [RGB]
    /// Path to new value: the accent, the text on it, the selection and the border, in both modes.
    public let changes: [String: ThemeValue]
}

public enum ThemeEditorPalette {
    /// The picture's main colors, most of the picture first. `pixels` can be any size; a thumbnail is plenty.
    public static func swatches(_ pixels: [RGB], count: Int = 5) -> [RGB] {
        // 16 levels a channel: near shades fall in one bin and the bin keeps their average.
        var bins: [Int: (n: Double, r: Double, g: Double, b: Double)] = [:]
        for p in pixels {
            let k = Int(p.r * 15.99) << 8 | Int(p.g * 15.99) << 4 | Int(p.b * 15.99)
            var e = bins[k] ?? (0, 0, 0, 0)
            e.n += 1; e.r += p.r; e.g += p.g; e.b += p.b
            bins[k] = e
        }
        let ranked = bins.values.sorted { $0.n > $1.n }.map { (n: $0.n, c: RGB(r: $0.r / $0.n, g: $0.g / $0.n, b: $0.b / $0.n)) }
        var out: [(n: Double, c: RGB)] = []
        for e in ranked {
            // A shade within reach of one already kept is the same color to the eye: it adds to that one.
            if let i = out.firstIndex(where: { distance($0.c, e.c) < 0.16 }) { out[i].n += e.n; continue }
            out.append(e)
        }
        return out.sorted { $0.n > $1.n }.prefix(count).map(\.c)
    }

    /// The color an accent comes from: the most common one with real color in it, weighted toward vivid. nil for a gray picture.
    public static func accentSource(_ pixels: [RGB]) -> RGB? {
        var bins: [Int: (w: Double, r: Double, g: Double, b: Double)] = [:]
        for p in pixels {
            let h = p.hsb
            guard h.s >= 0.25, h.b >= 0.2 else { continue }
            // Hue in 24 steps and two bands of strength: one hue in shade and in sun is one color.
            let k = Int(h.h * 23.99) * 2 + (h.s > 0.6 ? 1 : 0)
            // Squared, so a vivid color a tenth of the picture beats a dull one a third of it: that is the color people see.
            let w = h.s * h.s * min(1, h.b * 1.4)
            var e = bins[k] ?? (0, 0, 0, 0)
            e.w += w; e.r += p.r * w; e.g += p.g * w; e.b += p.b * w
            bins[k] = e
        }
        guard let best = bins.values.max(by: { $0.w < $1.w }), best.w > 0, best.w >= Double(pixels.count) * 0.01 else { return nil }
        return RGB(r: best.r / best.w, g: best.g / best.w, b: best.b / best.w)
    }

    /// The proposal for a theme whose colors are `light` and `dark` (by role). nil when the picture has no color to take.
    public static func propose(_ pixels: [RGB], light: [String: RGB], dark: [String: RGB]) -> ThemePaletteProposal? {
        guard let found = accentSource(pixels) else { return nil }
        var changes: [String: ThemeValue] = [:]
        for (mode, colors) in [("light", light), ("dark", dark)] {
            guard let fitted = fit(found, colors: colors, dark: mode == "dark") else { continue }
            for (role, c) in fitted { changes["\(mode).\(role)"] = .color(c) }
        }
        guard !changes.isEmpty else { return nil }
        return ThemePaletteProposal(found: found, swatches: swatches(pixels), changes: changes)
    }

    /// The accent moved toward black (light mode) or white (dark mode) until it reads as text on the page and the surface and as a
    /// mark on sunken, then the text on it, a selection tinted with it, and a border with a touch of it. Each pair the CLI checks holds.
    static func fit(_ found: RGB, colors: [String: RGB], dark: Bool) -> [String: RGB]? {
        guard let page = colors["background"], let surface = colors["surface"], let sunken = colors["sunken"],
              let fg = colors["foreground"] else { return nil }
        let toward = dark ? RGB(r: 1, g: 1, b: 1) : RGB(r: 0, g: 0, b: 0)
        // Checked as the file will hold them, in whole steps of 1/255, so rounding never drops a pair below the line.
        func q(_ c: RGB) -> RGB { RGB(hex: c.hex) ?? c }
        func reads(_ c: RGB) -> Bool {
            c.contrast(with: page) >= PolycarpTheme.minContrast && c.contrast(with: surface) >= PolycarpTheme.minContrast && c.contrast(with: sunken) >= 3
        }
        guard let accent = stride(from: 0.0, through: 1.0, by: 0.02).lazy.map({ q(toward.over(found, alpha: $0)) }).first(where: reads) else { return nil }
        // The page's own color on the accent when it reads (the built-ins do this), else the stronger of black and white.
        let onAccent = [page, fg, colors["strong"]].compactMap { $0 }.first { $0.contrast(with: accent) >= PolycarpTheme.minContrast } ?? accent.bestText
        guard onAccent.contrast(with: accent) >= PolycarpTheme.minContrast else { return nil }
        var out = ["accent": accent, "on_accent": onAccent]
        // As much of the accent in the selection as the text on it allows.
        let text = [fg, colors["strong"]].compactMap { $0 }
        if let sel = stride(from: 0.22, through: 0.06, by: -0.02).lazy.map({ q(accent.over(page, alpha: $0)) })
            .first(where: { s in text.allSatisfy { $0.contrast(with: s) >= PolycarpTheme.minContrast } }) {
            out["selection"] = sel
        }
        // Borders are not checked for contrast; a fifth of the accent keeps them quiet.
        if let border = colors["border"] { out["border"] = q(accent.over(border, alpha: 0.2)) }
        return out
    }

    static func distance(_ a: RGB, _ b: RGB) -> Double {
        ((a.r - b.r) * (a.r - b.r) + (a.g - b.g) * (a.g - b.g) + (a.b - b.b) * (a.b - b.b)).squareRoot()
    }
}
