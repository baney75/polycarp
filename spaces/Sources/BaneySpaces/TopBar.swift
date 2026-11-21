import AppKit
import BaneySpacesCore
import IOKit.ps
import Network
import SwiftUI

/// Polycarp's top bar (`bar.*` in surfaces.json): one strip per screen with the workspace you're on, what it is for,
/// today's one thing and the hour in words. It shows only where the macOS bar is set to hide
/// (`BarLayout.systemBarShown`), so pointing at the top edge still brings that bar and the app's menus down over it.
/// It sits just under your windows (`BarLayout.levelBelowWindows`): a window that reaches the top of the screen covers
/// it, so the bar never hides a window's buttons or title. It never takes focus and stays off full-screen apps. A click
/// switches workspaces (a dot) or opens what the macOS bar would (an app's menu, a status item). Main thread only.
final class TopBar {
    let model = TopBarModel()
    private let spaces: Spaces
    private var panels: [CGDirectDisplayID: NSPanel] = [:]
    private var tick: Timer?
    private let network = NWPathMonitor()
    private var powerSource: CFRunLoopSource?
    /// Set once System Settings was opened for `hideSystemMenuBar`, kept across launches, cleared when surfaces.json
    /// turns it off (`BarLayout.menuBarAsk`): the pane opens once each time you turn the setting on.
    private static let askedKey = "topBarAskedToHideMenuBar"
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
    }

    func start() {
        let center = NotificationCenter.default
        center.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in self?.reload(fromFile: true) }
        for name in [PurposeStore.didChange, NSApplication.didChangeScreenParametersNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.reload() }
        }
        // Set in System Settings, the menu bar's hiding changes the visible frame (and posts this, undocumented).
        DistributedNotificationCenter.default().addObserver(forName: .init("AppleInterfaceMenuBarHidingChangedNotification"),
                                                            object: nil, queue: .main) { [weak self] _ in self?.reload() }
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.reload()
        }
        // Some apps fill their menu bar a moment after they come forward, so it is read again half a second on.
        workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.readMenus()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.readMenus() }
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
        let me = Unmanaged.passUnretained(self).toOpaque()
        if let src = IOPSNotificationCreateRunLoopSource({ ctx in
            guard let ctx else { return }
            Unmanaged<TopBar>.fromOpaque(ctx).takeUnretainedValue().readBattery()
        }, me)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
            powerSource = src
        }
        reload()
    }

    /// Workspaces changed: the dots and the purpose follow at once.
    func workspacesChanged() {
        guard !panels.isEmpty else { return }
        readWorkspaces()
    }

    /// Reads surfaces.json, the purposes and the screens, and puts a bar on each screen where the macOS bar is hidden.
    /// `fromFile` is a change the store read from surfaces.json, the only kind that may clear the menu bar latch.
    func reload(fromFile: Bool = false) {
        let bar = SurfacesStore.shared.current.bar
        model.bar = bar
        let ask = BarLayout.menuBarAsk(wantsHidden: bar.hideSystemMenuBar && bar.enabled,
                                       asked: UserDefaults.standard.bool(forKey: Self.askedKey), fromFile: fromFile)
        UserDefaults.standard.set(ask.asked, forKey: Self.askedKey)
        if ask.open { askToHideMenuBar() }
        guard bar.enabled else { removeAll(); return }

        let hidden = UserDefaults.standard.bool(forKey: "_HIHideMenuBar")
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
            place(on: screen, id: id, notch: notch, height: CGFloat(bar.height))
        }
        for (id, p) in panels where !keep.contains(id) { p.orderOut(nil); panels[id] = nil }
        if covered > 0, keep.isEmpty, !loggedCovered {
            Trace.log("top bar: on, but the macOS menu bar is shown on every screen; set System Settings > Menu Bar > Automatically hide and show the menu bar to Always")
        }
        loggedCovered = covered > 0 && keep.isEmpty
        guard !panels.isEmpty else { stopTicking(); return }
        readPurposes()
        readWorkspaces()
        readBattery()
        readMenus()
        readStatus()
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
        for p in panels.values { p.orderOut(nil) }
        panels = [:]
        stopTicking()
    }

    private func wants(_ m: Surfaces.BarModule) -> Bool {
        let bar = model.bar
        return bar.enabled && !panels.isEmpty && (bar.left + bar.center + bar.right).contains(m)
    }

    /// The front app's menus for `app-menus`.
    private func readMenus() {
        guard wants(.appMenus), let app = NSWorkspace.shared.frontmostApplication else {
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
        let apps = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier != me }
        let targets = apps.map { (pid: $0.processIdentifier, bundle: $0.bundleIdentifier ?? "") }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let read = BarReader.status(of: targets)
            DispatchQueue.main.async {
                guard let self else { return }
                self.readingStatus = false
                if self.statusDirty { self.statusDirty = false; self.readStatus() }
                // The module went off while this was read.
                guard self.wants(.status) else { return }
                let bar = self.model.bar
                let kept = BarStatus.shown(read, \.item, modules: bar.left + bar.center + bar.right)
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

    private func readPurposes() {
        let store = PurposeKeeper.shared.purposes
        let all = store.snapshot.all
        if model.purposes != all { model.purposes = all }
        let one = store.oneThing?.text
        if model.oneThing != one { model.oneThing = one }
    }

    private func readWorkspaces() {
        var current: [CGDirectDisplayID: Int] = [:]
        for screen in NSScreen.screens { if let id = screen.displayID { current[id] = spaces.workspace(onScreen: screen) } }
        let occupied = Set(Workspaces.range.filter { !spaces.model.windows(on: $0).isEmpty })
        if model.current != current { model.current = current }
        if model.occupied != occupied { model.occupied = occupied }
        readPurposes()
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
            text = BarText.battery(percent: percent, charging: charging,
                                   onPower: d[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue)
            if model.charge?.percent != percent || model.charge?.charging != charging { model.charge = (percent, charging) }
        }
        if model.battery != text { model.battery = text }
    }

    /// The clock and the hour change on the minute; the timer is set for the next one, not every second.
    private func refreshTime() {
        let now = Date()
        model.now = now
        model.verse = Verses.pick(SurfacesStore.shared.current.desktop.verseRotation, at: now)
        tick?.invalidate()
        let t = Timer(fire: BarText.nextMinute(after: now), interval: 0, repeats: false) { [weak self] _ in self?.refreshTime() }
        t.tolerance = 1
        RunLoop.main.add(t, forMode: .common)
        tick = t
    }

    private func stopTicking() {
        tick?.invalidate()
        tick = nil
    }

    /// Polycarp never writes the menu bar setting: it opens the pane where you choose Always.
    private func askToHideMenuBar() {
        guard !UserDefaults.standard.bool(forKey: "_HIHideMenuBar"),
              let url = URL(string: "x-apple.systempreferences:com.apple.ControlCenter-Settings.extension?MenuBar") else { return }
        Trace.log("top bar: opening System Settings > Menu Bar so you can set the macOS menu bar to hide")
        NSWorkspace.shared.open(url)
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
    @Published var purposes: [Int: String] = [:]
    @Published var oneThing: String?
    @Published var battery: String?
    @Published var offline = false
    @Published var verse: Verse?
    @Published var menus: [BarMenus.Item] = []
    @Published var status: [BarStatus.Item] = []
    /// An app's icon by bundle id, drawn for its status items.
    @Published var icons: [String: NSImage] = [:]
    /// The battery's charge for the macOS battery item in `status`.
    @Published var charge: (percent: Int, charging: Bool)?
    var onPick: (Int, NSScreen) -> Void = { _, _ in }
    /// Presses the front app's menu at a `BarMenus.Item.index`.
    var onMenu: (Int) -> Void = { _ in }
    /// Opens Polycarp's own menu, the one its status item holds.
    var onMark: () -> Void = {}
    /// Presses the status item at an index of `status`.
    var onStatus: (Int) -> Void = { _ in }
}

/// One screen's bar. `sides` is the width beside the notch on each side, or nil on a screen without one.
struct TopBarView: View {
    @ObservedObject var model: TopBarModel
    @ObservedObject private var appearance = Appearance.shared
    let display: CGDirectDisplayID
    let screen: NSScreen
    let sides: (left: CGFloat, right: CGFloat)?

    private var here: Int { model.current[display] ?? 1 }
    private var gap: CGFloat { 12 }

    var body: some View {
        let places = BarLayout.places(model.bar, notch: sides != nil)
        ZStack {
            background
            if let sides {
                HStack(spacing: 0) {
                    row(places.left).frame(width: max(0, sides.left - gap), alignment: .leading)
                    Spacer(minLength: 0)
                    row(places.right).frame(width: max(0, sides.right - gap), alignment: .trailing)
                }
            } else {
                // Each place gets its share of the width, so a long purpose or one thing shortens instead of running
                // into the next: the middle up to half, the sides what is left either side of it.
                GeometryReader { g in
                    let middle = places.center.isEmpty ? 0 : g.size.width * BarLayout.middleShare
                    let side = max(0, (g.size.width - middle) / 2 - gap)
                    ZStack {
                        HStack(spacing: 0) {
                            row(places.left).frame(maxWidth: side, alignment: .leading)
                            Spacer(minLength: 0)
                            row(places.right).frame(maxWidth: side, alignment: .trailing)
                        }
                        row(places.center).frame(maxWidth: middle)
                    }
                    .frame(width: g.size.width, height: g.size.height)
                }
            }
        }
        .padding(.horizontal, gap)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .environment(\.colorScheme, Chrome.scheme)
    }

    @ViewBuilder private var background: some View {
        switch model.bar.style {
        case .solid:
            Chrome.panel(0.94).padding(.horizontal, -gap)
        case .glass:
            Rectangle().fill(.ultraThinMaterial).overlay(Chrome.panel(0.35)).padding(.horizontal, -gap)
        case .hairline:
            VStack(spacing: 0) { Spacer(minLength: 0); Chrome.edge(0.3).frame(height: Chrome.width(.dockBar)) }.padding(.horizontal, -gap)
        }
    }

    private func row(_ modules: [Surfaces.BarModule]) -> some View {
        HStack(spacing: gap) {
            ForEach(modules.filter(BarLayout.drawn), id: \.id) { module($0) }
        }
        .lineLimit(1)
    }

    @ViewBuilder private func module(_ m: Surfaces.BarModule) -> some View {
        switch m {
        case .mark:
            VineMark().frame(width: 12, height: 12)
                .padding(.vertical, 4).contentShape(Rectangle())
                .onTapGesture { model.onMark() }
                .help("Polycarp")
                .accessibilityLabel("Polycarp menu")
                .accessibilityAddTraits(.isButton)
        case .workspaces:
            dots
        case .purpose:
            if let p = model.purposes[here], !p.isEmpty {
                Text(p).font(Chrome.voice(12)).foregroundStyle(Chrome.wash(0.92)).truncationMode(.tail)
                    .help("Workspace \(here) is for: \(p)")
            }
        case .oneThing:
            if let one = model.oneThing, !one.isEmpty {
                HStack(spacing: 6) {
                    Text("One thing").font(Chrome.font(11, .medium)).foregroundStyle(Chrome.gold).fixedSize()
                    Text(one).font(Chrome.font(11, .medium)).foregroundStyle(Chrome.wash()).truncationMode(.tail)
                }
                .accessibilityElement(children: .combine)
            }
        case .hour:
            Text(BarText.hour(model.now, names: model.bar.hourNames)).font(Chrome.font(11, .medium)).foregroundStyle(Chrome.wash(0.85))
        case .clock:
            Text(BarText.clock(model.now, format: model.bar.clockFormat)).font(Chrome.font(11, .medium)).monospacedDigit()
                .foregroundStyle(Chrome.wash(0.85))
        case .date:
            Text(BarText.date(model.now)).font(Chrome.font(11, .medium)).foregroundStyle(Chrome.wash(0.85))
        case .verse:
            if let v = model.verse {
                HStack(spacing: 6) {
                    Text(v.text).font(Chrome.voice(11.5)).foregroundStyle(Chrome.wash(0.85)).truncationMode(.tail)
                    Text(v.ref).font(Chrome.font(10, .semibold)).foregroundStyle(Chrome.gold)
                }
                .help("\(v.text) (\(v.ref), BSB)")
            }
        case .battery:
            if let b = model.battery { Text(b).font(Chrome.font(11, .medium)).monospacedDigit().foregroundStyle(Chrome.wash(0.85)) }
        case .network:
            if model.offline { Text("Offline").font(Chrome.font(11, .semibold)).foregroundStyle(Chrome.urgent) }
        case .appMenus:
            menus
        case .status:
            statusItems
        case .custom:
            EmptyView()
        }
    }

    /// The front app's menus: the Apple logo, its name in bold, then its menus, as many as fit. Click one to open it.
    private var menus: some View {
        FitRow(spacing: 14) {
            ForEach(model.menus, id: \.index) { item in
                Group {
                    switch item.role {
                    case .apple: Image(systemName: "apple.logo").font(.system(size: 12, weight: .medium))
                    case .app: Text(item.title).font(Chrome.font(12, .bold))
                    case .menu: Text(item.title).font(Chrome.font(12))
                    }
                }
                .foregroundStyle(Chrome.wash(0.92))
                .fixedSize()
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .onTapGesture { model.onMenu(item.index) }
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(.isButton)
            }
        }
    }

    /// Every app's status items, as many as fit from the right: macOS's as symbols, an app's own as its icon.
    private var statusItems: some View {
        FitRow(spacing: 10, fromEnd: true) {
            ForEach(Array(model.status.enumerated()), id: \.offset) { i, item in
                Group {
                    if let symbol = BarStatus.symbol(item, percent: model.charge?.percent, charging: model.charge?.charging ?? false) {
                        Image(systemName: symbol).font(.system(size: 12, weight: .medium)).foregroundStyle(Chrome.wash(0.85))
                    } else if let icon = model.icons[item.owner] {
                        Image(nsImage: icon).resizable().interpolation(.high).frame(width: 15, height: 15)
                    } else {
                        Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(Chrome.wash(0.6))
                    }
                }
                .frame(minWidth: 16, minHeight: 16)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .onTapGesture { model.onStatus(i) }
                .help(item.name)
                .accessibilityLabel(item.name)
                .accessibilityAddTraits(.isButton)
            }
        }
    }

    /// A dot for each workspace with windows; the one you're on is drawn long in its color. Click one to go there.
    private var dots: some View {
        HStack(spacing: 4) {
            ForEach(BarLayout.dots(occupied: model.occupied, current: here), id: \.self) { n in
                let on = n == here
                Capsule()
                    .fill(on ? Chrome.workspace(n) : Chrome.wash(0.35))
                    .frame(width: on ? 14 : 5, height: 5)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                    .onTapGesture { model.onPick(n, screen) }
                    .help(model.purposes[n].map { "Workspace \(n): \($0)" } ?? "Workspace \(n)")
                    .accessibilityLabel(on ? "Workspace \(n), you're here" : "Workspace \(n)")
                    .accessibilityAddTraits(.isButton)
            }
        }
    }
}

/// Polycarp's vine mark: a stem with two leaves, in the theme's foreground and warm color.
private struct VineMark: View {
    var body: some View {
        Canvas { ctx, size in
            let s = size.width / 16
            var stem = Path()
            stem.move(to: CGPoint(x: 3 * s, y: 13 * s))
            stem.addCurve(to: CGPoint(x: 13 * s, y: 3 * s), control1: CGPoint(x: 6 * s, y: 10 * s), control2: CGPoint(x: 9 * s, y: 7 * s))
            ctx.stroke(stem, with: .color(Chrome.accent), lineWidth: s * 1.4)
            func leaf(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ deg: Double, _ c: Color) {
                let r = CGRect(x: -w * s, y: -h * s, width: 2 * w * s, height: 2 * h * s)
                let t = CGAffineTransform(translationX: x * s, y: y * s).rotated(by: deg * .pi / 180)
                ctx.fill(Path(ellipseIn: r).applying(t), with: .color(c))
            }
            leaf(6.5, 8, 2.2, 1.2, -40, Chrome.accent)
            leaf(10, 6.4, 2, 1.1, 30, Chrome.gold)
        }
    }
}
