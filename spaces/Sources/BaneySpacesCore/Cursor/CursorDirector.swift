import CoreGraphics
import Foundation

/// What the cursor shows for an action.
public enum CursorEffect: Equatable, Sendable {
    /// A ripple and a squish at the target, and a dot mark. Also select and toggle.
    case click
    /// A caret pulse at the target, and a caret mark.
    case type
    /// A short trail in the scroll's direction (unit vector, y down), and an arrow mark.
    case scroll(dx: Double, dy: Double)

    /// Nil for a verb that draws nothing (`press`, which is refused anyway).
    public static func of(kind: String, direction: String?) -> CursorEffect? {
        switch kind {
        case "click", "select", "toggle": return .click
        case "type", "set-value": return .type
        case "scroll":
            switch direction ?? "down" {
            case "up": return .scroll(dx: 0, dy: -1)
            case "left": return .scroll(dx: -1, dy: 0)
            case "right": return .scroll(dx: 1, dy: 0)
            default: return .scroll(dx: 0, dy: 1)
            }
        default: return nil
        }
    }
}

/// A glide for the renderer to hand to the compositor as one keyframe animation. Times are on the system
/// uptime clock (the one `CACurrentMediaTime` reads), so the animation and the planner agree on "now".
public struct CursorMotion: Equatable, Sendable {
    public var start: TimeInterval
    public var step: TimeInterval
    public var duration: TimeInterval
    /// When the cursor reaches the target: the ripple waits for it.
    public var arrival: TimeInterval
    public var points: [CGPoint]
    public var target: CGPoint

    public init(plan: GlidePlan, start: TimeInterval, step: TimeInterval = 1.0 / 240) {
        self.start = start; self.step = step; duration = plan.duration; arrival = plan.arrival
        points = plan.samples(step: step).map(\.position); target = plan.target
    }
}

/// Where the cursor is drawn. The real one is a Core Animation overlay per target window, ordered directly above that
/// window; tests use a fake. Every call comes from the director's queue, and none of them may be waited on by an action.
public protocol CursorSurface: AnyObject {
    /// The agent's look: its name, colors and theme. Called before the first draw and whenever it changes.
    func configure(_ agent: String, look: CursorLook)
    /// Shows the cursor at a point in a window's overlay (fading in).
    func appear(_ agent: String, at point: CGPoint, in window: CursorWindow)
    /// Glides it; replaces any glide in flight. In another window than the one it is in, it lands there instead.
    func move(_ agent: String, motion: CursorMotion, in window: CursorWindow)
    func jump(_ agent: String, to point: CGPoint, in window: CursorWindow)
    /// The mark of an action at the target: `delay` seconds from now, when the cursor arrives.
    func act(_ agent: String, effect: CursorEffect, point: CGPoint, frame: CGRect, delay: TimeInterval)
    func hide(_ agent: String)
    /// The agent is gone for good (idle for a long time): its layers are removed.
    func remove(_ agent: String)
    /// The window moved, resized or changed level, or (`reorder`) its overlay is no longer directly above it: the overlay follows.
    func place(_ window: CursorWindow, reorder: Bool)
    /// The "in use" veil over a window: shown, or updated to a new look.
    func showVeil(_ window: CursorWindow, look: VeilLook)
    /// The veil fades out.
    func hideVeil(_ window: UInt32)
    /// The window left the screen (minimized, closed, another Space, parked): its overlay goes at once, no fade.
    func windowGone(_ window: UInt32)
    /// The overlay's own window number for a target window, while it is on screen.
    func overlayWindow(for window: UInt32) -> UInt32?
    /// Every overlay's window number: never counted as covering anything.
    var overlayWindows: Set<UInt32> { get }
}

/// What the director needs to know about the world; the app updates it on the main thread.
public struct CursorEnvironment: Equatable, Sendable {
    public var settings = CursorSettings()
    /// Every workspace a display is showing (one per display).
    public var shownWorkspaces: Set<Int> = [1]
    /// With one display: the workspace you are on.
    public var current: Int {
        get { shownWorkspaces.min() ?? 1 }
        set { shownWorkspaces = [newValue] }
    }
    public var agentWorkspace: Int?
    public var reduceMotion = false
    public var reduceTransparency = false
    /// The displays' frames in the hands' coordinates (global, y down).
    public var displays: [CGRect] = []
    public init() {}
}

/// Where an agent's cursor last acted, for `agent shot --cursor`.
public struct CursorMark: Equatable, Sendable {
    public var look: CursorLook
    public var point: CGPoint
    /// The window's frame when it acted, so the mark can be placed in a capture of that window.
    public var windowFrame: CGRect?
    public var at: TimeInterval
    public init(look: CursorLook, point: CGPoint, windowFrame: CGRect?, at: TimeInterval) {
        self.look = look; self.point = point; self.windowFrame = windowFrame; self.at = at
    }
}

/// The agent cursor's brain. It listens to the hands (`HandsEvents`), decides whether the cursor is drawn,
/// plans the glide, and tells a `CursorSurface` what to animate. The action never waits for any of it:
/// `handsWillAct` only queues the event and returns.
public final class CursorDirector: HandsEventListener {
    public struct Host {
        /// The session engine's name and status for an agent session.
        public var agent: (String) -> (name: String, status: DockAgent.State) = { _ in ("Agent", .working) }
        /// A window's frame now (global, y down).
        public var windowFrame: (UInt32) -> CGRect? = { _ in nil }
        /// The windows on screen, front to back (`CGWindowListCopyWindowInfo`). Nil when the list can't be read: then
        /// nothing is checked for being covered and nothing follows its window.
        public var windows: () -> [ScreenWindow]? = { nil }
        /// Where the follow check reads `windows`: never the director's queue (the main thread in the app), so 8 window
        /// server round trips a second never land on it. Only the parsed list comes back.
        public var windowQueue = DispatchQueue(label: "baney.cursor.windows", qos: .userInitiated)
        public var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
        public init() {}
    }

    private struct Track {
        var plan: GlidePlan?
        var planStart: TimeInterval = 0
        /// The last place it stood (its destination), kept while hidden for being idle.
        var rest: CGPoint?
        var shown = false
        var stamp = 0
        var look: CursorLook?
        var scope = ""
        var workspace: Int?
        /// The window the cursor last acted in, and where its overlay was put.
        var window: UInt32 = 0
        var placement: CursorWindow?
    }

    /// The veil over one window: who has acted in it lately (newest first) and each one's latest stamp.
    private struct Veil {
        var order: [String] = []
        var stamps: [String: Int] = [:]
        var shown = false
        var look: VeilLook?
        var scope = ""
        var workspace: Int?
    }

    public static let maxNameLength = 18
    /// How long an action waits for its target's frame to be measured before the cursor settles for its last known point.
    public static let frameWait: TimeInterval = 0.05
    /// How often an overlay checks that it still sits on its window, while one is shown (8 times a second).
    public static let followInterval: TimeInterval = 0.125
    private let surface: CursorSurface
    private let queue: DispatchQueue
    private let host: Host
    private let idleAfter: TimeInterval
    private let veilIdleAfter: TimeInterval
    private let pruneAfter: TimeInterval
    private let lock = NSLock()
    private var env = CursorEnvironment()
    private var marks: [UInt32: CursorMark] = [:]
    // Touched only on `queue`.
    private var tracks: [String: Track] = [:]
    private var pending: [UInt64: HandsActionEvent] = [:]
    private var knownDisplays: [CGRect] = []
    private var veils: [UInt32: Veil] = [:]
    /// Where each window's overlay was last put.
    private var placed: [UInt32: CursorWindow] = [:]
    private var veilStamp = 0
    private var following = false

    /// `veilIdleAfter`: how long the veil stays after an agent's last action in the window. Agents think for several
    /// seconds between actions, so it is longer than the cursor's `idleAfter` (three times it by default), and the veil
    /// does not flicker off between consecutive actions.
    public init(surface: CursorSurface, queue: DispatchQueue, host: Host = Host(), idleAfter: TimeInterval = 6, veilIdleAfter: TimeInterval? = nil,
                pruneAfter: TimeInterval = 300) {
        self.surface = surface; self.queue = queue; self.host = host; self.idleAfter = idleAfter
        self.veilIdleAfter = veilIdleAfter ?? idleAfter * 3; self.pruneAfter = pruneAfter
    }

    // MARK: world

    private func environment() -> CursorEnvironment { lock.lock(); defer { lock.unlock() }; return env }

    /// Called by the app when a workspace, a setting or a display changes. Cursors that must not be drawn any more hide.
    public func setEnvironment(_ e: CursorEnvironment) {
        lock.lock(); let changed = env != e; env = e; lock.unlock()
        if changed { queue.async { [self] in reconcile() } }
    }

    /// Where the agent cursor last acted on `window`, if it did within `within` seconds.
    public func lastMark(window: UInt32, within: TimeInterval = 30) -> CursorMark? {
        lock.lock(); defer { lock.unlock() }
        guard let m = marks[window], host.now() - m.at <= within else { return nil }
        return m
    }

    // MARK: HandsEventListener

    public func handsWantsFrame(scope: String, workspace: Int?) -> Bool {
        let e = environment()
        return CursorVisibility.wantsFrame(enabled: e.settings.enabled, scope: scope, windowWorkspace: workspace, shown: e.shownWorkspaces, agent: e.agentWorkspace)
    }

    /// On the hands' thread, before the action is sent. It only queues the event: the action never waits for the glide.
    /// An event whose frame is still being measured waits here for up to `frameWait`, never on the hands' thread.
    public func handsWillAct(_ event: HandsActionEvent) {
        queue.async { [self] in
            guard event.frameComing else { return process(event) }
            pending[event.id] = event
            queue.asyncAfter(deadline: .now() + Self.frameWait) { [self] in
                // Late: draw at the last known point, if there is one. The action has long since gone.
                guard let ev = pending.removeValue(forKey: event.id) else { return }
                processLate(ev)
            }
        }
    }

    public func handsFrame(actionID: UInt64, frame: CGRect?) {
        queue.async { [self] in
            guard var ev = pending.removeValue(forKey: actionID) else { return }
            // No frame (the engine had none, or the read couldn't start in time) is the same as a late one.
            guard let frame else { return processLate(ev) }
            ev.frame = frame; ev.point = CGPoint(x: frame.midX, y: frame.midY); ev.frameComing = false
            process(ev)
        }
    }

    // MARK: on the queue

    private func look(for session: String, _ e: CursorEnvironment) -> CursorLook {
        let a = host.agent(session)
        let name = a.name.count > Self.maxNameLength ? String(a.name.prefix(Self.maxNameLength - 1)) + "…" : a.name
        return CursorLook(name: name, status: a.status, identity: CursorPalette.identityColor(for: session), theme: e.settings.resolvedTheme,
                          still: e.settings.skipsGlide(reduceMotion: e.reduceMotion))
    }

    private func current(_ t: Track, _ now: TimeInterval) -> GlideState? {
        if let plan = t.plan, now - t.planStart < plan.duration { return plan.state(at: now - t.planStart) }
        return t.rest.map { GlideState(position: $0) }
    }

    /// The frame didn't arrive in time (or there was none). The cursor never disappears and never forgets where it
    /// stood, and nothing is drawn at a point the action never targeted: no ripple, mark or focus box, and no mark
    /// kept for `agent shot --cursor`. In the window it was last in, it stays put. In another window it glides to that
    /// window's center (the window list gives that cheaply). Either way it counts as activity, so it doesn't fade mid-session.
    private func processLate(_ ev: HandsActionEvent) {
        let agent = ev.session
        let env = environment()
        let list = host.windows()
        let placement = self.placement(ev.window, list, env, frame: list == nil ? host.windowFrame(ev.window) : nil)
        noteVeil(ev, placement, env)
        guard var t = tracks[agent], t.shown else { return }
        guard CursorVisibility.wantsFrame(enabled: env.settings.enabled, scope: ev.scope, windowWorkspace: ev.workspace, shown: env.shownWorkspaces, agent: env.agentWorkspace) else {
            hide(agent, forget: true)
            return
        }
        if ev.window != t.window {
            guard let placement else { hide(agent, forget: true); return }
            let center = CGPoint(x: placement.frame.midX, y: placement.frame.midY)
            if env.displays.contains(where: { $0.contains(center) }) {
                if let list, case .visible = WindowCover.check(ev.window, point: center, windows: list, ignoring: surface.overlayWindows, displays: env.displays) {} else if list != nil {
                    hide(agent, forget: true)
                    return
                }
                // It lands in the other window instead of flying across the screen to it.
                surface.jump(agent, to: center, in: placement)
                t.plan = nil; t.rest = center
                t.window = ev.window; t.placement = placement; t.scope = ev.scope; t.workspace = ev.workspace
                placed[ev.window] = placement
            }
        }
        t.stamp += 1
        tracks[agent] = t
        scheduleIdle(agent, t.stamp)
    }

    /// Where a window's overlay goes: from the window server's list, or (no list) over `frame`. Nil when the list says
    /// the window is not on screen.
    private func placement(_ window: UInt32, _ list: [ScreenWindow]?, _ env: CursorEnvironment, frame: CGRect?) -> CursorWindow? {
        if let list { return WindowCover.place(window, windows: list, displays: env.displays) }
        return frame.map { CursorWindow(id: window, frame: $0) }
    }

    /// Moves the cursor from where it is to `target`: a glide, or a jump under Reduce Motion. Returns when it arrives.
    @discardableResult
    private func glide(_ t: inout Track, _ agent: String, to target: CGPoint, in window: CursorWindow, _ env: CursorEnvironment, _ now: TimeInterval) -> TimeInterval {
        let skip = env.settings.skipsGlide(reduceMotion: env.reduceMotion)
        let from = t.shown ? current(t, now) : t.rest.map { GlideState(position: $0) }
        var delay = 0.0
        if let from, !skip {
            let plan = GlidePlan(from: from, target: target, spring: env.settings.spring)
            if plan.duration > 0 {
                surface.move(agent, motion: CursorMotion(plan: plan, start: now), in: window)
                t.plan = plan; t.planStart = now; delay = plan.arrival
            } else {
                if t.plan != nil { surface.jump(agent, to: target, in: window) }
                t.plan = nil
            }
        } else { surface.jump(agent, to: target, in: window); t.plan = nil }
        t.rest = target
        return delay
    }

    private func scheduleIdle(_ agent: String, _ stamp: Int) {
        queue.asyncAfter(deadline: .now() + idleAfter) { [self] in
            guard tracks[agent]?.stamp == stamp else { return }
            hide(agent, forget: false)
            // A session that stays quiet is forgotten, so many sessions over weeks don't pile up layers.
            queue.asyncAfter(deadline: .now() + pruneAfter) { [self] in
                guard let t = tracks[agent], t.stamp == stamp, !t.shown else { return }
                tracks[agent] = nil
                surface.remove(agent)
            }
        }
    }

    private func process(_ ev: HandsActionEvent) {
        let env = environment()
        let agent = ev.session
        let list = host.windows()
        let target = ev.frame.map { CGPoint(x: $0.midX, y: $0.midY) }
        // The window server round trip happens here, on the director's queue, never on the hands' thread.
        let windowFrame = host.windowFrame(ev.window)
        let fallback = windowFrame ?? target.flatMap { p in env.displays.first { $0.contains(p) } }
        let placement = self.placement(ev.window, list, env, frame: fallback)
        noteVeil(ev, placement, env)
        let cover = list.flatMap { l in target.map { WindowCover.check(ev.window, point: $0, windows: l, ignoring: surface.overlayWindows, displays: env.displays) } }
        let decision = CursorVisibility.decide(enabled: env.settings.enabled, scope: ev.scope, windowWorkspace: ev.workspace, shown: env.shownWorkspaces,
                                               agent: env.agentWorkspace, frame: ev.frame, displays: env.displays, cover: cover)
        guard decision.shown, let frame = ev.frame, let target, let placement else {
            hide(agent, forget: true)
            return
        }
        guard let effect = CursorEffect.of(kind: ev.kind, direction: ev.direction) else { return }
        let now = host.now()
        var t = tracks[agent] ?? Track()
        let look = look(for: agent, env)
        if t.look != look { surface.configure(agent, look: look); t.look = look }
        let skip = env.settings.skipsGlide(reduceMotion: env.reduceMotion)
        // Where it stood counts only in the same window: a cursor never draws outside its window, and between two
        // windows it lands in the new one instead of flying across the screen.
        let sameWindow = t.window == ev.window && (t.rest.map { placement.frame.contains($0) } ?? false)
        if !t.shown || !sameWindow {
            let at = skip || !sameWindow ? target : (t.rest ?? target)
            if t.shown { surface.jump(agent, to: at, in: placement) } else { surface.appear(agent, at: at, in: placement) }
            t.shown = true; t.plan = nil; t.rest = at
        }
        placed[ev.window] = placement
        t.placement = placement
        let delay = glide(&t, agent, to: target, in: placement, env, now)
        surface.act(agent, effect: effect, point: target, frame: frame, delay: delay)
        t.stamp += 1; t.scope = ev.scope; t.workspace = ev.workspace; t.window = ev.window
        tracks[agent] = t
        followSoon()
        lock.lock()
        marks[ev.window] = CursorMark(look: look, point: target, windowFrame: windowFrame, at: now)
        if marks.count > 64, let old = marks.min(by: { $0.value.at < $1.value.at })?.key { marks[old] = nil }
        lock.unlock()
        scheduleIdle(agent, t.stamp)
    }

    /// `forget`: it left because you are not looking (or it was turned off), so where it stood is no use later.
    private func hide(_ agent: String, forget: Bool) {
        guard var t = tracks[agent] else { return }
        if t.shown { surface.hide(agent) }
        t.shown = false; t.plan = nil
        if forget { t.rest = nil }
        tracks[agent] = t
    }

    private func reconcile() {
        let env = environment()
        let now = host.now()
        // The displays changed: every cursor is made again from what the director knows (its look and where it stands),
        // whatever the overlay kept. A cursor that is on a display that is still there comes back at once.
        if env.displays != knownDisplays {
            knownDisplays = env.displays
            for (agent, var t) in tracks {
                let pos = t.shown ? (current(t, now)?.position ?? t.rest) : nil
                t.look = nil
                if t.shown {
                    t.shown = false; t.plan = nil
                    if let pos, let placement = t.placement, env.displays.contains(where: { $0.contains(pos) }), CursorVisibility.wantsFrame(enabled: env.settings.enabled, scope: t.scope, windowWorkspace: t.workspace, shown: env.shownWorkspaces, agent: env.agentWorkspace) {
                        let l = look(for: agent, env)
                        surface.configure(agent, look: l)
                        surface.appear(agent, at: pos, in: placement)
                        t.look = l; t.shown = true; t.rest = pos
                    } else { surface.hide(agent); t.rest = nil }
                } else if let r = t.rest, !env.displays.contains(where: { $0.contains(r) }) { t.rest = nil }
                tracks[agent] = t
            }
        }
        // Windows whose cursor or veil was stopped here: their overlay leaves at once, with no fade. You switched
        // workspace (or turned it off), so the window under it is going or gone. Only the idle timeout fades.
        var stopped: Set<UInt32> = []
        for (agent, t) in tracks {
            if !CursorVisibility.wantsFrame(enabled: env.settings.enabled, scope: t.scope, windowWorkspace: t.workspace, shown: env.shownWorkspaces, agent: env.agentWorkspace) {
                // Not watchable any more: hide it, and forget where it stood (idle ones too: the windows were parked).
                if t.shown { stopped.insert(t.window) }
                hide(agent, forget: true)
                continue
            }
            guard t.shown else { continue }
            let l = look(for: agent, env)
            if l != tracks[agent]?.look { surface.configure(agent, look: l); tracks[agent]?.look = l }
        }
        for (window, v) in veils {
            guard CursorVisibility.veilShown(enabled: env.settings.veil, scope: v.scope, windowWorkspace: v.workspace, shown: env.shownWorkspaces, agent: env.agentWorkspace) else {
                if v.shown { stopped.insert(window) }
                endVeil(window)
                continue
            }
            // Reduce Motion, Reduce Transparency or a status changed.
            let l = veilLook(v.order, env)
            if v.shown, l != v.look, let p = placed[window] { surface.showVeil(p, look: l); veils[window]?.look = l }
        }
        let inUse = windowsInUse
        for w in stopped where !inUse.contains(w) {
            placed[w] = nil
            surface.windowGone(w)
        }
    }

    /// Called by the app when an agent session's name or status changes (working to needs you, say) with no new
    /// action: its cursor's look and every veil naming it are made again.
    public func agentChanged(_ session: String) {
        queue.async { [self] in
            let env = environment()
            if let t = tracks[session], t.look != nil {
                let l = look(for: session, env)
                if l != t.look { surface.configure(session, look: l); tracks[session]?.look = l }
            }
            for (window, v) in veils where v.shown && v.order.contains(session) {
                let l = veilLook(v.order, env)
                if l != v.look, let p = placed[window] { surface.showVeil(p, look: l); veils[window]?.look = l }
            }
        }
    }

    // MARK: the veil

    private func veilLook(_ agents: [String], _ env: CursorEnvironment) -> VeilLook {
        VeilLook(agents: agents.map { VeilLook.Agent(look(for: $0, env)) }, still: env.settings.skipsGlide(reduceMotion: env.reduceMotion),
                 solid: env.reduceTransparency)
    }

    /// An action in a window: its veil shows (or stays), and fades `veilIdleAfter` after this agent's last action there.
    /// It needs no frame, so it shows even while the cursor itself is off or the target point is covered.
    private func noteVeil(_ ev: HandsActionEvent, _ placement: CursorWindow?, _ env: CursorEnvironment) {
        guard CursorVisibility.veilShown(enabled: env.settings.veil, scope: ev.scope, windowWorkspace: ev.workspace, shown: env.shownWorkspaces, agent: env.agentWorkspace),
              let placement else { return }
        let agent = ev.session
        var v = veils[ev.window] ?? Veil()
        veilStamp += 1
        v.stamps[agent] = veilStamp
        v.order.removeAll { $0 == agent }
        v.order.insert(agent, at: 0)
        v.scope = ev.scope; v.workspace = ev.workspace
        let l = veilLook(v.order, env)
        if !v.shown || v.look != l || placed[ev.window] != placement {
            surface.showVeil(placement, look: l)
            v.shown = true; v.look = l
        }
        placed[ev.window] = placement
        veils[ev.window] = v
        let stamp = veilStamp, window = ev.window
        queue.asyncAfter(deadline: .now() + veilIdleAfter) { [self] in veilIdle(window, agent, stamp) }
        followSoon()
    }

    private func veilIdle(_ window: UInt32, _ agent: String, _ stamp: Int) {
        guard var v = veils[window], v.stamps[agent] == stamp else { return }
        v.stamps[agent] = nil
        v.order.removeAll { $0 == agent }
        guard !v.order.isEmpty else { return endVeil(window) }
        let l = veilLook(v.order, environment())
        if v.shown, let p = placed[window] { surface.showVeil(p, look: l) }
        v.look = l
        veils[window] = v
    }

    private func endVeil(_ window: UInt32) {
        if veils[window]?.shown == true { surface.hideVeil(window) }
        veils[window] = nil
    }

    // MARK: following the window

    /// Windows something is drawn over right now.
    private var windowsInUse: Set<UInt32> {
        Set(tracks.values.filter(\.shown).map(\.window)).union(veils.filter(\.value.shown).keys)
    }

    /// Starts the follow check if it isn't running. It runs only while a cursor or a veil is shown.
    private func followSoon() {
        guard !following, !windowsInUse.isEmpty else { return }
        following = true
        queue.asyncAfter(deadline: .now() + Self.followInterval) { [self] in
            guard !windowsInUse.isEmpty else { following = false; return follow(nil) }
            readWindows { [self] list in
                following = false
                follow(list)
                followSoon()
            }
        }
    }

    /// Reads the window list on `host.windowQueue`, never the director's queue, and hands the parsed list back to it.
    private func readWindows(_ then: @escaping ([ScreenWindow]?) -> Void) {
        let read = host.windows, queue = self.queue
        host.windowQueue.async {
            dispatchPrecondition(condition: .notOnQueue(queue))
            let list = read()
            queue.async { then(list) }
        }
    }

    /// One look at the window list now, as the follow timer does (for tests and the probe). The list is read on
    /// `host.windowQueue` and handled on the director's queue.
    public func checkWindows() { readWindows { [self] in follow($0) } }

    /// Each window in use, against one read of the window list: moved, resized, raised or lowered, it is followed;
    /// minimized, closed, on another Space or parked, what is drawn over it hides.
    private func follow(_ read: [ScreenWindow]?) {
        let inUse = windowsInUse
        placed = placed.filter { inUse.contains($0.key) }
        guard !inUse.isEmpty, let list = read else { return }
        let env = environment()
        for w in inUse {
            guard let p = WindowCover.place(w, windows: list, displays: env.displays) else {
                for (agent, t) in tracks where t.window == w && t.shown { hide(agent, forget: true) }
                endVeil(w)
                placed[w] = nil
                surface.windowGone(w)
                continue
            }
            let reorder = !WindowCover.isDirectlyAbove(surface.overlayWindow(for: w), window: w, windows: list)
            let old = placed[w]
            guard old != p || reorder else { continue }
            if let old, old.frame.origin != p.frame.origin {
                // The cursor's layers move with the overlay; where the director thinks it stands moves too.
                let dx = p.frame.minX - old.frame.minX, dy = p.frame.minY - old.frame.minY
                for (agent, var t) in tracks where t.window == w {
                    if let r = t.rest { t.rest = CGPoint(x: r.x + dx, y: r.y + dy) }
                    t.plan = nil
                    tracks[agent] = t
                }
            }
            for agent in tracks.keys where tracks[agent]?.window == w { tracks[agent]?.placement = p }
            placed[w] = p
            surface.place(p, reorder: reorder)
        }
    }
}
