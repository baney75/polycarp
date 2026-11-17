import CoreGraphics

/// Which frame writes and frame changes go in trace.log around a drag. A window that jumps after it is let go
/// (Donovan, 2026-11-12 and 2026-11-16: Helium flipping between filled and the lower half) must show in the trace whether
/// Polycarp moved it. So every frame Polycarp writes while the button is down, or within `after` seconds of a drag's
/// release, is logged with the line that wrote it, and every frame change of the released window is logged for `after`
/// seconds, whoever made it. Outside those times nothing is added: a switch parks dozens of windows.
public enum DragFrameLog {
    public static let after: Double = 2
    /// Looks at the released window's frame this often while watching.
    public static let interval: Double = 0.02

    /// Whether a frame write at `now` is logged.
    public static func logsWrite(now: Double, buttonDown: Bool, lastRelease: Double?) -> Bool {
        if buttonDown { return true }
        guard let lastRelease else { return false }
        return now >= lastRelease && now - lastRelease <= after
    }

    /// Whether the watch started at `start` still runs at `now`.
    public static func watching(start: Double, now: Double) -> Bool { now - start <= after }

    public enum Write: String { case frame, origin, size }

    /// "frame write window=75067 origin=(0,33) size=1512x948 by Spaces.swift:861"
    public static func writeLine(window: UInt32, kind: Write, origin: CGPoint?, size: CGSize?, file: String, line: Int) -> String {
        var parts = ["\(kind.rawValue) write window=\(window)"]
        if let origin { parts.append("origin=(\(n(origin.x)),\(n(origin.y)))") }
        if let size { parts.append("size=\(n(size.width))x\(n(size.height))") }
        parts.append("by \(file.split(separator: "/").last.map(String.init) ?? file):\(line)")
        return parts.joined(separator: " ")
    }

    /// A line when the frame changed since the last look, or nil. `t` is seconds since the release.
    public static func changeLine(window: UInt32, t: Double, frame: CGRect?, previous: CGRect?) -> String? {
        guard frame != previous else { return nil }
        let now = frame.map { "(\(n($0.minX)),\(n($0.minY)) \(n($0.width))x\(n($0.height)))" } ?? "gone"
        return "drag watch window=\(window) +\(Int((t * 1000).rounded())) ms frame=\(now)"
    }

    private static func n(_ v: CGFloat) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.1f", Double(v))
    }
}
