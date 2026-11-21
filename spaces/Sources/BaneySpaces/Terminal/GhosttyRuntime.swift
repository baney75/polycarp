#if POLYCARP_TERMINAL
import AppKit
import BaneySpacesCore
import CGhostty

/// Polycarp's one `ghostty_app_t`, wired the way Ghostty's own macOS app wires it (macos/Sources/Ghostty/Ghostty.App.swift
/// at the pin): libghostty calls back for wakeups, actions, the clipboard and closing a surface, and Polycarp answers on
/// the main thread. Made on first use, so a Polycarp that never opens a terminal never starts libghostty.
final class GhosttyRuntime {
    private(set) static var shared: GhosttyRuntime?
    private static var failed: TerminalLaunchError?

    let app: ghostty_app_t
    private var config: ghostty_config_t
    private var lastThemeText = ""
    private var observers: [NSObjectProtocol] = []

    /// The runtime, started now if it isn't yet. A start that failed stays failed for this run (one trace line).
    static func get() -> Result<GhosttyRuntime, TerminalLaunchError> {
        if let shared { return .success(shared) }
        if let failed { return .failure(failed) }
        let t0 = DispatchTime.now().uptimeNanoseconds
        guard let r = GhosttyRuntime() else {
            let e = TerminalLaunchError("libghostty didn't start; see trace.log")
            failed = e
            return .failure(e)
        }
        shared = r
        // A wakeup that came while the app was being made found no `shared` to tick.
        ghostty_app_tick(r.app)
        Trace.log("term: libghostty started in \((DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000) ms")
        return .success(r)
    }

    private init?() {
        GhosttyRuntime.pointAtResources()
        // Only the program's name: Polycarp's own arguments (--render and the like) aren't Ghostty's.
        guard ghostty_init(1, CommandLine.unsafeArgv) == GHOSTTY_SUCCESS else {
            Trace.log("term: ghostty_init failed")
            return nil
        }
        let (cfg, text) = GhosttyRuntime.makeConfig()
        guard let cfg else { Trace.log("term: ghostty_config_new failed"); return nil }
        config = cfg
        lastThemeText = text
        var runtime = ghostty_runtime_config_s(
            userdata: nil,
            supports_selection_clipboard: true,
            wakeup_cb: { _ in DispatchQueue.main.async { GhosttyRuntime.shared.map { ghostty_app_tick($0.app) } } },
            action_cb: { app, target, action in GhosttyRuntime.action(app, target: target, action: action) },
            read_clipboard_cb: { ud, loc, state in GhosttyRuntime.readClipboard(ud, loc, state) },
            confirm_read_clipboard_cb: { ud, str, state, request in GhosttyRuntime.confirmRead(ud, str, state, request) },
            write_clipboard_cb: { ud, loc, content, len, confirm in GhosttyRuntime.writeClipboard(ud, loc, content, len, confirm) },
            close_surface_cb: { ud, alive in GhosttyRuntime.closeSurface(ud, processAlive: alive) })
        guard let app = ghostty_app_new(&runtime, cfg) else {
            Trace.log("term: ghostty_app_new failed")
            ghostty_config_free(cfg)
            return nil
        }
        self.app = app
        ghostty_app_set_focus(app, NSApp.isActive)
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            GhosttyRuntime.shared.map { ghostty_app_set_focus($0.app, true) }
        })
        observers.append(nc.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
            GhosttyRuntime.shared.map { ghostty_app_set_focus($0.app, false) }
        })
        observers.append(nc.addObserver(forName: NSTextInputContext.keyboardSelectionDidChangeNotification, object: nil, queue: .main) { _ in
            GhosttyRuntime.shared.map { ghostty_app_keyboard_changed($0.app) }
        })
        // A new Polycarp theme, palette or Dark Mode: the terminals take the new colors at once.
        observers.append(nc.addObserver(forName: Appearance.didChange, object: nil, queue: .main) { _ in
            GhosttyRuntime.shared?.reloadIfThemeChanged()
        })
    }

    // MARK: Config

    /// Where the theme's Ghostty lines go: Polycarp's own folder, never your Ghostty config.
    static var themeFile: URL { Spaces.folder.appendingPathComponent("terminal-theme.ghostty") }

    /// The Polycarp look as Ghostty sees it now.
    static func currentTheme() -> GhosttyTheme? {
        if let p = Appearance.shared.polycarp { return GhosttyTheme.from(p, systemDark: Appearance.systemDark) }
        return GhosttyTheme.from(Appearance.shared.look.palette)
    }

    /// Your Ghostty config (the files Ghostty itself reads, and the files they include), then the theme on top.
    private static func makeConfig() -> (ghostty_config_t?, String) {
        guard let cfg = ghostty_config_new() else { return (nil, "") }
        ghostty_config_load_default_files(cfg)
        ghostty_config_load_recursive_files(cfg)
        let text = currentTheme()?.configText ?? ""
        if !text.isEmpty {
            do {
                try FileManager.default.createDirectory(at: themeFile.deletingLastPathComponent(), withIntermediateDirectories: true)
                try text.write(to: themeFile, atomically: true, encoding: .utf8)
                themeFile.path.withCString { ghostty_config_load_file(cfg, $0) }
            } catch {
                Trace.log("term: couldn't write the theme's Ghostty config: \(error.localizedDescription)")
            }
        }
        ghostty_config_finalize(cfg)
        let n = ghostty_config_diagnostics_count(cfg)
        if n > 0 {
            // The first few, so a typo in your Ghostty config shows up somewhere you can find it.
            for i in 0..<min(n, 5) {
                let d = ghostty_config_get_diagnostic(cfg, i)
                Trace.log("term: Ghostty config: \(d.message.map { String(cString: $0) } ?? "?")")
            }
        }
        return (cfg, text)
    }

    private func reloadIfThemeChanged() {
        guard (GhosttyRuntime.currentTheme()?.configText ?? "") != lastThemeText else { return }
        let (cfg, text) = GhosttyRuntime.makeConfig()
        guard let cfg else { return }
        ghostty_app_update_config(app, cfg)
        ghostty_config_free(config)
        config = cfg
        lastThemeText = text
    }

    /// libghostty finds its themes, shell integration and terminfo in Contents/Resources of the app it runs in. A
    /// `swift build` binary has no bundle, so it points at what build-ghostty.sh left in ghostty/lib/share.
    private static func pointAtResources() {
        if let res = Bundle.main.resourceURL, FileManager.default.fileExists(atPath: res.appendingPathComponent("terminfo/78/xterm-ghostty").path) {
            return
        }
        let dev = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("ghostty/lib/share/ghostty")
        if FileManager.default.fileExists(atPath: dev.path), ProcessInfo.processInfo.environment["GHOSTTY_RESOURCES_DIR"] == nil {
            setenv("GHOSTTY_RESOURCES_DIR", dev.path, 1)
        }
    }

    // MARK: Callbacks

    /// The view a surface's userdata points at (`TerminalSurfaceView` passes itself, unretained).
    static func view(_ ud: UnsafeMutableRawPointer?) -> TerminalSurfaceView? {
        guard let ud else { return nil }
        return Unmanaged<TerminalSurfaceView>.fromOpaque(ud).takeUnretainedValue()
    }

    private static func view(of target: ghostty_target_s) -> TerminalSurfaceView? {
        guard target.tag == GHOSTTY_TARGET_SURFACE, let s = target.target.surface else { return nil }
        return view(ghostty_surface_userdata(s))
    }

    /// Runs `body` on the main thread's next turn, never inside the callback that asked. libghostty calls back from
    /// inside `ghostty_app_tick` (a shell's `exit` closes its surface from there), so work done at once could free a
    /// surface under its own callback, or run a question's loop that ticks the app again. Ghostty's own app defers the
    /// same way. A view a callback names is resolved before the hop and held by the closure.
    private static func onMain(_ body: @escaping () -> Void) {
        DispatchQueue.main.async(execute: body)
    }

    /// The actions Polycarp answers. Anything else returns false, and libghostty does its own default (or nothing):
    /// tabs and splits are Ghostty-the-app's, not part of phase 1.
    static func action(_ app: ghostty_app_t?, target: ghostty_target_s, action: ghostty_action_s) -> Bool {
        switch action.tag {
        case GHOSTTY_ACTION_SET_TITLE:
            guard let v = view(of: target), let p = action.action.set_title.title else { return false }
            let title = String(cString: p)
            onMain { if v.surface != nil { v.setTitle(title) } }
            return true
        case GHOSTTY_ACTION_CELL_SIZE:
            guard let v = view(of: target) else { return false }
            let s = action.action.cell_size
            onMain { v.cellSize = NSSize(width: Double(s.width), height: Double(s.height)) }
            return true
        case GHOSTTY_ACTION_MOUSE_SHAPE:
            guard let v = view(of: target) else { return false }
            let shape = action.action.mouse_shape
            onMain { v.setCursorShape(shape) }
            return true
        case GHOSTTY_ACTION_OPEN_URL:
            let u = action.action.open_url
            guard let p = u.url else { return false }
            let text = String(decoding: UnsafeRawBufferPointer(start: p, count: Int(u.len)), as: UTF8.self)
            onMain { openURL(text) }
            return true
        case GHOSTTY_ACTION_CLOSE_WINDOW:
            guard let v = view(of: target) else { return false }
            onMain { if v.surface != nil { v.window?.performClose(nil) } }
            return true
        case GHOSTTY_ACTION_NEW_WINDOW:
            onMain { _ = TerminalWindows.shared.open(TerminalLaunch()) }
            return true
        case GHOSTTY_ACTION_TOGGLE_QUICK_TERMINAL:
            onMain { TerminalWindows.shared.toggleQuick() }
            return true
        case GHOSTTY_ACTION_RING_BELL:
            onMain { NSSound.beep() }
            return true
        case GHOSTTY_ACTION_QUIT:
            // Ghostty's quit key would quit Polycarp. It closes nothing here; close the windows instead.
            return true
        default:
            return false
        }
    }

    /// A link the person clicked in the terminal: web, mail and files only.
    private static func openURL(_ text: String) {
        if let url = URL(string: text), let scheme = url.scheme?.lowercased() {
            guard ["http", "https", "mailto", "file"].contains(scheme) else { return }
            NSWorkspace.shared.open(url)
        } else if text.hasPrefix("/") {
            NSWorkspace.shared.open(URL(fileURLWithPath: text))
        }
    }

    private static let selection = NSPasteboard(name: NSPasteboard.Name("com.baney.polycarp.terminal.selection"))

    private static func pasteboard(_ loc: ghostty_clipboard_e) -> NSPasteboard {
        loc == GHOSTTY_CLIPBOARD_SELECTION ? selection : .general
    }

    static func readClipboard(_ ud: UnsafeMutableRawPointer?, _ loc: ghostty_clipboard_e, _ state: UnsafeMutableRawPointer?) -> Bool {
        guard let surface = view(ud)?.surface, let text = pasteboard(loc).string(forType: .string) else { return false }
        text.withCString { ghostty_surface_complete_clipboard_request(surface, $0, state, false) }
        return true
    }

    /// libghostty asks before an unsafe paste (it would run a command) or a program reading the clipboard (OSC 52).
    static func confirmRead(_ ud: UnsafeMutableRawPointer?, _ str: UnsafePointer<CChar>?, _ state: UnsafeMutableRawPointer?,
                            _ request: ghostty_clipboard_request_e) {
        let text = str.map { String(cString: $0) } ?? ""
        let reading = request == GHOSTTY_CLIPBOARD_REQUEST_OSC_52_READ
        let v = view(ud)
        onMain {
            guard let v, v.surface != nil else { return }
            ask(reading ? "A program in the terminal wants to read your clipboard." : "Paste text that runs a command?",
                detail: String(text.prefix(400)), allow: reading ? "Allow" : "Paste", over: v.window) { ok in
                // The window may have closed while the question was up.
                guard let surface = v.surface else { return }
                (ok ? text : "").withCString { ghostty_surface_complete_clipboard_request(surface, $0, state, true) }
            }
        }
    }

    static func writeClipboard(_ ud: UnsafeMutableRawPointer?, _ loc: ghostty_clipboard_e,
                               _ content: UnsafePointer<ghostty_clipboard_content_s>?, _ len: Int, _ confirm: Bool) {
        guard let content, len > 0 else { return }
        var text: String?
        for i in 0..<len {
            let c = content[i]
            guard let mime = c.mime, String(cString: mime) == "text/plain", let data = c.data else { continue }
            text = String(cString: data)
        }
        guard let text else { return }
        let v = view(ud)
        onMain {
            func write() {
                let pb = pasteboard(loc)
                pb.clearContents()
                pb.setString(text, forType: .string)
            }
            guard confirm else { return write() }
            guard let v, v.surface != nil else { return }
            ask("A program in the terminal wants to set your clipboard.", detail: String(text.prefix(400)), allow: "Allow",
                over: v.window) { if $0 { write() } }
        }
    }

    /// The program in a surface ended (or Ghostty asked to close it): its window goes, after asking if one still runs.
    /// Called from inside `ghostty_app_tick` (a plain shell's `exit` lands here), so the window closes on the next turn,
    /// never while libghostty is still handling this surface.
    static func closeSurface(_ ud: UnsafeMutableRawPointer?, processAlive: Bool) {
        let v = view(ud)
        onMain {
            guard let v, v.surface != nil else { return }
            guard processAlive else { return v.closeHost() }
            ask("Close this terminal?", detail: "A program in it is still running.", allow: "Close", over: v.window) { ok in
                if ok, v.surface != nil { v.closeHost() }
            }
        }
    }

    /// Asks on a sheet over the terminal's own window and answers in `done`; no modal loop, so nothing ticks libghostty
    /// while a callback is on the stack. Without a window to hang it on, the answer is no.
    static func ask(_ message: String, detail: String, allow: String, over window: NSWindow?, _ done: @escaping (Bool) -> Void) {
        guard let window, window.isVisible, window.attachedSheet == nil else { return done(false) }
        let a = NSAlert()
        a.messageText = message
        a.informativeText = detail
        a.addButton(withTitle: allow)
        a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        a.beginSheetModal(for: window) { done($0 == .alertFirstButtonReturn) }
    }

    /// Whether quitting now would end a program in any terminal (Ghostty's own rule, its `confirm-close-surface` included).
    var needsConfirmQuit: Bool { ghostty_app_needs_confirm_quit(app) }
}
#endif
