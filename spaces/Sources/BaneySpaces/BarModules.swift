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

/// A number for each workspace with windows and the one you're on (`BarWorkspaces.shown`), each in a slot of one size,
/// with one marker that slides to the one you're on (`BarWorkspaces.marker`). Click a number to go there, or turn the
/// wheel over them for the one before or after.
/// The sheet's `bar .workspace` (with `.current` and `:hover`) styles each number; a background or line it sets for
/// `.current` is the marker in place of this one, and the module's `gap` spaces them.
struct WorkspaceStrip: View {
    let shown: [Int]
    let here: Int
    /// What the other displays show, which the wheel passes over.
    let elsewhere: Set<Int>
    let style: ComputedStyle
    let region: StyleBook.Region
    let book: StyleBook
    let pick: (Int) -> Void
    @Namespace private var space
    @State private var over: Int?
    @State private var wheel = BarScroll()

    private var marker: BarWorkspaces.Marker? {
        guard shown.contains(here) else { return nil }
        let hover = over == here
        return BarWorkspaces.marker(Chrome.spec.indicator, current: book.workspace(in: region, current: true, hover: hover),
                                    other: book.workspace(in: region, current: false, hover: hover))
    }

    var body: some View {
        HStack(spacing: style.gap.map { CGFloat($0) } ?? 0) {
            ForEach(shown, id: \.self) { n in number(n) }
        }
        .background { if let marker, marker != .underline { mark(marker) } }
        .overlay { if marker == .underline { mark(.underline).allowsHitTesting(false) } }
        .animation(Chrome.reduceMotion ? nil : Chrome.spring(0.26, damping: 0.84), value: here)
        .background {
            PointerArea(onScroll: { event in
                let way = wheel.step(Double(event.scrollingDeltaY), across: Double(event.scrollingDeltaX),
                                     precise: event.hasPreciseScrollingDeltas, phased: !event.phase.isEmpty,
                                     began: event.phase.contains(.began), momentum: !event.momentumPhase.isEmpty, at: event.timestamp)
                if let n = BarScroll.target(from: here, way: way, shown: shown, elsewhere: elsewhere) { pick(n) }
            }) { _ in }
        }
    }

    @ViewBuilder private func number(_ n: Int) -> some View {
        let on = n == here
        let w = book.workspace(in: region, current: on, hover: over == n)
        if !w.isHidden {
            BarButton(width: CGFloat(BarGeometry.number), label: on ? "Workspace \(n), you're here" : "Workspace \(n)",
                      help: "Workspace \(n)", action: { pick(n) }) {
                BarWords.text("\(n)", w, on ? .semibold : .regular)
                    .monospacedDigit()
                    .foregroundStyle(w.ink(ink(n, on: on)))
                    .modifier(StyledText(style: w))
                    .modifier(StyledBox(style: w))
            }
            .background { PointerArea { inside in if inside { over = n } else if over == n { over = nil } } }
            .matchedGeometryEffect(id: n, in: space)
        }
    }

    private func ink(_ n: Int, on: Bool) -> Color {
        if on { return marker == .block ? Chrome.onAccent : Chrome.wash() }
        return over == n ? Chrome.wash() : Chrome.wash(0.62)
    }

    /// One marker for the strip, so it slides. The sheet's own face for the current number takes its place.
    private func mark(_ kind: BarWorkspaces.Marker) -> some View {
        WorkspaceMarker(kind: kind).matchedGeometryEffect(id: here, in: space, isSource: false)
    }
}

private struct WorkspaceMarker: View {
    let kind: BarWorkspaces.Marker
    @Environment(\.barFace) private var face

    var body: some View {
        Group {
            switch kind {
            case .pill: BarShape.face.fill(Chrome.accent.opacity(0.26)).frame(height: face)
            case .block: Rectangle().fill(Chrome.accent).frame(height: min(face, 18)).padding(.horizontal, 3)
            case .underline: Capsule().fill(Chrome.accent).frame(width: 12, height: 2).frame(height: face, alignment: .bottom)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Every app's status items. macOS's own stay in view as symbols in the bar's ink; your apps' fold into a drawer behind
/// a chevron (`bar.tray` drawer) that opens while the pointer is on it, or until you click the chevron again. With
/// `bar.tray` row they are all in one row, as many as fit from the right.
struct StatusRow: View {
    @Environment(\.barBoxed) private var boxed
    @ObservedObject var model: TopBarModel
    let style: ComputedStyle
    /// The room the drawer may take when it opens.
    let room: Double
    @State private var over = false
    @State private var open = false

    private var gap: CGFloat { style.gap.map { CGFloat($0) } ?? 0 }
    private var ink: Color { style.ink(Chrome.wash(0.88)) }

    var body: some View {
        let parts = BarTray.split(model.status)
        if model.bar.tray == .drawer, BarTray.folds(parts.apps.count) {
            HStack(spacing: gap) {
                drawer(parts.apps)
                FitRow(spacing: gap, fromEnd: true, fills: !boxed) { ForEach(parts.system, id: \.self) { item($0) } }
            }
        } else {
            FitRow(spacing: gap, fromEnd: true, fills: !boxed) { ForEach(model.status.indices, id: \.self) { item($0) } }
        }
    }

    private func drawer(_ apps: [Int]) -> some View {
        let n = BarTray.open(apps.count, room: room - Double(model.status.count - apps.count + 1) * BarGeometry.slot)
        let out = open || model.trayHeld
        return HStack(spacing: 0) {
            HStack(spacing: 0) { ForEach(apps.suffix(n), id: \.self) { item($0) } }
                .fixedSize(horizontal: true, vertical: false)
                .opacity(out ? 1 : 0)
                .frame(width: out ? CGFloat(Double(n) * BarGeometry.slot) : 0, alignment: .trailing)
                .clipped()
                .allowsHitTesting(out)
                .accessibilityHidden(!out)
            BarButton(width: 20, held: model.trayHeld, label: out ? "Hide apps' status items" : "Show apps' status items",
                      help: "\(apps.count) status items", action: toggle) {
                Image(systemName: "chevron.left").font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(style.ink(out ? Chrome.wash(0.88) : Chrome.muted))
                    .rotationEffect(.degrees(out ? 180 : 0))
            }
        }
        .animation(Chrome.ease(out ? 0.2 : 0.135, out ? .panelIn : .panelOut), value: out)
        .background { PointerArea { pointer($0) } }
    }

    /// A click keeps it open with the pointer away; the next closes it, pointer or not.
    private func toggle() {
        model.trayHeld.toggle()
        open = model.trayHeld
    }

    private func pointer(_ on: Bool) {
        over = on
        if on { open = true; return }
        DispatchQueue.main.asyncAfter(deadline: .now() + BarTray.linger) { if !over { open = false } }
    }

    private func item(_ i: Int) -> some View {
        let item = model.status.indices.contains(i) ? model.status[i] : BarStatus.Item(owner: "")
        return BarButton(label: item.name, help: item.name, action: { model.onStatus(i) }) { glyph(item) }
    }

    /// macOS's items as symbols and a template icon in the bar's ink; any other app's icon in its own colors, since a
    /// gray one is a smudge at this size.
    @ViewBuilder private func glyph(_ item: BarStatus.Item) -> some View {
        let size = CGFloat(BarGeometry.canvas)
        if BarStatus.isBattery(item), let c = model.charge {
            BatteryGlyph(look: BarStatus.batteryLook(percent: c.percent, charging: c.charging, onPower: c.onPower, lowPower: c.lowPower),
                         ink: ink)
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
    @Environment(\.barBoxed) private var boxed
    let items: [BarMenus.Item]
    let style: ComputedStyle
    let open: (Int) -> Void

    var body: some View {
        FitRow(spacing: style.gap.map { CGFloat($0) } ?? 0, fills: !boxed) {
            ForEach(items, id: \.index) { item in
                BarButton(width: item.role == .apple ? CGFloat(BarGeometry.slot) : 0,
                          inset: item.role == .apple ? 0 : CGFloat(BarGeometry.textInset), label: item.title,
                          action: { open(item.index) }) {
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

/// The clock in two tones: the time in full, the day before it and the AM or PM after it a step quieter. The digits
/// keep one width and roll on the minute.
struct ClockFace: View {
    let now: Date
    let format: Surfaces.ClockFormat
    let style: ComputedStyle

    var body: some View {
        let parts = BarText.clockParts(now, format: format)
        let quiet = style.ink(Chrome.muted, dim: 0.7)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let day = parts.day { BarWords.text(day, style).foregroundStyle(quiet) }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                BarWords.text(parts.time, style, .medium).monospacedDigit().foregroundStyle(style.ink(Chrome.wash()))
                    .contentTransition(.numericText())
                    .animation(Chrome.ease(0.25, .panelIn), value: parts.time)
                if let half = parts.half { BarWords.text(half, style).foregroundStyle(quiet) }
            }
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(BarText.clock(now, format: format))
    }
}

/// The page in front of the browser here, by its site's icon and its title; a speaker while a tab plays; and the downloads on
/// their way. Each is a button.
struct PageModule: View {
    let page: TopBarModel.Page
    let style: ComputedStyle
    let go: (BrowserWindows.Front) -> Void

    private var inset: CGFloat { CGFloat(BarGeometry.textInset) }

    var body: some View {
        HStack(spacing: style.gap.map { CGFloat($0) } ?? 0) {
            if let f = page.now.front {
                BarButton(inset: inset, label: "Page: " + f.tab.title, help: f.tab.site, action: { go(f) }) {
                    HStack(spacing: 6) {
                        if let icon = page.icon {
                            Image(nsImage: icon).resizable().interpolation(.high).frame(width: 14, height: 14)
                        } else {
                            BarSymbol(name: "globe")
                        }
                        BarWords.text(BrowserPage.title(f), style).truncationMode(.tail)
                    }
                }
            }
            if let p = page.now.playing {
                BarButton(label: "Playing: " + p.tab.title, help: "Playing: " + p.tab.title, action: { go(p) }) {
                    BarSymbol(name: "speaker.wave.2")
                }
            }
            if let d = page.now.downloads {
                BarButton(inset: d.short.isEmpty ? 0 : inset, label: d.label, help: d.label, action: { go(d.one) }) {
                    HStack(spacing: 4) {
                        BarSymbol(name: "arrow.down.circle")
                        if !d.short.isEmpty { BarWords.text(d.short, style).monospacedDigit() }
                    }
                }
            }
        }
        .foregroundStyle(style.ink(Chrome.wash(0.85)))
    }
}
