import AppKit

/// Silas's pen as AppKit images, here so a test can draw them and read the pixels (issue 33).
public enum SilasMark {
    /// A template image (macOS tints it for the menu bar), the pen alone or with the listening dot.
    public static func templateImage(size: CGFloat = 18, recording: Bool = false) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let s = rect.width / SilasMarkGeometry.grid
            ctx.scaleBy(x: s, y: s)
            ctx.setFillColor(NSColor.black.cgColor)
            ctx.addPath(SilasMarkGeometry.pen())
            ctx.fillPath(using: .evenOdd)
            if recording {
                ctx.addPath(SilasMarkGeometry.dot())
                ctx.fillPath()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Silas"
        return image
    }
}

/// The menu bar image while Silas listens: the workspace mark and Silas's pen with its dot, drawn into ONE template image. macOS
/// tints a template image for the menu bar's appearance (black on a light bar, white on a dark one), so the pen and the dot are
/// the same silhouette color as the workspace mark, and the title text stays the system's own. Nothing is drawn through a text
/// attachment, which would not follow the appearance.
public enum SilasMenuBarImage {
    /// Space between the workspace mark and the pen.
    public static let gap: CGFloat = 3
    /// What VoiceOver adds to the menu bar item's name while Silas listens.
    public static let listeningLabel = "Silas, listening"

    public static func composite(base: NSImage) -> NSImage {
        let height = max(base.size.height, 16)
        let pen = min(height, 16)
        let size = NSSize(width: base.size.width + gap + pen, height: height)
        let mark = SilasMark.templateImage(size: pen, recording: true)
        let image = NSImage(size: size, flipped: false) { rect in
            base.draw(in: NSRect(x: 0, y: (rect.height - base.size.height) / 2, width: base.size.width, height: base.size.height),
                      from: .zero, operation: .sourceOver, fraction: 1)
            mark.draw(in: NSRect(x: base.size.width + gap, y: (rect.height - pen) / 2, width: pen, height: pen),
                      from: .zero, operation: .sourceOver, fraction: 1)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = [base.accessibilityDescription, listeningLabel].compactMap { $0 }.joined(separator: ", ")
        return image
    }
}
