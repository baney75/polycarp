import AppKit
import BaneySpacesCore

/// What a key, the bar, the command line or an agent asks tiling to do.
extension Tiling {
    /// Runs a command on the workspace in use and its front window. `done` gets nil when it did something, else why not.
    /// `pressed` is the key event's time, for timing.log (spec/tiling-speed.md R-TS1).
    func run(_ command: TilingCommand, pressed: Double? = nil, done: @escaping (String?) -> Void = { _ in }) {
        // A command acts on the windows there are now, so one just opened counts. Mid-switch it waits for the switch.
        spaces.whenFresh { [self] in
            guard spaces.active else { return done("Polycarp isn't placing windows now") }
            let n = spaces.model.current
            look()
            // Timed only where the key's own look writes (R-TS2): a key that writes nothing leaves no cause behind.
            let key = { if let pressed { self.cause(TileCauses.Cause(.key, at: pressed)) } }
            switch engine.run(command, on: n, focused: spaces.front()) {
            case .nothing(let why): done(why)
            case .changed:
                key()
                if case .move = command, let pressed { action(.move, how: "key", at: pressed, workspace: n) }
                look()
                done(nil)
            case .focus(let id):
                engine.focused(id)
                drawStrips()
                spaces.focus(id, on: n, announce: false)
                if let pressed {
                    let now = Self.uptime
                    Timed(causes: [TileCauses.Cause(.key, at: pressed)], looked: now, asked: now).log(landed: nil)
                }
                done(nil)
            case .cross(let d, let id): done(cross(d, from: n, carrying: id))
            case .nextDisplay(let id): done(next(from: n, carrying: id))
            case .toggle: toggle(n, done: done)
            case .scratchpad: spaces.toggleScratchpad(done: done)
            case .pin(let id, let sized):
                if !spaces.model.pinned.contains(id) { engine.popOut(id, sized: sized) }
                spaces.pin(id, !spaces.model.pinned.contains(id))
                look()
                done(nil)
            case .toScratchpad(let id):
                spaces.sendToScratchpad(id, at: engine.release(id))
                look()
                done(nil)
            }
        }
    }

    /// The same from `polycarp-spaces tile`, answered with how tiling stands once it is done.
    func answer(_ words: [String], done: @escaping (Wire.Reply) -> Void) {
        let end: (String?) -> Void = { [self] why in done(why.map { Wire.Reply(ok: false, error: $0) } ?? status.reply) }
        switch TilingRequest(words: words) {
        case nil: end("tile doesn't take that; `polycarp-spaces tile help` lists what it takes")
        case .status?: end(spaces.active ? nil : "Polycarp isn't placing windows now")
        case .turn(let on, let n)?:
            let n = n ?? spaces.model.current
            guard spaces.active else { return end("Polycarp isn't placing windows now") }
            if n == engine.options.agentWorkspace { return end("the agent workspace never tiles") }
            engine.options.tiles(n) == on ? end(nil) : toggle(n, done: end)
        case .run(let command)?: run(command, done: end)
        }
    }

    private var status: TilingStatus {
        let n = spaces.model.current, ids = engine.windows(of: n), front = spaces.front()
        return TilingStatus(workspace: n, tiles: engine.options.tiles(n), style: engine.style(of: n).rawValue, full: engine.isFull(n), windows: ids,
                            focused: front.flatMap { ids.contains($0) ? $0 : nil }, tiling: Workspaces.range.filter { engine.options.tiles($0) })
    }

    /// The workspaces that tile, and their style.
    var styles: [Int: TileStyle] {
        var out: [Int: TileStyle] = [:]
        for n in Workspaces.range where engine.options.tiles(n) { out[n] = engine.style(of: n) }
        return out
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
