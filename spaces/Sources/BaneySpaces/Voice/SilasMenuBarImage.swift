import AppKit
#if canImport(BaneySpacesCore)
import BaneySpacesCore
#endif

/// The menu bar image while Silas listens: the workspace mark and Silas's pen with its dot, drawn into ONE template image. macOS
/// tints a template image for the menu bar's appearance (black on a light bar, white on a dark one), so the pen and the dot are
/// the same silhouette color as the workspace mark, and the title text stays the system's own. Nothing is drawn through a text
/// attachment, which would not follow the appearance.
enum SilasMenuBarImage {
    static func composite(base: NSImage, recording: Bool) -> NSImage {
        let gap: CGFloat = 3
        let height = max(base.size.height, 16)
        let pen = min(height, 16)
        let size = NSSize(width: base.size.width + gap + pen, height: height)
        let image = NSImage(size: size, flipped: false) { rect in
            base.draw(in: NSRect(x: 0, y: (rect.height - base.size.height) / 2, width: base.size.width, height: base.size.height),
                      from: .zero, operation: .sourceOver, fraction: 1)
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.saveGState()
            // The pen's grid is y-down; the image here is y-up.
            let s = pen / SilasMarkGeometry.grid
            ctx.translateBy(x: base.size.width + gap, y: (rect.height - pen) / 2 + pen)
            ctx.scaleBy(x: s, y: -s)
            ctx.setFillColor(NSColor.black.cgColor)
            ctx.addPath(SilasMarkGeometry.pen())
            ctx.fillPath(using: .evenOdd)
            if recording {
                ctx.addPath(SilasMarkGeometry.dot())
                ctx.fillPath()
            }
            ctx.restoreGState()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Silas is listening"
        return image
    }
}
