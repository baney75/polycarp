import CoreGraphics

/// Where `arrange` and `move --frame` lay agent windows out: the usable area of the display that shows the agent
/// workspace. When no display shows it, the one ⌘1 to ⌘9 change, since that is where it is shown next; else the main one.
/// With two displays the main one may be the one Donovan is working on, so it is never taken just for being first.
public enum AgentArea {
    /// `displays`: each display's key and usable area (AX coordinates), the main one first.
    public static func visible(displays: [(key: DisplayKey, visible: CGRect)], showing: DisplayKey?, focused: DisplayKey?) -> CGRect {
        for key in [showing, focused].compactMap({ $0 }) {
            if let d = displays.first(where: { $0.key == key }) { return d.visible }
        }
        return displays.first?.visible ?? .zero
    }
}
