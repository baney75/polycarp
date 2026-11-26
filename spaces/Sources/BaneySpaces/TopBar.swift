import AppKit
import BaneySpacesCore
import Combine
import IOKit.ps
import Network
import SwiftUI

/// Polycarp's top bar (`bar.*` in surfaces.json): one strip per screen with the workspace you're on and the hour in
/// words. It shows only where the macOS bar is set to hide
/// (`BarLayout.systemBarShown`). While it is up, `SystemMenuBar` keeps that bar transparent and out of the way, so it
/// never slides in over Polycarp's (Donovan, 2026-11-23); the app's menus open from the bar's own `app-menus`.
/// It sits just under your windows (`BarLayout.levelBelowWindows`): a window that reaches the top of the screen covers
/// it, so the bar never hides a window's buttons or title. It never takes focus and stays off full-screen apps. A click
/// switches workspaces (a number) or opens what the macOS bar would (an app's menu, a status item). Main thread only.
final class TopBar {
    let model = TopBarModel()
    private let spaces: Spaces
    let notices = NoticeWatcher()
    private let noticePanel = BarPanel("Notifications", anchor: .right, width: NoticeList.width)
    private let calendarPanel = BarPanel("Calendar", anchor: .middle, width: BarCalendar.width)
    private let calendar = CalendarModel()
    private let agentsPanel = BarPanel("Agents", anchor: .right, width: AgentsList.width)
    private var noticeCount: AnyCancellable?
    private var panels: [CGDirectDisplayID: NSPanel] = [:]
    private var tick: Timer?
    private let network = NWPathMonitor()
    private var powerSource: CFRunLoopSource?
    private var loggedCovered = false
    private var menuPress: (Int) -> Void = { _ in }
    /// The app whose menus are being read or shown.
    private var menuPid: pid_t = 0
    private var statusElements: [AXUIElement] = []
    private var statusTimer: Timer?
    private var readingStatus = false
    /// An app started or quit during a read: read again when it lands.
    private var statusDirty = false
    /// Polycarp's own menu (the status item's), opened from the mark.
    var ownMenu: () -> NSMenu? = { nil }
    /// What the browsers have for the `page` module on a workspace, with its site's icon, and what its parts do.
    var page: (Int) -> TopBarModel.Page? = { _ in nil }
    var goTo: (BrowserWindows.Front) -> Void = { _ in }
    private var pageWaits = false
    private var menuOwner: NSKeyValueObservation?
    /// The minute the menus were last read on the clock's tick.
    private var menuMinute: Date?
    /// The height the panels were placed at, so a theme change that leaves it alone places nothing.
    private var placedHeight: Double?
    /// Moves a module with ⌘ and a drag (spec/bar.md R-BA1).
    private lazy var dragger = BarDragger(model: model, display: { [weak self] w in self?.panels.first { $0.value === w }?.key },
                                          panel: { [weak self] in self?.panels[$0] }, drop: { [weak self] in self?.move($0, to: $1) })
    /// The lists from before the last move, for Undo Move until the next move or a quit (R-BA5).
    private(set) var undo: Surfaces.Bar?
    private let writes = DispatchQueue(label: "com.baney.polycarp.bar-arrange", qos: .userInitiated)
    private var rightClicks: Any?

    init(spaces: Spaces) {
        self.spaces = spaces
        model.onPick = { [weak self] n, screen in
            guard let self else { return }
            self.spaces.useDisplay(of: screen)
            self.spaces.switchTo(n, announce: false)
        }
        model.onMenu = { [weak self] i in self?.menuPress(i) }
        model.onMark = { [weak self] in self?.ownMenu()?.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil) }
        model.onStatus = { [weak self] i in
            guard let self, self.statusElements.indices.contains(i) else { return }
            BarReader.press(self.statusElements[i])
        }
        model.onNotices = { [weak self] screen, x in
            guard let self, let bar = screen.displayID.flatMap({ self.panels[$0] }) else { return }
            self.noticePanel.toggle(on: screen, x: x + 24, below: bar.frame.minY,
                                    changes: self.notices.objectWillChange.map { _ in }.eraseToAnyPublisher()) { room, close in
                NoticeList(watcher: self.notices, room: room, close: close)
            }
        }
        // Seen once closed, so what was new stays marked while you look at it.
        noticePanel.onShow = { [weak self] in
            if $0 == nil { self?.notices.see() }
            self?.model.opened(.notifications, on: $0)
        }
        model.onCalendar = { [weak self] screen, x in
            guard let self, let bar = screen.displayID.flatMap({ self.panels[$0] }) else { return }
            self.calendar.open()
            self.calendarPanel.toggle(on: screen, x: x, below: bar.frame.minY,
                                      changes: self.calendar.objectWillChange.map { _ in }.eraseToAnyPublisher()) { _, close in
                BarCalendar(model: self.calendar, close: close)
            }
        }
        model.onAgents = { [weak self] screen, x in
            guard let self, let bar = screen.displayID.flatMap({ self.panels[$0] }) else { return }
            self.agentsPanel.toggle(on: screen, x: x + AgentsList.width / 2, below: bar.frame.minY,
                                    changes: self.model.$agents.map { _ in }.eraseToAnyPublisher()) { room, close in
                AgentsList(model: self.model, room: room, open: { [weak self] in self?.model.onAgent($0) }, close: close)
            }
        }
        agentsPanel.onShow = { [weak self] in self?.model.opened(.agents, on: $0) }
        calendarPanel.onKey = { [weak self] in self?.calendar.key($0) ?? false }
        calendarPanel.onShow = { [weak self] in self?.model.opened(.clock, on: $0) }
        model.onPage = { [weak self] in self?.goTo($0) }
        noticeCount = notices.$shelf.map(\.count).removeDuplicates().sink { [weak self] in self?.model.notices = $0 }
    }

    func start() {
        let center = NotificationCenter.default
        center.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in self?.reload() }
        // style.css (docs/style.md): the views redraw from `Styles` on their own; the panels follow a new `height`.
        center.addObserver(forName: StyleSheetStore.didChange, object: nil, queue: .main) { [weak self] _ in
            Styles.shared.sync()
            self?.reload()
        }
        // A mode change can pick another `@media` height; a slider drag posts this many times a second, so only a new
        // height places the panels again.
        center.addObserver(forName: Appearance.didChange, object: nil, queue: .main) { [weak self] _ in
            guard let self, !self.panels.isEmpty else { return }
            Styles.shared.sync()
            if Styles.shared.book.barHeight(Double(self.model.bar.height)) != self.placedHeight { self.reload() }
        }
        center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.reload()
        }
        // Set in System Settings, the menu bar's hiding changes the visible frame (and posts this, undocumented).
        DistributedNotificationCenter.default().addObserver(forName: .init("AppleInterfaceMenuBarHidingChangedNotification"),
                                                            object: nil, queue: .main) { [weak self] _ in self?.reload() }
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.reload()
        }
        // A Space change (full screen in or out, a desktop switch) may set the macOS bar back; hide it again (review of #621).
        workspace.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            SystemMenuBar.hide(!self.panels.isEmpty)
        }
        // The menus are the menu bar owner's, which an accessory app coming forward (Raycast, a launcher) doesn't take.
        // Some apps fill their menu bar a moment after they take it, so it is read again half a second on.
        menuOwner = NSWorkspace.shared.observe(\.menuBarOwningApplication) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.readMenus()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.readMenus() }
            }
        }
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.readStatus() }
            }
        }
        network.pathUpdateHandler = { [weak self] path in
            let offline = path.status != .satisfied
            DispatchQueue.main.async { if self?.model.offline != offline { self?.model.offline = offline } }
        }
        network.start(queue: .global(qos: .utility))
        dragger.start()
        dragger.onUndo = { [weak self] in self?.undoMove() }
        model.onDone = { [weak self] in self?.dragger.endArranging("Done") }
        model.onStep = { [weak self] from, step in
            guard let self, let to = BarArrange.slot(for: step, from: from, in: self.model.bar, shown: BarSplitHandle.shown) else { return }
            self.move(from, to: to)
        }
        rightClicks = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] e in
            self?.rightClick(e) == true ? nil : e
        }
        let me = Unmanaged.passUnretained(self).toOpaque()
        if let src = IOPSNotificationCreateRunLoopSource({ ctx in
            guard let ctx else { return }
            Unmanaged<TopBar>.fromOpaque(ctx).takeUnretainedValue().readBattery()
        }, me)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
            powerSource = src
        }
        // Low Power Mode changes without a power-source event; the battery turns yellow (or back) at once.
        NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.readBattery()
        }
        reload()
    }

    /// Workspaces changed: the numbers follow at once.
    func workspacesChanged() {
        guard !panels.isEmpty else { return }
        SystemMenuBar.hide(true)
        readWorkspaces()
        pageChanged()
    }

    /// A browser's pages, or the windows on a workspace, changed: the `page` module follows, at most five times a second.
    func pageChanged() {
        guard wants(.page), !pageWaits else { return }
        pageWaits = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.pageWaits = false
            self?.readPages()
        }
    }

    private func readPages() {
        var pages: [CGDirectDisplayID: TopBarModel.Page] = [:]
        if wants(.page) {
            for screen in NSScreen.screens { if let id = screen.displayID { pages[id] = page(spaces.workspace(onScreen: screen)) } }
        }
        if model.pages != pages { model.pages = pages }
    }

    /// Reads surfaces.json and the screens, and puts a bar on each screen where the macOS bar is hidden. Polycarp
    /// never opens System Settings for it (2026-11-22): the trace says what to set when every screen's bar is covered.
    func reload() {
        let bar = SurfacesStore.shared.current.bar
        model.bar = bar
        guard bar.enabled else { removeAll(); return }

        let hidden = UserDefaults.standard.bool(forKey: "_HIHideMenuBar")
        // The sheet's `bar { height }` over surfaces.json's.
        let height = Styles.shared.book.barHeight(Double(bar.height))
        placedHeight = height
        var keep = Set<CGDirectDisplayID>()
        var covered = 0
        for screen in NSScreen.screens {
            guard let id = screen.displayID else { continue }
            let notch = screen.safeAreaInsets.top > 0
            if BarLayout.systemBarShown(frameMaxY: screen.frame.maxY, visibleMaxY: screen.visibleFrame.maxY, notch: notch, hideMenuBar: hidden) {
                covered += 1
                continue
            }
            keep.insert(id)
            place(on: screen, id: id, notch: notch, height: CGFloat(height))
        }
        for (id, p) in panels where !keep.contains(id) { p.orderOut(nil); panels[id] = nil }
        // Where the bar is up, macOS's own bar may not come in over it.
        SystemMenuBar.hide(!keep.isEmpty)
        if covered > 0, keep.isEmpty, !loggedCovered {
            Trace.log("top bar: on, but the macOS menu bar is shown on every screen; set System Settings > Menu Bar > Automatically hide and show the menu bar to Always")
        }
        loggedCovered = covered > 0 && keep.isEmpty
        guard !panels.isEmpty else { stopTicking(); forgetReads(); return }
        readWorkspaces()
        readBattery()
        readMenus()
        readStatus()
        readPages()
        notices.set(on: wants(.notifications))
        if !wants(.notifications) { noticePanel.hide() }
        if !wants(.clock), !wants(.date) { calendarPanel.hide() }
        if !wants(.agents) { agentsPanel.hide() }
        refreshTime()
    }

    private func place(on screen: NSScreen, id: CGDirectDisplayID, notch: Bool, height: CGFloat) {
        // On a screen with a notch the bar fills the strip beside the camera; elsewhere it takes `bar.height`.
        let h = notch ? screen.safeAreaInsets.top : height
        let frame = NSRect(x: screen.frame.minX, y: screen.frame.maxY - h, width: screen.frame.width, height: h)
        let sides = notch ? (left: screen.auxiliaryTopLeftArea?.width ?? 0, right: screen.auxiliaryTopRightArea?.width ?? 0) : nil
        if let p = panels[id] {
            if p.frame != frame { p.setFrame(frame, display: true) }
            (p.contentView as? NSHostingView<TopBarView>)?.rootView = TopBarView(model: model, display: id, screen: screen, sides: sides)
            return
        }
        let p = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.normalWindow)) + BarLayout.levelBelowWindows)
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.hidesOnDeactivate = false
        p.isMovable = false
        p.becomesKeyOnlyIfNeeded = true
        p.isReleasedWhenClosed = false
        p.title = "Polycarp bar"
        p.contentView = NSHostingView(rootView: TopBarView(model: model, display: id, screen: screen, sides: sides))
        p.orderFrontRegardless()
        panels[id] = p
    }

    private func removeAll() {
        dragger.endArranging("bar gone")
        dragger.cancel()
        SystemMenuBar.hide(false)
        for p in panels.values { p.orderOut(nil) }
        panels = [:]
        stopTicking()
        forgetReads()
    }

    /// No bar is drawn: let go of every app's elements and stop the status timer.
    private func forgetReads() {
        statusTimer?.invalidate(); statusTimer = nil
        statusElements = []
        if !model.status.isEmpty { model.status = [] }
        menuPid = 0
        show(BarReader.Menus())
        if !model.pages.isEmpty { model.pages = [:] }
        noticePanel.hide()
        calendarPanel.hide()
        agentsPanel.hide()
        notices.set(on: false)
    }

    /// A drop: the lists moved, drawn on every bar at once, then written in one write that the store and every bar follow
    /// (R-BA4). A drop on the module's own place writes nothing (R-BA5).
    func move(_ from: BarSlot, to: BarSlot) {
        let before = model.bar
        let next = BarArrange.move(before, from: from, to: to)
        guard next != before else { Trace.log("top bar: move to its own place, nothing changed"); return }
        let id = BarArrange.list(before, from.row)[from.index].id
        save(next, undo: before, revert: before, "moved \(id) from \(from.row.rawValue) \(from.index) to \(to.row.rawValue) \(to.index)")
    }

    /// Puts back the lists from before the last move.
    func undoMove() {
        guard let u = undo else { return }
        var next = model.bar
        (next.left, next.center, next.right) = (u.left, u.center, u.right)
        save(next, undo: nil, revert: model.bar, "move undone")
    }

    /// Draws `next` and writes it; a failed write puts back `revert` and the undo there was.
    private func save(_ next: Surfaces.Bar, undo before: Surfaces.Bar?, revert: Surfaces.Bar, _ what: String) {
        let undoBefore = undo
        model.bar = next
        undo = before
        writes.async { [weak self] in
            let failed = BarArrange.write(next, file: SurfacesFile.path())
            DispatchQueue.main.async {
                guard let self else { return }
                if let failed {
                    // Nothing was written: the bars go back to what they showed before it.
                    self.undo = undoBefore
                    self.model.bar = revert
                    Trace.log("top bar: \(what) not saved: \(failed)")
                } else {
                    Trace.log("top bar: \(what)")
                }
            }
        }
    }

    /// A right-click on the bar's empty space or the mark: Arrange Bar Items…, and Undo Move when there is a move to undo.
    private func rightClick(_ e: NSEvent) -> Bool {
        guard let (id, panel) = panels.first(where: { $0.value === e.window }) else { return false }
        let hit = model.measure[id]?.module(at: Double(e.locationInWindow.x))
        if let hit {
            let list = BarArrange.list(model.bar, hit.slot.row)
            guard list.indices.contains(hit.slot.index), list[hit.slot.index] == .mark else { return false }
        }
        let menu = NSMenu()
        if model.arranging {
            menu.addItem(BlockMenuItem("Done Arranging") { [weak self] in self?.dragger.endArranging("Done") })
        } else {
            menu.addItem(BlockMenuItem("Arrange Bar Items…") { [weak self, weak panel] in self?.dragger.arrange(near: panel) })
        }
        if undo != nil { menu.addItem(BlockMenuItem("Undo Move") { [weak self] in self?.undoMove() }) }
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
        return true
    }

    private func wants(_ m: Surfaces.BarModule) -> Bool {
        let bar = model.bar
        return bar.enabled && !panels.isEmpty && (bar.left + bar.center + bar.right).contains(m)
    }

    /// The menu bar owner's menus for `app-menus`, read when it changes and each minute; a click reads them again.
    private func readMenus() {
        guard wants(.appMenus), let app = NSWorkspace.shared.menuBarOwningApplication else {
            if !model.menus.isEmpty { model.menus = [] }
            menuPress = { _ in }
            menuPid = 0
            return
        }
        let pid = app.processIdentifier
        // Another app came forward: nothing may press the last one's menus while this one's are read.
        if pid != menuPid { show(BarReader.Menus()) }
        menuPid = pid
        BarReader.want(pid)
        guard pid != getpid() else { show(BarReader.ownMenus(name: app.localizedName ?? "Polycarp")); return }
        BarReader.queue.async { [weak self] in
            // A read queued behind a hung app is skipped once another app is in front.
            guard BarReader.wanted == pid else { return }
            let read = BarReader.menus(of: pid)
            DispatchQueue.main.async {
                // An app that came forward while this one was read wins.
                guard let self, self.menuPid == pid else { return }
                self.show(read)
            }
        }
    }

    private func show(_ read: BarReader.Menus) {
        menuPress = read.press
        if model.menus != read.items { model.menus = read.items }
    }

    /// Every app's status items for `status`, read off the main thread every 15 seconds and when an app starts or quits.
    private func readStatus() {
        guard wants(.status) else {
            statusTimer?.invalidate(); statusTimer = nil
            if !model.status.isEmpty { model.status = [] }
            statusElements = []
            return
        }
        if statusTimer == nil {
            let t = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.readStatus() }
            t.tolerance = 3
            RunLoop.main.add(t, forMode: .common)
            statusTimer = t
        }
        guard !readingStatus else { statusDirty = true; return }
        readingStatus = true
        let me = getpid()
        let targets = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier != me }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let read = BarReader.status(of: targets)
            DispatchQueue.main.async {
                guard let self else { return }
                self.readingStatus = false
                if self.statusDirty { self.statusDirty = false; self.readStatus() }
                // The module went off while this was read.
                guard self.wants(.status) else { return }
                let bar = self.model.bar
                // Each display's top in Accessibility's coordinates, where the main display's top is 0 and y runs down.
                let main = NSScreen.screens.first?.frame.maxY ?? 0
                let tops = NSScreen.screens.map { Double(main - $0.frame.maxY) }
                let kept = BarStatus.shown(read, \.item, modules: bar.left + bar.center + bar.right, barTops: tops.isEmpty ? [0] : tops)
                self.statusElements = kept.map(\.element)
                let items = kept.map(\.item)
                // Icons only for owners not seen yet; an app without a bundle id draws the plain dot.
                for item in items where !item.isSystem && !item.owner.isEmpty && self.model.icons[item.owner] == nil {
                    let app = NSRunningApplication.runningApplications(withBundleIdentifier: item.owner).first
                    if let icon = app?.icon { self.model.icons[item.owner] = icon }
                }
                if self.model.status != items { self.model.status = items }
            }
        }
    }

    private func readWorkspaces() {
        var current: [CGDirectDisplayID: Int] = [:]
        for screen in NSScreen.screens { if let id = screen.displayID { current[id] = spaces.workspace(onScreen: screen) } }
        let occupied = Set(Workspaces.range.filter { !spaces.model.windows(on: $0).isEmpty })
        if model.current != current { model.current = current }
        if model.occupied != occupied { model.occupied = occupied }
    }

    fileprivate func readBattery() {
        let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue()
        let list = info.flatMap { IOPSCopyPowerSourcesList($0)?.takeRetainedValue() as? [CFTypeRef] } ?? []
        var text: String?
        for src in list {
            guard let d = IOPSGetPowerSourceDescription(info, src)?.takeUnretainedValue() as? [String: Any],
                  d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 else { continue }
            let percent = Int((Double(cur) / Double(max) * 100).rounded())
            let charging = d[kIOPSIsChargingKey] as? Bool ?? false
            let onPower = d[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
            text = BarText.battery(percent: percent, charging: charging, onPower: onPower)
            let now = TopBarModel.Charge(percent: percent, charging: charging, onPower: onPower,
                                         lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled)
            if model.charge != now { model.charge = now }
        }
        if model.battery != text { model.battery = text }
    }

    /// The clock and the hour change on the minute; the timer is set for the next one, not every second.
    private func refreshTime() {
        let now = Date()
        model.now = now
        model.verse = Verses.pick(SurfacesStore.shared.current.desktop.verseRotation, at: now)
        // An app can change its menus without coming forward again (Electron apps do on a window change). Once a minute.
        let minute = BarText.nextMinute(after: now)
        if minute != menuMinute { menuMinute = minute; readMenus() }
        tick?.invalidate()
        let t = Timer(fire: minute, interval: 0, repeats: false) { [weak self] _ in self?.refreshTime() }
        t.tolerance = 1
        RunLoop.main.add(t, forMode: .common)
        tick = t
    }

    private func stopTicking() {
        tick?.invalidate()
        tick = nil
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID? { deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID }
}

final class TopBarModel: ObservableObject {
    @Published var bar = Surfaces.defaults.bar
    @Published var now = Date()
    @Published var current: [CGDirectDisplayID: Int] = [:]
    @Published var occupied: Set<Int> = []
    @Published var battery: String?
    @Published var offline = false
    @Published var verse: Verse?
    @Published var menus: [BarMenus.Item] = []
    @Published var status: [BarStatus.Item] = []
    /// An app's icon by bundle id, drawn for its status items.
    @Published var icons: [String: NSImage] = [:]
    /// The battery's charge for the macOS battery item in `status`.
    @Published var charge: Charge?
    /// The status row's drawer was clicked open, so it stays open with the pointer away.
    @Published var trayHeld = false
    /// The panel open under the bar (the bell's list, the clock's calendar), and the screen it is on.
    @Published private(set) var open: (module: Surfaces.BarModule, display: CGDirectDisplayID)?
    func opened(_ module: Surfaces.BarModule, on display: CGDirectDisplayID?) {
        if let display { open = (module, display) } else if open?.module == module { open = nil }
    }
    /// The agents at work or asking for you.
    @Published var agents = BarAgents()
    /// How many notifications are new, as the bell shows it (`NoticeShelf.count`).
    @Published var notices = ""
    @Published var pages: [CGDirectDisplayID: Page] = [:]
    /// The module being moved by hand, on one bar (`BarDragger`).
    @Published var drag: BarDrag?
    /// Arrange mode: modules outlined, a plain drag moves one, a click runs none (R-BA1).
    @Published var arranging = false
    /// A VoiceOver move of the module at a slot (R-BA6).
    var onStep: (BarSlot, BarArrange.Step) -> Void = { _, _ in }
    /// Ends arrange mode, from its Done pill.
    var onDone: () -> Void = {}
    /// Where each bar last laid out its rows and modules; read at a press, never drawn from.
    var measure: [CGDirectDisplayID: BarMeasure] = [:]

    /// The `page` module's: what there is to show, and the front page's site's icon.
    struct Page: Equatable {
        var now: BrowserPage
        var icon: NSImage?
    }
    struct Charge: Equatable {
        var percent: Int
        var charging: Bool
        var onPower: Bool
        var lowPower: Bool
    }
    var onPick: (Int, NSScreen) -> Void = { _, _ in }
    /// Presses the front app's menu at a `BarMenus.Item.index`.
    var onMenu: (Int) -> Void = { _ in }
    /// Opens Polycarp's own menu, the one its status item holds.
    var onMark: () -> Void = {}
    /// Presses the status item at an index of `status`.
    var onStatus: (Int) -> Void = { _ in }
    /// Opens the list of notifications near a place across the screen, or closes it.
    var onNotices: (NSScreen, CGFloat) -> Void = { _, _ in }
    /// Opens the list of agents there, or closes it.
    var onAgents: (NSScreen, CGFloat) -> Void = { _, _ in }
    /// Goes to an agent, by its row's id.
    var onAgent: (String) -> Void = { _ in }
    /// Opens the calendar there, or closes it.
    var onCalendar: (NSScreen, CGFloat) -> Void = { _, _ in }
    /// Goes to a tab, or shows a download in Finder.
    var onPage: (BrowserWindows.Front) -> Void = { _ in }
}

/// One screen's bar. `sides` is the width beside the notch on each side, or nil on a screen without one.
struct TopBarView: View {
    @ObservedObject var model: TopBarModel
    @ObservedObject private var appearance = Appearance.shared
    /// style.css: what the sheet says for the bar, its regions, modules and workspace numbers (docs/style.md).
    @ObservedObject private var styles = Styles.shared
    /// The module under the pointer, for `:hover`.
    @State private var hovered: String?
    let display: CGDirectDisplayID
    let screen: NSScreen
    let sides: (left: CGFloat, right: CGFloat)?

    private var here: Int { model.current[display] ?? 1 }
    /// The bar's inset from each screen edge, or the sheet's `bar { padding }`.
    private var inset: EdgeInsets {
        styles.book.bar.padding.map(Styled.insets)
            ?? EdgeInsets(top: 0, leading: CGFloat(BarGeometry.edge), bottom: 0, trailing: CGFloat(BarGeometry.edge))
    }
    /// Between modules, and added to the room between groups: each slot carries its own, so nothing more until the sheet's
    /// `gap` for the bar or a region adds it.
    private var spacing: CGFloat { CGFloat(styles.book.bar.gap ?? 0) }

    var body: some View {
        let pad = inset
        GeometryReader { g in
            let height = Double(g.size.height)
            ZStack {
                background.padding(EdgeInsets(top: -pad.top, leading: -pad.leading, bottom: -pad.bottom, trailing: -pad.trailing))
                if let sides {
                    let right = max(0, sides.right - pad.trailing)
                    HStack(spacing: 0) {
                        row(.left).frame(width: max(0, sides.left - pad.leading), alignment: .leading)
                        Spacer(minLength: 0)
                        // The clock beside the camera, the icons at the edge.
                        BarSideRow {
                            HStack(spacing: 6) { row(.center); done }
                            row(.right, room: Double(right) * (1 - BarLayout.middleShare))
                        }
                        .animation(slide, value: model.drag?.target)
                        .padding(.leading, CGFloat(BarGeometry.group))
                        .frame(width: right)
                    }
                    .animation(slide, value: model.drag?.target)
                } else {
                    // Each place gets its share of the width, so a long verse or app menu row shortens instead of running
                    // into the next: the middle what it needs up to its share, the sides what is left either side of it.
                    BarFlatRow {
                        row(.left)
                        HStack(spacing: 6) { row(.center); done }
                        row(.right, room: Double(g.size.width) * (1 - BarLayout.middleShare) / 2)
                    }
                    .animation(slide, value: model.drag?.target)
                }
                if let d = model.drag, d.display == display { lifted(d, pad: pad, height: g.size.height) }
            }
            .frame(width: g.size.width, height: g.size.height)
            .barMeasured(.bar)
            .environment(\.barFace, CGFloat(BarGeometry.face(bar: model.bar.style == .islands ? height - 6 : height)))
        }
        .padding(pad)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .coordinateSpace(name: BarDragger.space)
        .onPreferenceChange(BarMeasureFrames.self) { frames in
            let width = Double((frames[.bar]?.maxX ?? screen.frame.width) + pad.trailing)
            let bar = model.bar
            let all = bar.left + bar.center + bar.right
            var hides: [BarRow: Set<Surfaces.BarModule>] = [:]
            var closed: Set<BarRow> = []
            for row in BarRow.allCases {
                let region = StyleBook.Region(rawValue: row.rawValue) ?? .left
                if styles.book.region(region).isHidden { closed.insert(row) }
                hides[row] = Set(all.filter { styles.book.module($0, in: region).isHidden })
            }
            model.measure[display] = BarMeasure(frames: frames, width: width,
                                                notch: sides.map { (Double($0.left), width - Double($0.right)) }, closed: closed, hides: hides)
        }
        .opacity(styles.book.bar.opacity ?? 1)
        .environment(\.colorScheme, Chrome.scheme)
    }

    /// surfaces.json's `bar.style`, or the sheet's `bar { background }`, with the sheet's lines and corners over it.
    @ViewBuilder private var background: some View {
        let b = styles.book.bar
        let shape = Styled.shape(b)
        ZStack {
            if let fill = Styled.fill(b.background) {
                shape.fill(fill)
            } else {
                themed.clipShape(shape)
            }
            StyledLines(style: b, shape: shape)
        }
    }

    @ViewBuilder private var themed: some View {
        switch model.bar.style {
        case .islands:
            // Nothing behind the islands: the desktop shows between them.
            Color.clear
        case .solid:
            // The theme's background role, whole: one calm strip.
            Chrome.panel()
        case .glass:
            Rectangle().fill(.ultraThinMaterial).overlay(Chrome.panel(0.35))
        case .hairline:
            VStack(spacing: 0) { Spacer(minLength: 0); Chrome.edge(0.3).frame(height: Chrome.width(.dockBar)) }
        }
    }

    /// One region's modules, in the groups `|` splits them into. The sheet can hide a region, box it and set its own
    /// gap. With `bar.style` islands each group floats in its own island; otherwise a little room parts them.
    @ViewBuilder private func row(_ place: BarRow, room: Double = 400) -> some View {
        let region = StyleBook.Region(rawValue: place.rawValue) ?? .left
        let r = styles.book.region(region)
        if r.isHidden {
            // A hidden region keeps its place in the layout, with nothing in it.
            Color.clear.frame(width: 0, height: 0).barMeasured(.row(place))
        } else {
            let gap = r.gap.map { CGFloat($0) } ?? spacing
            let groups = placed(BarArrange.list(shown, place), place, region)
            Group {
                if groups.isEmpty, model.arranging || dragging {
                    // An empty row while arranging or moving: somewhere to drop a module.
                    BarShape.face.strokeBorder(Chrome.wash(0.45), style: StrokeStyle(lineWidth: Chrome.width(.overviewChip), dash: [3, 3]))
                        .frame(width: CGFloat(BarGeometry.slot) + 12).padding(.vertical, 4)
                } else if model.bar.style == .islands {
                    // A fixed space between islands; the region's gap still spaces the modules inside each.
                    HStack(spacing: 6) {
                        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                            if let split = group.split { splitHandle(split, place) } else { island(group.items, place, region, gap: r.gap, room: room) }
                        }
                    }
                } else {
                    HStack(spacing: CGFloat(BarGeometry.group) + gap) {
                        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                            if let split = group.split {
                                splitHandle(split, place)
                            } else {
                                HStack(spacing: gap) {
                                    ForEach(group.items) { item($0, place, region, room: room) }
                                }
                            }
                        }
                    }
                }
            }
            .lineLimit(1)
            .environment(\.barBoxed, r.hasBox)
            .modifier(StyledBox(style: r))
            .barMeasured(.row(place))
        }
    }

    /// One island: its modules on a rounded face, inset from the bar's top and bottom so it floats. Only the face is inset:
    /// what is on it reaches the screen's edge. The sheet's
    /// `bar .island` sets its background, corners, line, shadow, padding and gap; what it leaves unset keeps the face.
    @ViewBuilder private func island(_ modules: [Placed], _ place: BarRow, _ region: StyleBook.Region, gap: Double?, room: Double) -> some View {
        let s = styles.book.island(in: region)
        if !s.isHidden {
            HStack(spacing: CGFloat(s.gap ?? gap ?? Double(spacing))) {
                ForEach(modules) { item($0, place, region, room: room) }
            }
            .padding(s.padding.map(Styled.insets) ?? EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
            .frame(maxHeight: .infinity)
            .background { IslandFace(style: s, barFill: styles.book.bar.background).padding(.vertical, 3) }
            .opacity(s.opacity ?? 1)
        }
    }

    /// A drawn module with its index in its row's list.
    struct Placed: Identifiable {
        let index: Int
        let module: Surfaces.BarModule
        var id: String { module.id }
    }

    private var dragging: Bool { model.drag?.display == display }

    /// The lists as the drop under the pointer would leave them, so the others slide apart where it will land.
    private var shown: Surfaces.Bar {
        guard let d = model.drag, d.display == display, let to = d.target else { return model.bar }
        return BarArrange.move(model.bar, from: d.from, to: to)
    }

    private var slide: Animation? { Chrome.reduceMotion ? nil : Chrome.spring(0.22, damping: 0.86) }

    /// A row's modules in the groups `|` splits them into (`BarArrange.runs`), each `|` a grip of its own in arrange mode.
    private func placed(_ modules: [Surfaces.BarModule], _ place: BarRow, _ region: StyleBook.Region) -> [(items: [Placed], split: Int?)] {
        BarArrange.runs(modules, arranging: model.arranging) { BarLayout.drawn($0) && draws($0, region) }
            .map { r in (r.items.map { Placed(index: $0, module: modules[$0]) }, r.split) }
    }

    /// Where one island ends and the next begins, drawn so it can be moved like any module (R-BA2).
    private func splitHandle(_ index: Int, _ place: BarRow) -> some View {
        // The bar draws the lists as they will be after the drop, so the grip being moved sits where it lands.
        let d = model.drag.flatMap { $0.display == display && $0.module == .split ? $0 : nil }
        let moving = d.map { d in (d.target.map { BarArrange.landing(from: d.from, to: $0) } ?? d.from) == BarSlot(place, index) } ?? false
        return BarSplitHandle()
            .opacity(moving ? (d?.target == nil ? 0.3 : 0) : 1)
            .overlay(alignment: .leading) {
                if moving, d?.target != nil { Capsule().fill(Chrome.accent).frame(width: 2).padding(.vertical, 5) }
            }
            .barMeasured(.item(place, index))
            .accessibilityLabel("Island split")
            .modifier(BarMoveActions(slot: BarSlot(place, index), bar: model.bar, run: model.onStep))
    }

    /// Arrange mode's Done pill, after the middle's modules.
    @ViewBuilder private var done: some View {
        if model.arranging {
            Text("Done").font(Chrome.mono(BarWords.size - 1, .semibold)).foregroundStyle(Chrome.onAccent)
                .padding(.horizontal, 10).padding(.vertical, 3)
                .background(Capsule().fill(Chrome.accent))
                .barMeasured(.done)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Done arranging")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { model.onDone() }
        }
    }

    /// One module in its row, measured for a press. The one being moved leaves a gap where it will land, marked by a
    /// thin accent line, or shows faintly where it was while the pointer is off the bar.
    @ViewBuilder private func item(_ p: Placed, _ place: BarRow, _ region: StyleBook.Region, room: Double) -> some View {
        let moving = model.drag.map { $0.display == display && $0.module == p.module } ?? false
        styled(p.module, region, room: room)
            .overlay {
                if model.arranging { BarShape.face.strokeBorder(Chrome.wash(0.35), lineWidth: Chrome.width(.overviewChip)).padding(.vertical, 3) }
            }
            .opacity(moving ? (model.drag?.target == nil ? 0.3 : 0) : 1)
            .overlay(alignment: .leading) {
                if moving, model.drag?.target != nil { Capsule().fill(Chrome.accent).frame(width: 2).padding(.vertical, 5) }
            }
            .barMeasured(.item(place, p.index))
            .accessibilityElement(children: .contain)
            .modifier(BarMoveActions(slot: BarSlot(place, p.index), bar: model.bar, run: model.onStep))
    }

    /// The module being moved, lifted under the pointer.
    private func lifted(_ d: BarDrag, pad: EdgeInsets, height: CGFloat) -> some View {
        Group {
            if d.module == .split { BarSplitHandle() } else { styled(d.module, StyleBook.Region(rawValue: d.from.row.rawValue) ?? .left, room: 400) }
        }
            .fixedSize()
            .background { BarShape.face.fill(Chrome.panel(0.94)).shadow(color: Chrome.shadow(0.3), radius: 5, x: 0, y: 2) }
            .scaleEffect(Chrome.reduceMotion ? 1 : 1.06)
            .opacity(d.over ? 1 : 0.6)
            .position(x: CGFloat(d.x - d.grab + d.width / 2) - pad.leading, y: height / 2)
            .allowsHitTesting(false)
    }

    /// A module with the sheet's style for it where it sits, hidden by `display: none`.
    @ViewBuilder private func styled(_ m: Surfaces.BarModule, _ region: StyleBook.Region, room: Double) -> some View {
        let s = styles.book.module(m, in: region, hover: hovered == m.id)
        if !s.isHidden {
            module(m, s, region, room: room)
                .modifier(StyledText(style: s))
                .modifier(BarBoxed(on: s.hasBox))
                .modifier(StyledBox(style: s))
                .background { PointerArea { on in if on { hovered = m.id } else if hovered == m.id { hovered = nil } } }
        }
    }

    /// Whether a module draws anything now, so a group of modules that draw nothing (a battery on a desktop Mac, the
    /// network while online) isn't an empty pill or a gap.
    private func draws(_ m: Surfaces.BarModule, _ region: StyleBook.Region) -> Bool {
        guard !styles.book.module(m, in: region).isHidden else { return false }
        switch m {
        case .battery: return model.battery != nil
        case .network: return model.offline
        // With its list open it stays, so the list keeps the button it hangs from.
        case .agents: return !model.agents.rows.isEmpty || isOpen(.agents)
        case .verse: return model.verse != nil
        case .appMenus: return !model.menus.isEmpty
        case .status: return !model.status.isEmpty
        case .page: return model.pages[display] != nil
        case .custom, .split: return false
        default: return true
        }
    }

    private func isOpen(_ m: Surfaces.BarModule) -> Bool { model.open?.module == m && model.open?.display == display }

    /// The clock and the date, which open the calendar.
    private func calendar(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        BarButton(width: 0, inset: CGFloat(BarGeometry.textInset), held: isOpen(.clock), label: label, help: "Calendar",
                  under: { model.onCalendar(screen, $0) }, content: content)
    }

    private func words(_ text: String, _ s: ComputedStyle, _ weight: TextWeight = .regular) -> Text { BarWords.text(text, s, weight) }

    @ViewBuilder private func module(_ m: Surfaces.BarModule, _ s: ComputedStyle, _ region: StyleBook.Region, room: Double) -> some View {
        let quiet = s.ink(Chrome.wash(0.85))
        switch m {
        case .mark:
            BarButton(label: "Polycarp menu", help: "Polycarp", action: { model.onMark() }) {
                OliveMark().fill(s.ink(Chrome.accent)).frame(width: 15, height: 15)
            }
        case .workspaces:
            WorkspaceStrip(shown: BarWorkspaces.shown(occupied: model.occupied, current: here), here: here,
                           elsewhere: Set(model.current.filter { $0.key != display }.values), style: s, region: region, book: styles.book) { model.onPick($0, screen) }
        case .hour:
            words(BarText.hour(model.now, names: model.bar.hourNames), s).foregroundStyle(quiet).modifier(BarInset())
        case .clock:
            calendar(BarText.clock(model.now, format: model.bar.clockFormat)) {
                ClockFace(now: model.now, format: model.bar.clockFormat, style: s)
            }
        case .date:
            calendar(BarText.date(model.now)) { words(BarText.date(model.now), s).foregroundStyle(quiet) }
        case .verse:
            if let v = model.verse {
                HStack(spacing: 8) {
                    words(v.text, s).foregroundStyle(quiet).truncationMode(.tail)
                    words(v.ref, s).foregroundStyle(s.ink(Chrome.muted, dim: 0.6)).fixedSize()
                }
                .help("\(v.text) (\(v.ref), BSB)")
                .modifier(BarInset())
            }
        case .battery:
            if let b = model.battery {
                HStack(spacing: 5) {
                    if let c = model.charge {
                        BatteryGlyph(look: BarStatus.batteryLook(percent: c.percent, charging: c.charging, onPower: c.onPower,
                                                                 lowPower: c.lowPower), ink: quiet)
                    }
                    words(b, s).monospacedDigit().foregroundStyle(quiet)
                }
                .modifier(BarInset())
            }
        case .network:
            if model.offline { words("Offline", s, .semibold).foregroundStyle(s.ink(Chrome.urgent)).modifier(BarInset()) }
        case .appMenus:
            MenuRow(items: model.menus, style: s) { model.onMenu($0) }
        case .status:
            StatusRow(model: model, style: s, room: room)
        case .agents:
            BarButton(inset: CGFloat(BarGeometry.textInset), held: isOpen(.agents), label: model.agents.label, help: model.agents.label,
                      under: { model.onAgents(screen, $0) }) {
                AgentsFace(agents: model.agents, style: s)
            }
        case .page:
            if let p = model.pages[display] { PageModule(page: p, style: s) { model.onPage($0) } }
        case .notifications:
            BarButton(inset: model.notices.isEmpty ? 0 : CGFloat(BarGeometry.textInset), held: isOpen(.notifications),
                      label: model.notices.isEmpty ? "Notifications" : "Notifications, \(model.notices) new", help: "Notifications",
                      under: { model.onNotices(screen, $0) }) {
                HStack(spacing: 4) {
                    BarSymbol(name: model.notices.isEmpty ? "bell" : "bell.fill")
                    if !model.notices.isEmpty { words(model.notices, s, .semibold).monospacedDigit() }
                }
                .foregroundStyle(s.ink(Chrome.wash(0.88)))
            }
        case .custom, .split:
            EmptyView()
        }
    }
}

/// Tells the buttons of a module the sheet draws a box round to keep the box's own height.
private struct BarBoxed: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View { content.transformEnvironment(\.barBoxed) { $0 = $0 || on } }
}

/// The room either side of a module that is only words, the same as a title's.
private struct BarInset: ViewModifier {
    func body(content: Content) -> some View { content.padding(.horizontal, CGFloat(BarGeometry.textInset)) }
}

/// An island's face: the theme's surface, a hairline edge and a soft shadow, each replaced by what the sheet's
/// `bar .island` sets.
/// Its corners and line width are the overview chip's, the theme's pill: square in Omarchy, rounded in BaneySpaces.
private struct IslandFace: View {
    let style: ComputedStyle
    /// The sheet's `bar { background }`: a sheet written for one strip (the `omarchy` preset) chose its text colors
    /// for that fill, so an island it leaves unset wears it.
    let barFill: StyleBackground?

    var body: some View {
        let shape = Styled.shape(style, else: Chrome.radius(.overviewChip))
        ZStack {
            if let fill = Styled.fill(style.background) ?? Styled.fill(barFill) {
                shape.fill(fill)
            } else {
                shape.fill(Chrome.panel(0.94))
            }
            if style.border == nil {
                shape.strokeBorder(Chrome.edge(0.22), lineWidth: Chrome.width(.overviewChip))
            } else {
                StyledLines(style: style, shape: shape)
            }
        }
        .compositingGroup()
        .modifier(IslandShadow(shadow: style.boxShadow))
    }
}

private struct IslandShadow: ViewModifier {
    let shadow: StyleShadow?
    func body(content: Content) -> some View {
        if shadow != nil {
            content.modifier(StyledShadow(shadow: shadow))
        } else {
            // Small enough to fade inside the 3 pt the island is inset from the panel's edge.
            content.shadow(color: Chrome.shadow(0.22), radius: 2, x: 0, y: 1)
        }
    }
}

/// macOS's battery, drawn: an outline filled to the charge in the bar's ink, the theme's `working` color in Low Power
/// Mode and `urgent` nearly empty, with a bolt while charging or a plug on power in ink, set in a gap cut out of the glyph.
/// Corners are the launcher key's, so the theme decides them (square in Omarchy).
struct BatteryGlyph: View {
    let look: BarStatus.BatteryLook
    let ink: Color

    private var badgeSymbol: String? {
        switch look.badge {
        case .none: nil
        case .bolt: "bolt.fill"
        case .plug: "powerplug.fill"
        }
    }

    private var fillColor: Color {
        switch look.tint {
        case .normal: ink
        case .lowPower: Chrome.working
        case .critical: Chrome.urgent
        }
    }

    var body: some View {
        let outer = Chrome.shape(.launcherKey)
        HStack(spacing: 1) {
            ZStack(alignment: .leading) {
                outer.strokeBorder(ink.opacity(0.45), lineWidth: Chrome.width(.launcherKey))
                GeometryReader { g in
                    RoundedRectangle(cornerRadius: max(0, Chrome.radius(.launcherKey) - 2), style: .continuous).fill(fillColor)
                        .frame(width: max(2, (g.size.width - 4) * look.fill), height: g.size.height - 4)
                        .offset(x: 2, y: 2)
                }
                if let symbol = badgeSymbol {
                    // A larger copy cuts a gap out of the outline and the fill, so the badge reads on whatever is behind
                    // the bar, filled or empty, with no color assumed.
                    Image(systemName: symbol).font(.system(size: 10, weight: .black))
                        .frame(maxWidth: .infinity).blendMode(.destinationOut)
                }
            }
            .compositingGroup()
            .overlay {
                if let symbol = badgeSymbol {
                    Image(systemName: symbol).font(.system(size: 7, weight: .black)).foregroundStyle(ink)
                }
            }
            .frame(width: 22, height: 11)
            .clipped()
            Capsule().fill(ink.opacity(0.45)).frame(width: 1.5, height: 4)
        }
        .accessibilityElement(children: .ignore)
    }
}
