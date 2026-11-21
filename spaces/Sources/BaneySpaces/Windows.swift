import AppKit
import ApplicationServices
import BaneySpacesCore

// Private but stable since macOS 10.x: the WindowServer number behind an Accessibility window.
// Every window manager on the Mac relies on it; there is no public way to match the two.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError
// Private but stable, as above: which macOS desktops a window is on, and the desktop each
// display is showing. yabai and AltTab rely on the same calls.
@_silgen_name("CGSMainConnectionID")
private func CGSMainConnectionID() -> Int32
@_silgen_name("CGSCopySpacesForWindows")
private func CGSCopySpacesForWindows(_ cid: Int32, _ mask: Int32, _ windows: CFArray) -> Unmanaged<CFArray>?
@_silgen_name("CGSCopyManagedDisplaySpaces")
private func CGSCopyManagedDisplaySpaces(_ cid: Int32) -> CFArray

/// One real window, reached through Accessibility.
struct Window {
    let id: WindowID
    let element: AXUIElement
    let pid: pid_t
    let appName: String

    var frame: CGRect? {
        guard Windows.isResponsive(pid), let p: CGPoint = element.value(kAXPositionAttribute, .cgPoint),
              let s: CGSize = element.value(kAXSizeAttribute, .cgSize) else { return nil }
        return CGRect(origin: p, size: s)
    }

    var isMinimized: Bool { Windows.isResponsive(pid) && element.bool(kAXMinimizedAttribute) }
    var title: String { Windows.isResponsive(pid) ? element.string(kAXTitleAttribute) ?? "" : "" }
    var isFullScreen: Bool { Windows.isResponsive(pid) && element.bool("AXFullScreen") }

    func setOrigin(_ p: CGPoint, file: String = #fileID, line: Int = #line) {
        guard Windows.isResponsive(pid) else { return }
        DragFrameTrace.write(id, .origin, origin: p, size: nil, file: file, line: line)
        withoutAnimation { element.set(kAXPositionAttribute, p, .cgPoint) }
    }
    func setSize(_ s: CGSize, file: String = #fileID, line: Int = #line) {
        guard Windows.isResponsive(pid) else { return }
        DragFrameTrace.write(id, .size, origin: nil, size: s, file: file, line: line)
        withoutAnimation { element.set(kAXSizeAttribute, s, .cgSize) }
    }
    /// Moves a window back to `r`. A parked window kept its size, so usually one move is all it
    /// takes; resizing makes apps lay out again, which is slow and can flicker.
    func place(_ r: CGRect, currentSize: CGSize, file: String = #fileID, line: Int = #line) {
        if currentSize == r.size { setOrigin(r.origin, file: file, line: line) } else { setFrame(r, file: file, line: line) }
    }

    func setFrame(_ r: CGRect, file: String = #fileID, line: Int = #line) {
        guard Windows.isResponsive(pid) else { return }
        DragFrameTrace.write(id, .frame, origin: r.origin, size: r.size, file: file, line: line)
        // Size, move, size again: a window that would cross a screen edge gets clamped otherwise.
        withoutAnimation {
            element.set(kAXSizeAttribute, r.size, .cgSize)
            element.set(kAXPositionAttribute, r.origin, .cgPoint)
            element.set(kAXSizeAttribute, r.size, .cgSize)
        }
    }

    /// While an app has AXEnhancedUserInterface on, AppKit animates every move made through
    /// Accessibility: a parked window slid across the screen to the corner for a fifth of a
    /// second (Ghostty, measured: 20 positions; with it off, one). Chromium browsers turn it on,
    /// and assistive tools can turn it on for every app. It's off for the move and back on right
    /// after, which leaves the move instant and whoever wanted it on unaffected.
    private func withoutAnimation(_ move: () -> Void) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        let key = "AXEnhancedUserInterface" as CFString
        var raw: CFTypeRef?
        let on = AXUIElementCopyAttributeValue(app, key, &raw) == .success && (raw as? Bool) == true
        if on { AXUIElementSetAttributeValue(app, key, kCFBooleanFalse) }
        move()
        guard on, AXUIElementSetAttributeValue(app, key, kCFBooleanTrue) != .success else { return }
        // Busy laying out after a resize: try again in a moment, with longer to answer, so
        // whoever turned it on (VoiceOver, automation) doesn't lose it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            AXUIElementSetMessagingTimeout(app, 0.5)
            AXUIElementSetAttributeValue(app, key, kCFBooleanTrue)
        }
    }

    func unminimize() {
        AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }

    func exitFullScreen() {
        AXUIElementSetAttributeValue(element, "AXFullScreen" as CFString, kCFBooleanFalse)
    }

    func pressFullScreenButton() {
        guard let button: AXUIElement = element.value(kAXFullScreenButtonAttribute) else { return }
        AXUIElementPerformAction(button, kAXPressAction as CFString)
    }

    /// Raises the window and brings its app forward; whether the raise took. An app busy coming
    /// back from hiding can stall each call, so the calls wait briefly and stop at the first
    /// timeout. Other errors (a window that can't be made main) don't stop the raise.
    @discardableResult
    func focus() -> Bool {
        defer { NSRunningApplication(processIdentifier: pid)?.activate() }
        AXUIElementSetMessagingTimeout(element, 0.1)
        defer { AXUIElementSetMessagingTimeout(element, 0) }
        let main = AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
        guard main != .cannotComplete else { element.checked(main, call: "set AXMain"); return false }
        let raise = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
        guard raise != .cannotComplete else { element.checked(raise, call: "raise"); return false }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        app.checked(AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue), call: "set AXFrontmost")
        return raise == .success
    }
}

/// The regular apps that are running, kept current by launch and quit notifications instead of
/// asking macOS about every app on every switch (about 12 ms each time).
enum RunningApps {
    private static var cached: Set<pid_t>?
    private static var observing = false

    /// Forget the cached list; the next read asks macOS again. Apps can turn into regular apps
    /// after launch (menu bar apps that open a window), which no notification announces.
    static func invalidate() { cached = nil }

    static var regular: Set<pid_t> {
        if !observing {
            observing = true
            let center = NSWorkspace.shared.notificationCenter
            for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
                center.addObserver(forName: name, object: nil, queue: .main) { _ in cached = nil }
            }
        }
        if let cached { return cached }
        let me = getpid()
        let set = Set(NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && !$0.isTerminated && $0.processIdentifier != me }
            .map(\.processIdentifier))
        cached = set
        return set
    }

    /// Which of `pids` are hidden (⌘H). Main thread.
    static func hidden(among pids: Set<pid_t>) -> Set<pid_t> {
        let facts = facts()
        return pids.filter { (facts[$0]?.hidden ?? (NSRunningApplication(processIdentifier: $0)?.isHidden == true)) }
    }

    /// Every running app as the Background tile reads it (`BackgroundApps.list`). `untracked` is asked only for a
    /// regular app with no window in `tracked`: whether it shows a window Polycarp doesn't track. Main thread.
    static func forBackground(tracked: Set<pid_t>, untracked: (pid_t) -> Bool) -> [BackgroundApps.Running] {
        facts().values.map { f in
            BackgroundApps.Running(pid: f.pid, name: f.name, bundleID: f.bundleID, isRegular: f.regular,
                                   isTerminated: f.terminated, isHidden: f.hidden, launchedAt: f.launchedAt,
                                   hasUntrackedWindow: f.regular && !tracked.contains(f.pid) && untracked(f.pid))
        }
    }

    /// What a dock open reads of one running app.
    struct Facts {
        let pid: pid_t
        let regular: Bool
        let terminated: Bool
        let hidden: Bool
        let name: String
        let bundleID: String?
        let launchedAt: Date?
    }

    /// Reading those for every running app (about 130) costs 25 to 30 ms: each `NSRunningApplication` fetches its
    /// state on first read, and name and launch date on every read. Until 2026-11-21 every dock open paid that on the
    /// main thread. Now the dock asks for it while the pointer rests on the edge (`prepare`, during the 120 ms dwell),
    /// it is read off the main thread, and the open uses it. It is used for `freshFor` seconds, and never after an app
    /// launched, quit, hid or unhid; an open without one (a script's `dock/show`) reads it on the spot, as before.
    static let freshFor: TimeInterval = 0.5
    private static var prepared: (facts: [pid_t: Facts], at: TimeInterval, seed: Int)?
    private static var preparing = false
    /// Bumped by every launch, quit, hide and unhide: a read from before one is stale.
    private static var seed = 0
    private static var watchingFacts = false
    private static let factsQueue = DispatchQueue(label: "com.baney.polycarp.running-apps", qos: .userInteractive)

    /// Starts reading the facts off the main thread, unless a fresh read is at hand or one is running. Main thread.
    static func prepare() {
        watchFacts()
        let now = ProcessInfo.processInfo.systemUptime
        if let p = prepared, p.seed == seed, now - p.at < freshFor / 2 { return }
        guard !preparing else { return }
        preparing = true
        let started = seed
        factsQueue.async {
            let facts = readFacts()
            DispatchQueue.main.async {
                preparing = false
                guard seed == started else { return }
                prepared = (facts, ProcessInfo.processInfo.systemUptime, started)
            }
        }
    }

    /// The fresh read if there is one, else a read now. Main thread.
    static func facts() -> [pid_t: Facts] {
        watchFacts()
        let now = ProcessInfo.processInfo.systemUptime
        if let p = prepared, p.seed == seed, now - p.at < freshFor { return p.facts }
        let facts = readFacts()
        prepared = (facts, now, seed)
        return facts
    }

    /// Whether `facts()` would answer without reading (for the dock bench).
    static var factsPrepared: Bool {
        guard let p = prepared else { return false }
        return p.seed == seed && ProcessInfo.processInfo.systemUptime - p.at < freshFor
    }

    /// NSRunningApplication's properties are safe to read from any thread (AppKit returns them atomically).
    private static func readFacts() -> [pid_t: Facts] {
        var out: [pid_t: Facts] = [:]
        for a in NSWorkspace.shared.runningApplications {
            out[a.processIdentifier] = Facts(pid: a.processIdentifier, regular: a.activationPolicy == .regular, terminated: a.isTerminated,
                                             hidden: a.isHidden, name: a.localizedName ?? a.bundleIdentifier ?? "App",
                                             bundleID: a.bundleIdentifier, launchedAt: a.launchDate)
        }
        return out
    }

    private static func watchFacts() {
        guard !watchingFacts else { return }
        watchingFacts = true
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                     NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { _ in seed += 1 }
        }
    }
}

enum Windows {
    /// Apps that stopped answering Accessibility, and when to ask them again (`AXBench`): one hung app costs a full
    /// timeout per call, so skipping it keeps every switch quick; one still starting is asked again within a second.
    private static var bench = AXBench()
    private static let unresponsiveLock = NSLock()

    static func isResponsive(_ pid: pid_t) -> Bool {
        unresponsiveLock.lock(); defer { unresponsiveLock.unlock() }
        let now = Date()
        return !bench.isBenched(pid, now: now)
    }

    static func markUnresponsive(_ pid: pid_t, call: String, error: AXError) {
        let app = NSRunningApplication(processIdentifier: pid)
        let age = app?.launchDate.map { -$0.timeIntervalSinceNow }
        // No app is waited on for its first window now (`AXBench`, review 157 F8): every miss takes the hung back-off.
        let waitedOn = false
        unresponsiveLock.lock()
        let now = Date()
        let already = bench.isBenched(pid, now: now)
        let delay = bench.missed(pid, age: age, waitedOn: waitedOn, now: now)
        unresponsiveLock.unlock()
        // Which app went unseen and for how long: a window it opens meanwhile isn't placed until it answers.
        if !already { Trace.log(AXBench.missLine(app: app?.localizedName ?? "app", pid: pid, call: call, error: error.rawValue, delay: delay)) }
    }

    /// The app answered, or the person brought it forward: give it a clean slate.
    static func markResponsive(_ pid: pid_t) {
        unresponsiveLock.lock(); defer { unresponsiveLock.unlock() }
        bench.answered(pid)
    }

    /// Forgets the apps that quit, so the bench doesn't grow with every pid a session saw.
    static func keepBench(_ alive: Set<pid_t>) {
        unresponsiveLock.lock(); defer { unresponsiveLock.unlock() }
        bench.keep(alive)
    }

    /// Every app asked again on the next scan (the Mac woke).
    static func clearBench() {
        unresponsiveLock.lock(); defer { unresponsiveLock.unlock() }
        bench.clear()
    }

    /// Seconds until the first benched app may be asked again, for the retry timer.
    static func retryDelay() -> TimeInterval {
        unresponsiveLock.lock(); defer { unresponsiveLock.unlock() }
        return bench.retryDelay(now: Date())
    }

    /// One app's answer to a scan. `answered` is false when it didn't list its windows (timed out, refused, or skipped
    /// because it is benched); `partial` when it gave an element whose number couldn't be read: only an app that
    /// answered in full can say a window it didn't list is closed.
    struct Answer {
        var windows: [Window] = []
        var listed: Set<WindowID> = []
        var partial = false
        var notWindows: Set<WindowID> = []
        var asking: [WaitingWindow.Seen] = []
        var details: [WindowID: WindowDetails] = [:]
        var answered = false
    }

    /// Every standard window of the apps in `apps` (regular apps, never Polycarp itself), each app asked in parallel.
    /// Dialogs, panels, popovers and windows on other macOS desktops are left alone. Safe off the main thread, and only
    /// ever called there except at launch and quit (`Spaces.refreshNow`): an app that doesn't answer costs its 0.25 s
    /// timeout, and the main thread must never wait on another app (2026-11-21).
    /// `listed` is every window number the app gave, of any kind. `notWindows` are listed elements whose subrole was
    /// read and isn't a standard window's (sheets, panels). One whose subrole couldn't be read is neither: it stays
    /// unplaced, so `UnplacedWindows` looks at it again. `asking` are the listed elements that wait on you
    /// (`WaitingWindow.asks`: a dialog, an alert, anything modal). `details` holds each standard window's title and
    /// minimized state, so the dock and the launcher never ask for them on the main thread.
    static func all(asking apps: Set<pid_t>) -> [pid_t: Answer] {
        let named = apps.compactMap { pid -> (pid_t, String)? in
            guard isResponsive(pid), let app = NSRunningApplication(processIdentifier: pid) else { return nil }
            return (pid, app.localizedName ?? "App")
        }
        var out = Dictionary(uniqueKeysWithValues: apps.map { ($0, Answer()) })
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: named.count) { i in
            let (pid, name) = named[i]
            let ax = AXUIElementCreateApplication(pid)
            // A hung app must not hold up the scan for long.
            AXUIElementSetMessagingTimeout(ax, 0.25)
            var raw: CFTypeRef?
            let error = AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &raw)
            let listed = error == .success ? raw as? [AXUIElement] : nil
            // Any failure, not just a timeout, counts: otherwise an app that answers with an error
            // would be retried at full speed forever instead of backing off.
            if listed == nil { markUnresponsive(pid, call: kAXWindowsAttribute, error: error) } else { markResponsive(pid) }
            var a = Answer()
            a.answered = listed != nil
            let elements = listed ?? []
            let ids = elements.map(\.windowID)
            var asks: [WaitingWindow.Seen] = []
            for (el, id) in zip(elements, ids) {
                AXUIElementSetMessagingTimeout(el, 0.25)
                guard let id, let subrole = el.string(kAXSubroleAttribute) else { continue }
                let modal = (el.value(kAXModalAttribute) as NSNumber?)?.boolValue
                if subrole == kAXStandardWindowSubrole as String {
                    a.windows.append(Window(id: id, element: el, pid: pid, appName: name))
                    a.details[id] = WindowDetails(title: el.string(kAXTitleAttribute) ?? "", minimized: el.bool(kAXMinimizedAttribute))
                    // A standard window that blocks its app (a lent app's modal) waits on you too:
                    // placed like any window, and marked when it is out of sight.
                    if modal == true { asks.append(.init(id: id, pid: pid, subrole: subrole, modal: true)) }
                    continue
                }
                a.notWindows.insert(id)
                if WaitingWindow.asks(subrole: subrole, modal: modal) { asks.append(.init(id: id, pid: pid, subrole: subrole, modal: modal)) }
            }
            a.asking = asks
            a.listed = Set(ids.compactMap { $0 })
            a.partial = ids.contains(nil)
            lock.lock()
            out[pid] = a
            lock.unlock()
        }
        return out
    }

    /// Titles and minimized state of `windows`, read again (titles change with every tab). Off the main thread only;
    /// an app that is benched or doesn't answer keeps what it had.
    static func details(of windows: [Window]) -> [WindowID: WindowDetails] {
        let byApp = Dictionary(grouping: windows.filter { isResponsive($0.pid) }, by: \.pid).map(\.value)
        var out: [WindowID: WindowDetails] = [:]
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: byApp.count) { i in
            var mine: [WindowID: WindowDetails] = [:]
            for w in byApp[i] {
                guard isResponsive(w.pid) else { break }
                AXUIElementSetMessagingTimeout(w.element, 0.25)
                var raw: CFTypeRef?
                let error = AXUIElementCopyAttributeValue(w.element, kAXTitleAttribute as CFString, &raw)
                guard w.element.checked(error, call: kAXTitleAttribute) else { continue }
                mine[w.id] = WindowDetails(title: raw as? String ?? "", minimized: w.element.bool(kAXMinimizedAttribute))
            }
            lock.lock(); out.merge(mine) { a, _ in a }; lock.unlock()
        }
        return out
    }

    /// What `Spaces` needs to know about one app when it comes forward or moves focus between its windows, asked in one
    /// go off the main thread: its focused window (number, frame, full screen), whether each of `windows` is
    /// minimized, and the window numbers it lists (all kinds, and standard ones). `listed` is nil when it didn't answer.
    struct FocusLook {
        var focused: WindowID?
        var frame: CGRect?
        var fullScreen = false
        var minimized: [WindowID: Bool] = [:]
        var listed: Set<WindowID>?
        var standard: Set<WindowID> = []
    }

    static func look(at pid: pid_t, windows: [Window]) -> FocusLook {
        var look = FocusLook()
        guard isResponsive(pid) else { return look }
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.25)
        if let el: AXUIElement = ax.value(kAXFocusedWindowAttribute) {
            AXUIElementSetMessagingTimeout(el, 0.25)
            look.focused = el.windowID
            if let p: CGPoint = el.value(kAXPositionAttribute, .cgPoint), let size: CGSize = el.value(kAXSizeAttribute, .cgSize) {
                look.frame = CGRect(origin: p, size: size)
            }
            look.fullScreen = el.bool("AXFullScreen")
        }
        for w in windows where w.pid == pid && isResponsive(pid) {
            AXUIElementSetMessagingTimeout(w.element, 0.25)
            look.minimized[w.id] = w.element.bool(kAXMinimizedAttribute)
        }
        if let elements: [AXUIElement] = ax.value(kAXWindowsAttribute) {
            look.listed = Set(elements.compactMap(\.windowID))
            look.standard = Set(elements.compactMap { el in
                el.string(kAXSubroleAttribute) == kAXStandardWindowSubrole as String ? el.windowID : nil
            })
        }
        return look
    }

    /// The app in front's frontmost window among `windows`, from the window server's stacking order, which answers
    /// without asking the app: an app's focused window is its frontmost one. `preferring` wins over the rest when
    /// both are listed (windows not parked at the hiding spot). For the main thread.
    static func front(in windows: [WindowID: Window], preferring keep: (WindowID) -> Bool = { _ in true }) -> Window? {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        var fallback: Window?
        for w in info {
            guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value, let win = windows[id] else { continue }
            if keep(id) { return win }
            if fallback == nil { fallback = win }
        }
        return fallback
    }

    static func alive() -> Set<WindowID> { snapshot(apps: RunningApps.regular).alive }

    /// Every window number, plus the ordinary app windows (layer 0) among them. When the layer-0
    /// set hasn't changed since the last look, no window was opened or closed, and the full
    /// Accessibility scan can be skipped.
    /// `offscreen` holds the app windows the window server isn't drawing (a hidden app's,
    /// minimized ones, ones on another macOS desktop, and ones the app closed but kept), by owner;
    /// `onScreen` the rest.
    static func snapshot(apps: Set<pid_t>) -> (alive: Set<WindowID>, appWindows: Set<WindowID>, owners: Set<pid_t>, offscreen: [WindowID: pid_t], onScreen: [WindowID: pid_t]) {
        let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        var alive = Set<WindowID>(), appWindows = Set<WindowID>(), owners = Set<pid_t>(), offscreen: [WindowID: pid_t] = [:], onScreen: [WindowID: pid_t] = [:]
        for w in info {
            guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
            alive.insert(id)
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, apps.contains(pid) else { continue }
            appWindows.insert(id)
            owners.insert(pid)
            if (w[kCGWindowIsOnscreen as String] as? Bool) != true { offscreen[id] = pid } else { onScreen[id] = pid }
        }
        return (alive, appWindows, owners, offscreen, onScreen)
    }

    /// Whether a window is on no macOS desktop at all, or on one a display is showing. A window
    /// the app closed but kept (Ghostty keeps every one; so does Music), or a tab behind
    /// another tab, is one of these and off screen. A window on another desktop, or in full
    /// screen on its own, is neither: Accessibility just can't see it from here.
    static func onNoOtherDesktop(_ id: WindowID) -> Bool {
        let cid = CGSMainConnectionID()
        guard let raw = CGSCopySpacesForWindows(cid, 0x7, [id] as CFArray)?.takeRetainedValue() as? [NSNumber] else { return false }
        let spaces = Set(raw.map(\.intValue))
        if spaces.isEmpty { return true }
        guard let displays = CGSCopyManagedDisplaySpaces(cid) as? [[String: Any]] else { return false }
        let shown = Set(displays.compactMap { ($0["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int })
        return !shown.isEmpty && spaces.isSubset(of: shown)
    }

    /// The app that receives keystrokes. Accessibility's system-wide answer often fails or goes
    /// stale, so it is only the fallback.
    static func focusedPid() -> pid_t? {
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier { return pid }
        guard let app: AXUIElement = AXUIElementCreateSystemWide().value(kAXFocusedApplicationAttribute) else { return nil }
        var pid: pid_t = 0
        return AXUIElementGetPid(app, &pid) == .success && pid > 0 ? pid : nil
    }

    /// Brings an app to the front through Accessibility, which works even when macOS would
    /// refuse a plain activation request from a background app.
    static func makeFrontmost(_ pid: pid_t) {
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        NSRunningApplication(processIdentifier: pid)?.activate()
    }

    /// Whether the app still lists this window among its open ones. Some apps hide a window on
    /// ⌘W instead of closing it, so the window server alone can't tell.
    /// The app's standard windows that Accessibility lists, by number: what a new window looks
    /// like to BaneySpaces. The window server also lists every app's invisible helper windows
    /// (Ghostty has 14), which come and go on their own.
    static func standardIDs(of pid: pid_t) -> Set<WindowID> {
        guard isResponsive(pid) else { return [] }
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.1)
        let listed: [AXUIElement] = ax.value(kAXWindowsAttribute) ?? []
        return Set(listed.compactMap { el in
            el.string(kAXSubroleAttribute) == kAXStandardWindowSubrole as String ? el.windowID : nil
        })
    }

    /// Every window number the app lists, of any kind; nil when it doesn't answer in full.
    static func listedIDs(of pid: pid_t) -> Set<WindowID>? {
        guard isResponsive(pid) else { return nil }
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.25)
        guard let listed: [AXUIElement] = ax.value(kAXWindowsAttribute) else { return nil }
        let ids = listed.map(\.windowID)
        return ids.contains(nil) ? nil : Set(ids.compactMap { $0 })
    }

    static func lists(_ id: WindowID, pid: pid_t) -> Bool {
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.25)
        let listed: [AXUIElement] = ax.value(kAXWindowsAttribute) ?? []
        return listed.contains { $0.windowID == id }
    }

    /// Each window's owner and frame from the window server, which answers even when the app
    /// doesn't. Frames are in Accessibility coordinates (top-left origin).
    static func serverWindows() -> [WindowID: (pid: pid_t, bounds: CGRect?)] {
        let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        var result: [WindowID: (pid: pid_t, bounds: CGRect?)] = [:]
        for w in info {
            guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
            let bounds = (w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
            result[id] = (pid, bounds)
        }
        return result
    }

    /// The windows on screen right now, from the window server.
    static func onScreenIDs() -> Set<WindowID> {
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        return Set(info.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value })
    }

    /// Whether the window in front is in full screen, on its own macOS Space.
    static func frontIsFullScreen() -> Bool {
        guard let pid = focusedPid() else { return false }
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.25)
        guard let el: AXUIElement = ax.value(kAXFocusedWindowAttribute) else { return false }
        return el.bool("AXFullScreen")
    }

    /// The frames a full-screen window can have, in Accessibility coordinates: the whole screen,
    /// and on a display with a camera notch, the screen below it (where macOS puts full screen
    /// by default).
    static func fullScreenFrames() -> [CGRect] {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSScreen.screens.flatMap { screen -> [CGRect] in
            let f = Geometry.toAX(screen.frame, primaryHeight: primaryHeight)
            let top = screen.safeAreaInsets.top
            return top > 0 ? [f, CGRect(x: f.minX, y: f.minY + top, width: f.width, height: f.height - top)] : [f]
        }
    }

    /// Whether the windows in front of `id` hide every usable part of the screens within `path`
    /// (the box from where a window is to where it goes), so it can move there unseen. Windows
    /// in `moving`, and those of apps in `leaving` (being hidden), don't count: they're on their
    /// way out too.
    static func isCovered(_ id: WindowID, ignoring moving: Set<WindowID>, apps leaving: Set<pid_t>, path: CGRect) -> Bool {
        let above = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], id) as? [[String: Any]] ?? []
        let rects = above.compactMap { w -> CGRect? in
            guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  ((w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) >= 1,
                  let n = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value, !moving.contains(n),
                  !leaving.contains((w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1) else { return nil }
            return (w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
        }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        // A maximized window can stop a point or two short of the menu bar; motion there is invisible.
        return NSScreen.screens.allSatisfy { screen in
            let area = Geometry.toAX(screen.visibleFrame, primaryHeight: primaryHeight).insetBy(dx: 2, dy: 2).intersection(path)
            return area.isNull || Geometry.covers(rects, area: area)
        }
    }

    /// Apps with a window on screen now that a person can see (not one parked in the corner).
    static func pidsInSight(screens: [CGRect]) -> Set<pid_t> {
        let shown = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return Set(shown.compactMap { w -> pid_t? in
            guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }),
                  b.width > 50, b.height > 50, !Geometry.isStranded(b, screens: screens) else { return nil }
            return (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        })
    }

    /// Whether the window server shows none of these windows on screen (their app hid).
    static func allOffscreen(_ ids: Set<WindowID>) -> Bool {
        let shown = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        return !shown.contains { ($0[kCGWindowNumber as String] as? NSNumber).map { ids.contains($0.uint32Value) } ?? false }
    }

    /// Every display, the main one first: its UUID, and its whole and usable (no menu bar, no
    /// Dock) areas in Accessibility coordinates.
    static func displays() -> [(key: DisplayKey, frame: CGRect, visible: CGRect)] {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSScreen.screens.compactMap { s in
            guard let key = key(of: s) else { return nil }
            return (key, Geometry.toAX(s.frame, primaryHeight: primaryHeight), Geometry.toAX(s.visibleFrame, primaryHeight: primaryHeight))
        }
    }

    /// A screen's display UUID.
    static func key(of s: NSScreen) -> DisplayKey? {
        guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
              let uuid = CGDisplayCreateUUIDFromDisplayID(n.uint32Value)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, uuid) as String?
    }

    /// The screen for a display UUID from `displays()`.
    static func screen(for key: DisplayKey) -> NSScreen? {
        NSScreen.screens.first { Self.key(of: $0) == key }
    }

    /// Screen frames in Accessibility coordinates.
    static func screens() -> [CGRect] {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSScreen.screens.map { Geometry.toAX($0.frame, primaryHeight: primaryHeight) }
    }

    /// The usable area (no menu bar, no Dock) of the screen a frame is mostly on.
    static func visibleArea(near frame: CGRect) -> CGRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let areas = NSScreen.screens.map { (Geometry.toAX($0.frame, primaryHeight: primaryHeight),
                                            Geometry.toAX($0.visibleFrame, primaryHeight: primaryHeight)) }
        let best = areas.max { a, b in
            let ia = a.0.intersection(frame), ib = b.0.intersection(frame)
            return ia.width * ia.height < ib.width * ib.height
        }
        return best?.1 ?? areas.first?.1 ?? frame
    }

    /// The app's own New Window command: a menu item named New … Window (New Window, New Finder
    /// Window, New Personal Window), preferring the one on plain ⌘N. Matched by name, not by ⌘N
    /// alone, which in Notes or Mail makes a note or a message instead, and which Ghostty gives
    /// up when its New Window key is changed. Works on a hidden app, which stays hidden.
    static func newWindowItem(_ pid: pid_t) -> AXUIElement? {
        guard isResponsive(pid) else { return nil }
        // Every element asked gets the short timeout: an app that hangs partway through its
        // menus must not hold the launcher.
        func children(_ e: AXUIElement) -> [AXUIElement] {
            AXUIElementSetMessagingTimeout(e, 0.25)
            return e.value(kAXChildrenAttribute) ?? []
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        guard let bar: AXUIElement = app.value(kAXMenuBarAttribute) else { return nil }
        var named: AXUIElement?
        // A document app's plain "New" on ⌘N (TextEdit) opens an empty window, and counts only
        // when the app has no command with "window" in its name.
        var document: AXUIElement?
        // The Apple menu is first and never has it.
        for menu in children(bar).dropFirst() {
            for list in children(menu) {
                for item in children(list) {
                    if let title = item.string(kAXTitleAttribute), title == "New" || title == "New Document", document == nil,
                       item.bool(kAXEnabledAttribute), item.string("AXMenuItemCmdChar") == "N",
                       (item.value("AXMenuItemCmdModifiers") as NSNumber?)?.intValue == 0 {
                        document = item
                    }
                    guard let title = item.string(kAXTitleAttribute), title.hasPrefix("New"),
                          title.localizedCaseInsensitiveContains("window"), item.bool(kAXEnabledAttribute) else { continue }
                    if item.string("AXMenuItemCmdChar") == "N", (item.value("AXMenuItemCmdModifiers") as NSNumber?)?.intValue == 0 {
                        return item
                    }
                    if named == nil { named = item }
                }
            }
            guard isResponsive(pid) else { return nil }
        }
        return named ?? document
    }
}

extension AXUIElement {
    var windowID: WindowID? {
        var id: CGWindowID = 0
        return _AXUIElementGetWindow(self, &id) == .success && id != 0 ? id : nil
    }

    func value<T>(_ attribute: String) -> T? {
        var raw: CFTypeRef?
        guard checked(AXUIElementCopyAttributeValue(self, attribute as CFString, &raw), call: attribute) else { return nil }
        return raw as? T
    }

    /// Whether a call succeeded. A timeout means the app is busy or hung: stop asking it for a
    /// few seconds, so one stuck app costs one timeout instead of one per call.
    @discardableResult
    func checked(_ result: AXError, call: String = "a call") -> Bool {
        if result == .cannotComplete {
            var pid: pid_t = 0
            if AXUIElementGetPid(self, &pid) == .success, pid > 0 { Windows.markUnresponsive(pid, call: call, error: result) }
        }
        return result == .success
    }

    func value<T>(_ attribute: String, _ type: AXValueType) -> T? {
        var raw: CFTypeRef?
        guard checked(AXUIElementCopyAttributeValue(self, attribute as CFString, &raw), call: attribute),
              let raw, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let pointer = UnsafeMutablePointer<T>.allocate(capacity: 1)
        defer { pointer.deallocate() }
        return AXValueGetValue(raw as! AXValue, type, pointer) ? pointer.pointee : nil
    }

    func string(_ attribute: String) -> String? { value(attribute) }
    func bool(_ attribute: String) -> Bool { (value(attribute) as NSNumber?)?.boolValue ?? false }

    func set(_ attribute: String, _ value: CGPoint, _ type: AXValueType) {
        var v = value
        guard let ax = AXValueCreate(type, &v) else { return }
        checked(AXUIElementSetAttributeValue(self, attribute as CFString, ax), call: "set \(attribute)")
    }

    func set(_ attribute: String, _ value: CGSize, _ type: AXValueType) {
        var v = value
        guard let ax = AXValueCreate(type, &v) else { return }
        checked(AXUIElementSetAttributeValue(self, attribute as CFString, ax), call: "set \(attribute)")
    }
}

/// trace.log lines for frames around a drag (`DragFrameLog`): Polycarp's own writes, with the line that made them, and
/// what the released window did for two seconds, whoever moved it.
enum DragFrameTrace {
    private static let lock = NSLock()
    private static var lastRelease: Double?
    private static var watches: [WindowID: Timer] = [:]

    static func write(_ id: WindowID, _ kind: DragFrameLog.Write, origin: CGPoint?, size: CGSize?, file: String, line: Int) {
        lock.lock(); let last = lastRelease; lock.unlock()
        guard DragFrameLog.logsWrite(now: ProcessInfo.processInfo.systemUptime, buttonDown: NSEvent.pressedMouseButtons & 1 != 0,
                                     lastRelease: last) else { return }
        Trace.log(DragFrameLog.writeLine(window: UInt32(id), kind: kind, origin: origin, size: size, file: file, line: line))
    }

    /// A drag of window `id` was let go: watch its frame for `DragFrameLog.after` seconds. Main thread.
    static func released(_ id: WindowID) {
        let start = ProcessInfo.processInfo.systemUptime
        lock.lock(); lastRelease = start; lock.unlock()
        watches.removeValue(forKey: id)?.invalidate()
        var previous = TopDragWatcher.bounds(of: id)
        if let line = DragFrameLog.changeLine(window: UInt32(id), t: 0, frame: previous, previous: nil) { Trace.log(line) }
        let timer = Timer(timeInterval: DragFrameLog.interval, repeats: true) { timer in
            let now = ProcessInfo.processInfo.systemUptime
            guard DragFrameLog.watching(start: start, now: now) else {
                timer.invalidate()
                if watches[id] === timer { watches[id] = nil }
                return
            }
            let frame = TopDragWatcher.bounds(of: id)
            if let line = DragFrameLog.changeLine(window: UInt32(id), t: now - start, frame: frame, previous: previous) { Trace.log(line) }
            previous = frame
        }
        RunLoop.main.add(timer, forMode: .common)
        watches[id] = timer
    }

    /// Stops every watch, when Polycarp stops watching drags.
    static func stopAll() {
        watches.values.forEach { $0.invalidate() }
        watches = [:]
    }
}
