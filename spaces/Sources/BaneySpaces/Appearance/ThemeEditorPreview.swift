import AppKit
import BaneySpacesCore
import SwiftUI

/// The draft drawn the way the Mac app draws it, in one mode: the top bar's workspace numbers, a panel with a selected row,
/// buttons, a settings row and status colors. Every color, corner, border and size comes from the draft,
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
            topBar
            panel
            HStack(spacing: 8) { buttons; Spacer(minLength: 0) }
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

    /// The top bar's workspaces (`TopBarView.numbers`), in the theme's own font: workspaces 1, 2 and 4 with windows, 2 the one you're
    /// on, marked as the theme marks it (`BarWorkspaces.marker`: an accent line, or an accent block for `number-block`),
    /// the others muted, and the hour on the right, over the theme's background with its edge below.
    private var topBar: some View {
        let accent = c("accent")
        let marker = BarWorkspaces.marker(look.spec.indicator)
        return HStack(spacing: 10) {
            ForEach(BarWorkspaces.shown(occupied: [1, 4], current: 2), id: \.self) { n in
                let on = n == 2
                if on, marker == .block {
                    Text("\(n)").font(font(11, bold: true)).foregroundStyle(Appearance.color(look.text(onAccent: look.color("accent"))))
                        .padding(.horizontal, 4)
                        .background(Rectangle().fill(accent))
                } else {
                    Text("\(n)").font(font(11, bold: on)).foregroundStyle(c("foreground").opacity(on ? 1 : 0.5))
                        .overlay(alignment: .bottom) {
                            if on { Rectangle().fill(accent).frame(height: 2).offset(y: 3) }
                        }
                }
            }
            Spacer(minLength: 0)
            Text("9:12").font(font(11)).foregroundStyle(c("foreground"))
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(c("background"))
        .overlay(alignment: .bottom) { Rectangle().fill(c("border")).frame(height: max(1, CGFloat(theme.borderWidth))) }
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

    private var settingsRow: some View {
        let box = style(.settingsCallout)
        let shape = RoundedRectangle(cornerRadius: CGFloat(box.radius), style: .continuous)
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Show the Top Bar").font(font(11)).foregroundStyle(c("foreground"))
                Text("Across the top of every screen").font(font(9)).foregroundStyle(c("muted"))
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
