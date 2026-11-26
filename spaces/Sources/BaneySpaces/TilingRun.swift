import AppKit
import BaneySpacesCore

/// What a key asks tiling to do.
extension Tiling {
    /// Runs a command on the workspace in use and its front window. `done` gets nil when it did something, else why not.
    func run(_ command: TilingCommand, done: @escaping (String?) -> Void = { _ in }) {
        // A command acts on the windows there are now, so one just opened counts. Mid-switch it waits for the switch.
        spaces.whenFresh { [self] in
            guard spaces.active else { return done("Polycarp isn't placing windows now") }
            let n = spaces.model.current
            look()
            switch engine.run(command, on: n, focused: spaces.front()) {
            case .nothing(let why): done(why)
            case .changed:
                look()
                done(nil)
            case .focus(let id):
                engine.focused(id)
                spaces.focus(id, on: n, announce: false)
                done(nil)
            case .cross(let d, let id): done(cross(d, from: n, carrying: id))
            case .nextDisplay(let id): done(next(from: n, carrying: id))
            case .toggle: toggle(n, done: done)
            }
        }
    }

    /// Turns a workspace on or off: at once here, and in surfaces.json.
    func toggle(_ n: Int, done: @escaping (String?) -> Void = { _ in }) {
        guard n != engine.options.agentWorkspace else { return done("the agent workspace never tiles") }
        let was = engine.options
        let next = was.toggled(n)
        engine.apply(next)
        changed()
        look()
        Spaces.writer.async { [weak self] in
            let failed = Self.write(from: was, to: next)
            DispatchQueue.main.async {
                if failed != nil { self?.settingsChanged() }
                done(failed)
            }
        }
    }

    /// The two lists in surfaces.json; what went wrong. Off the main thread.
    static func write(from was: TilingOptions, to next: TilingOptions) -> String? {
        var failed: String?
        func set(_ path: String, _ old: Set<Int>, _ new: Set<Int>) {
            guard old != new, failed == nil else { return }
            let list = SurfaceValue.array(new.sorted().map { .string(String($0)) })
            if case .failure(let f) = SurfacesOps.set(path, list, file: SurfacesFile.path()) { failed = f.message }
        }
        // The list that loses the workspace first, so no version of the file names it in both.
        if next.on.count < was.on.count { set("tiling.on", was.on, next.on) }
        set("tiling.off", was.off, next.off)
        if next.on.count >= was.on.count { set("tiling.on", was.on, next.on) }
        return failed
    }

    private func cross(_ d: TileDirection, from n: Int, carrying id: WindowID?) -> String? {
        let frames = Spaces.displayFrames()
        guard let here = spaces.model.display(showing: n) ?? Windows.displays().first?.key,
              let there = TilingEngine.display(d, of: here, in: frames) else {
            return id == nil ? "there is no window that way" : "there is no display that way"
        }
        return go(to: there, carrying: id)
    }

    private func next(from n: Int, carrying id: WindowID) -> String? {
        guard let here = spaces.model.display(showing: n), let there = TilingEngine.display(after: here, in: Spaces.displayFrames()) else {
            return "there is no other display"
        }
        return go(to: there, carrying: id)
    }

    private func go(to display: DisplayKey, carrying id: WindowID?) -> String? {
        guard let n = spaces.model.shown[display] else { return "nothing is shown on that display" }
        if let id {
            guard spaces.send(id, to: display, placing: !engine.options.tiles(n)) else { return "the window can't go there" }
            spaces.focus(id, on: n, announce: false)
            look()
            return nil
        }
        spaces.use(display: display)
        if let there = engine.last(on: n) ?? spaces.model.lastFocused[n] { spaces.focus(there, on: n, announce: false) }
        return nil
    }
}
