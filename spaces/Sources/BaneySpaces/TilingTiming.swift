import AppKit
import BaneySpacesCore

/// `BANEYSPACES_RENDER_TILE_TIMING=<rounds> Polycarp --render <folder>` times tiling's own work on `MoveTiming`'s helper
/// windows (8, nearly clear and below the normal level): all but one are tiled, the last one appears, and from there its
/// app is asked, the layout solved and every frame that changed written, as `Tiling.look` does. Then it looks at rest, and
/// must find nothing to write. Then a move key on that window, that window let go over another's tile, and a close of another, each timed the
/// same way. Sending a window to a workspace leaves its tile the way a close does. Exits 1
/// when a window isn't on its tile, a plan asks one window for two frames, or something is written at rest.
@MainActor
enum TilingTiming {
    static func run(rounds: Int) -> Int32 {
        Trace.muted = true
        let env = ProcessInfo.processInfo.environment
        func number(_ key: String, _ standard: Int) -> Int { env[key].flatMap(Int.init) ?? standard }
        let apps = number("BANEYSPACES_RENDER_MOVE_APPS", 4), each = number("BANEYSPACES_RENDER_MOVE_WINDOWS", 2)
        let delay = number("BANEYSPACES_RENDER_MOVE_DELAY", 0)
        let helpers = MoveTiming.Helpers()
        defer { helpers.stop() }
        guard let windows = helpers.start(apps: apps, each: each, delay: delay), let d = Windows.displays().first else { return 2 }
        let ids = Set(windows.map(\.id)), mine = Dictionary(uniqueKeysWithValues: windows.map { ($0.id, $0) })
        let place = TilingShot.Place(display: d.key, area: TilingRead.area(frame: d.frame, visible: d.visible, bar: 0))
        var options = TilingOptions()
        options.everywhere = true
        options.gaps = TileGaps(inner: 8, outer: 8)
        var whole: [Double] = [], plans: [Double] = [], asks: [Double] = [], rests: [Double] = []
        var keys: [Double] = [], drags: [Double] = [], closes: [Double] = []
        var astray = 0, restless = 0, twice = 0, stuck = 0
        for round in 0...rounds {
            let last = windows[round % windows.count].id
            var engine = TilingEngine()
            engine.apply(options)
            var answers: [WindowID: TilingAnswer] = [:]
            func look(_ without: WindowID?) -> [TilingMove] {
                let places = WindowMoves.places(of: ids)
                let facts = windows.filter { $0.id != without }.map { w in
                    var f = TilingFacts(id: w.id, pid: w.pid, bundle: "helper", workspace: 1, frame: places[w.id]?.bounds)
                    f.onScreen = places[w.id]?.onScreen ?? false
                    f.answer = answers[w.id]
                    return f
                }
                return engine.plan(TilingRead.shot(facts, shown: [1: place], focused: nil))
            }
            func write(_ moves: [TilingMove]) { _ = Tiling.place(moves.compactMap { m in mine[m.id].map { (m, $0) } }, screens: Windows.screens(), while: { true }) }
            for w in windows where w.id != last { answers[w.id] = w.tilingAnswer(screenSized: false) }
            write(look(last))
            MoveTiming.spin(0.25)
            _ = engine.landed(WindowMoves.bounds(of: ids.subtracting([last])))
            let start = MoveTiming.now()
            answers[last] = mine[last]?.tilingAnswer(screenSized: false)
            let asked = MoveTiming.now()
            let moves = look(nil)
            let planned = MoveTiming.now()
            write(moves)
            let done = MoveTiming.now()
            MoveTiming.spin(0.25)
            let now = WindowMoves.bounds(of: ids)
            astray += engine.frames(1).filter { id, f in now[id].map { !TilingEngine.near($0, f) } ?? true }.count
            _ = engine.landed(now)
            let rest = MoveTiming.now()
            restless += look(nil).count
            if round > 0 { whole.append(done - start); asks.append(asked - start); plans.append(planned - asked); rests.append(MoveTiming.now() - rest) }
            // A move key on the new window, then another window closes: each plans one frame per window and writes it.
            let shut = windows[(round + 1) % windows.count].id
            for (kind, without) in [("key", nil), ("drag", nil), ("close", shut)] as [(String, WindowID?)] {
                let pressed = MoveTiming.now()
                if kind == "key", engine.run(.move(.left), on: 1, focused: last) != .changed,
                   engine.run(.move(.right), on: 1, focused: last) != .changed { stuck += 1 }
                // Let go over the middle of another window's tile, as a drag into a tile ends (TilingDrags.finish).
                if kind == "drag" {
                    let target = engine.frames(1).first { $0.key != last && $0.key != shut }?.value
                    if !(target.map { engine.drop(last, on: CGPoint(x: $0.midX, y: $0.midY)) } ?? false) { stuck += 1 }
                }
                let moves = look(without)
                twice += moves.count - Set(moves.map(\.id)).count
                write(moves)
                let wrote = MoveTiming.now()
                MoveTiming.spin(0.25)
                let now = WindowMoves.bounds(of: ids.subtracting([without].compactMap { $0 }))
                astray += engine.frames(1).filter { id, f in now[id].map { !TilingEngine.near($0, f) } ?? true }.count
                _ = engine.landed(now)
                restless += look(without).count
                if round > 0 { switch kind { case "key": keys.append(wrote - pressed); case "drag": drags.append(wrote - pressed); default: closes.append(wrote - pressed) } }
            }
        }
        print("tiling, n=\(rounds), a window appears among \(windows.count), \(apps) helper apps answering \(delay) ms late")
        print(TimingStats.line("from its appearing to the last frame asked for", whole))
        print(TimingStats.line("of which asking its app", asks))
        print(TimingStats.line("of which reading the windows and solving", plans))
        print(TimingStats.line("a look at rest", rests))
        print(TimingStats.line("a move key to the last frame asked for", keys))
        print(TimingStats.line("a drag let go on a tile to the last frame asked", drags))
        print(TimingStats.line("a close to the last frame asked for", closes))
        if astray > 0 { print("tiling timing: \(astray) windows weren't on their tile") }
        if restless > 0 { print("tiling timing: \(restless) frames written at rest") }
        if twice > 0 { print("tiling timing: \(twice) windows asked for two frames in one plan") }
        if stuck > 0 { print("tiling timing: \(stuck) move keys or drops moved nothing") }
        return astray + restless + twice + stuck == 0 ? 0 : 1
    }
}
