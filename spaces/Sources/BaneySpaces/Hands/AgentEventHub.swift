import Foundation
import BaneySpacesCore

/// The agent API's events (spec/agent-api.md, "Events"): `polycarp-spaces subscribe` holds a socket connection, and the
/// MCP `events` tool polls a buffer per session. After a change the model publishes (`Spaces.onModelChange`, the look's
/// `Appearance.didChange`), the facts are read once per main-thread turn and diffed for each listener through its own
/// scope, so a window it may not see is never sent.
final class AgentEventHub {
    static let maxSubscribers = 32
    /// Lines waiting for a slow reader; past this, events are dropped and counted in one `lagged` event.
    static let maxPending = 256
    /// A polled session nobody has read for this long is dropped; its next call starts again.
    static let pollIdle: TimeInterval = 600

    private unowned let router: HandsRouter
    private var listeners: [Listener] = []  // main thread
    private var scheduled = false  // main thread

    init(_ router: HandsRouter) { self.router = router }

    var count: Int { router.onMain { listeners.count } }

    private var busy: HandsError {
        HandsError(.inUse, "\(Self.maxSubscribers) subscribers are already listening", suggestion: "Stop one, or query `state` instead.", retry: .safe)
    }

    /// A new subscriber, on its connection's thread. Owns `fd` from here: hello with the whole state, then every change.
    func add(_ fd: Int32, _ req: Wire.Request) {
        let session = req.target ?? ""
        let types: Set<String>?
        switch AgentEvents.filter(req.text) {
        case .failure(let e): return refuse(fd, e)
        case .success(let t): types = t
        }
        guard count < Self.maxSubscribers else { return refuse(fd, busy) }
        guard let (facts, view) = router.apiRead(session: session) else { return refuse(fd, HandsRouter.notStarted) }
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let s = Subscriber(fd: fd, session: session, types: types, old: facts, view: view)
        s.send([AgentEvents.hello(facts, view, types: types)], at: Date())
        // Registered after the read: anything that changed since is in the first diff against it, never lost.
        router.onMain { listeners.append(s) }
        Trace.log("events: subscriber added (\(view.scope)), \(count) listening")
    }

    private func refuse(_ fd: Int32, _ e: HandsError) {
        _ = Wire.writeAll(fd, Data((HandsEnvelope.failure(e).line + "\n").utf8))
        close(fd)
    }

    /// The `events` tool, on the caller's thread. Without `since` it starts this session's events again with hello.
    func poll(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        guard let since = req.int("since") else { return start(session, req.string("events")) }
        guard let p = router.onMain({ listeners.lazy.compactMap { $0 as? Poll }.first { $0.session == session && !$0.isGone } }) else {
            return .failure(HandsError(.badArguments, "this session's events ended (Access changed, or nobody read them for 10 minutes) or never started",
                                       suggestion: "Start again: call events without since. It answers hello with the whole state, the scope in force and the since to pass next.", retry: .never))
        }
        return p.buffer.answer(since: since, waitMs: req.int("wait_ms"))
    }

    private func start(_ session: String, _ filter: String?) -> HandsEnvelope {
        let types: Set<String>?
        switch AgentEvents.filter(filter) {
        case .failure(let e): return .failure(e)
        case .success(let t): types = t
        }
        guard let (facts, view) = router.apiRead(session: session) else { return .failure(HandsRouter.notStarted) }
        let p = Poll(session: session, buffer: AgentEventPoll(types: types), old: facts, view: view)
        p.buffer.push([AgentEvents.hello(facts, view, types: types)], at: Date())
        let added = router.onMain { () -> Bool in
            listeners.removeAll { ($0 as? Poll)?.session == session }
            guard listeners.count < Self.maxSubscribers else { return false }
            listeners.append(p)
            return true
        }
        guard added else { return .failure(busy) }
        return p.buffer.answer(since: 0, waitMs: 0)
    }

    /// Main thread: the model changed. One read and diff per main-thread turn, however many changes it held.
    func changed() {
        guard !listeners.isEmpty, !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [self] in
            scheduled = false
            publish()
        }
    }

    /// Main thread: Donovan changed Access. Every listener ends: `subscribe` closes, and the next `events` call with
    /// `since` fails `invalid_args`. Each starts again with a `hello` in the new scope (review F10).
    func end(_ why: String) {
        guard !listeners.isEmpty else { return }
        for l in listeners { l.finish() }
        Trace.log("events: \(listeners.count) listeners ended, \(why)")
        listeners.removeAll()
    }

    private func publish() {
        listeners.removeAll(where: \.isGone)
        guard !listeners.isEmpty, let now = router.host.facts() else { return }
        let at = Date()
        var batches: [(Listener, [AgentEvents.Event])] = []
        var untitled = Set<UInt32>()
        for l in listeners {
            let view = router.apiView(now, session: l.session)
            // Access changed before its hook ran: the listener ends rather than hear a diff across two scopes (review F10).
            if AgentEvents.ends(l.view, view) { l.finish(); continue }
            let events = AgentEvents.diff(l.old, l.view, now, view)
            l.old = now
            l.view = view
            batches.append((l, events))
            for e in events where e.type == "window_created" && e.data["window"]?["title"]?.string == "" {
                if let id = e.data["window"]?["id"]?.int { untitled.insert(UInt32(id)) }
            }
        }
        // A new window in scope that the window server left untitled gets its title from Accessibility, once.
        let titles = untitled.isEmpty ? [:] : router.host.titles(Array(untitled))
        for (l, events) in batches where !events.isEmpty { l.send(events.map { Self.titled($0, titles) }, at: at) }
        listeners.removeAll(where: \.isGone)
    }

    static func titled(_ e: AgentEvents.Event, _ titles: [UInt32: String]) -> AgentEvents.Event {
        guard e.type == "window_created", case .object(var d) = e.data, case .object(var w)? = d["window"],
              let id = w["id"]?.int, let t = titles[UInt32(id)] else { return e }
        w["title"] = .string(t)
        d["window"] = .object(w)
        return AgentEvents.Event(e.type, .object(d))
    }

    /// One caller the hub diffs for: `old` and `view` are what it last saw (main thread).
    private class Listener {
        let session: String
        var old: AgentAPI.Facts
        var view: AgentAPI.View
        init(session: String, old: AgentAPI.Facts, view: AgentAPI.View) { self.session = session; self.old = old; self.view = view }
        var isGone: Bool { false }
        func send(_ events: [AgentEvents.Event], at: Date) {}
        /// Hears nothing more: a poll is forgotten, a connection closes after the lines already queued.
        func finish() {}
    }

    /// A session polling with the `events` tool.
    private final class Poll: Listener {
        let buffer: AgentEventPoll
        init(session: String, buffer: AgentEventPoll, old: AgentAPI.Facts, view: AgentAPI.View) {
            self.buffer = buffer
            super.init(session: session, old: old, view: view)
        }
        private var ended = false  // main thread
        override var isGone: Bool { ended || Date().timeIntervalSince(buffer.lastRead) > AgentEventHub.pollIdle }
        override func finish() { ended = true }
        override func send(_ events: [AgentEvents.Event], at: Date) { buffer.push(events, at: at) }
    }

    /// One held connection. Its lines are written in order on its own queue, so a slow reader never holds the main thread.
    private final class Subscriber: Listener {
        let fd: Int32
        let types: Set<String>?
        private let queue = DispatchQueue(label: "polycarp.events.subscriber")
        private let lock = NSLock()
        private var pending = 0, missed = 0, seq = 0, closed = false
        private var open = true  // its queue only: the fd is closed once, after every line queued before

        init(fd: Int32, session: String, types: Set<String>?, old: AgentAPI.Facts, view: AgentAPI.View) {
            self.fd = fd; self.types = types
            super.init(session: session, old: old, view: view)
        }

        override var isGone: Bool {
            lock.lock(); defer { lock.unlock() }
            return closed
        }

        /// Sends nothing more, and closes the connection after the lines already queued.
        override func finish() {
            lock.lock(); closed = true; lock.unlock()
            queue.async { self.closeOnce() }
        }

        private func closeOnce() {
            guard open else { return }
            open = false
            close(fd)
        }

        override func send(_ events: [AgentEvents.Event], at: Date) {
            for e in events where types?.contains(e.type) ?? true {
                lock.lock()
                if closed { lock.unlock(); return }
                if pending >= AgentEventHub.maxPending { missed += 1; lock.unlock(); continue }
                pending += 1
                lock.unlock()
                queue.async { self.write(e, at: at) }
            }
        }

        /// `seq` rises by one per line sent; dropped events take no number, and the `lagged` after them says how many.
        private func write(_ e: AgentEvents.Event, at: Date) {
            lock.lock()
            if closed { lock.unlock(); return }
            seq += 1
            let n = seq
            lock.unlock()
            let ok = Wire.writeAll(fd, Data((AgentEvents.line(e, seq: n, at: at) + "\n").utf8))
            lock.lock()
            pending -= 1
            var lagged = 0
            if !ok { closed = true } else if pending == 0, missed > 0 { lagged = missed; missed = 0; pending += 1 }
            lock.unlock()
            if !ok { closeOnce(); return }
            if lagged > 0 { write(AgentEvents.Event("lagged", .object(["missed": .int(lagged)])), at: Date()) }
        }
    }
}
