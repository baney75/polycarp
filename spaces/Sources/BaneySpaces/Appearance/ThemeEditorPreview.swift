import AppKit
import BaneySpacesCore
import SwiftUI

/// The draft drawn the way the Mac app draws it, in one mode: a dock with its workspace marks, a panel with a selected row,
/// buttons, a settings row, status colors and the agent cursor. Every color, corner, border and size comes from the draft,
/// not from the theme the app is using now.
struct ThemeEditorPreview: View {
    let theme: PolycarpTheme
    let dark: Bool

    private var look: Look { theme.look(systemDark: dark) }
    private func c(_ role: String) -> Color { Appearance.color(look.color(role)) }
    private func style(_ s: Surface) -> SurfaceStyle { SurfaceStyle.make(s, theme: look.theme, spec: look.spec) }
    private var square: Bool { look.spec.radius.row == 0 }

    /// The theme's own UI font where this Mac has it, at its own size and weight.
    private func font(_ size: CGFloat, bold: Bool = false) -> Font {
        let scaled = size * CGFloat(theme.fontSize) / 15
        let weight: Font.Weight = bold ? .semibold : theme.fontWeight >= 600 ? .semibold : theme.fontWeight >= 500 ? .medium
            : theme.fontWeight < 400 ? .light : .regular
        if let name = look.fontFamilies?.first(where: { NSFont(name: $0, size: 12) != nil }) {
            return Font.custom(name, size: scaled).weight(weight)
        }
        return Font.system(size: scaled, weight: weight)
    }

    var body: some View {
        let page = style(.settingsCallout)
        VStack(alignment: .leading, spacing: 12) {
            dock
            panel
            HStack(spacing: 8) { buttons; Spacer(minLength: 0); cursor }
            settingsRow
            statuses
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(c("background"))
        .clipShape(RoundedRectangle(cornerRadius: CGFloat(page.radius), style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CGFloat(page.radius), style: .continuous)
            .strokeBorder(c("border"), lineWidth: max(1, CGFloat(theme.borderWidth))))
        .environment(\.colorScheme, dark ? .dark : .light)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(dark ? "Dark" : "Light") preview of \(theme.title)")
    }

    // MARK: Surfaces

    /// Four workspaces, the second current, each with its mark in the theme's indicator.
    private var dock: some View {
        let bar = style(.dockBar), tile = style(.dockTile)
        let s: CGFloat = 0.62
        let side = CGFloat(tile.tile) * s
        return HStack(spacing: CGFloat(bar.gap) * s) {
            ForEach(1...4, id: \.self) { n in
                let current = n == 2
                let tint = n == 2 ? look.color("accent") : look.color(["done", "working", "accent", "urgent"][n - 1])
                let shape = RoundedRectangle(cornerRadius: CGFloat(tile.radius) * s, style: .continuous)
                VStack(spacing: 3) {
                    shape.fill(current ? Appearance.color(tint).opacity(0.3) : c("foreground").opacity(0.08))
                        .overlay(shape.strokeBorder(Appearance.color(look.color(current ? tile.focusedBorderRole : tile.borderRole))
                            .opacity(current ? 1 : (tile.borderOpacity ?? 0.25)),
                                                    lineWidth: CGFloat(current ? tile.focusedBorderWidth : tile.borderWidth)))
                        .overlay(windows(n).padding(side * 0.18))
                        .frame(width: side, height: side)
                    mark(n, tint: Appearance.color(tint), current: current)
                }
            }
        }
        .padding(CGFloat(bar.padding) * s)
        .background(PanelBackground(surface: .dockBar, look: look, scale: s))
        .frame(maxWidth: .infinity)
    }

    private func windows(_ n: Int) -> some View {
        let r = CGFloat(style(.dockChip).radius) * 0.5
        return VStack(spacing: 2) {
            ForEach(0..<(n % 3 + 1), id: \.self) { _ in
                RoundedRectangle(cornerRadius: r, style: .continuous).fill(c("surface")).frame(height: 5)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private func mark(_ n: Int, tint: Color, current: Bool) -> some View {
        let w = max(1, CGFloat(theme.borderWidth))
        switch look.spec.indicator {
        case .dot:
            Text("\(n)").font(font(9, bold: true)).foregroundStyle(current ? Appearance.color(look.text(onAccent: look.color("accent"))) : c("muted"))
                .frame(minWidth: 15, minHeight: 12)
                .background(Capsule().fill(current ? tint : Color.clear))
        case .numberBlock:
            Text("\(n)").font(font(9, bold: true)).foregroundStyle(current ? c("background") : tint)
                .frame(minWidth: 15, minHeight: 12)
                .background(Rectangle().fill(current ? tint : Color.clear))
                .overlay(Rectangle().strokeBorder(tint, lineWidth: w))
        case .bar:
            VStack(spacing: 1) {
                Text("\(n)").font(font(9, bold: true)).foregroundStyle(current ? c("foreground") : tint)
                Rectangle().fill(current ? tint : Color.clear).frame(width: 12, height: max(2, w))
            }
        }
    }

    /// The launcher: a search line and three results, the second selected.
    private var panel: some View {
        let row = style(.launcherRow)
        let r = CGFloat(row.radius)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(font(10)).foregroundStyle(c("muted"))
                Text("Search apps and files").font(font(11)).foregroundStyle(c("muted"))
                Spacer(minLength: 0)
                Text("⌘K").font(font(9, bold: true)).foregroundStyle(c("muted"))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: CGFloat(style(.launcherKey).radius), style: .continuous).fill(c("sunken")))
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: r, style: .continuous).fill(c("sunken")))
            ForEach(Array(["Notes", "Terminal", "Calendar"].enumerated()), id: \.offset) { i, name in
                HStack(spacing: 7) {
                    RoundedRectangle(cornerRadius: r * 0.6, style: .continuous).fill(c(["accent", "done", "working"][i]).opacity(0.85))
                        .frame(width: 14, height: 14)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(name).font(font(11, bold: i == 1)).foregroundStyle(c(i == 1 ? "strong" : "foreground"))
                        Text(i == 1 ? "Workspace 2" : "Application").font(font(9)).foregroundStyle(c("muted"))
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: r, style: .continuous).fill(i == 1 ? c("selection") : Color.clear))
            }
        }
        .padding(CGFloat(style(.launcherPanel).padding) * 0.5)
        .background(PanelBackground(surface: .launcherPanel, look: look, scale: 0.7))
    }

    private var buttons: some View {
        let w = max(1, CGFloat(theme.borderWidth))
        return HStack(spacing: 6) {
            Text("Save").font(font(11, bold: true)).foregroundStyle(Appearance.color(look.text(onAccent: look.color("accent"))))
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(ThemedPreviewPill(square: square).fill(c("accent")))
            Text("Cancel").font(font(11)).foregroundStyle(c("foreground"))
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(ThemedPreviewPill(square: square).fill(c("surface")))
                .overlay(ThemedPreviewPill(square: square).strokeBorder(c("border"), lineWidth: w))
        }
    }

    /// The agent cursor on this page. Its colors are its own, never the theme's, so the swatch shows how it reads here.
    private var cursor: some View {
        let path = Path(CursorGlyphs.path(CursorTheme.standard.glyph, size: 18))
        let status = CursorPalette.status(.working)
        let white = RGB(r: 1, g: 1, b: 1)
        return HStack(alignment: .top, spacing: 2) {
            path.fill(Appearance.color(status))
                .overlay(path.stroke(Appearance.color(white), lineWidth: 1.5))
                .frame(width: 18, height: 18)
            Text("Claude").font(font(9, bold: true)).foregroundStyle(Appearance.color(white))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Capsule().fill(Appearance.color(status)))
                .offset(y: 10)
        }
        .frame(height: 30, alignment: .top)
        .accessibilityLabel("Agent cursor")
    }

    private var settingsRow: some View {
        let box = style(.settingsCallout)
        let shape = RoundedRectangle(cornerRadius: CGFloat(box.radius), style: .continuous)
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Show the Workspace Dock").font(font(11)).foregroundStyle(c("foreground"))
                Text("At the bottom of every screen").font(font(9)).foregroundStyle(c("muted"))
            }
            Spacer(minLength: 0)
            ZStack(alignment: .trailing) {
                ThemedPreviewPill(square: square).fill(c("accent")).frame(width: 26, height: 15)
                ThemedPreviewPill(square: square).fill(Appearance.color(look.text(onAccent: look.color("accent")))).frame(width: 11, height: 11).padding(2)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(shape.fill(c("surface")))
        .overlay(shape.strokeBorder(c("border"), lineWidth: max(1, CGFloat(theme.borderWidth))))
    }

    private var statuses: some View {
        HStack(spacing: 10) {
            ForEach([("urgent", "Needs you"), ("working", "Working"), ("done", "Done")], id: \.0) { role, label in
                HStack(spacing: 4) {
                    ThemedPreviewPill(square: square).fill(c(role)).frame(width: 7, height: 7)
                    Text(label).font(font(9.5, bold: true)).foregroundStyle(c(role))
                }
            }
            Spacer(minLength: 0)
            Text("Accent link").font(font(9.5)).underline().foregroundStyle(c("accent"))
        }
    }
}

/// A capsule, or a rectangle where the draft's corners are square (the app's `ThemedPill` reads the theme in use).
struct ThemedPreviewPill: InsettableShape {
    let square: Bool
    var inset: CGFloat = 0
    func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: inset, dy: inset)
        return square ? Rectangle().path(in: r) : Capsule().path(in: r)
    }
    func inset(by amount: CGFloat) -> ThemedPreviewPill { ThemedPreviewPill(square: square, inset: inset + amount) }
}
