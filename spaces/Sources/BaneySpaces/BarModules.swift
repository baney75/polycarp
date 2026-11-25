import AppKit
import BaneySpacesCore
import SwiftUI

/// The text of a bar module in its style: the sheet's font and case over the bar's one monospace face.
enum BarWords {
    /// The bar's text size.
    static let size = 12.0

    static func text(_ words: String, _ s: ComputedStyle, _ weight: TextWeight = .regular) -> Text {
        Text(s.cased(words)).font(Styled.font(s, .mono, size, weight))
    }
}

/// Every app's status items, as many as fit from the right: macOS's as symbols in the bar's ink, an app's own as its icon.
struct StatusRow: View {
    @ObservedObject var model: TopBarModel
    let style: ComputedStyle

    private var ink: Color { style.ink(Chrome.wash(0.88)) }

    var body: some View {
        FitRow(spacing: style.gap.map { CGFloat($0) } ?? 0, fromEnd: true) {
            ForEach(model.status.indices, id: \.self) { item($0) }
        }
    }

    private func item(_ i: Int) -> some View {
        let item = model.status.indices.contains(i) ? model.status[i] : BarStatus.Item(owner: "")
        return BarButton(label: item.name, action: { model.onStatus(i) }) { glyph(item) }
    }

    /// macOS's items as symbols and a template icon in the bar's ink; any other app's icon in its own colors, since a
    /// gray one is a smudge at this size.
    @ViewBuilder private func glyph(_ item: BarStatus.Item) -> some View {
        let size = CGFloat(BarGeometry.canvas)
        if BarStatus.isBattery(item), let c = model.charge {
            BatteryGlyph(look: BarStatus.batteryLook(percent: c.percent, charging: c.charging, onPower: c.onPower, lowPower: c.lowPower),
                         ink: ink)
                .padding(.horizontal, 4)
        } else if let symbol = BarStatus.symbol(item, percent: model.charge?.percent, charging: model.charge?.charging ?? false) {
            BarSymbol(name: symbol).foregroundStyle(ink)
        } else if let icon = model.icons[item.owner], icon.isTemplate {
            Image(nsImage: icon).renderingMode(.template).resizable().interpolation(.high).frame(width: size, height: size)
                .foregroundStyle(ink)
        } else if let icon = model.icons[item.owner] {
            Image(nsImage: icon).resizable().interpolation(.high).frame(width: size, height: size)
        } else {
            Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(Chrome.muted)
        }
    }
}

/// A symbol at the bar's one size and weight.
struct BarSymbol: View {
    let name: String
    var body: some View {
        Image(systemName: name).font(.system(size: CGFloat(BarGeometry.symbol), weight: .medium)).imageScale(.medium)
    }
}

/// The front app's menus: the Apple logo, its name in semibold, then its menus a step quieter, as many as fit. Click
/// one to open it.
struct MenuRow: View {
    let items: [BarMenus.Item]
    let style: ComputedStyle
    let open: (Int) -> Void

    var body: some View {
        FitRow(spacing: style.gap.map { CGFloat($0) } ?? 0) {
            ForEach(items, id: \.index) { item in
                BarButton(width: 0, inset: CGFloat(BarGeometry.textInset), label: item.title, action: { open(item.index) }) {
                    switch item.role {
                    case .apple: BarSymbol(name: "apple.logo").foregroundStyle(style.ink(Chrome.wash(0.95)))
                    case .app: BarWords.text(item.title, style, .semibold).foregroundStyle(style.ink(Chrome.wash()))
                    case .menu: BarWords.text(item.title, style).foregroundStyle(style.ink(Chrome.wash(0.82)))
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            }
        }
    }
}
