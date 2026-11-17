import AppKit

/// Times the launcher from a key event to the end of the frame that shows its answer
/// (spec/launcher.md R-L13), in timing.log: `launcher key->paint=<ms> results=<n>` for the rows
/// from memory and `launcher files first=<ms>` for the first files. Counts only, never what was
/// typed.
final class PaintClock {
    static let shared = PaintClock()
    /// When the last key that changed the query went down.
    private(set) var typedAt = ProcessInfo.processInfo.systemUptime
    private var keyAt: TimeInterval?
    /// Lines to log once the next frame is committed, each from its own start.
    private var waiting: [(since: TimeInterval, line: (Int) -> String)] = []
    private var observer: CFRunLoopObserver?

    /// The query changed: from when its key went down (the event's own time), else from now.
    func keyTyped() {
        let now = ProcessInfo.processInfo.systemUptime
        if let e = NSApp.currentEvent, e.type == .keyDown, e.timestamp <= now, now - e.timestamp < 1 {
            typedAt = e.timestamp
        } else {
            typedAt = now
        }
        if keyAt == nil { keyAt = typedAt }
    }

    /// The list is set for the last key.
    func willPaint(results n: Int) {
        guard let keyAt else { return }
        self.keyAt = nil
        afterFrame(since: keyAt) { ms in "launcher key->paint=\(ms) results=\(n)" }
    }

    /// The first files for the query typed at `since` are in the list.
    func filesShown(since: TimeInterval) {
        afterFrame(since: since) { ms in "launcher files first=\(ms)" }
    }

    /// SwiftUI draws the list and Core Animation commits it before the run loop waits again; this
    /// looks after that commit (order 2,000,000), so the time includes the drawing.
    private func afterFrame(since: TimeInterval, _ line: @escaping (Int) -> String) {
        waiting.append((since, line))
        guard observer == nil else { return }
        let o = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, 2_000_100) { [weak self] _, _ in
            self?.painted()
        }
        observer = o
        CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
    }

    private func painted() {
        if let o = observer { CFRunLoopObserverInvalidate(o) }
        observer = nil
        let now = ProcessInfo.processInfo.systemUptime
        let epoch = Int(Date().timeIntervalSince1970)
        let lines = waiting.map { "\(epoch) " + $0.line(Int(((now - $0.since) * 1000).rounded())) }
        waiting = []
        let url = Spaces.folder.appendingPathComponent("timing.log")
        DispatchQueue.global(qos: .utility).async { lines.forEach { TimingLog.append($0, to: url) } }
    }
}
