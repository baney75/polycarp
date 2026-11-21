import Foundation

// The Polycarp look as Ghostty config keys, for the built-in terminal. The app loads your own Ghostty config first
// (~/.config/ghostty/config and Ghostty's Application Support file, as Ghostty does), then this text on top, so the
// theme's colors and monospace font win and every other key you set (keybinds, scrollback, shell integration) stays.

public struct GhosttyTheme: Equatable, Sendable {
    public var background: RGB
    public var foreground: RGB
    public var cursor: RGB
    public var cursorText: RGB
    public var selectionBackground: RGB
    public var selectionForeground: RGB
    /// Font names to try, in order; empty leaves Ghostty's (or your config's) font alone.
    public var fontFamilies: [String]
    /// Points; nil leaves the size alone.
    public var fontSize: Double?

    public init(background: RGB, foreground: RGB, cursor: RGB, cursorText: RGB, selectionBackground: RGB,
                selectionForeground: RGB, fontFamilies: [String] = [], fontSize: Double? = nil) {
        self.background = background; self.foreground = foreground; self.cursor = cursor; self.cursorText = cursorText
        self.selectionBackground = selectionBackground; self.selectionForeground = selectionForeground
        self.fontFamilies = fontFamilies; self.fontSize = fontSize
    }

    /// A Polycarp theme in the mode it draws in now: background and text, the accent as the cursor, the selection
    /// role behind selected text, and the theme's `mono` stack at the UI size scaled to a terminal's (16 px is 13 pt).
    public static func from(_ theme: PolycarpTheme, systemDark: Bool) -> GhosttyTheme {
        let c = theme.colors(systemDark: systemDark)
        func role(_ r: String) -> RGB { c.roles[r]! }
        return GhosttyTheme(background: role("background"), foreground: role("foreground"), cursor: role("accent"),
                            cursorText: c.onAccent, selectionBackground: role("selection"),
                            selectionForeground: role("foreground"), fontFamilies: monoFamilies(theme.mono),
                            fontSize: (theme.fontSize * 13 / 16).rounded())
    }

    /// The palette Polycarp draws with when no Polycarp theme is set (Settings' theme and palette). Its fonts are the
    /// system's, so the terminal keeps Ghostty's font. Nil when a role it needs is missing.
    public static func from(_ palette: Palette) -> GhosttyTheme? {
        guard let bg = palette.color("background"), let fg = palette.color("foreground"), let accent = palette.color("accent"),
              let sel = palette.color("selection") else { return nil }
        return GhosttyTheme(background: bg, foreground: fg, cursor: accent, cursorText: bg,
                            selectionBackground: sel, selectionForeground: fg)
    }

    /// The named fonts of a CSS-style monospace stack, in order. `ui-monospace` is SF Mono on macOS; the other generic
    /// names (`monospace`, `system-ui`…) say nothing Ghostty can use and are dropped. A stack that doesn't parse gives none.
    public static func monoFamilies(_ stack: String) -> [String] {
        guard let names = PolycarpTheme.parseStack(stack) else { return [] }
        let generic: Set = ["monospace", "system-ui", "-apple-system", "blinkmacsystemfont", "ui-sans-serif", "sans-serif",
                            "ui-rounded", "ui-serif", "serif", "cursive", "fantasy"]
        var out: [String] = []
        for n in names {
            let name = n.lowercased() == "ui-monospace" ? "SF Mono" : n
            if generic.contains(name.lowercased()) || out.contains(name) || !safeValue(name) { continue }
            out.append(name)
        }
        return out
    }

    /// A value that can sit inside a Ghostty config line's double quotes: no quote, backslash, line break or other
    /// control character, so a font name can never end the line and start a key of its own.
    static func safeValue(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains { $0 == "\"" || $0 == "\\" || $0.properties.generalCategory == .control }
    }

    /// The lines, as a Ghostty config file. `font-family = ""` first clears the list your own config built, so the theme's
    /// fonts replace it rather than join it as fallbacks.
    public var configText: String {
        var lines = [
            "# Written by Polycarp from its theme. Loaded after your own Ghostty config; edit the theme, not this file.",
            "background = \(background.hex)",
            "foreground = \(foreground.hex)",
            "cursor-color = \(cursor.hex)",
            "cursor-text = \(cursorText.hex)",
            "selection-background = \(selectionBackground.hex)",
            "selection-foreground = \(selectionForeground.hex)",
        ]
        let fonts = fontFamilies.filter(GhosttyTheme.safeValue)
        if !fonts.isEmpty {
            lines.append("font-family = \"\"")
            lines += fonts.map { "font-family = \"\($0)\"" }
        }
        if let fontSize, fontSize.isFinite, fontSize > 0 {
            lines.append("font-size = \(Int(min(72, max(6, fontSize))))")
        }
        return lines.joined(separator: "\n") + "\n"
    }
}
