import CoreGraphics

/// Where the dictation overlay goes: the display that holds the window you're typing into, so the pill sits where you
/// look. Pure, so the choice is tested without screens.
public enum VoiceOverlayPlace {
    /// A window's bounds as CGWindowList gives them (top-left origin, y down from the top of the primary display), in
    /// AppKit's coordinates (bottom-left origin).
    public static func cocoa(_ cg: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: cg.minX, y: primaryHeight - cg.maxY, width: cg.width, height: cg.height)
    }

    /// The index of the screen that holds most of `window` (AppKit coordinates), else the one under the pointer, else 0.
    public static func screen(window: CGRect?, pointer: CGPoint, screens: [CGRect]) -> Int {
        if let w = window {
            let best = screens.indices.max { area(screens[$0].intersection(w)) < area(screens[$1].intersection(w)) }
            if let b = best, area(screens[b].intersection(w)) > 0 { return b }
        }
        return screens.firstIndex { $0.contains(pointer) } ?? 0
    }

    /// Bottom center of that screen, 72 pt up, as the Tauri overlay sits.
    public static func frame(size: CGSize, on screen: CGRect) -> CGRect {
        CGRect(x: screen.midX - size.width / 2, y: screen.minY + 72, width: size.width, height: size.height)
    }

    private static func area(_ r: CGRect) -> CGFloat { r.isNull ? 0 : r.width * r.height }
}
