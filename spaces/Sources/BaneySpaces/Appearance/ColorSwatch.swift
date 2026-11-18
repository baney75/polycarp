import AppKit
import BaneySpacesCore
import SwiftUI

/// The system color panel, aimed at one swatch at a time. A `ColorPicker` is an `NSColorWell`, which draws its own light
/// bezel whatever the theme: in dark mode the workspace colors sat in a white box (gap X1). Swatches drawn by SwiftUI follow
/// the theme and open this same panel.
@MainActor
final class ColorPanelPick: NSObject, ObservableObject {
    static let shared = ColorPanelPick()

    /// The swatch the panel is changing, until the panel closes or another swatch is clicked.
    @Published private(set) var key: String?
    private var start: RGB?
    private var apply: ((RGB) -> Void)?
    private var closing: NSObjectProtocol?

    func open(_ key: String, start: RGB, apply: @escaping (RGB) -> Void) {
        let panel = NSColorPanel.shared
        // Aim away first: setting the panel's color would otherwise answer the swatch picked before.
        panel.setTarget(nil)
        panel.setAction(nil)
        panel.showsAlpha = false
        panel.isContinuous = true
        panel.color = NSColor(srgbRed: start.r, green: start.g, blue: start.b, alpha: 1)
        self.key = key
        self.start = start
        self.apply = apply
        panel.setTarget(self)
        panel.setAction(#selector(changed(_:)))
        if closing == nil {
            closing = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: panel, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.letGo() }
            }
        }
        panel.orderFront(nil)
    }

    @objc private func changed(_ panel: NSColorPanel) {
        guard let c = panel.color.usingColorSpace(.sRGB) else { return }
        let rgb = RGB(r: Double(c.redComponent), g: Double(c.greenComponent), b: Double(c.blueComponent))
        // The panel also answers with the color it was given; that isn't a pick.
        if let s = start, abs(rgb.r - s.r) + abs(rgb.g - s.g) + abs(rgb.b - s.b) <= 0.01 { return }
        start = nil
        apply?(rgb)
    }

    private func letGo() {
        NSColorPanel.shared.setTarget(nil)
        NSColorPanel.shared.setAction(nil)
        key = nil
        apply = nil
    }
}

/// Where each swatch drew, for the render check that samples the pixels around them (`SwatchCheck`).
struct SwatchFramesKey: PreferenceKey {
    static let defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

/// One color that opens the color panel when clicked: a workspace's color, or the custom accent.
struct ColorSwatch: View {
    let key: String
    let color: RGB
    /// What VoiceOver reads, such as "Workspace 3 color".
    let label: String
    var size = CGSize(width: 30, height: 20)
    let apply: (RGB) -> Void
    @ObservedObject private var pick = ColorPanelPick.shared

    var body: some View {
        let editing = pick.key == key
        Button { pick.open(key, start: color, apply: apply) } label: {
            Chrome.shape(.settingsCell).fill(Appearance.color(color))
                .frame(width: size.width, height: size.height)
                .overlay(Chrome.shape(.settingsCell).strokeBorder(editing ? Chrome.accent : Chrome.edge(0.25),
                                                                   lineWidth: Chrome.width(.settingsTile, focused: editing)))
                .padding(2)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .anchorPreference(key: SwatchFramesKey.self, value: .bounds) { [key: $0] }
        .help("\(label): click to pick a color")
        .accessibilityLabel(label)
        .accessibilityValue(color.hex)
        .accessibilityHint("Opens the color panel")
        .accessibilityAddTraits(editing ? [.isButton, .isSelected] : .isButton)
    }
}
