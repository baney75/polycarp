import AppKit
import BaneySpacesCore

/// The window reads and moves of a switch, apart from its state (`Spaces.bringHome`, `Spaces.park`), so `MoveTiming` times
/// the same code on windows of its own. Main thread.
enum WindowMoves {
    /// A parked window and where it goes back to.
    struct Homing {
        let window: Window
        let to: CGRect
    }

    /// What parking needs to know of a window. `frame` is nil for a minimized window, or one whose app doesn't answer.
    struct State {
        let minimized: Bool
        let frame: CGRect?
    }

    /// Where the window server has these windows now; one it doesn't list isn't in the answer. It asks no app.
    static func bounds(of ids: Set<WindowID>) -> [WindowID: CGRect] {
        Windows.serverWindows().filter { ids.contains($0.key) }.compactMapValues(\.bounds)
    }

    /// Where each parked window goes back to. A window whose app doesn't answer can't move now; it isn't in the answer.
    static func targets(_ moves: [(Window, CGRect)], screens: [CGRect]) -> [Homing] {
        moves.compactMap { w, frame in
            w.frame.map { Homing(window: w, to: Geometry.restoreFrame(saved: frame, size: $0.size, screens: screens)) }
        }
    }

    static func place(_ list: [Homing], file: String = #fileID, line: Int = #line) {
        for m in list { m.window.place(m.to, currentSize: m.window.frame?.size ?? m.to.size, file: file, line: line) }
    }

    static func states(of windows: [Window]) -> [WindowID: State] {
        var out: [WindowID: State] = [:]
        for w in windows {
            let minimized = w.isMinimized
            out[w.id] = State(minimized: minimized, frame: minimized ? nil : w.frame)
        }
        return out
    }

    static func move(_ windows: [Window], to p: CGPoint, file: String = #fileID, line: Int = #line) {
        for w in windows { w.setOrigin(p, file: file, line: line) }
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
