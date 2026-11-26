import CoreGraphics

/// One press on a tiled window, from the button going down until the window holds still after it came up: what the person
/// did with it, and what tiling does about it.
public struct TilingDrag: Equatable, Sendable {
    public enum Phase: Equatable, Sendable { case still, moving, resizing }

    public enum Release: Equatable, Sendable {
        /// The window wasn't moved, or something else took it.
        case nothing
        /// Back to its tile.
        case back
        case float
        case drop(CGPoint)
        /// Let go over another display.
        case across(DisplayKey, CGPoint)
        case resize
    }

    public let window: WindowID
    public let press: CGRect
    public private(set) var phase = Phase.still
    /// Escape was pressed: the window goes back, whatever happens next.
    public var cancelled = false
    private var last: CGRect?
    private var looks = 0
    private var same = 0

    public init(window: WindowID, press: CGRect) {
        self.window = window
        self.press = press
    }

    /// Where the window is now. The first change says what the drag is, and it stays that: a window that is moved may
    /// change size on the way (one filled shrinks), and an edge pulled on the left moves the window too.
    public mutating func saw(_ frame: CGRect?) {
        guard let frame, phase == .still else { return }
        if abs(frame.width - press.width) > 1 || abs(frame.height - press.height) > 1 { phase = .resizing }
        else if abs(frame.minX - press.minX) > 1 || abs(frame.minY - press.minY) > 1 { phase = .moving }
    }

    /// What the release at `point` asks for. `point` is nil for a drag that ended some other way; `taken` says a workspace
    /// in the overview took the window; `under` is the display the pointer is over and `home` the one the window tiles on.
    public func release(at point: CGPoint?, floating: Bool, taken: Bool, under: DisplayKey?, home: DisplayKey?) -> Release {
        guard !taken, phase != .still else { return .nothing }
        guard !cancelled, let point else { return .back }
        if phase == .resizing { return .resize }
        if floating { return .float }
        if let under, let home, under != home { return .across(under, point) }
        return .drop(point)
    }

    /// One look, 20 ms after the last, once the button is up. True when the window holds still (60 ms, no sooner than a
    /// tenth of a second after the release), or after half a second: the app and macOS may still be moving it.
    public mutating func settled(_ frame: CGRect?) -> Bool {
        looks += 1
        same = frame == last ? same + 1 : 0
        last = frame
        return (looks >= 5 && same >= 3) || looks >= 25
    }
}
