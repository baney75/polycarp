import AppKit

/// Times a launcher keystroke from its key event to the end of the frame that draws its list
/// (spec/launcher.md R-L13): `launcher key->paint=<ms> results=<n>` in timing.log. Counts only,
/// never what was typed.
final class PaintClock {
    static let shared = PaintClock()
    private var keyAt: TimeInterval?
    private var results = 0
    private var observer: CFRunLoopObserver?

    /// The query changed: from when its key went down (the event's own time), else from now.
    /// Two keys in one run-loop turn count from the first.
    func keyTyped() {
        guard keyAt == nil else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let e = NSApp.currentEvent, e.type == .keyDown, e.timestamp <= now, now - e.timestamp < 1 {
            keyAt = e.timestamp
        } else {
            keyAt = now
        }
    }

    /// The list is set. SwiftUI draws it and Core Animation commits it before the run loop waits
    /// again; this looks after that commit (order 2,000,000), so the time includes the drawing.
    func willPaint(results n: Int) {
        guard keyAt != nil else { return }
        results = n
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
        guard let keyAt else { return }
        self.keyAt = nil
        let ms = Int(((ProcessInfo.processInfo.systemUptime - keyAt) * 1000).rounded())
        let line = "\(Int(Date().timeIntervalSince1970)) launcher key->paint=\(ms) results=\(results)"
        let url = Spaces.folder.appendingPathComponent("timing.log")
        DispatchQueue.global(qos: .utility).async { TimingLog.append(line, to: url) }
    }
}
