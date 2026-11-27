import AppKit
import BaneySpacesCore

/// `polycarp-spaces agent probe` (spec/tiling-speed.md R-TS12): tiling runs on the agent workspace, off screen, only
/// while the probe runs, on the windows of one helper copy of the app. It never touches the current workspace, the
/// focus, a display or any other app, so it needs no idle wait. Its state is in memory only.
final class TilingProbeRun {
    unowned let tiling: Tiling
    private var spaces: Spaces { tiling.spaces }
    private var session: TilingProbe.Session?
    /// The helper, started by LaunchServices as its own app: started as this app's child, macOS answers this app's
    /// Accessibility asks of it with "API disabled" (measured 2026-11-26). It talks over two named pipes.
    private var helper: (app: NSRunningApplication, exit: DispatchSourceProcess)?
    private var pipes: (input: FileHandle, output: FileHandle, folder: URL)?
    /// The helper said `ready` before LaunchServices handed its pid over, or the other way round: the first step waits for both.
    private var ready = false
    private var going = false
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
                                      active: spaces.active, agentInSight: Spaces.agentWorkspace.map(spaces.model.isShown) == true,
                                      alive: { kill($0, 0) == 0 || errno == EPERM })
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
        let keys: [Step] = TilingProbe.keys.map { Step.key($0) }
        var all: [Step] = []
        for r in 0..<ask.rounds {
            let first: Int = 3 * r
            all += [Step.open, Step.open, Step.open]
            all += keys
            all += [Step.close(first, timed: true), Step.close(first + 1, timed: true), Step.close(first + 2, timed: false)]
        }
        steps = all
        spaces.probe = (n, [])
        probing(true)
        Tiling.probeHook = { [weak self] in self?.heard($0) ?? false }
        let source = DispatchSource.makeProcessSource(identifier: ask.caller, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in self?.end(.caller) }
        source.resume()
        caller = source
        tick = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, let s = self.session else { return }
            let inSight = self.spaces.model.isShown(s.workspace)
            if let why = s.check(now: Tiling.uptime, active: self.spaces.active, agentWorkspace: Spaces.agentWorkspace,
                                 agentInSight: inSight) { self.end(why) }
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
        let files = FileManager.default, folder = files.temporaryDirectory.appendingPathComponent("polycarp-probe-\(getpid())")
        try? files.removeItem(at: folder)
        guard (try? files.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return false }
        let inPath = folder.appendingPathComponent("in").path, outPath = folder.appendingPathComponent("out").path
        guard mkfifo(inPath, 0o600) == 0, mkfifo(outPath, 0o600) == 0 else { return false }
        // Held read and write here, so neither open waits for the helper and neither reads an end of file before it
        // starts. Closing `in` is the helper's end of input; a crash here closes it too.
        let inFD = open(inPath, O_RDWR), outFD = open(outPath, O_RDWR)
        guard inFD >= 0, outFD >= 0 else {
            if inFD >= 0 { close(inFD) }
            if outFD >= 0 { close(outFD) }
            return false
        }
        let input = FileHandle(fileDescriptor: inFD, closeOnDealloc: true), output = FileHandle(fileDescriptor: outFD, closeOnDealloc: true)
        output.readabilityHandler = { [weak self] h in
            let data = h.availableData
            DispatchQueue.main.async { self?.said(data) }
        }
        pipes = (input, output, folder)
        (ready, going) = (false, false)
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.activates = false
        config.addsToRecentItems = false
        config.promptsUserIfNeeded = false
        config.arguments = ["--render", NSTemporaryDirectory()]
        config.environment = ProcessInfo.processInfo.environment.merging([
            "BANEYSPACES_RENDER_MOVE_HELPER": "0 0", "BANEYSPACES_RENDER_MOVE_FREE": "1",
            "BANEYSPACES_PROBE_AREA": "\(a.minX) \(a.minY) \(a.width) \(a.height)",
            "BANEYSPACES_PROBE_IN": inPath, "BANEYSPACES_PROBE_OUT": outPath, "BANEYSPACES_PROBE_OWNER": "\(getpid())",
        ]) { $1 }
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { app, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.session?.running == true, self.pipes?.input === input, let app else {
                    app?.forceTerminate()
                    self?.end(.error)
                    return
                }
                let exit = DispatchSource.makeProcessSource(identifier: app.processIdentifier, eventMask: .exit, queue: .main)
                exit.setEventHandler { [weak self] in self?.end(.error) }
                exit.resume()
                self.helper = (app, exit)
                self.spaces.probe?.pids.insert(app.processIdentifier)
                self.started()
            }
        }
        return true
    }

    /// The first step goes once the helper is ready and its pid is known, so its first window is the probe's.
    private func started() {
        guard helper != nil, ready, !going else { return }
        going = true
        next()
    }

    /// The helper's lines: `ready`, then `open <window number>` for each window it opened. Its end ends the probe.
    private func said(_ data: Data) {
        guard session?.running == true else { return }
        guard !data.isEmpty else { return end(.error) }
        lines.append(data)
        while let end = lines.firstIndex(of: 10) {
            let words = String(decoding: lines[..<end], as: UTF8.self).split(separator: " ")
            lines.removeSubrange(...end)
            if words == ["ready"] { ready = true; started() }
            if words.count == 2, words[0] == "open", let id = WindowID(words[1]) {
                opened.append(id)
                focus = id
                // Its app is asked at once: the helper's first window comes with no notification to say so.
                if let pid = helper?.app.processIdentifier { spaces.whenFresh(asking: [pid]) { [weak tiling] in tiling?.look() } }
            }
        }
    }

    private func send(_ line: String) { pipes?.input.write(Data((line + "\n").utf8)) }

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
                if let pid = self.helper?.app.processIdentifier { self.tiling.cause(TileCauses.Cause(.new, at: at, pid: pid)) }
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
        case .timed(let c, _, _):
            mine = ours.contains(c.at) || c.pid.map { spaces.probe?.pids.contains($0) == true } == true
                || (c.workspace != nil && c.workspace == session?.workspace)
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
        if let p = pipes {
            p.input.write(Data("quit\n".utf8))
            p.output.readabilityHandler = nil
            try? p.input.close()
            try? p.output.close()
            try? FileManager.default.removeItem(at: p.folder)
        }
        if let h = helper {
            h.exit.cancel()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if !h.app.isTerminated { h.app.forceTerminate() } }
        }
        (helper, pipes) = (nil, nil)
        spaces.probe = nil
        probing(false)
        tiling.engine.dropLayout(of: s.workspace)
        Trace.log("probe end why=\(why.rawValue)")
    }
}
