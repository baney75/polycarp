import Foundation

/// Follows surfaces.json the way `PolycarpThemeWatcher` follows the theme: a kqueue watch on the file and the folders
/// above it (`PathEvents`) wakes a background queue, which stats the file and reads it only when the stat changed. A safety
/// look every 30 s catches a change no event reported. An invalid file never takes effect: the last good config stays,
/// and the reason is logged once. A missing file is every default. Nothing here touches the main thread.
public final class SurfacesWatcher: @unchecked Sendable {
    private let path: String
    private let queue: DispatchQueue
    private let log: (String) -> Void
    private let deliver: (Surfaces) -> Void
    private let schedule: PolycarpThemeWatcher.Schedule
    private let watch: PolycarpThemeWatcher.Watch
    private let retry: TimeInterval
    private var cancel: (() -> Void)?
    private var unwatch: (() -> Void)?
    private var lookDue = false
    // Only touched on `queue`.
    private var last: PolycarpThemeFile.Stamp?
    private var looked = false
    private var current = Surfaces.defaults
    private var lastProblem: String?

    public init(path: String = SurfacesFile.path(),
                queue: DispatchQueue = DispatchQueue(label: "com.baney.polycarp.surfaces", qos: .userInitiated),
                log: @escaping (String) -> Void = { _ in },
                schedule: @escaping PolycarpThemeWatcher.Schedule = PolycarpThemeWatcher.systemTimer,
                watch: @escaping PolycarpThemeWatcher.Watch = PolycarpThemeWatcher.fileEvents,
                retry: TimeInterval = 1,
                deliver: @escaping (Surfaces) -> Void) {
        self.path = path; self.queue = queue; self.log = log; self.schedule = schedule; self.watch = watch
        self.retry = retry; self.deliver = deliver
    }

    /// Starts watching and makes the first look at once, on the watcher's queue, waiting up to `timeout` for it. Returns
    /// the config in force when the look finished in time (not also delivered), else nil: `deliver` gets it when it does.
    @discardableResult
    public func start(firstLookWithin timeout: TimeInterval = 0) -> Surfaces? {
        let box = FirstLook()
        let sem = DispatchSemaphore(value: 0)
        queue.async { [self] in
            defer { sem.signal() }
            guard cancel == nil else { return }
            tick { s in
                box.lock.lock()
                if box.abandoned || timeout <= 0 { box.lock.unlock(); self.deliver(s) } else { box.value = s; box.lock.unlock() }
            }
            cancel = schedule(queue, PolycarpThemeWatcher.safetyInterval, PolycarpThemeWatcher.safetyInterval) { [weak self] in self?.tick() }
            unwatch = watch(queue, path) { [weak self] in self?.changed() }
        }
        guard timeout > 0 else { return nil }
        _ = sem.wait(timeout: .now() + timeout)
        box.lock.lock(); defer { box.lock.unlock() }
        if box.value == nil { box.abandoned = true }
        return box.value
    }

    private final class FirstLook: @unchecked Sendable {
        let lock = NSLock()
        var value: Surfaces?
        var abandoned = false
    }

    public func stop() {
        queue.async { [self] in cancel?(); cancel = nil; unwatch?(); unwatch = nil }
    }

    /// Events that arrive together make one look, after those already queued.
    private func changed() {
        guard !lookDue else { return }
        lookDue = true
        queue.async { [weak self] in
            guard let self, self.cancel != nil else { return }
            self.lookDue = false
            self.tick()
        }
    }

    /// One look: stat, read if it changed, stat again (a file that moved while being read waits for its own event).
    /// Call it on `queue` only.
    func tick(into out: ((Surfaces) -> Void)? = nil) {
        let before = PolycarpThemeFile.stamp(path)
        if looked && before == last { return }
        let loaded: SurfacesFile.Loaded = before == nil ? .missing : SurfacesFile.load(path: path)
        if PolycarpThemeFile.stamp(path) != before { return }
        let next: Surfaces
        switch loaded {
        case .failed(let why):
            if why != lastProblem { log("surfaces: could not read \(SurfacesOps.display(path)): \(why); keeping the current config and trying again") }
            lastProblem = why
            if cancel != nil { queue.asyncAfter(deadline: .now() + retry) { [weak self] in if self?.cancel != nil { self?.tick() } } }
            return
        case .rejected(let why):
            note("surfaces: ignored \(SurfacesOps.display(path)): \(why); keeping the last good config")
            next = current
        case .invalid(let e, _):
            note("surfaces: ignored \(SurfacesOps.display(path)): \(e.summary); keeping the last good config")
            next = current
        case .missing:
            if looked && lastProblem == nil && current != .defaults { log("surfaces: file removed, every default is back") }
            lastProblem = nil
            next = .defaults
        case .document(let d):
            if lastProblem != nil || !looked || d.surfaces != current { log("surfaces: loaded \(SurfacesOps.display(path))") }
            lastProblem = nil
            next = d.surfaces
        }
        last = before
        let first = !looked
        looked = true
        guard first || next != current else { return }
        current = next
        (out ?? deliver)(next)
    }

    private func note(_ line: String) {
        if line != lastProblem { log(line) }
        lastProblem = line
    }

    /// For tests: one look on the watcher's queue, waited for.
    func tickNow() { queue.sync { tick() } }
}

/// The config in force for the whole app: what views read and the notification they listen for. `start` once at
/// launch; `current` is safe from any thread. `didChange` is posted on the main queue (never waited for) after
/// `current` already holds the new config, with it in `userInfo[SurfacesStore.key]`.
public final class SurfacesStore: @unchecked Sendable {
    public static let shared = SurfacesStore()
    public static let didChange = Notification.Name("com.baney.polycarp.surfaces.didChange")
    public static let key = "surfaces"

    private let lock = NSLock()
    private var value = Surfaces.defaults
    private var watcher: SurfacesWatcher?
    private let center: NotificationCenter

    public init(center: NotificationCenter = .default) { self.center = center }

    public var current: Surfaces {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    /// Starts following the file. Waits up to `firstLookWithin` for the first read, so the first panel draws with it.
    public func start(path: String = SurfacesFile.path(), firstLookWithin timeout: TimeInterval = 0.1,
                      log: @escaping (String) -> Void = { _ in }) {
        lock.lock()
        guard watcher == nil else { lock.unlock(); return }
        let w = SurfacesWatcher(path: path, log: log) { [weak self] s in self?.take(s) }
        watcher = w
        lock.unlock()
        if let first = w.start(firstLookWithin: timeout) { take(first, post: false) }
    }

    public func stop() {
        lock.lock(); let w = watcher; watcher = nil; lock.unlock()
        w?.stop()
    }

    private func take(_ s: Surfaces, post: Bool = true) {
        lock.lock()
        let changed = s != value
        value = s
        lock.unlock()
        guard post, changed else { return }
        let center = center
        DispatchQueue.main.async { center.post(name: SurfacesStore.didChange, object: nil, userInfo: [SurfacesStore.key: s]) }
    }
}
