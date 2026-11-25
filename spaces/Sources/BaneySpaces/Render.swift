import AppKit
import BaneySpacesCore
import SwiftUI

/// `BaneySpaces --render <folder>` draws the overview, still and mid-drag, with sample windows
/// into PNGs, for the README and the website. It never touches real windows.
@MainActor
enum Render {
    static func run(into folder: URL) -> Int32 {
        if let asked = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_MOVE_HELPER"] { return MoveTiming.help(asked) }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Run from `swift build` rather than the app bundle, macOS hands out a generic folder for
        // the app icon; settings would show that. Use the repo's icon when it's there.
        if Bundle.main.bundleURL.pathExtension != "app", let icon = NSImage(contentsOfFile: "../brand/export/macos/icon-512.png") {
            NSApp.applicationIconImage = icon
        }
        // BANEYSPACES_RENDER_SAMPLE=reported draws seven windows on workspace 1 and none elsewhere.
        let sample = ProductRenderPlan.windows(ProductRenderPlan.sample(named: ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_SAMPLE"]))
        // Product shots always show the default look, whatever this Mac has picked.
        Appearance.shared.useDefaultLookWithoutSaving()
        // BANEYSPACES_RENDER_POLYCARP=<theme.json> draws what an install really shows: `polycarp theme set` writes this file.
        if let path = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_POLYCARP"],
           case .theme(let theme) = PolycarpThemeFile.load(path: path) {
            Appearance.shared.usePolycarp(theme)
        }
        PermissionsModel.shared.useRenderSample()
        // BANEYSPACES_RENDER_THEME=omarchy|minimal draws the same shots in that theme (a check, saved nowhere).
        if let t = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_THEME"], let id = ThemeID(rawValue: t) {
            Appearance.shared.settings.theme = id
        }
        // BANEYSPACES_RENDER_PALETTE=<name> likewise picks a palette.
        if let p = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_PALETTE"], PaletteCatalog.shared.named(p) != nil {
            Appearance.shared.settings.colorPalette = p
        }
        let model = ViewerModel()
        model.current = 1
        var id: WindowID = 100
        model.tiles = ProductRenderPlan.tiles(from: sample.mapValues { windows in
            windows.map { w in
                id += 1
                model.icons[id] = NSWorkspace.shared.icon(forFile: w.path)
                return Spaces.Entry(id: id, pid: 0, app: w.app, title: w.title)
            }
        })
        let size = CGSize(width: 1512, height: 945)
        // Tile frames as the live layout places them, so the drag image can light its target.
        // Drawn by AppKit in an offscreen window (never shown), so colors match the live app.
        func save(_ view: some View, _ name: String, _ size: CGSize) -> Bool {
            let height: CGFloat? = size.height == 0 ? nil : size.height
            let framed = view.frame(width: size.width, height: height).environment(\.colorScheme, Chrome.scheme).environment(\.controlActiveState, .key)
            let host = NSHostingView(rootView: framed)
            // Height 0 means "as tall as the content".
            let size = size.height == 0 ? CGSize(width: size.width, height: host.fittingSize.height) : size
            let window = RenderWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                                      backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: Chrome.scheme == .dark ? .darkAqua : .aqua)
            window.contentView = host
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
            host.cacheDisplay(in: host.bounds, to: rep)
            let png = rep.representation(using: .png, properties: [:])
            return (try? png?.write(to: folder.appendingPathComponent(name))) != nil
        }
        if let r = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_SETTINGS_TIMING"].flatMap(Int.init) {
            return SettingsTiming.run(rounds: r)
        }
        if let r = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_THEME_RELOAD"].flatMap(Int.init) {
            return ThemeReloadTiming.run(rounds: r)
        }
        if let r = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_MOVE_TIMING"].flatMap(Int.init) {
            return MoveTiming.run(rounds: r)
        }
        // BANEYSPACES_RENDER_SWATCHES=1 checks only what the workspace colors sit on in dark mode (scripts/swatch-check.sh).
        if ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_SWATCHES"] == "1" { return SwatchCheck.run(into: folder) }
        // BANEYSPACES_RENDER_THEME_EDITOR=<user theme> draws only the theme editor and the Appearance tab, light and dark.
        if let name = ProcessInfo.processInfo.environment["BANEYSPACES_RENDER_THEME_EDITOR"], !name.isEmpty {
            return ThemeEditorRender.run(name) { save($0, $1, $2) }
        }
        guard save(ViewerView(model: model, stillBackdrop: true), "overview.png", size) else { return 1 }

        // The same overview mid-drag: Mail's window on its way to workspace 6. A sample with no
        // window to drag skips the drag and carry shots and draws the rest.
        if let source = ProductRenderPlan.dragSource(in: model.tiles) {
            // Mirrors ViewerView's layout: 48pt padding, 20pt gaps, a 40pt footer.
            let pad: CGFloat = 48, gap: CGFloat = 20, footer: CGFloat = 40
            let gridWidth: CGFloat = min(size.width, 1600) - 2 * pad
            let tileW: CGFloat = (gridWidth - 2 * gap) / 3
            let tileH: CGFloat = (size.height - 2 * pad - footer - 2 * gap) / 3
            let targetX: CGFloat = pad + 2 * (tileW + gap)
            let targetY: CGFloat = pad + tileH + gap
            let target = CGRect(x: targetX, y: targetY, width: tileW, height: tileH)
            model.tileFrames = [6: target]
            model.drag = ViewerModel.Drag(entry: source.entry, from: source.workspace, location: CGPoint(x: target.midX - 40, y: target.midY + 10))
            guard save(ViewerView(model: model, stillBackdrop: true), "overview-drag.png", size) else { return 1 }
            // A window carried up by its title bar opens the same view; the footer says what letting go does.
            model.carrying = true
            guard save(ViewerView(model: model, stillBackdrop: true), "overview-carry.png", size) else { return 1 }
            model.carrying = false
            model.drag = nil
        }

        let setup = SetupModel()
        setup.trusted = true
        setup.started = true
        setup.modifier = .command
        setup.conflicts = []
        setup.desktops = 1
        setup.openAtLogin = true
        setup.viewerKeys = true
        setup.parkedApps = { [.init(id: "com.apple.Safari", name: "Safari", on: false, animates: false),
                            .init(id: "com.example.automation", name: "Automation Helper", on: true, animates: false),
                            .init(id: "com.mitchellh.ghostty", name: "Ghostty", on: true, animates: true)] }
        setup.update = .init(have: "0.4.0 (abc1234)", daily: true, notice: UpdateNotice(name: "Polycarp 0.4.0 (2026-11-25)", installing: false))
        setup.finished = [.init(id: "a", label: "Claude Code · polycarp")]
        guard save(SetupView(model: setup, close: {}).background(Color(nsColor: .windowBackgroundColor)),
                   "setup.png", SettingsSidebar.windowSize) else { return 1 }
        // Each settings tab, for checks.
        for tab in SettingsTab.allCases.dropFirst() {
            setup.tab = tab
            guard save(SetupView(model: setup, close: {}).background(Color(nsColor: .windowBackgroundColor)),
                       "setup-\(tab.rawValue.lowercased()).png", SettingsSidebar.windowSize) else { return 1 }
        }
        setup.tab = .general
        // The ⌘Tab workspace switcher, second tile selected.
        let switcher = SwitcherModel()
        let icon = { (path: String) in NSWorkspace.shared.icon(forFile: path) }
        switcher.tiles = [
            .init(n: 1, icons: [icon("/Applications/Safari.app"), icon("/System/Applications/Notes.app"), icon("/System/Applications/Utilities/Terminal.app")], count: 3, isCurrent: true),
            .init(n: 2, icons: [icon("/System/Applications/Mail.app"), icon("/System/Applications/Calendar.app")], count: 2, isCurrent: false),
            .init(n: 5, icons: [icon("/System/Applications/Photos.app")], count: 1, isCurrent: false),
            .init(n: 3, icons: [icon("/System/Applications/Music.app")], count: 1, isCurrent: false),
        ]
        switcher.selected = 1
        guard save(SwitcherView(model: switcher), "switcher.png", CGSize(width: 520, height: 0)) else { return 1 }

        // The ⌘Tab app switcher across workspaces, Mail selected.
        let appSwitcher = SwitcherModel()
        appSwitcher.mode = .apps
        // Ghostty is on workspaces 1 and 4 (two windows there): two entries, told apart by color.
        appSwitcher.apps = [("Safari", "/Applications/Safari.app", 1, 1, false), ("Ghostty", "/System/Applications/Utilities/Terminal.app", 4, 2, true),
                            ("Mail", "/System/Applications/Mail.app", 2, 1, false), ("Ghostty", "/System/Applications/Utilities/Terminal.app", 1, 1, true),
                            ("Music", "/System/Applications/Music.app", 3, 1, false), ("Maps", "/System/Applications/Maps.app", 7, 1, false)]
            .enumerated().map { i, a in SwitcherModel.AppTile(pid: a.4 ? 99 : pid_t(i + 1), name: a.0, icon: icon(a.1), workspace: a.2, windows: a.3, isSplit: a.4) }
        appSwitcher.selected = 1
        guard save(SwitcherView(model: appSwitcher).padding(30), "switcher-apps.png", CGSize(width: 820, height: 0)) else { return 1 }
        // The same switcher as an image sequence (selection 0→1→2→3), for `ffmpeg -framerate 2 -i switcher-seq-%02d.png`.
        for frame in ProductRenderPlan.switcherSequence(tileCount: appSwitcher.apps.count) {
            appSwitcher.selected = frame.selected
            guard save(SwitcherView(model: appSwitcher).padding(30), frame.name, CGSize(width: 820, height: 0)) else { return 1 }
        }

        // The Ledger top bar, on a screen without a notch and on one with it (the middle folds left).
        let topBar = TopBarModel()
        topBar.occupied = [1, 2, 4]
        topBar.now = Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 21, hour: 9, minute: 12)) ?? Date()
        if let screen = NSScreen.main, let id = screen.displayID {
            topBar.current[id] = 2
            guard save(TopBarView(model: topBar, display: id, screen: screen, sides: nil).background(Color(white: 0.35)), "topbar.png", CGSize(width: 1512, height: 24)) else { return 1 }
            guard save(TopBarView(model: topBar, display: id, screen: screen, sides: (left: 656, right: 656)).background(Color(white: 0.35)), "topbar-notch.png", CGSize(width: 1512, height: 37)) else { return 1 }
            topBar.notices = "3"
            guard save(TopBarView(model: topBar, display: id, screen: screen, sides: nil).background(Color(white: 0.35)), "topbar-notices.png", CGSize(width: 1512, height: 26)) else { return 1 }
        }

        // The bell's list: two apps with one quiet, then nothing new.
        let notices = NoticeWatcher()
        var shelf = NoticeShelf()
        for (app, bundle, title, subtitle, body) in [
            ("Calendar", "com.apple.iCal", "Choir practice", "", "In 15 minutes"),
            ("Mail", "com.apple.mail", "Anna Reed", "Saturday", "The hall is ours from nine, so bring the long table and the good coffee. I will have the keys and can let the others in if they come early."),
            ("Mail", "com.apple.mail", "Library", "", "Two books are ready to pick up."),
        ] {
            let node = NoticeNode(subrole: "AXNotificationCenterBanner", label: app + ", " + title, stacking: "bundleIdentifier=" + bundle, children: [
                NoticeNode(identifier: "title", text: title), NoticeNode(identifier: "subtitle", text: subtitle), NoticeNode(identifier: "body", text: body)])
            shelf.take(NoticeReader.read([node]), at: topBar.now)
        }
        notices.sample(shelf, quiet: ["com.apple.Music": "Music"])
        guard save(NoticeList(watcher: notices, room: 620) {}.padding(20), "notices.png", CGSize(width: 412, height: 0)) else { return 1 }
        notices.sample(NoticeShelf())
        guard save(NoticeList(watcher: notices, room: 620, trusted: true) {}.padding(20), "notices-empty.png", CGSize(width: 412, height: 0)) else { return 1 }

        // The switch HUD, landing on workspace 4.
        let hud = HUDModel()
        hud.current = 4
        hud.occupied = [1, 2, 3, 4, 5, 7]
        hud.icons = [icon("/System/Applications/Mail.app"), icon("/System/Applications/Utilities/Terminal.app"), icon("/System/Applications/Messages.app")]
        guard save(HUDView(model: hud).background(Color(white: 0.35)), "hud.png", CGSize(width: 260, height: 0)) else { return 1 }

        // The ⌘Tab window bar: Tab held on Helium.
        let bar = SwitcherModel()
        bar.mode = .apps
        bar.windowBar = .init(pid: 1, name: "Helium", icon: icon("/Applications/Safari.app"),
                              windows: [.init(id: 1, title: "YouTube — I finally ported TypeScript to Go", workspace: 4),
                                        .init(id: 2, title: "baney75/polycarp pull request 3 · GitHub", workspace: 4),
                                        .init(id: 3, title: "Gmail — Inbox", workspace: 1)], selected: 1)
        guard save(SwitcherView(model: bar).padding(30), "switcher-windows.png", CGSize(width: 820, height: 0)) else { return 1 }

        // ⌘Tab across windows: thirty on a small screen, so the cards are on one line.
        bar.windowBar = nil
        bar.mode = .windows
        bar.windows = (0..<30).map { i in
            let app = [("Safari", "/Applications/Safari.app"), ("Mail", "/System/Applications/Mail.app"), ("Notes", "/System/Applications/Notes.app")][i % 3]
            return .init(id: WindowID(i + 1), title: "\(app.0) window \(i + 1)", workspace: i % 9 + 1, app: app.0, icon: icon(app.1))
        }
        for (count, name) in [(30, "switcher-all-windows.png"), (7, "switcher-few-windows.png")] {
            bar.windows = Array(bar.windows.prefix(count))
            bar.selected = 1
            guard save(SwitcherView(model: bar), name, bar.grid.size) else { return 1 }
        }

        // The launcher: the opening menu, then a search.
        let launcher = LauncherModel(actions: LauncherActions())
        launcher.prepare(scope: .root)
        guard save(LauncherView(model: launcher).frame(height: 512).padding(30).background(Color(white: 0.3)), "launcher.png", CGSize(width: 760, height: 0)) else { return 1 }
        launcher.query = "ma"
        guard save(LauncherView(model: launcher).frame(height: 512).padding(30).background(Color(white: 0.3)), "launcher-search.png", CGSize(width: 760, height: 0)) else { return 1 }
        // A coding agent by name, offered in your terminal.
        launcher.agents = ["claude": "/usr/local/bin/claude", "codex": "/usr/local/bin/codex"]
        launcher.query = "claude"
        guard save(LauncherView(model: launcher).frame(height: 512).padding(30).background(Color(white: 0.3)), "launcher-agents.png", CGSize(width: 760, height: 0)) else { return 1 }

        // Bangs: typing "!", then a question for the default agent.
        launcher.query = "!y"
        guard save(LauncherView(model: launcher).frame(height: 512).padding(30).background(Color(white: 0.3)), "launcher-bangs.png", CGSize(width: 760, height: 0)) else { return 1 }
        launcher.query = "sunset photos"
        guard save(LauncherView(model: launcher).frame(height: 512).padding(30).background(Color(white: 0.3)), "launcher-web.png", CGSize(width: 760, height: 0)) else { return 1 }

        // The first thing a new person sees: permission not granted yet.
        let fresh = SetupModel()
        fresh.trusted = false
        fresh.modifier = .command
        fresh.conflicts = []
        fresh.desktops = 1
        fresh.openAtLogin = false
        fresh.viewerKeys = true
        guard save(SetupView(model: fresh, close: {}).background(Color(nsColor: .windowBackgroundColor)),
                   "setup-first-run.png", SettingsSidebar.windowSize) else { return 1 }
        // The whole Permissions section, Optional open, at the section's width.
        let pane = PermissionsPane(optionalOpen: true).padding(28).frame(width: SettingsSidebar.windowSize.width - SettingsSidebar.width)
            .foregroundStyle(Chrome.wash()).tint(Chrome.accent).background(Chrome.panel())
        guard save(pane, "permissions-pane.png", CGSize(width: SettingsSidebar.windowSize.width - SettingsSidebar.width, height: 0)) else { return 1 }

        // The drag helper beside System Settings: the tile, then the check once the permission is on.
        let helper = HelperViewModel()
        helper.appURL = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.bundleURL : URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        guard save(HelperView(model: helper), "permission-helper.png", PermissionHelper.size) else { return 1 }
        helper.done = true
        guard save(HelperView(model: helper), "permission-helper-done.png", PermissionHelper.size) else { return 1 }

        // The welcome window, as a new person sees it.
        let welcome = WelcomeModel()
        welcome.granted = [.accessibility]
        guard save(WelcomeView(model: welcome), "welcome.png", CGSize(width: 560, height: 0)) else { return 1 }

        // The idle screen at 9:41 on a 1512-point laptop screen: Martyr Night with embers, and one verse on black.
        let idleAt = Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 21, hour: 21, minute: 41)) ?? Date()
        let idleSize = CGSize(width: 1512, height: 982)
        var idle = Surfaces.defaults.idle
        guard save(IdleView(settings: idle, machine: "Rectory1", size: idleSize, backdrop: nil, at: idleAt), "idle-night.png", idleSize) else { return 1 }
        idle.style = .verse
        guard save(IdleView(settings: idle, machine: "Rectory1", size: idleSize, backdrop: nil, at: idleAt), "idle-verse.png", idleSize) else { return 1 }
        idle.style = .theme
        guard save(IdleView(settings: idle, machine: "Rectory1", size: idleSize, backdrop: nil, at: idleAt), "idle-theme.png", idleSize) else { return 1 }
        return 0
    }
}

/// Draws its controls as they look in the window you're using. A window that's never on screen is otherwise inactive, and
/// every switch and button comes out gray.
final class RenderWindow: NSWindow {
    override var isKeyWindow: Bool { true }
    override var isMainWindow: Bool { true }
}
