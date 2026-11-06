import CoreGraphics
import Foundation

/// What the green button and ⌃⌘F do while Polycarp runs. macOS full screen moves a window to a desktop of its own, and every
/// switch to or from it plays macOS's slide, which nothing can speed up. So a window fills the screen on its own workspace
/// instead: at once, with no slide, and ⌘1 to ⌘9 stay instant (Donovan, 2026-11-06). Anything else that asks for full screen
/// (a video's own button, Window > Enter Full Screen, a slideshow) stays native.
public enum FullScreenFill {
    /// A preference, on unless the person turned it off.
    public static let enabledKey = "fullScreenFills"

    public static func isEnabled(stored: Any?) -> Bool { (stored as? Bool) ?? true }

    /// F's virtual key code.
    public static let fKey: Int64 = 3

    /// ⌃⌘F and fn-F, the two standard full-screen keys. Any other modifier means something else.
    public static func isFullScreenKey(code: Int64, control: Bool, command: Bool, shift: Bool, option: Bool, fn: Bool) -> Bool {
        guard code == fKey, !shift, !option else { return false }
        return (control && command && !fn) || (fn && !control && !command)
    }

    /// A plain click only: ⌥-click on the green button is macOS's own zoom, and stays that.
    public static func isPlainClick(command: Bool, control: Bool, shift: Bool, option: Bool) -> Bool {
        !command && !control && !shift && !option
    }

    /// Accessibility's name for the green button.
    public static let buttonSubrole = "AXFullScreenButton"

    /// Where a press of the gesture sends a window. A window already filling goes back where it was; any other fills. A
    /// filled window with nothing saved, such as one the person sized by hand to fill, stays.
    public static func target(current: CGRect, fill: CGRect, saved: CGRect?) -> CGRect {
        guard isFilling(current, fill) else { return fill }
        return saved ?? current
    }

    public static func isFilling(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 3) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }
}
