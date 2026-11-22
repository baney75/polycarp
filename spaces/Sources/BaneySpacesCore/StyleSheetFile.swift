#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
import Foundation

/// Where style.css lives, reading it, and writing it whole.
public enum StyleSheetFile {
    public static let name = "style.css"
    public static let maxBytes = 64 * 1024

    /// `<config>/style.css`, the folder `polycarp theme` uses (spec/themes.md, "Polycarp themes"). Nil when the config
    /// folder can't be known (a relative `POLYCARP_CONFIG_DIR`).
    public static func path(env: [String: String] = ProcessInfo.processInfo.environment, home: String? = NSHomeDirectory()) -> String? {
        PolycarpThemeFile.configDir(env: { env[$0] }, home: env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home).map { $0 + "/" + name }
    }

    public enum Loaded: Equatable, Sendable {
        /// No file: no sheet.
        case missing
        case text(String)
        /// Not readable for good: not a regular file, too big, not UTF-8, not allowed.
        case rejected(String)
        /// A read that may pass next time.
        case failed(String)
    }

    /// One read through one handle, as the theme is read (`PolycarpThemeFile.bytes`).
    public static func load(path: String) -> Loaded {
        switch PolycarpThemeFile.bytes(path: path, limit: maxBytes) {
        case .missing: return .missing
        case .rejected(let why): return .rejected(why)
        case .failed(let why): return .failed(why)
        case .data(let data): return decode(data)
        }
    }

    public static func decode(_ data: Data) -> Loaded {
        guard data.count <= maxBytes else { return .rejected("over \(maxBytes) bytes") }
        guard var text = String(data: data, encoding: .utf8) else { return .rejected("not UTF-8 text") }
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        return .text(text)
    }

    /// Writes the whole text: a temp file beside the target, flushed, then renamed over it, so a reader (the app's
    /// watcher, another agent) sees the old file or the new one and never half of one. Makes the folder if need be.
    public static func write(_ text: String, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard text.utf8.count <= maxBytes else { throw StyleWriteError("the sheet would be over \(maxBytes) bytes") }
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(getpid()).\(UInt32.random(in: 0...UInt32.max)).tmp").path
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o644)
        guard fd >= 0 else { throw StyleWriteError("can't write \(dir.path): \(String(cString: strerror(errno)))") }
        var ok = true
        var why = ""
        let bytes = Array(text.utf8)
        bytes.withUnsafeBufferPointer { buf in
            var off = 0
            while off < buf.count {
                #if canImport(Darwin)
                let n = Darwin.write(fd, buf.baseAddress! + off, buf.count - off)
                #else
                let n = Glibc.write(fd, buf.baseAddress! + off, buf.count - off)
                #endif
                if n < 0 { if errno == EINTR { continue }; ok = false; why = String(cString: strerror(errno)); return }
                off += n
            }
        }
        if ok && fsync(fd) != 0 { ok = false; why = String(cString: strerror(errno)) }
        close(fd)
        guard ok, rename(tmp, path) == 0 else {
            if ok { why = String(cString: strerror(errno)) }
            unlink(tmp)
            throw StyleWriteError("can't write \(path): \(why)")
        }
    }

    /// A path with the home folder as `~`, for messages and logs.
    public static func display(_ p: String) -> String {
        let home = NSHomeDirectory()
        return p.hasPrefix(home + "/") ? "~" + p.dropFirst(home.count) : p
    }
}

public struct StyleWriteError: Error, CustomStringConvertible {
    public let description: String
    init(_ d: String) { description = d }
}

// MARK: Following the file

/// Follows style.css the way `PolycarpThemeWatcher` follows the theme: a kqueue watch on the file and the folders above
/// it wakes a background queue, which stats the file and reads it only when the stat changed; a look every 30 s is a
/// safety net. Every change is one `trace.log` line: `style.css: applied, N rules, M problems`, `style.css: removed`, or
/// why it was ignored. A sheet with errors still applies (what parsed), as CSS does, but one an event brought is held
/// 150 ms first and applies only if the file is unchanged by then, so an editor's write in place never flashes half a
/// sheet. Nothing here touches the main thread.
public final class StyleSheetWatcher: @unchecked Sendable {
    private let path: String?
    private let queue: DispatchQueue
    private let log: (String) -> Void
    /// Each sheet with its number: every look that delivers one counts up, so a store can tell an older one.
    private let deliver: (StyleSheet, Int) -> Void
    private let schedule: PolycarpThemeWatcher.Schedule
    private let watch: PolycarpThemeWatcher.Watch
    private let load: (String) -> StyleSheetFile.Loaded
    /// Runs a block on a queue after a delay; tests count the retries it is given.
    typealias After = (DispatchQueue, TimeInterval, @escaping () -> Void) -> Void
    private let after: After
    private let retry: TimeInterval
    private var cancel: (() -> Void)?
    private var unwatch: (() -> Void)?
    private var lookDue = false
    // Only touched on `queue`.
    /// A retry of a failed read is waiting: a read that keeps failing waits on that one, however many events and safety
    /// ticks fail meanwhile, instead of starting a chain of its own each time (review of #604).
    private var retryDue = false
    /// Numbers count up across every watcher, so a store started again after `stop` still takes the new watcher's sheets.
    private static let numbers = NSLock()
    private static var lastNumber = 0
    private static func nextNumber() -> Int {
        numbers.lock(); defer { numbers.unlock() }
        lastNumber += 1
        return lastNumber
    }
    private var last: PolycarpThemeFile.Stamp?
    private var looked = false
    private var lastText: String?
    private var lastProblem: String?
    private var current = StyleSheet.empty
    private var settling: (stamp: PolycarpThemeFile.Stamp?, until: DispatchTime)?

    public convenience init(path: String? = StyleSheetFile.path(),
                queue: DispatchQueue = DispatchQueue(label: "com.baney.polycarp.style", qos: .userInitiated),
                log: @escaping (String) -> Void = { _ in },
                schedule: @escaping PolycarpThemeWatcher.Schedule = PolycarpThemeWatcher.systemTimer,
                watch: @escaping PolycarpThemeWatcher.Watch = PolycarpThemeWatcher.fileEvents,
                retry: TimeInterval = 1,
                deliver: @escaping (StyleSheet) -> Void) {
        self.init(path: path, queue: queue, log: log, schedule: schedule, watch: watch, retry: retry, numbered: { s, _ in deliver(s) })
    }

    init(path: String?, queue: DispatchQueue = DispatchQueue(label: "com.baney.polycarp.style", qos: .userInitiated),
         log: @escaping (String) -> Void = { _ in },
         schedule: @escaping PolycarpThemeWatcher.Schedule = PolycarpThemeWatcher.systemTimer,
         watch: @escaping PolycarpThemeWatcher.Watch = PolycarpThemeWatcher.fileEvents,
         load: @escaping (String) -> StyleSheetFile.Loaded = { StyleSheetFile.load(path: $0) },
         after: @escaping After = { q, t, f in q.asyncAfter(deadline: .now() + t, execute: f) },
         retry: TimeInterval = 1, numbered: @escaping (StyleSheet, Int) -> Void) {
        self.path = path; self.queue = queue; self.log = log; self.schedule = schedule; self.watch = watch
        self.load = load; self.after = after; self.retry = retry; self.deliver = numbered
    }

    /// Starts watching and makes the first look at once, on the watcher's queue, waiting up to `timeout` for it. Returns
    /// the sheet in force when the look finished in time (not also delivered), else nil: `deliver` gets it when it does.
    @discardableResult
    public func start(firstLookWithin timeout: TimeInterval = 0) -> StyleSheet? {
        startNumbered(firstLookWithin: timeout)?.sheet
    }

    /// `start`, with the first look's number.
    func startNumbered(firstLookWithin timeout: TimeInterval = 0) -> (sheet: StyleSheet, generation: Int)? {
        let box = FirstLook()
        let sem = DispatchSemaphore(value: 0)
        queue.async { [self] in
            defer { sem.signal() }
            guard cancel == nil, let path else { return }
            tick { s, n in
                box.lock.lock()
                if box.abandoned || timeout <= 0 { box.lock.unlock(); self.deliver(s, n) } else { box.value = (s, n); box.lock.unlock() }
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
        var value: (sheet: StyleSheet, generation: Int)?
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
            self.tick(fromEvent: true)
        }
    }

    /// One look: stat, read if it changed, stat again (a file that moved while being read waits for its own event).
    /// Call it on `queue` only.
    func tick(into out: ((StyleSheet, Int) -> Void)? = nil, fromEvent: Bool = false) {
        guard let path else { return }
        let before = PolycarpThemeFile.stamp(path)
        if looked && before == last { return }
        let loaded: StyleSheetFile.Loaded = before == nil ? .missing : load(path)
        if PolycarpThemeFile.stamp(path) != before { return }
        let next: StyleSheet
        switch loaded {
        case .failed(let why):
            if why != lastProblem { log("style.css: could not read \(StyleSheetFile.display(path)): \(why); keeping the current sheet and trying again") }
            lastProblem = why
            if cancel != nil, !retryDue {
                retryDue = true
                after(queue, retry) { [weak self] in
                    guard let self else { return }
                    self.retryDue = false
                    if self.cancel != nil { self.tick() }
                }
            }
            return
        case .rejected(let why):
            let line = "style.css: ignored \(StyleSheetFile.display(path)): \(why); no style sheet"
            if line != lastProblem { log(line) }
            lastProblem = line
            lastText = nil
            next = .empty
        case .missing:
            if lastText != nil { log("style.css: removed") }
            lastProblem = nil
            lastText = nil
            next = .empty
        case .text(let text):
            let (sheet, problems) = StyleSheet.parse(text)
            // An event's sheet with errors may be half an edit in place: look again in a moment before it lands.
            if fromEvent, text != lastText, problems.contains(where: \.isError) {
                if let s = settling, s.stamp == before {
                    if DispatchTime.now() < s.until { return }
                } else {
                    let until = DispatchTime.now() + PolycarpThemeWatcher.settle
                    settling = (before, until)
                    queue.asyncAfter(deadline: until) { [weak self] in if self?.cancel != nil { self?.tick(fromEvent: true) } }
                    return
                }
            }
            if text != lastText || lastProblem != nil {
                log("style.css: applied, \(sheet.ruleCount) rule\(sheet.ruleCount == 1 ? "" : "s"), \(problems.count) problem\(problems.count == 1 ? "" : "s")")
            }
            lastProblem = nil
            lastText = text
            next = sheet
        }
        settling = nil
        last = before
        let first = !looked
        looked = true
        guard first || next != current else { return }
        current = next
        (out ?? deliver)(next, Self.nextNumber())
    }

    /// For tests: one look on the watcher's queue, waited for.
    func tickNow() { queue.sync { tick() } }
}

/// The sheet in force for the whole app: what views read and the notification they listen for. `start` once at launch;
/// `current` is safe from any thread. `didChange` is posted on the main queue (never waited for) after `current` already
/// holds the new sheet, with it in `userInfo[StyleSheetStore.key]`.
public final class StyleSheetStore: @unchecked Sendable {
    public static let shared = StyleSheetStore()
    public static let didChange = Notification.Name("com.baney.polycarp.style.didChange")
    public static let key = "sheet"

    private let lock = NSLock()
    private var value = StyleSheet.empty
    /// The number of the sheet in `value`. The first look comes back on the caller's thread while the watcher may already
    /// have delivered a newer sheet on its queue; the older one never replaces it (review of #604).
    private var generation = 0
    private var watcher: StyleSheetWatcher?
    private let center: NotificationCenter

    public init(center: NotificationCenter = .default) { self.center = center }

    public var current: StyleSheet {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    /// Starts following the file. Waits up to `firstLookWithin` for the first read, so the first panel draws with it.
    public func start(path: String? = StyleSheetFile.path(), firstLookWithin timeout: TimeInterval = 0.1,
                      log: @escaping (String) -> Void = { _ in }) {
        lock.lock()
        guard watcher == nil else { lock.unlock(); return }
        let w = StyleSheetWatcher(path: path, log: log) { [weak self] s, n in self?.take(s, generation: n) }
        watcher = w
        lock.unlock()
        if let first = w.startNumbered(firstLookWithin: timeout) { take(first.sheet, generation: first.generation, post: false) }
    }

    public func stop() {
        lock.lock(); let w = watcher; watcher = nil; lock.unlock()
        w?.stop()
    }

    /// Takes sheet number `n` unless a newer one is already in force.
    func take(_ s: StyleSheet, generation n: Int, post: Bool = true) {
        lock.lock()
        guard n > generation else { lock.unlock(); return }
        generation = n
        let changed = s != value
        value = s
        lock.unlock()
        guard post, changed else { return }
        let center = center
        DispatchQueue.main.async { center.post(name: StyleSheetStore.didChange, object: nil, userInfo: [StyleSheetStore.key: s]) }
    }
}
