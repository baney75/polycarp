import AppKit
import BaneySpacesCore

/// `polycarp-spaces agent probe` (spec/tiling-speed.md R-TS12): tiling runs on the agent workspace, off screen, only
/// while the probe runs, on the windows of one helper copy of the app. It never touches the current workspace, the
/// focus, a display or any other app, so it needs no idle wait. Its state is in memory only.
final class TilingProbeRun {
    unowned let tiling: Tiling
    private var spaces: Spaces { tiling.spaces }
    private var session: TilingProbe.Session?
    private var helper: (process: Process, input: Pipe)?
    private var tick: Timer?
    private var caller: DispatchSourceProcess?
    private enum Step { case open, key(TilingCommand), close(Int, timed: Bool) }
    private var steps: [Step] = []
    private var samples: [TilingProbe.Sample] = []
    /// The step waiting for its timing result: its kind, when it was asked for, and its number.
    private var waiting: (kind: TilingProbe.Kind, at: Double, serial: Int)?
    private var serial = 0
    private var writes: [WindowID: Int] = [:]
    private var opened: [WindowID] = []
    private var focus: WindowID?
    private var lines = Data()
    /// The cause times of the probe's own steps: their timing lines are the probe's, not real use.
    private var ours: Set<Double> = []

    init(tiling: Tiling) { self.tiling = tiling }

    /// The `agent probe` operation: `start <pid> <rounds> <seconds>` or `status`.
    func answer(_ args: [String]) -> Wire.Reply {
        if args.first == "status" { return session?.reply ?? TilingProbe.none }
        let start = TilingProbe.start(args, agentWorkspace: Spaces.agentWorkspace, running: session?.running == true,
                                      active: spaces.active, alive: { kill($0, 0) == 0 || errno == EPERM })
        switch start {
        case .refused(let reply): return reply
        case .go(let ask):
            begin(ask, on: Spaces.agentWorkspace ?? 0)
            return session?.reply ?? TilingProbe.none
        }
    }

    private func begin(_ ask: TilingProbe.Ask, on n: Int) {
        session = TilingProbe.Session(ask, workspace: n, now: Tiling.uptime)
        (samples, opened, focus, waiting, lines, ours) = ([], [], nil, nil, Data(), [])
        let round: [Step] = [.open, .open, .open] + TilingProbe.keys.map { .key($0) }
        steps = (0..<ask.rounds).flatMap { r in round + [.close(3 * r, timed: true), .close(3 * r + 1, timed: true), .close(3 * r + 2, timed: false)] }
        spaces.probe = (n, [])
        probing(true)
        Tiling.probeHook = { [weak self] in self?.heard($0) ?? false }
        let source = DispatchSource.makeProcessSource(identifier: ask.caller, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in self?.end(.caller) }
        source.resume()
        caller = source
        tick = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, let s = self.session else { return }
            if let why = s.check(now: Tiling.uptime, active: self.spaces.active, agentWorkspace: Spaces.agentWorkspace) { self.end(why) }
        }
        guard startHelper() else { return end(.error) }
    }

    private func probing(_ on: Bool) {
        var o = tiling.engine.options
        o.probing = on
        tiling.engine.apply(o)
    }

    private func startHelper() -> Bool {
        guard let a = spaces.probeArea(bar: Tiling.reach) else { return false }
        let p = Process(), input = Pipe(), output = Pipe()
        p.executableURL = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        p.arguments = ["--render", NSTemporaryDirectory()]
        p.environment = ProcessInfo.processInfo.environment.merging([
            "BANEYSPACES_RENDER_MOVE_HELPER": "0 0", "BANEYSPACES_RENDER_MOVE_FREE": "1",
            "BANEYSPACES_PROBE_AREA": "\(a.minX) \(a.minY) \(a.width) \(a.height)",
        ]) { $1 }
        p.standardInput = input
        p.standardOutput = output
        output.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil }
            DispatchQueue.main.async { self?.said(data) }
        }
        do { try p.run() } catch { return false }
        helper = (p, input)
        spaces.probe?.pids.insert(p.processIdentifier)
        return true
    }

    /// The helper's lines: `ready`, then `open <window number>` for each window it opened. Its end ends the probe.
    private func said(_ data: Data) {
        guard session?.running == true else { return }
        guard !data.isEmpty else { return end(.error) }
        lines.append(data)
        while let end = lines.firstIndex(of: 10) {
            let words = String(decoding: lines[..<end], as: UTF8.self).split(separator: " ")
            lines.removeSubrange(...end)
            if words == ["ready"] { next() }
            if words.count == 2, words[0] == "open", let id = WindowID(words[1]) {
                opened.append(id)
                focus = id
                // Its app is asked at once: the helper's first window comes with no notification to say so.
                if let pid = helper?.process.processIdentifier { spaces.whenFresh(asking: [pid]) { [weak tiling] in tiling?.look() } }
            }
        }
    }

    private func send(_ line: String) { helper?.input.fileHandleForWriting.write(Data((line + "\n").utf8)) }

    /// The next step, a moment after the last (R-TS12.11).
    private func next(after seconds: Double = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, let s = self.session, s.running else { return }
            guard !self.steps.isEmpty else { return self.finish() }
            let step = self.steps.removeFirst(), at = Tiling.uptime
            self.ours.insert(at)
            self.writes = [:]
            self.serial += 1
            switch step {
            case .open:
                self.wait(for: .new, at: at)
                if let pid = self.helper?.process.processIdentifier { self.tiling.cause(TileCauses.Cause(.new, at: at, pid: pid)) }
                self.send("open")
            case .key(let c):
                guard let kind = TilingProbe.Kind(c) else { return self.next() }
                self.wait(for: kind, at: at)
                self.tiling.runProbe(c, on: s.workspace, focused: self.focus, pressed: at) { [weak self] id, why in
                    guard let self else { return }
                    if let id { self.focus = id }
                    // A key with nothing to do (an edge) writes no line: it is no sample.
                    if why != nil, self.waiting?.at == at { self.waiting = nil; self.next(after: 0.05) }
                }
            case .close(let i, let timed):
                if timed { self.wait(for: .close, at: at) } else { self.next(after: 0.6) }
                self.send("close \(i)")
            }
        }
    }

    private func wait(for kind: TilingProbe.Kind, at: Double) {
        waiting = (kind, at, serial)
        let mine = serial
        DispatchQueue.main.asyncAfter(deadline: .now() + TilingProbe.wait) { [weak self] in
            guard let self, self.waiting?.serial == mine else { return }
            self.take(nil, writes: self.writes.values.max() ?? 0)
        }
    }

    /// A timing result: the one the step waits for is its sample.
    /// True for a result of the probe's own, which timing.log doesn't get.
    private func heard(_ h: Tiling.ProbeHeard) -> Bool {
        let mine: Bool
        switch h {
        case .wrote(let ids):
            for id in ids where opened.contains(id) { writes[id, default: 0] += 1 }
            return false
        case .timed(let c, _, _): mine = ours.contains(c.at) || c.pid.map { spaces.probe?.pids.contains($0) == true } == true
        case .action(let a): mine = a.workspace == session?.workspace
        }
        guard let w = waiting else { return mine }
        switch h {
        case .wrote: break
        case .timed(let c, let asked, let landed):
            guard c.at == w.at, c.kind == (w.kind == .new ? .new : .key) else { return mine }
            // A focus writes no frame, so it lands when it is asked.
            take(w.kind == .focus || landed != nil ? (asked - w.at) * 1000 : nil, writes: writes.values.max() ?? 0)
        case .action(let a):
            guard w.kind == .close, a.kind == .close, a.workspace == session?.workspace, a.at >= w.at else { return mine }
            take(a.last.map { ($0 - a.at) * 1000 }, writes: a.writes.values.max() ?? 0)
        }
        return mine
    }

    private func take(_ ms: Double?, writes: Int) {
        guard let w = waiting else { return }
        samples.append(TilingProbe.Sample(w.kind, ms: ms, writes: writes))
        waiting = nil
        next(after: 0.15)
    }

    private func finish() { end(.done, result: TilingProbe.json(TilingProbe.stats(samples))) }

    /// R-TS12.9: every end closes the helper's input, stops it a second later if it still runs, turns tiling off on the
    /// agent workspace again and drops its layout.
    private func end(_ why: TilingProbe.Why, result: String? = nil) {
        guard var s = session, s.end(why, result: result) else { return }
        session = s
        tick?.invalidate()
        tick = nil
        caller?.cancel()
        caller = nil
        Tiling.probeHook = nil
        (steps, waiting) = ([], nil)
        if let h = helper {
            try? h.input.fileHandleForWriting.close()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if h.process.isRunning { h.process.terminate() } }
        }
        helper = nil
        spaces.probe = nil
        probing(false)
        tiling.engine.dropLayout(of: s.workspace)
        Trace.log("probe end why=\(why.rawValue)")
    }
}
