import Foundation

/// Windows a note took out of the model before the window server dropped them (spec/tiling-speed.md R-TS8), and which
/// of them a scan may put back.
public enum LeftEarly {
    public struct Left: Equatable, Sendable {
        public var workspace: Int
        /// The last scan begun when the window left: one at or before it may still list the window.
        public var serial: Int

        public init(workspace: Int, serial: Int) { (self.workspace, self.serial) = (workspace, serial) }
    }

    /// The windows a scan numbered `scan` must not put back: all of them when it began before they left, else those
    /// its apps didn't list in a full answer of their own (`relisted`). An answer kept from an earlier scan still lists a
    /// closed window, so it proves nothing.
    public static func held(_ left: [WindowID: Left], scan: Int, relisted: Set<WindowID>) -> Set<WindowID> {
        Set(left.filter { scan <= $0.value.serial || !relisted.contains($0.key) }.keys)
    }
}
