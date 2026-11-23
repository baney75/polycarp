import AppKit
import BaneySpacesCore
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
    private var menuOwner: NSKeyValueObservation?
    /// The minute the menus were last read on the clock's tick.
    private var menuMinute: Date?
    /// The height the panels were placed at, so a theme change that leaves it alone places nothing.
    private var placedHeight: Double?

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

    /// Workspaces changed: the numbers follow at once.
    func workspacesChanged() {
        guard !panels.isEmpty else { return }
        SystemMenuBar.hide(true)
        readWorkspaces()
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
    /// style.css: what the sheet says for the bar, its regions, modules and workspace numbers (docs/style.md).
    @ObservedObject private var styles = Styles.shared
    /// The module and the workspace number under the pointer, for `:hover`.
    @State private var hovered: String?
    @State private var hoveredNumber: Int?
    let display: CGDirectDisplayID
    let screen: NSScreen
    let sides: (left: CGFloat, right: CGFloat)?

    private var here: Int { model.current[display] ?? 1 }
    /// The bar's inset from each screen edge, or the sheet's `bar { padding }`.
    private var inset: EdgeInsets {
        styles.book.bar.padding.map(Styled.insets) ?? EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12)
    }
    /// Between modules, as Waybar spaces its own: no separators. The sheet's `gap` for the bar or a region wins.
    private var spacing: CGFloat { CGFloat(styles.book.bar.gap ?? 14) }
    /// The bar's text size: one monospace face (`Chrome.mono`) for all of it.
    private var text: Double { 12 }

    var body: some View {
        let places = BarLayout.places(model.bar, notch: sides != nil)
        let pad = inset
        ZStack {
            background.padding(EdgeInsets(top: -pad.top, leading: -pad.leading, bottom: -pad.bottom, trailing: -pad.trailing))
            if let sides {
                HStack(spacing: 0) {
                    row(places.left, .left).frame(width: max(0, sides.left - pad.leading), alignment: .leading)
                    Spacer(minLength: 0)
                    row(places.right, .right).frame(width: max(0, sides.right - pad.trailing), alignment: .trailing)
                }
            } else {
                // Each place gets its share of the width, so a long verse or app menu row shortens instead of running
                // into the next: the middle up to half, the sides what is left either side of it.
                GeometryReader { g in
                    let middle = places.center.isEmpty ? 0 : g.size.width * BarLayout.middleShare
                    let side = max(0, (g.size.width - middle) / 2 - max(pad.leading, pad.trailing))
                    ZStack {
                        HStack(spacing: 0) {
                            row(places.left, .left).frame(maxWidth: side, alignment: .leading)
                            Spacer(minLength: 0)
                            row(places.right, .right).frame(maxWidth: side, alignment: .trailing)
                        }
                        row(places.center, .center).frame(maxWidth: middle)
                    }
                    .frame(width: g.size.width, height: g.size.height)
                }
            }
        }
        .padding(pad)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        case .solid:
            // The theme's background role, whole: one calm strip.
            Chrome.panel()
        case .glass:
            Rectangle().fill(.ultraThinMaterial).overlay(Chrome.panel(0.35))
        case .hairline:
            VStack(spacing: 0) { Spacer(minLength: 0); Chrome.edge(0.3).frame(height: Chrome.width(.dockBar)) }
        }
    }

    /// One region's modules. The sheet can hide a region, box it and set its own gap.
    @ViewBuilder private func row(_ modules: [Surfaces.BarModule], _ region: StyleBook.Region) -> some View {
        let r = styles.book.region(region)
        if !r.isHidden {
            HStack(spacing: r.gap.map { CGFloat($0) } ?? spacing) {
                ForEach(modules.filter(BarLayout.drawn), id: \.id) { styled($0, region) }
            }
            .lineLimit(1)
            .modifier(StyledBox(style: r))
        }
    }

    /// A module with the sheet's style for it where it sits, hidden by `display: none`.
    @ViewBuilder private func styled(_ m: Surfaces.BarModule, _ region: StyleBook.Region) -> some View {
        let s = styles.book.module(m, in: region, hover: hovered == m.id)
        if !s.isHidden {
            module(m, s, region)
                .modifier(StyledText(style: s))
                .modifier(StyledBox(style: s))
                .onHover { on in
                    if on { hovered = m.id } else if hovered == m.id { hovered = nil }
                }
        }
    }

    /// The text of a module in its style: the sheet's font and case over the bar's one monospace face.
    private func words(_ text: String, _ s: ComputedStyle, _ weight: TextWeight = .regular) -> Text {
        Text(s.cased(text)).font(Styled.font(s, .mono, self.text, weight))
    }

    @ViewBuilder private func module(_ m: Surfaces.BarModule, _ s: ComputedStyle, _ region: StyleBook.Region) -> some View {
        switch m {
        case .mark:
            VineMark().frame(width: 12, height: 12)
                .padding(.vertical, 4).contentShape(Rectangle())
                .onTapGesture { model.onMark() }
                .help("Polycarp")
                .accessibilityLabel("Polycarp menu")
                .accessibilityAddTraits(.isButton)
        case .workspaces:
            numbers(s, region)
        case .hour:
            words(BarText.hour(model.now, names: model.bar.hourNames), s).foregroundStyle(s.ink(Chrome.wash(0.85)))
        case .clock:
            words(BarText.clock(model.now, format: model.bar.clockFormat), s).foregroundStyle(s.ink(Chrome.wash()))
                .fixedSize()
        case .date:
            words(BarText.date(model.now), s).foregroundStyle(s.ink(Chrome.wash(0.85)))
        case .verse:
            if let v = model.verse {
                HStack(spacing: 8) {
                    words(v.text, s).foregroundStyle(s.ink(Chrome.wash(0.85))).truncationMode(.tail)
                    words(v.ref, s).foregroundStyle(s.ink(Chrome.wash(0.5), dim: 0.6)).fixedSize()
                }
                .help("\(v.text) (\(v.ref), BSB)")
            }
        case .battery:
            if let b = model.battery { words(b, s).foregroundStyle(s.ink(Chrome.wash(0.85))) }
        case .network:
            if model.offline { words("Offline", s, .semibold).foregroundStyle(s.ink(Chrome.urgent)) }
        case .appMenus:
            menus(s)
        case .status:
            statusItems(s)
        case .custom:
            EmptyView()
        }
    }

    /// The front app's menus: the Apple logo, its name in semibold, then its menus, as many as fit. Click one to open it.
    private func menus(_ s: ComputedStyle) -> some View {
        FitRow(spacing: s.gap.map { CGFloat($0) } ?? 12) {
            ForEach(model.menus, id: \.index) { item in
                Group {
                    switch item.role {
                    case .apple: Image(systemName: "apple.logo").font(.system(size: 12, weight: .medium))
                    case .app: words(item.title, s, .semibold)
                    case .menu: words(item.title, s)
                    }
                }
                .foregroundStyle(s.ink(Chrome.wash(0.92)))
                .fixedSize()
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .onTapGesture { model.onMenu(item.index) }
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(.isButton)
            }
        }
    }

    /// Every app's status items, as many as fit from the right, in one monochrome row like Waybar's glyphs: macOS's as
    /// symbols and a template icon in the bar's foreground, any other app icon in gray.
    private func statusItems(_ s: ComputedStyle) -> some View {
        FitRow(spacing: s.gap.map { CGFloat($0) } ?? 10, fromEnd: true) {
            ForEach(Array(model.status.enumerated()), id: \.offset) { i, item in
                Group {
                    if let symbol = BarStatus.symbol(item, percent: model.charge?.percent, charging: model.charge?.charging ?? false) {
                        Image(systemName: symbol).font(.system(size: 12, weight: .medium)).foregroundStyle(s.ink(Chrome.wash(0.85)))
                    } else if let icon = model.icons[item.owner], icon.isTemplate {
                        Image(nsImage: icon).renderingMode(.template).resizable().interpolation(.high).frame(width: 15, height: 15)
                            .foregroundStyle(s.ink(Chrome.wash(0.85)))
                    } else if let icon = model.icons[item.owner] {
                        Image(nsImage: icon).resizable().interpolation(.high).frame(width: 15, height: 15)
                            .grayscale(1).opacity(0.85)
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

    /// A number for each workspace with windows and the one you're on (`BarWorkspaces.shown`), as Omarchy's bar has them:
    /// the one you're on in full over an accent line (or on an accent block, `BarWorkspaces.marker`), the rest muted.
    /// The line sits under the digit without moving it, so the numbers stay centered. Click one to go there.
    /// The sheet's `bar .workspace` (with `.current` and `:hover`) styles each number; a `border-bottom` it sets is the
    /// line in place of the accent one, and the module's `gap` spaces them.
    private func numbers(_ module: ComputedStyle, _ region: StyleBook.Region) -> some View {
        let marker = BarWorkspaces.marker(Chrome.spec.indicator)
        return HStack(spacing: module.gap.map { CGFloat($0) } ?? 10) {
            ForEach(BarWorkspaces.shown(occupied: model.occupied, current: here), id: \.self) { n in
                let on = n == here
                let w = styles.book.workspace(in: region, current: on, hover: hoveredNumber == n)
                Group {
                    if w.isHidden {
                        EmptyView()
                    } else if on, marker == .block, w.color == nil, !w.hasBox {
                        words("\(n)", w, .semibold).foregroundStyle(Chrome.onAccent)
                            .padding(.horizontal, 4)
                            .background(Rectangle().fill(Chrome.accent))
                    } else {
                        words("\(n)", w, on ? .semibold : .regular).foregroundStyle(w.ink(on ? Chrome.wash() : Chrome.wash(0.5)))
                            .modifier(StyledText(style: w))
                            .overlay(alignment: .bottom) {
                                if on, w.borderBottom == nil { Rectangle().fill(Chrome.accent).frame(height: 2).offset(y: 3) }
                            }
                            .modifier(StyledBox(style: w))
                    }
                }
                .onHover { inside in
                    if inside { hoveredNumber = n } else if hoveredNumber == n { hoveredNumber = nil }
                }
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .onTapGesture { model.onPick(n, screen) }
                .help("Workspace \(n)")
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
