import AppKit
import BaneySpacesCore
import SwiftUI
import os

/// ⌘Tab across workspaces: hold ⌘, tap Tab to step, let go to go there. ⌘⇧Tab steps back;
/// Esc cancels. A quick tap goes to the one before without the panel coming up (`SwitcherReveal`).
/// In window mode it steps through every window, most recently used first, whatever app or
/// workspace it's in. In app mode it steps through every app with a window, on any workspace, most
/// recently used first, and letting go lands on that app's window wherever it is. In workspace
/// mode it steps through workspaces with windows, most recent first, with the one you're on
/// first even when it's empty. The arrow keys step too.
///
/// In app mode, holding Tab on an app with more than one window opens the window bar: that app's windows,
/// on every workspace, to tab through the same way. Holding Tab again goes back to the apps.
final class WorkspaceSwitcher {
    private let spaces: Spaces
    private let model = SwitcherModel()
    private var panel: NSPanel?
    /// Its panel sits at the pop-up menu level without being a menu; the dock doesn't count it as one.
    var windowNumber: Int? { panel?.windowNumber }
    private var watchdog: Timer?
    /// The page in front in each of a browser's windows (pid, its windows), where its extension says: its title and its
    /// site's icon, if there is one yet.
    var pages: (pid_t, [(id: UInt32, title: String)]) -> [UInt32: (title: String, icon: NSImage?)] = { _, _ in [:] }
    /// Apps in the order they were last brought forward, most recent first.
    private var appOrder: [pid_t] = []
    private var hold = TabHold()
    /// Checks a press once it has lasted long enough to be a hold. Key repeats alone aren't
    /// enough: they don't always reach the event tap, and then holding Tab did nothing.
    private var holdCheck: DispatchWorkItem?
    private var reveal = SwitcherReveal()
    private var revealCheck: DispatchWorkItem?
    /// Which time the panel came up, so a late look at one never judges the next.
    private var shows = 0

    init(spaces: Spaces) {
        self.spaces = spaces
        if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier { appOrder = [front] }
    }

    /// The panel is up. A gesture runs before that too, and may end with no panel at all: `isActive`.
    var isShowing: Bool { panel?.isVisible == true }
    /// From the first Tab until ⌘ comes up or Esc.
    var isActive: Bool { reveal.active }

    /// Called for every app that comes forward, by any means.
    func noteActivated(_ pid: pid_t) {
        guard pid != getpid() else { return }
        appOrder.removeAll { $0 == pid }
        appOrder.insert(pid, at: 0)
        if appOrder.count > 64 { appOrder.removeLast() }
    }

    /// `time` is the system uptime when the key arrived, read on the tap's thread.
    func step(forward: Bool, isRepeat: Bool, at time: Double) {
        // A held Tab opens or closes the window bar once, on the app that's highlighted; its
        // other repeats do nothing, so holding never races through the list.
        if isRepeat { return held(at: time, via: "repeat") }
        guard !isActive else {
            // Wait to see whether this press is a tap (step when it's let go) or a hold (stay).
            // Windows and workspaces have no window bar, so a press there steps at once and leaves nothing
            // pending: the first press of the gesture used deferStep false, so Tab's release
            // returns nil and can't step a second time (SwitcherSelectionTests pins it).
            if model.mode == .apps {
                hold.press(at: time, forward: forward, deferStep: true)
                checkHold(pressedAt: time)
            } else {
                advance(forward)
            }
            return revealNow()
        }
        hold.press(at: time)
        checkHold(pressedAt: time)
        model.windowBar = nil
        // Off can't get here: the key watcher leaves ⌘Tab alone.
        model.mode = switch MissionControlKeys.cmdTabMode { case .windows: .windows; case .workspaces: .workspaces; case .apps, .off: .apps }
        var inFront = true
        switch model.mode {
        case .windows:
            let list = spaces.switcherWindows()
            inFront = list.inFront
            var icons: [pid_t: NSImage] = [:]
            model.windows = list.cards.map { e, n in
                let icon = icons[e.pid] ?? icon(of: e.pid)
                icons[e.pid] = icon
                return .init(id: e.id, title: WindowTitle.clean(e.title, app: e.app), workspace: n, pid: e.pid, app: e.app, icon: icon)
            }
            for pid in icons.keys { name(&model.windows, of: pid) }
            Trace.log("cmdTab show windows=\(model.windows.count) current=\(spaces.model.current)")
        case .workspaces:
            let order = spaces.switcherOrder()
            let current = spaces.model.current
            Trace.log("cmdTab show order=\(order) current=\(current)")
            model.tiles = order.map { n in
                SwitcherModel.Tile(n: n, icons: icons(on: n), count: spaces.entries(on: n).count, isCurrent: n == current)
            }
        case .apps:
            model.apps = appTiles()
            Trace.log("cmdTab show apps=\(model.apps.count) current=\(spaces.model.current)")
        }
        // The first tap lands on the previous one, like the app switcher.
        model.selected = SwitcherSelection.first(count: model.count, forward: forward, inFront: inFront)
        reveal.begin(at: time)
        awaitReveal()
        watchCommand()
    }

    /// Shows the panel once the gesture has lasted long enough to be more than a tap.
    private func awaitReveal() {
        revealCheck?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isActive, !self.reveal.isUp else { return }
            if self.reveal.lasted(at: ProcessInfo.processInfo.systemUptime) { self.show() } else { self.awaitReveal() }
        }
        revealCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + reveal.wait(at: ProcessInfo.processInfo.systemUptime), execute: work)
    }

    /// The gesture's second step: picking from the list, not tapping back, so the list shows at once.
    private func revealNow() {
        if reveal.stepped() { show() }
    }

    /// Tab held past the threshold, by a key repeat or the hold check, whichever comes first:
    /// opens or closes the window bar once, on the app that's highlighted.
    private func held(at time: Double, via source: String) {
        guard isActive, model.mode == .apps, hold.repeated(at: time) else { return }
        holdCheck?.cancel()
        if model.windowBar != nil { return toggleWindowBar() }
        guard WindowBarGate.shouldOpen(windowCount: windowCount(of: model.selected)) else {
            Trace.log("cmdTab hold (\(source)): highlighted app has one window")
            return
        }
        Trace.log("cmdTab hold (\(source))")
        toggleWindowBar()
    }

    /// When the press would become a hold, looks at the keyboard itself: Tab still down is a
    /// hold, whether or not any repeat arrived.
    private func checkHold(pressedAt time: Double) {
        holdCheck?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, CGEventSource.keyState(.hidSystemState, key: CGKeyCode(MissionControlKeys.tabKey)) else { return }
            self.held(at: ProcessInfo.processInfo.systemUptime, via: "check")
        }
        holdCheck = work
        let wait = TabHold.threshold - (ProcessInfo.processInfo.systemUptime - time)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, wait) + 0.02, execute: work)
    }

    /// Tab let go: a tap takes its step now.
    func tabReleased() {
        holdCheck?.cancel()
        guard isActive, let forward = hold.release() else { return }
        advance(forward)
    }

    /// An arrow key during the gesture: one step, the same as a Tab tap; up and down go by row among windows.
    func arrow(forward: Bool, byRow: Bool) {
        guard isActive else { return }
        // Rows are the panel's once it's up, wherever the pointer went since.
        if !reveal.isUp { fitScreen() }
        if byRow, model.mode == .windows {
            model.selected = SwitcherSelection.row(selected: model.selected, count: model.count, columns: model.grid.columns, forward: forward)
        } else {
            advance(forward)
        }
        revealNow()
    }

    /// Titles read again in the background (`refreshDetails`) since the gesture started: the cards say the new ones.
    func titlesChanged() {
        guard isActive, model.mode == .windows else { return }
        for i in model.windows.indices {
            let w = model.windows[i], title = WindowTitle.clean(spaces.title(of: w.id), app: w.app)
            if !title.isEmpty, title != w.title { model.windows[i].title = title }
        }
        for pid in Set(model.windows.map(\.pid)) { name(&model.windows, of: pid) }
    }

    /// A browser's windows by the page in front, with its site's icon.
    private func name(_ tiles: inout [SwitcherModel.WindowTile], of pid: pid_t) {
        let mine = tiles.filter { $0.pid == pid }
        let said = pages(pid, mine.map { (id: $0.id, title: spaces.title(of: $0.id)) })
        guard !said.isEmpty else { return }
        for i in tiles.indices {
            guard let page = said[tiles[i].id] else { continue }
            if !page.title.isEmpty, page.title != tiles[i].title { tiles[i].title = page.title }
            if page.icon !== tiles[i].site { tiles[i].site = page.icon }
        }
    }

    /// One step through the window bar if it's open, otherwise through the cards as drawn.
    private func advance(_ forward: Bool) {
        if let bar = model.windowBar {
            model.windowBar!.selected = SwitcherSelection.advance(selected: bar.selected, count: bar.windows.count, forward: forward)
        } else {
            model.selected = SwitcherSelection.advance(selected: model.selected, count: model.count, forward: forward)
        }
    }

    func commit() {
        guard isActive else { return }
        // ⌘ came up before Tab: the tap still counts.
        if let forward = hold.release() { advance(forward) }
        end()
        switch model.mode {
        case .windows:
            guard model.windows.indices.contains(model.selected) else { return }
            let w = model.windows[model.selected]
            go(to: w, of: w.pid)
        case .workspaces:
            let target = model.tiles.indices.contains(model.selected) ? model.tiles[model.selected].n : nil
            Trace.log("cmdTab commit target=\(target.map(String.init) ?? "none") current=\(spaces.model.current)")
            if let target, target != spaces.model.current { spaces.switchTo(target, announce: false) }
        case .apps:
            if let bar = model.windowBar, bar.windows.indices.contains(bar.selected) {
                return go(to: bar.windows[bar.selected], of: bar.pid)
            }
            guard model.apps.indices.contains(model.selected) else { return }
            let app = model.apps[model.selected]
            Trace.log("cmdTab commit app on=\(app.workspace) current=\(spaces.model.current)")
            noteActivated(app.pid)
            spaces.focusApp(app.pid, on: app.workspace)
        }
    }

    /// Where the window is now decides: it may have moved, or closed, since its card was drawn.
    private func go(to w: SwitcherModel.WindowTile, of pid: pid_t) {
        Trace.log("cmdTab commit window on=\(spaces.model.workspace(of: w.id) ?? w.workspace) current=\(spaces.model.current)")
        noteActivated(pid)
        spaces.focusWindow(w.id, pid: pid)
    }

    func cancel() {
        Trace.log("cmdTab cancel")
        _ = hold.release()
        end()
    }

    /// Opens the selected app's window bar, or closes it back to the apps. An app with one
    /// window has nothing to pick, so a hold on it does nothing.
    private func toggleWindowBar() {
        if model.windowBar != nil {
            model.windowBar = nil
            Trace.log("cmdTab window bar closed")
            return relayout()
        }
        guard model.apps.indices.contains(model.selected) else { return }
        let app = model.apps[model.selected]
        var windows: [SwitcherModel.WindowTile] = []
        for n in [app.workspace] + Workspaces.range.filter({ $0 != app.workspace }) {
            // The window used last on each workspace leads that workspace's group.
            let last = spaces.model.lastFocused[n]
            let mine = spaces.entries(on: n).filter { $0.pid == app.pid }.sorted { $0.id == last && $1.id != last }
            for e in mine { windows.append(.init(id: e.id, title: WindowTitle.clean(e.title, app: e.app), workspace: n, pid: e.pid)) }
        }
        name(&windows, of: app.pid)
        guard windows.count > 1 else { return }
        Trace.log("cmdTab window bar opened windows=\(windows.count)")
        // The first one is the window that tapping would land on; a tap from here moves on.
        // For the app you're in, its first window is the one in front, so start on the next one.
        let inFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid && app.workspace == spaces.model.current
        model.windowBar = .init(pid: app.pid, name: app.name, icon: app.icon, windows: windows, selected: inFront ? 1 : 0)
        relayout()
    }

    /// Every window of the app at `index` in the list, on all workspaces.
    private func windowCount(of index: Int) -> Int {
        guard model.apps.indices.contains(index) else { return 0 }
        let pid = model.apps[index].pid
        return WindowBarGate.windowCount(
            pid: pid,
            tiles: model.apps.map { (pid: $0.pid, windows: $0.windows) }
        )
    }

    /// The bar changed size: keep it centered on the display it's on.
    private func relayout() {
        guard let p = panel, let host = p.contentView as? NSHostingView<SwitcherView>,
              let visible = p.screen?.visibleFrame ?? activeVisibleFrame() else { return }
        p.setFrame(SwitcherPanelFrame.center(content: contentSize(host), visibleFrame: visible), display: true)
    }

    /// The display under the pointer, else the main one, less the menu bar and the Dock.
    private func activeVisibleFrame() -> CGRect? {
        let screens = NSScreen.screens
        return SwitcherPanelFrame.activeVisibleFrame(
            pointer: NSEvent.mouseLocation,
            screens: screens.map { (frame: $0.frame, visible: $0.visibleFrame) },
            main: NSScreen.main.flatMap { m in screens.firstIndex { $0 === m } }
        )
    }

    /// Window cards are sized from `WindowGrid` and workspace tiles from `SwitcherLayout`; the other rows are measured.
    private func contentSize(_ host: NSHostingView<SwitcherView>) -> CGSize {
        if model.mode == .windows { return Styles.shared.book.switcher.panelSize(model.grid) }
        if model.mode == .workspaces, model.windowBar == nil {
            return Styles.shared.book.switcher.panelSize(tileCount: model.tiles.count, maxWidth: model.maxWidth)
        }
        // Lay out the new tiles first; otherwise fittingSize still reports the last gesture's size.
        host.layoutSubtreeIfNeeded()
        return host.fittingSize
    }

    /// Every app with a window, most recently used first; an app on two workspaces once for each.
    private func appTiles() -> [SwitcherModel.AppTile] {
        var windows: [(app: Int32, workspace: Int)] = []
        var names: [pid_t: String] = [:]
        var titles: [String: [String]] = [:]
        for n in Workspaces.range {
            for e in spaces.entries(on: n) {
                windows.append((e.pid, n))
                names[e.pid] = e.app
                titles["\(e.pid):\(n)", default: []].append(e.title)
            }
        }
        var last: [Int32: Int] = [:]
        for pid in Set(windows.map(\.app)) { last[pid] = spaces.lastWorkspace(of: pid) }
        let list = AppSwitchList.make(windows: windows, appOrder: appOrder, workspaceOrder: spaces.recent, lastWorkspace: last)
        return list.map { e in
            SwitcherModel.AppTile(pid: e.app, name: names[e.app] ?? "App",
                                  icon: icon(of: e.app),
                                  workspace: e.workspace, windows: e.windows, isSplit: e.isSplit,
                                  titles: titles["\(e.app):\(e.workspace)"] ?? [])
        }
    }

    private func icon(of pid: pid_t) -> NSImage {
        NSRunningApplication(processIdentifier: pid)?.icon ?? NSWorkspace.shared.icon(for: .application)
    }

    /// The workspace's apps in the dock tile's order: the one used there last first.
    private func icons(on n: Int) -> [NSImage] {
        var seen = Set<String>()
        let keys = spaces.entries(on: n).map { "\($0.pid)" }.filter { seen.insert($0).inserted }
        return DockAppOrder.sort(keys, activatedAt: spaces.activations.on(n)).compactMap { key in
            pid_t(key).flatMap { NSRunningApplication(processIdentifier: $0)?.icon }
        }
    }

    /// The display the panel opens on, which the cards are laid out for.
    private func fitScreen() {
        guard let visible = activeVisibleFrame() else { return }
        (model.maxWidth, model.maxHeight) = (Double(visible.width), Double(visible.height))
    }

    private func show(retried: Bool = false) {
        let clock = retried ? nil : OpenClock(panel == nil ? "switcher-first" : "switcher")
        defer { clock?.shown() }
        shows += 1
        let showing = shows
        fitScreen()
        let p = panel ?? makePanel()
        panel = p
        let host = p.contentView as! NSHostingView<SwitcherView>
        if let visible = activeVisibleFrame() {
            p.setFrame(SwitcherPanelFrame.center(content: contentSize(host), visibleFrame: visible), display: true)
        }
        p.orderFrontRegardless()
        p.displayIfNeeded()
        // A panel kept for hours has been seen to stay off screen though it was ordered in
        // front. If the window server doesn't have it on screen, build a new one, once. The
        // window server hears of the order only after this run-loop turn, so look a moment later.
        if !retried {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                guard let self, self.isActive, self.shows == showing, self.isShowing, self.panel === p, !p.isOnScreenNow else { return }
                Trace.log("cmdTab panel not on screen; rebuilding it")
                p.orderOut(nil)
                self.panel = nil
                self.show(retried: true)
            }
        }
    }

    /// If the key watcher misses ⌘ being let go (it was off for a moment), notice it here, panel or no panel.
    private func watchCommand() {
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, self.isActive else { return }
            if !NSEvent.modifierFlags.contains(.command) {
                MissionControlKeys.gestureEndedElsewhere()
                self.commit()
            }
        }
    }

    /// The gesture is over: nothing waiting on it runs, and its panel, if it came up, goes.
    private func end() {
        reveal.end()
        revealCheck?.cancel()
        holdCheck?.cancel()
        watchdog?.invalidate()
        watchdog = nil
        panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.level = .popUpMenu
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        p.contentView = NSHostingView(rootView: SwitcherView(model: model))
        return p
    }
}

final class SwitcherModel: ObservableObject {
    enum Mode { case windows, apps, workspaces }
    struct Tile: Identifiable {
        let n: Int
        let icons: [NSImage]
        let count: Int
        /// The workspace you're on: always listed, even empty, and marked.
        let isCurrent: Bool
        var id: Int { n }
    }
    struct AppTile: Identifiable {
        let pid: pid_t
        let name: String
        let icon: NSImage
        let workspace: Int
        let windows: Int
        /// The same app has windows on another workspace too.
        let isSplit: Bool
        var titles: [String] = []
        var id: String { "\(pid):\(workspace)" }
    }
    struct WindowTile: Identifiable {
        let id: WindowID
        var title: String
        let workspace: Int
        var pid: pid_t = 0
        var app = ""
        var icon: NSImage?
        /// A browser window's front page's site icon.
        var site: NSImage?
    }
    /// The window bar: one app's windows, open while Tab was held on it.
    struct WindowBar {
        let pid: pid_t
        let name: String
        let icon: NSImage
        var windows: [WindowTile]
        var selected: Int
    }
    @Published var windowBar: WindowBar?
    @Published var mode = Mode.workspaces
    @Published var tiles: [Tile] = []
    @Published var apps: [AppTile] = []
    @Published var windows: [WindowTile] = []
    @Published var selected = 0
    /// The display the panel opens on, for how many cards fit on a row and how many rows.
    @Published var maxWidth = SwitcherLayout.narrowScreen
    @Published var maxHeight = 700.0
    var grid: WindowGrid { .fit(count: windows.count, maxWidth: maxWidth, maxHeight: maxHeight) }
    var count: Int { switch mode { case .windows: windows.count; case .apps: apps.count; case .workspaces: tiles.count } }
}

struct SwitcherView: View {
    @ObservedObject var model: SwitcherModel
    /// Redraws when Settings › Appearance changes.
    @ObservedObject private var appearance = Appearance.shared
    @ObservedObject private var styles = Styles.shared

    /// Every part's style, worked out once for the sheet in force (`StyleBook.switcher`).
    private var sheet: SwitcherStyles { styles.book.switcher }
    /// Between app and window tiles.
    private var gap: CGFloat { sheet.panel.gap.map { CGFloat($0) } ?? 8 }

    var body: some View {
        Group {
            if sheet.plain { rows(Bare.self) } else { rows(Dressed.self) }
        }
        .padding(Styled.insets(sheet.padding))
        .background(Chrome.panelBackground(.switcherPanel, style: sheet.panel))
        .opacity(sheet.panel.opacity ?? 1)
        .environment(\.colorScheme, Chrome.scheme)
    }

    @ViewBuilder private func rows<D: Dress>(_ d: D.Type) -> some View {
        if let bar = model.windowBar { windowRow(d, bar) } else {
            switch model.mode {
            case .windows: windowRows(d)
            case .apps: appRow(d)
            case .workspaces: workspaceRow(d)
            }
        }
    }

    private func label(_ text: String, _ c: ComputedStyle, _ size: Double, _ weight: TextWeight, _ own: Color) -> some View {
        Text(c.cased(text)).spaced(c).font(Styled.font(c, .ui, size, weight)).foregroundStyle(c.ink(own))
    }

    /// Long lists wrap onto more rows instead of running off the screen. An app on two
    /// workspaces shows twice, each copy in its workspace's color with the number on it.
    private func appRow<D: Dress>(_ d: D.Type) -> some View {
        let sheet = sheet
        let columns = Array(repeating: GridItem(.fixed(104), spacing: gap), count: min(max(model.apps.count, 1), 8))
        return VStack(spacing: 10) {
            LazyVGrid(columns: columns, spacing: gap) {
                ForEach(Array(model.apps.enumerated()), id: \.element.id) { i, app in
                    let on = i == model.selected
                    let c = sheet.item(selected: on)
                    let tint = Chrome.workspace(app.workspace)
                    VStack(spacing: 6) {
                        ZStack(alignment: .topTrailing) {
                            Image(nsImage: app.icon).resizable().frame(width: 64, height: 64)
                                .modifier(D.cut(c.icon)).modifier(D.part(c.icon))
                            WorkspaceBadge(n: app.workspace).offset(x: 8, y: -4)
                            if app.windows > 1 {
                                Text("×\(app.windows)").font(Chrome.font(10, .bold, rounded: true)).foregroundStyle(Chrome.wash())
                                    .padding(.horizontal, 5).frame(minHeight: 17)
                                    .background(Chrome.pill().fill(Chrome.shade(0.75)))
                                    .offset(x: 8, y: c.icon.isHidden ? 18 : 50)
                            }
                        }
                        label(app.name, c.label, 12, .medium, Chrome.wash(on ? 1 : 0.7)).lineLimit(1).frame(maxWidth: 92)
                            .modifier(D.part(c.label))
                    }
                    // A tile grows with the sheet's text.
                    .frame(width: 104, height: c.label.fontSize == nil ? 108 : nil).frame(minHeight: 108)
                    // A split app's copies are told apart at a glance by their workspace's color.
                    .background(D.back(c.box, .switcherTile)
                        .fill(on ? Chrome.lit(tint, 0.28) : app.isSplit ? tint.opacity(0.10) : .clear).marking(on && !c.marked))
                    .overlay(D.edge(c.box, .switcherTile, on ? Chrome.focusEdge(tint) : app.isSplit ? tint.opacity(0.35) : Chrome.edge(0),
                                    focused: on, marking: on && !c.marked))
                    .modifier(D.part(c.box))
                    .accessibilityLabel("\(app.name), workspace \(app.workspace), \(app.windows) windows\(on ? ", selected" : "")")
                }
            }
            if model.apps.indices.contains(model.selected), !sheet.hint.isHidden {
                let hint = sheet.hint
                let app = model.apps[model.selected]
                let title = app.titles.first { !$0.isEmpty }
                HStack(spacing: 6) {
                    Chrome.mark().fill(Chrome.workspace(app.workspace)).frame(width: 7, height: 7)
                    Text(hint.cased(["Workspace \(app.workspace)", app.windows > 1 ? "\(app.windows) windows" : title].compactMap { $0 }.joined(separator: " · ")))
                        .spaced(hint).lineLimit(1)
                    if model.apps.filter({ $0.pid == app.pid }).reduce(0, { $0 + $1.windows }) > 1 {
                        Text(hint.cased("Hold Tab to pick a window")).spaced(hint).foregroundStyle(hint.ink(Chrome.wash(0.4), dim: 0.7))
                    }
                }
                .font(Styled.font(hint, .ui, 11, .semibold)).foregroundStyle(hint.ink(Chrome.wash(0.6)))
                .frame(maxWidth: 600)
                .opacity(hint.opacity ?? 1)
            }
        }
    }

    /// One app's windows, each with its title and workspace color. Wraps after four.
    private func windowRow<D: Dress>(_ d: D.Type, _ bar: SwitcherModel.WindowBar) -> some View {
        let sheet = sheet, heading = sheet.panel, hint = sheet.hint
        let columns = Array(repeating: GridItem(.fixed(200), spacing: gap), count: min(bar.windows.count, 4))
        return VStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(nsImage: bar.icon).resizable().frame(width: 22, height: 22)
                Text(heading.cased("\(bar.name) windows")).spaced(heading).font(Styled.font(heading, .ui, 13, .semibold)).foregroundStyle(heading.ink(Chrome.wash()))
                label("Hold Tab to go back", hint, 11, .medium, Chrome.wash(0.45)).modifier(D.part(hint))
            }
            LazyVGrid(columns: columns, spacing: gap) {
                ForEach(Array(bar.windows.enumerated()), id: \.element.id) { i, w in
                    windowCard(d, w, icon: bar.icon, title: w.title.isEmpty ? "Untitled window" : w.title, on: i == bar.selected, width: 200)
                }
            }
        }
    }

    /// Every window in even rows sized from `WindowGrid`, which the panel is framed from too.
    private func windowRows<D: Dress>(_ d: D.Type) -> some View {
        let grid = model.grid
        let card = CGSize(width: grid.cardWidth, height: grid.cardHeight)
        return VStack(alignment: .leading, spacing: WindowGrid.spacing) {
            ForEach(SwitcherLayout.rows(tileCount: model.windows.count, columns: grid.columns), id: \.lowerBound) { row in
                HStack(spacing: WindowGrid.spacing) {
                    ForEach(row, id: \.self) { i in
                        let w = model.windows[i]
                        windowCard(d, w, icon: w.icon, title: w.title.isEmpty ? w.app : w.title, on: i == model.selected,
                                   width: card.width, height: card.height, stacked: grid.isStacked)
                    }
                }
            }
            if model.windows.isEmpty {
                let c = sheet.item(selected: false).label
                label("No windows", c, 12, .medium, Chrome.wash(0.6)).frame(width: card.width, height: card.height)
            }
        }
        .frame(width: grid.size.width - WindowGrid.padding, height: grid.size.height - WindowGrid.padding, alignment: .topLeading)
    }

    /// A window's icon, title and workspace badge: the title under the other two on two lines, or all on one line.
    private func windowCard<D: Dress>(_ d: D.Type, _ w: SwitcherModel.WindowTile, icon: NSImage?, title: String, on: Bool,
                                      width: CGFloat, height: CGFloat? = nil, stacked: Bool = true) -> some View {
        let c = sheet.item(selected: on)
        let tint = Chrome.workspace(w.workspace)
        let text = label(title, c.label, 12, .medium, Chrome.wash(on ? 1 : 0.75)).multilineTextAlignment(.leading)
        // The sheet shapes the app's icon; a browser window's site icon sits over it, uncut.
        let image = { (size: CGFloat) in
            Image(nsImage: icon ?? NSImage()).resizable().frame(width: size, height: size).modifier(D.cut(c.icon)).modifier(D.part(c.icon))
                .overlay(alignment: .bottomTrailing) {
                    if let site = w.site {
                        Image(nsImage: site).resizable().interpolation(.high).frame(width: size * 0.5, height: size * 0.5)
                            .padding(1.5).background(Chrome.shape(.launcherKey).fill(Chrome.panel()))
                            .offset(x: 4, y: 4)
                    }
                }
        }
        // A card the grid doesn't size grows with the sheet's text.
        let lines = height == nil ? max(32, (c.label.fontSize.map { CGFloat($0) } ?? 0) * 2.5) : 32
        return Group {
            if stacked {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        image(30)
                        Spacer()
                        WorkspaceBadge(n: w.workspace)
                    }
                    text.lineLimit(2).frame(maxWidth: .infinity, minHeight: lines, alignment: .topLeading).modifier(D.part(c.label))
                }
                .padding(12)
            } else {
                HStack(spacing: 8) {
                    image(22)
                    text.lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).modifier(D.part(c.label))
                    WorkspaceBadge(n: w.workspace, size: 18)
                }
                .padding(.horizontal, 10)
            }
        }
        .frame(width: width, height: height)
        .background(D.back(c.box, .switcherWindow).fill(on ? Chrome.lit(tint, 0.28) : Chrome.cell(0.06)).marking(on && !c.marked))
        .overlay(D.edge(c.box, .switcherWindow, on ? Chrome.focusEdge(tint) : Chrome.edge(0.08), focused: on, marking: on && !c.marked))
        .modifier(D.part(c.box))
        .accessibilityLabel("\(w.app.isEmpty ? "" : "\(w.app), ")\(title), workspace \(w.workspace)\(on ? ", selected" : "")")
    }

    /// Rows of tiles sized from `SwitcherLayout`, not a lazy grid: a LazyVGrid's fitting size
    /// came out far taller than one row, and the panel is framed from the same numbers.
    private func workspaceRow<D: Dress>(_ d: D.Type) -> some View {
        let sheet = sheet, pad = sheet.padding
        let cols = sheet.columns(tileCount: model.tiles.count, maxWidth: model.maxWidth)
        let size = sheet.panelSize(tileCount: model.tiles.count, maxWidth: model.maxWidth)
        return VStack(alignment: .leading, spacing: sheet.gap) {
            ForEach(SwitcherLayout.rows(tileCount: model.tiles.count, columns: cols), id: \.lowerBound) { row in
                HStack(spacing: sheet.gap) {
                    ForEach(row, id: \.self) { i in workspaceTile(d, model.tiles[i], on: i == model.selected) }
                }
            }
        }
        .frame(width: size.width - pad.left - pad.right, height: size.height - pad.top - pad.bottom, alignment: .topLeading)
    }

    private func workspaceTile<D: Dress>(_ d: D.Type, _ tile: SwitcherModel.Tile, on: Bool) -> some View {
        let c = sheet.item(selected: on)
        return VStack(spacing: 8) {
            Text("\(tile.n)").spaced(c.number)
                .font(Styled.font(c.number, .ui, 34, .bold, rounded: true))
                .foregroundStyle(c.number.ink(Chrome.wash())).modifier(D.part(c.number))
            HStack(spacing: -6) {
                ForEach(Array(tile.icons.prefix(4).enumerated()), id: \.offset) { _, image in
                    Image(nsImage: image).resizable().frame(width: 26, height: 26).modifier(D.cut(c.icon))
                }
            }
            .frame(height: 26)
            .modifier(D.part(c.icon))
            label(SwitcherTileText.caption(count: tile.count, isCurrent: tile.isCurrent), c.label, 10, tile.isCurrent ? .semibold : .regular,
                  Chrome.wash(tile.isCurrent ? 0.9 : 0.65))
                .lineLimit(c.label.hasFont ? 1 : nil)
                .modifier(D.part(c.label))
        }
        .frame(width: SwitcherLayout.tileWidth, height: sheet.tileHeight)
        .background(D.back(c.box, .switcherTile).fill(on ? Chrome.cell(0.16) : Chrome.cell(0.05)).marking(on && !c.marked))
        .overlay(D.edge(c.box, .switcherTile, on ? Chrome.wash(0.55) : Chrome.edge(0), focused: on, marking: on && !c.marked))
        .modifier(D.part(c.box))
        // The workspace you're on carries its own color along the top edge, selected or not.
        .overlay(alignment: .top) {
            if tile.isCurrent {
                Chrome.pill().fill(Chrome.workspace(tile.n)).frame(width: 28, height: 4).padding(.top, 6)
            }
        }
        .accessibilityLabel("Workspace \(tile.n)\(tile.isCurrent ? ", current" : ""), \(tile.count) windows\(on ? ", selected" : "")")
    }

}

struct WorkspaceBadge: View {
    let n: Int
    var size: CGFloat = 20
    /// Redraws when Settings › Appearance changes.
    @ObservedObject private var appearance = Appearance.shared
    var body: some View {
        WorkspaceMark(n: n, tint: Chrome.workspace(n), size: size)
    }
}

extension NSWindow {
    /// Whether the window server has this window on screen right now, which `isVisible` can
    /// claim when it isn't.
    var isOnScreenNow: Bool {
        guard windowNumber > 0,
              let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(windowNumber)) as? [[String: Any]],
              let w = info.first else { return false }
        return (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
    }
}

/// A short record of ⌘Tab gestures in trace.log, to diagnose a switcher that misbehaves. It
/// notes only the gesture (Tab, ⌘ let go, Esc) and workspace numbers, never other keys.
///
/// Each line also goes to the unified log (subsystem com.baney.baneyspaces), so a Shotate debug
/// recording and `log show --predicate 'subsystem == "com.baney.baneyspaces"'` carry it next to
/// what macOS logged. The file rotates at 200 KB (trace.log, .1, .2) instead of deleting history.
/// Lines hold workspace numbers, window ids and app names, never window titles, so they're public.
enum Trace {
    private static let unified = Logger(subsystem: "com.baney.polycarp", category: "trace")

    /// Benches (`--render`) run beside the installed app and must not write to its trace.log.
    static var muted = false

    static func log(_ line: String) {
        guard !muted else { return }
        unified.notice("\(line, privacy: .public)")
        let stamped = "\(Date().timeIntervalSince1970) \(line)"
        try? FileTrace.append(stamped, directory: Spaces.folder, maxBytes: FileTrace.defaultMaxBytes, maxFiles: FileTrace.defaultMaxFiles)
    }
}
