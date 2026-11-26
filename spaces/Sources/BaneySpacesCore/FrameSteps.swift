import CoreGraphics

/// The Accessibility messages that take a window from one frame to another (spec/tiling-speed.md R-TS9). An app takes
/// a size and a position one after the other, and the window server draws the window between them: sent in the wrong
/// order, a window growing to the left was first widened where it stood, clamped by the display's edge, and only then
/// moved and widened again (2026-11-26: 744 to 1420 to 1496 wide).
public enum FrameSteps {
    public enum Step: Equatable, Sendable { case size, position }

    /// The fewest messages that never show the window clamped by `display` or outside both frames. Nil `display`: the
    /// old way, size, position and size again.
    public static func order(from: CGRect, to: CGRect, display: CGRect?) -> [Step] {
        let sameSize = abs(from.width - to.width) < 0.5 && abs(from.height - to.height) < 0.5
        let sameOrigin = abs(from.minX - to.minX) < 0.5 && abs(from.minY - to.minY) < 0.5
        if sameSize { return [.position] }
        if sameOrigin { return [.size] }
        guard let display else { return [.size, .position, .size] }
        // Between the two messages: moved first it has its old size at the new place; sized first, the new size here.
        let moved = CGRect(origin: to.origin, size: from.size), sized = CGRect(origin: from.origin, size: to.size)
        let movedFits = fits(moved, display), sizedFits = fits(sized, display)
        switch (movedFits, sizedFits) {
        case (true, false): return [.position, .size]
        case (false, true): return [.size, .position]
        case (false, false): return [.size, .position, .size]
        case (true, true):
            // Both stay on the display: the one drawn inside the new frame, else inside the old one.
            if fits(moved, to) { return [.position, .size] }
            if fits(sized, to) { return [.size, .position] }
            return fits(sized, from) ? [.size, .position] : [.position, .size]
        }
    }

    private static func fits(_ r: CGRect, _ area: CGRect) -> Bool { area.insetBy(dx: -0.5, dy: -0.5).contains(r) }
}
