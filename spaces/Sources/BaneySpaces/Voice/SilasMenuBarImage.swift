import AppKit

/// The menu bar image while Silas listens: the workspace mark and Silas's pen with its dot, drawn into ONE template image. macOS
/// tints a template image for the menu bar's appearance (black on a light bar, white on a dark one), so the pen and the dot are
/// the same silhouette color as the workspace mark, and the title text stays the system's own. Nothing is drawn through a text
/// attachment, which would not follow the appearance.
enum SilasMenuBarImage {
    static func composite(base: NSImage) -> NSImage {
        let gap: CGFloat = 3
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
        image.accessibilityDescription = [base.accessibilityDescription, "Silas is listening"].compactMap { $0 }.joined(separator: ", ")
        return image
    }
}
