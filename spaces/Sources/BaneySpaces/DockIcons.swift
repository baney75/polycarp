import AppKit

/// Each app's icon on the dock, drawn once at the largest size the dock shows it and kept while the app is on the dock.
/// `NSRunningApplication.icon` costs about 0.5 ms an app and hands back a new image each time, a full-size icon file
/// that SwiftUI had to decode and scale again for every open: 10 to 30 ms for 25 apps on the main thread (measured
/// 2026-11-21). Kept, an icon is the same small image from one open to the next, so SwiftUI has nothing new to draw.
final class DockIcons {
    private var kept: [pid_t: (image: NSImage, pixels: Int)] = [:]
    private let source: (pid_t) -> NSImage?
    /// What an app with no icon yet shows (`NSRunningApplication.icon` is nil for a moment after launch). Not kept
    /// for that app, so its own icon shows once macOS has it.
    private lazy var generic = NSWorkspace.shared.icon(for: .application)

    init(source: @escaping (pid_t) -> NSImage?) { self.source = source }

    /// The app's icon, drawn `pixels` wide.
    func icon(_ pid: pid_t, pixels: Int) -> NSImage {
        if let k = kept[pid], k.pixels == pixels { return k.image }
        guard let big = source(pid) else { return generic }
        let small = Self.draw(big, pixels: pixels)
        kept[pid] = (small, pixels)
        return small
    }

    /// Forgets apps no longer on the dock (and so any that quit, before their pid can be another app's).
    func keep(only pids: Set<pid_t>) {
        if kept.keys.contains(where: { !pids.contains($0) }) { kept = kept.filter { pids.contains($0.key) } }
    }

    /// The width in pixels to draw icons at: the largest icon the dock draws (one app filling a tile, 42 pt at this
    /// dock size, grown 18% under the pointer) on the sharpest display, rounded up to 16.
    static func pixels(dockScale k: CGFloat) -> Int {
        let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
        let px = 42 * k * 1.2 * max(scale, 2)
        return Int((px / 16).rounded(.up)) * 16
    }

    /// `image` drawn into a square bitmap `pixels` wide, in Display P3 so no color is lost.
    static func draw(_ image: NSImage, pixels: Int) -> NSImage {
        let points = CGFloat(pixels) / 2
        guard let space = CGColorSpace(name: CGColorSpace.displayP3),
              let cg = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return image }
        cg.interpolationQuality = .high
        cg.scaleBy(x: 2, y: 2)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: false)
        image.draw(in: NSRect(x: 0, y: 0, width: points, height: points), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let out = cg.makeImage() else { return image }
        return NSImage(cgImage: out, size: NSSize(width: points, height: points))
    }
}
