import Foundation
import BaneySpacesCore

/// `polycarp-spaces subscribe` (spec/agent-api.md, "Events"). Each subscriber is a held socket connection. After a change
/// the model publishes (`Spaces.onModelChange`, the look's `Appearance.didChange`), the facts are read once per main-thread
/// turn and diffed for each subscriber through its own scope, so a window it may not see is never sent.
final class AgentEventHub {
    static let maxSubscribers = 32
    /// Lines waiting for a slow reader; past this, events are dropped and counted in one `lagged` event.
    static let maxPending = 256

    private unowned let router: HandsRouter
    private var subscribers: [Subscriber] = []  // main thread
    private var scheduled = false  // main thread

    init(_ router: HandsRouter) { self.router = router }

    var count: Int { router.onMain { subscribers.count } }

    /// A new subscriber, on its connection's thread. Owns `fd` from here: hello with the whole state, then every change.
    func add(_ fd: Int32, _ req: Wire.Request) {
        let session = req.target ?? ""
        let types: Set<String>?
        switch AgentEvents.filter(req.text) {
        case .failure(let e): return refuse(fd, e)
        case .success(let t): types = t
        }
        guard count < Self.maxSubscribers else {
            return refuse(fd, HandsError(.inUse, "\(Self.maxSubscribers) subscribers are already listening", suggestion: "Stop one, or query `state` instead.", retry: .safe))
        }
        guard let (facts, view) = router.apiRead(session: session) else { return refuse(fd, HandsRouter.notStarted) }
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let s = Subscriber(fd: fd, session: session, types: types, old: facts, view: view)
        s.send([AgentEvents.hello(facts, view, types: types)], at: Date())
        // Registered after the read: anything that changed since is in the first diff against it, never lost.
        router.onMain { subscribers.append(s) }
        Trace.log("events: subscriber added (\(view.scope)), \(count) listening")
    }

    private func refuse(_ fd: Int32, _ e: HandsError) {
        _ = Wire.writeAll(fd, Data((HandsEnvelope.failure(e).line + "\n").utf8))
        close(fd)
    }

    /// Main thread: the model changed. One read and diff per main-thread turn, however many changes it held.
    func changed() {
        guard !subscribers.isEmpty, !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [self] in
            scheduled = false
            publish()
        }
    }

    /// Main thread: Donovan changed Access. Every subscriber ends; each starts again with a `hello` in the new scope.
    func end(_ why: String) {
        guard !subscribers.isEmpty else { return }
        for s in subscribers { s.finish() }
        Trace.log("events: \(subscribers.count) subscribers ended, \(why)")
        subscribers.removeAll()
    }

    private func publish() {
        subscribers.removeAll(where: \.isClosed)
        guard !subscribers.isEmpty, let now = router.host.facts() else { return }
        let at = Date()
        var batches: [(Subscriber, [AgentEvents.Event])] = []
        var untitled = Set<UInt32>()
        for s in subscribers {
            let view = router.apiView(now, session: s.session)
            // Access changed before its hook ran: the listener ends rather than hear a diff across two scopes (review F10).
            if AgentEvents.ends(s.view, view) { s.finish(); continue }
            let events = AgentEvents.diff(s.old, s.view, now, view)
            s.old = now
            s.view = view
            batches.append((s, events))
            for e in events where e.type == "window_created" && e.data["window"]?["title"]?.string == "" {
                if let id = e.data["window"]?["id"]?.int { untitled.insert(UInt32(id)) }
            }
        }
        // A new window in scope that the window server left untitled gets its title from Accessibility, once.
        let titles = untitled.isEmpty ? [:] : router.host.titles(Array(untitled))
        for (s, events) in batches { s.send(events.map { Self.titled($0, titles) }, at: at) }
        subscribers.removeAll(where: \.isClosed)
    }

    static func titled(_ e: AgentEvents.Event, _ titles: [UInt32: String]) -> AgentEvents.Event {
        guard e.type == "window_created", case .object(var d) = e.data, case .object(var w)? = d["window"],
              let id = w["id"]?.int, let t = titles[UInt32(id)] else { return e }
        w["title"] = .string(t)
        d["window"] = .object(w)
        return AgentEvents.Event(e.type, .object(d))
    }

    /// One held connection. Its lines are written in order on its own queue, so a slow reader never holds the main thread.
    private final class Subscriber {
        let fd: Int32
        let session: String
        let types: Set<String>?
        var old: AgentAPI.Facts  // main thread
        var view: AgentAPI.View  // main thread
        private let queue = DispatchQueue(label: "polycarp.events.subscriber")
        private let lock = NSLock()
        private var pending = 0, missed = 0, seq = 0, closed = false
        private var open = true  // its queue only: the fd is closed once, after every line queued before

        init(fd: Int32, session: String, types: Set<String>?, old: AgentAPI.Facts, view: AgentAPI.View) {
            self.fd = fd; self.session = session; self.types = types; self.old = old; self.view = view
        }

        var isClosed: Bool {
            lock.lock(); defer { lock.unlock() }
            return closed
        }

        /// Sends nothing more, and closes the connection after the lines already queued.
        func finish() {
            lock.lock(); closed = true; lock.unlock()
            queue.async { self.closeOnce() }
        }

        private func closeOnce() {
            guard open else { return }
            open = false
            close(fd)
        }

        func send(_ events: [AgentEvents.Event], at: Date) {
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
