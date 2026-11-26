import AppKit
import BaneySpacesCore

/// The window reads and moves of a switch, apart from its state (`Spaces.bringHome`, `Spaces.park`), so `MoveTiming` times
/// the same code on windows of its own. Main thread, which waits for the answers: apps are asked side by side (`Lanes`).
enum WindowMoves {
    /// A parked window, where it goes back to, and its size now.
    struct Homing {
        let window: Window
        let to: CGRect
        let size: CGSize
    }

    /// What parking needs to know of a window. `frame` is nil for a minimized window, or one whose app doesn't answer.
    struct State {
        let minimized: Bool
        let frame: CGRect?
    }

    /// Where the window server has these windows now; one it doesn't list isn't in the answer. It asks no app, and asks the
    /// server for these alone: its whole list takes 5 ms, and a switch looks every 10.
    static func bounds(of ids: Set<WindowID>) -> [WindowID: CGRect] { describe(ids) { _, bounds in bounds } }

    static func describe<T>(_ ids: Set<WindowID>, _ take: ([String: Any], CGRect) -> T) -> [WindowID: T] {
        // The window server wants the bare numbers in the array, not NSNumbers.
        var raw = ids.map { UnsafeRawPointer(bitPattern: UInt($0)) }
        guard !raw.isEmpty, let array = CFArrayCreate(nil, &raw, raw.count, nil) else { return [:] }
        let list = CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]] ?? []
        return Dictionary(list.compactMap { w in
            guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }) else { return nil }
            return (id, take(w, b))
        }) { $1 }
    }

    /// Where each parked window goes back to. A window whose app doesn't answer can't move now; it isn't in the answer.
    static func targets(_ moves: [(Window, CGRect)], screens: [CGRect]) -> [Homing] {
        Lanes.map(moves, by: \.0.pid) { w, frame in
            w.frame.map { Homing(window: w, to: Geometry.restoreFrame(saved: frame, size: $0.size, screens: screens), size: $0.size) }
        }.compactMap { $0 }
    }

    static func place(_ list: [Homing], file: String = #fileID, line: Int = #line) {
        _ = Lanes.map(list, by: \.window.pid) { $0.window.place($0.to, currentSize: $0.size, file: file, line: line) }
    }

    static func states(of windows: [Window]) -> [WindowID: State] {
        let read = Lanes.map(windows, by: \.pid) { w in
            let minimized = w.isMinimized
            return (w.id, State(minimized: minimized, frame: minimized ? nil : w.frame))
        }
        return Dictionary(read) { $1 }
    }

    static func move(_ windows: [Window], to p: CGPoint, file: String = #fileID, line: Int = #line) {
        _ = Lanes.map(windows, by: \.pid) { $0.setOrigin(p, file: file, line: line) }
    }

    /// Looks every 10 ms until each window has stopped (`Settling`), then says which animated their move. Gives up after
    /// 0.4 s.
    static func settle(_ ids: Set<WindowID>, goal: Settling.Goal, screens: [CGRect], then: @escaping (Set<WindowID>) -> Void) {
        guard !ids.isEmpty else { return then([]) }
        var settling = Settling(ids, goal: goal, screens: screens, start: ProcessInfo.processInfo.systemUptime)
        let deadline = Date().addingTimeInterval(0.4)
        Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { timer in
            let done = settling.look(bounds(of: ids), at: ProcessInfo.processInfo.systemUptime)
            guard done || Date() > deadline else { return }
            timer.invalidate()
            then(settling.slow)
        }
    }
}
