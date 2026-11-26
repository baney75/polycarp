import AppKit
import BaneySpacesCore

/// `BANEYSPACES_RENDER_TILE_TIMING=<rounds> Polycarp --render <folder>` times tiling's own work on `MoveTiming`'s helper
/// windows (8, nearly clear and below the normal level): all but one are tiled, the last one appears, and from there its
/// app is asked, the layout solved and every frame that changed written, as `Tiling.look` does. Then it looks at rest, and
/// must find nothing to write. Exits 1 when a window isn't on its tile or something is written at rest.
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
        var astray = 0, restless = 0
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
            func write(_ moves: [TilingMove]) { _ = Tiling.place(moves.compactMap { m in mine[m.id].map { (m, $0) } }, while: { true }) }
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
        }
        print("tiling, n=\(rounds), a window appears among \(windows.count), \(apps) helper apps answering \(delay) ms late")
        print(TimingStats.line("from its appearing to the last frame asked for", whole))
        print(TimingStats.line("of which asking its app", asks))
        print(TimingStats.line("of which reading the windows and solving", plans))
        print(TimingStats.line("a look at rest", rests))
        if astray > 0 { print("tiling timing: \(astray) windows weren't on their tile") }
        if restless > 0 { print("tiling timing: \(restless) frames written at rest") }
        return astray + restless == 0 ? 0 : 1
    }
}
