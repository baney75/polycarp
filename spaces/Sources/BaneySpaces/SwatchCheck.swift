import AppKit
import BaneySpacesCore
import SwiftUI

/// `BANEYSPACES_RENDER_SWATCHES=1 Polycarp --render <folder>` draws Settings > Appearance in dark mode, offscreen, saves it as
/// `swatches-dark.png`, samples the pixels around and between the nine workspace colors (`SwatchBackdrop`) and prints one
/// `swatch check:` line. It exits 1 when they sit on near-white, when the look isn't dark, or when the nine aren't found.
/// `scripts/swatch-check.sh` runs it.
@MainActor
enum SwatchCheck {
    /// Where SwiftUI put each swatch, read from the anchors as the view is laid out.
    private final class Frames {
        var byKey: [String: CGRect] = [:]
        func record(_ f: [String: CGRect]) -> Color {
            byKey.merge(f) { $1 }
            return .clear
        }
    }

    static func run(into folder: URL) -> Int32 {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        // The default look's palette is dark; another palette picked for this run (BANEYSPACES_RENDER_PALETTE) may not be.
        let dark = Chrome.scheme == .dark
        let setup = SetupModel()
        setup.tab = .appearance
        let frames = Frames()
        // Tall enough that the lazy pane builds every group down to the panels.
        let size = CGSize(width: SettingsSidebar.windowSize.width, height: 1600)
        let view = SetupView(model: setup, close: {}, height: size.height)
            .frame(width: size.width, height: size.height)
            .environment(\.colorScheme, Chrome.scheme).environment(\.controlActiveState, .key)
            .overlayPreferenceValue(SwatchFramesKey.self) { anchors in
                GeometryReader { g in frames.record(anchors.mapValues { g[$0] }) }
            }
        let host = NSHostingView(rootView: view)
        let window = RenderWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return 1 }
        host.cacheDisplay(in: host.bounds, to: rep)
        _ = try? rep.representation(using: .png, properties: [:])?.write(to: folder.appendingPathComponent("swatches-dark.png"))

        let scale = CGFloat(rep.pixelsWide) / host.bounds.width
        let swatches = frames.byKey.filter { $0.key.hasPrefix("workspace-") }.values.map { r in
            SwatchBackdrop.Rect(x: Int((r.minX * scale).rounded()), y: Int((r.minY * scale).rounded()),
                                width: Int((r.width * scale).rounded()), height: Int((r.height * scale).rounded()))
        }
        let result = SwatchBackdrop.sample(width: rep.pixelsWide, height: rep.pixelsHigh, swatches: swatches, margin: Int(4 * scale)) { x, y in
            guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return RGB(r: 1, g: 1, b: 1) }
            return SwatchBackdrop.overWhite(RGB(r: Double(c.redComponent), g: Double(c.greenComponent), b: Double(c.blueComponent)),
                                            alpha: Double(c.alphaComponent))
        }
        let line = SwatchBackdrop.report(result, swatches: swatches.count, dark: dark)
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
        return result.passes && dark && swatches.count == 9 ? 0 : 1
    }
}
