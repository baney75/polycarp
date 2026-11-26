import AppKit
import ApplicationServices
import BaneySpacesCore

/// Tells BaneySpaces when an app moves focus between its own windows. App activation alone
/// misses this: close a window with ⌘W and the app focuses its next window, which may sit on
/// another workspace, without any app switch. One Accessibility observer per running app.
/// It also hears a window open, close, minimize or come back (spec/tiling-speed.md R-TS6), so a scan of that app
/// starts the moment it happens instead of waiting for something else to look.
final class FocusWatcher {
    enum WindowNote { case created, destroyed, minimized, restored }

    private var observers: [pid_t: AXObserver] = [:]
    /// Apps that should be watched but aren't yet (busy, or refused an observer), when to try
    /// again, and how many tries failed: each failure waits longer, so a frozen app is rarely asked.
    private var retryAfter: [pid_t: Date] = [:]
    private var failures: [pid_t: Int] = [:]
    private var wanted: Set<pid_t> = []

    /// Some app that should be watched isn't yet.
    var missing: Bool { !wanted.subtracting(observers.keys).isEmpty }
    private let onChange: (pid_t) -> Void
    private let onWindow: (pid_t, WindowNote, AXUIElement) -> Void
    /// Windows each app was asked to report closing, minimizing and coming back.
    private var watched: [pid_t: Set<WindowID>] = [:]
    private static let windowNotes = [kAXUIElementDestroyedNotification, kAXWindowMiniaturizedNotification,
                                      kAXWindowDeminiaturizedNotification]

    init(onChange: @escaping (pid_t) -> Void, onWindow: @escaping (pid_t, WindowNote, AXUIElement) -> Void = { _, _, _ in }) {
        self.onChange = onChange
        self.onWindow = onWindow
    }

    /// Asks each app to report its windows' own notes, once per window, off the main thread: each is a call the app
    /// must answer.
    func watchWindows(_ list: [(pid: pid_t, id: WindowID, element: AXUIElement)]) {
        let me = Unmanaged.passUnretained(self).toOpaque()
        var todo: [(AXObserver, AXUIElement)] = []
        let ids = Set(list.map(\.id))
        watched = watched.mapValues { $0.intersection(ids) }
        for w in list where watched[w.pid]?.contains(w.id) != true {
            guard let observer = observers[w.pid] else { continue }
            watched[w.pid, default: []].insert(w.id)
            todo.append((observer, w.element))
        }
        guard !todo.isEmpty else { return }
        Spaces.axQueue.async {
            for (observer, element) in todo {
                for n in Self.windowNotes { AXObserverAddNotification(observer, element, n as CFString, me) }
            }
        }
    }

    /// Watches exactly the apps in `pids`: new apps are added, quit apps dropped.
    func sync(_ pids: Set<pid_t>) {
        wanted = pids
        for pid in Set(observers.keys).subtracting(pids) { remove(pid) }
        retryAfter = retryAfter.filter { pids.contains($0.key) }
        failures = failures.filter { pids.contains($0.key) }
        retry()
    }

    /// Tries again for every wanted app whose wait is over.
    func retry() {
        let now = Date()
        for pid in wanted.subtracting(observers.keys) where Windows.isResponsive(pid) && retryAfter[pid].map({ $0 < now }) ?? true {
            if add(pid) { failures[pid] = nil; retryAfter[pid] = nil; continue }
            let n = failures[pid, default: 0]
            failures[pid] = n + 1
            retryAfter[pid] = now.addingTimeInterval([5, 30, 120, 600][min(n, 3)])
        }
    }

    func removeAll() {
        Array(observers.keys).forEach(remove)
        wanted = []
    }

    @discardableResult
    private func add(_ pid: pid_t) -> Bool {
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, element, note, refcon in
            guard let refcon else { return }
            var pid: pid_t = 0
            guard AXUIElementGetPid(element, &pid) == .success else { return }
            let me = Unmanaged<FocusWatcher>.fromOpaque(refcon).takeUnretainedValue()
            switch note as String {
            case kAXWindowCreatedNotification: me.onWindow(pid, .created, element)
            case kAXUIElementDestroyedNotification: me.onWindow(pid, .destroyed, element)
            case kAXWindowMiniaturizedNotification: me.onWindow(pid, .minimized, element)
            case kAXWindowDeminiaturizedNotification: me.onWindow(pid, .restored, element)
            default: me.onChange(pid)
            }
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { return false }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard app.checked(AXObserverAddNotification(observer, app, kAXFocusedWindowChangedNotification as CFString, me), call: "focus observer") else { return false }
        // The rest are for speed only: an app that refuses one is still watched for focus, and scanned as before.
        for n in [kAXWindowCreatedNotification, kAXMainWindowChangedNotification] { AXObserverAddNotification(observer, app, n as CFString, me) }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        observers[pid] = observer
        return true
    }

    private func remove(_ pid: pid_t) {
        watched[pid] = nil
        guard let observer = observers.removeValue(forKey: pid) else { return }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    }
}
