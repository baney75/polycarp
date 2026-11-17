import AppKit
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_BORDERS=1 Polycarp --render <folder>` draws `window-borders.png`: two sample windows on the
/// theme's background, the front one focused, each with the border Settings › Appearance › Window borders draws (both
/// switches on), from the same `WindowBorderStyle` the live border windows use. With `BANEYSPACES_RENDER_POLYCARP` it
/// draws that theme.
struct BorderSample: View {
    static let size = CGSize(width: 900, height: 560)
    let look: Look
    private var style: WindowBorderStyle { WindowBorderStyle(look) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Appearance.color(look.color("background"))
            window(title: "Notes", focused: false).offset(x: 60, y: 60)
            window(title: "Terminal", focused: true).offset(x: 300, y: 170)
        }
        .frame(width: Self.size.width, height: Self.size.height)
    }

    private func window(title: String, focused: Bool) -> some View {
        let size = CGSize(width: 520, height: 320)
        let panel = style.panelFrame(CGRect(origin: .zero, size: size))
        let stroke = style.stroke(in: panel.size)
        return ZStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    ForEach(0..<3, id: \.self) { _ in Circle().fill(Appearance.color(look.color("muted"))).frame(width: 12, height: 12) }
                    Spacer()
                    Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Appearance.color(look.color("foreground")))
                    Spacer()
                }
                .padding(.horizontal, 14).frame(height: 36)
                .background(Appearance.color(look.color("sunken")))
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(0..<6, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 3).fill(Appearance.color(look.color("muted")).opacity(0.35))
                            .frame(width: CGFloat(200 + (i * 53) % 220), height: 10)
                    }
                    Spacer()
                }
                .padding(18).frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(width: size.width, height: size.height)
            .background(Appearance.color(look.color("surface")))
            .clipShape(RoundedRectangle(cornerRadius: style.radius))
            RoundedRectangle(cornerRadius: stroke.radius)
                .stroke(Appearance.color(focused ? style.focused : style.unfocused), lineWidth: style.width)
                .frame(width: stroke.rect.width, height: stroke.rect.height)
        }
        .frame(width: panel.width, height: panel.height)
    }
}
