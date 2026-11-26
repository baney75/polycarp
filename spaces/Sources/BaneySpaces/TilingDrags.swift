import AppKit
import BaneySpacesCore

/// Drags and pulled edges of tiled windows: the outline while the button is down, and the layout once the window has been
/// let go and holds still. Nothing is written while the button is down or the window still moves.
extension Tiling {
    /// Whether a drag of this window is tiling's to end: the title bar rescue leaves it alone.
    func holds(_ id: WindowID) -> Bool { drag?.window == id && drag?.phase != .still }

    /// A window's button went down. Any drag before it is over.
    func pressed(_ id: WindowID?, frame: CGRect?) {
        endDrag()
        guard let id, let frame, spaces.shownWorkspaces.contains(where: engine.options.tiles), engine.tile(of: id) != nil else { return }
        drag = TilingDrag(window: id, press: frame)
    }

    /// The button is still down. `frame` is nil while the overview has the window.
    func held(_ id: WindowID, frame: CGRect?, at point: CGPoint) {
        guard drag?.window == id, !dragLetGo else { return }
        let was = drag?.phase
        drag?.saw(frame)
        guard let d = drag, d.phase == .moving else { return }
        if was != .moving { watchEscape() }
        guard frame != nil, !d.cancelled, !floatKeyDown, let to = engine.dropFrame(id, at: point) else { return outline.hide() }
        outline.show(to)
    }

    func letGo(_ id: WindowID, at point: CGPoint?, taken: Bool) {
        outline.hide()
        guard let d = drag, d.window == id, !dragLetGo else { return }
        let frames = Spaces.displayFrames()
        let under = point.flatMap { p in frames.first { $0.value.contains(p) }?.key }
        let home = spaces.model.workspace(of: id).flatMap { spaces.model.display(showing: $0) }
        let end = d.release(at: point, floating: floatKeyDown, taken: taken, under: under, home: home)
        guard end != .nothing else { return endDrag() }
        dragLetGo = true
        stopEscape()
        dragTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] timer in
            guard let self, self.dragTimer === timer else { return timer.invalidate() }
            let now = TopDragWatcher.bounds(of: id)
            guard self.drag?.settled(now) ?? true else { return }
            self.endDrag()
            self.finish(end, id, now, from: d.press)
        }
    }

    private func finish(_ end: TilingDrag.Release, _ id: WindowID, _ now: CGRect?, from press: CGRect) {
        switch end {
        case .nothing: return
        case .back: engine.touched(id)
        case .float: engine.setFloating(id, true)
        case .drop(let p): engine.drop(id, on: p)
        case .resize: if let now { engine.resized(id, to: now, from: press) } else { engine.touched(id) }
        case .across(let display, let p):
            engine.touched(id)
            engine.lands(id, at: p)
            if !spaces.send(id, to: display, placing: false) { Trace.log("tiling: window=\(id) let go over another display stays") }
        }
        changed()
        look()
    }

    private func endDrag() {
        dragTimer?.invalidate()
        dragTimer = nil
        dragLetGo = false
        drag = nil
        outline.hide()
        stopEscape()
    }

    private var floatKeyDown: Bool {
        guard let flag = SurfacesStore.shared.current.tiling.floatModifier.flag else { return false }
        return NSEvent.modifierFlags.contains(flag)
    }

    /// Escape is listened for only while a tiled window is on the move.
    private func watchEscape() {
        guard escape == nil else { return }
        escape = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard e.keyCode == 53 else { return }
            self?.drag?.cancelled = true
            self?.outline.hide()
        }
    }

    private func stopEscape() {
        if let escape { NSEvent.removeMonitor(escape) }
        escape = nil
    }
}

private extension Surfaces.Tiling.FloatModifier {
    var flag: NSEvent.ModifierFlags? {
        switch self {
        case .shift: .shift
        case .control: .control
        case .option: .option
        case .command: .command
        case .none: nil
        }
    }
}
