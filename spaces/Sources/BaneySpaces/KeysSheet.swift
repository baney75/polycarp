import AppKit
import BaneySpacesCore
import Carbon
import SwiftUI

/// Hold the Polycarp modifier alone and every shortcut shows, grouped, in the modifier you picked; let go and it goes.
/// Like vim's which-key, it never takes the keyboard or the mouse, so the key you press next still goes where it was
/// going. `KeysHold` (Core) decides when a hold counts; the launcher's Shortcuts menu (⌘K there) is the searchable copy.
final class KeysHoldWatcher {
    private var hold = KeysHold(modifier: [.command])
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: DispatchWorkItem?
    /// While the sheet is up, checks `allowed` ten times a second: the launcher opened by a link, the overview from a
    /// hot corner, or the ⌘Tab switcher can come up with no key or click this tap sees.
    private var watch: Timer?
    private let sheet = KeysSheetPanel()
    /// False while something else owns the moment: the launcher or the overview is open, a ⌘Tab gesture runs.
    var allowed: () -> Bool = { true }

    private static weak var current: KeysHoldWatcher?

    /// Watches with a listen-only event tap: it sees keys that become Polycarp's own shortcuts and macOS's ⌘Tab, which
    /// never reach an app's event monitors, so a hold that was really a shortcut never shows the sheet. Pointer moves
    /// and drags count too (⌘-hover, a ⌘-drag). It needs Accessibility; without it nothing is watched.
    func start(modifier: Modifier) {
        stop()
        hold = KeysHold(modifier: Self.mods(modifier))
        let mask = [CGEventType.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
                    .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
            .reduce(CGEventMask(0)) { $0 | CGEventMask(1 << $1.rawValue) }
        guard let t = CGEvent.tapCreate(tap: .cghidEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                        eventsOfInterest: mask, callback: Self.callback, userInfo: nil)
            ?? CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                 eventsOfInterest: mask, callback: Self.callback, userInfo: nil)
        else { return Trace.log("keys: no event tap, so holding the modifier shows nothing") }
        tap = t
        let s = CFMachPortCreateRunLoopSource(nil, t, 0)
        source = s
        CFRunLoopAddSource(CFRunLoopGetMain(), s, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        Self.current = self
    }

    func stop() {
        timer?.cancel()
        timer = nil
        if let s = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false); CFMachPortInvalidate(t) }
        tap = nil
        source = nil
        dismiss()
    }

    /// Something else came up (the launcher opened): the sheet goes and this hold is spent.
    func dismiss() {
        stopWatching()
        sheet.hide()
        hold.dismissed()
    }

    private static let callback: CGEventTapCallBack = { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = KeysHoldWatcher.current?.tap { CGEvent.tapEnable(tap: t, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let flags = event.flags
        // A move event that didn't move (a wake, a warp to the same point) is not the pointer at work.
        if type == .mouseMoved, event.getDoubleValueField(.mouseEventDeltaX) == 0,
           event.getDoubleValueField(.mouseEventDeltaY) == 0 { return Unmanaged.passUnretained(event) }
        // The tap runs on the main run loop, so the watcher is touched on the main thread only.
        KeysHoldWatcher.current?.handle(type, flags)
        return Unmanaged.passUnretained(event)
    }

    private func handle(_ type: CGEventType, _ flags: CGEventFlags) {
        let now = ProcessInfo.processInfo.systemUptime
        switch type {
        case .flagsChanged: apply(hold.flags(KeysHold.mods(flags), at: now, secure: IsSecureEventInputEnabled()))
        case .keyDown: apply(hold.key())
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: apply(hold.move())
        default: apply(hold.mouse())
        }
        timer?.cancel()
        timer = nil
        guard hold.waiting else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self, NSEvent.pressedMouseButtons == 0, self.allowed() else { return }
            self.apply(self.hold.tick(at: ProcessInfo.processInfo.systemUptime, secure: IsSecureEventInputEnabled()))
        }
        timer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + hold.delay, execute: item)
    }

    private func apply(_ change: KeysHold.Change) {
        switch change {
        case .show:
            sheet.show()
            startWatching()
        case .hide:
            stopWatching()
            sheet.hide()
        case .none: break
        }
    }

    private func startWatching() {
        stopWatching()
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self, !self.allowed() else { return }
            self.dismiss()
        }
        RunLoop.main.add(t, forMode: .common)
        watch = t
    }

    private func stopWatching() {
        watch?.invalidate()
        watch = nil
    }

    static func mods(_ m: Modifier) -> Set<KeysHold.Mod> {
        switch m {
        case .command: [.command]
        case .control: [.control]
        case .option: [.option]
        case .controlOption: [.control, .option]
        }
    }

}

/// The sheet's window: over everything, on every desktop, never key, never in the way of a click.
final class KeysSheetPanel {
    private var panel: NSPanel?
    private static let counts = [3, 4, 5]

    func show() {
        let p = panel ?? make()
        panel = p
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main ?? NSScreen.screens[0]
        let area = screen.visibleFrame
        func sheet(_ count: Int) -> some View {
            KeysSheetView(modifier: Modifier.current.symbol, count: count).environment(\.colorScheme, Chrome.scheme)
        }
        let host = NSHostingView(rootView: AnyView(sheet(3)))
        p.contentView = host
        // As many columns as shrink it least: a short screen gets more, so the text stays its size.
        let sizes = Self.counts.map { count -> (count: Int, size: CGSize) in
            host.rootView = AnyView(sheet(count))
            return (count, host.fittingSize)
        }
        let count = KeysSheetLayout.bestCount(sizes, in: area.size)
        let view = sheet(count)
        host.rootView = AnyView(view)
        let full = sizes.first { $0.count == count }?.size ?? host.fittingSize
        // A display too small for every row (a narrow or short visible frame, larger text) gets the whole sheet, smaller.
        let scale = KeysSheetLayout.fitScale(full, in: area.size)
        let size = NSSize(width: (full.width * scale).rounded(.up), height: (full.height * scale).rounded(.up))
        if scale < 1 {
            host.rootView = AnyView(view.fixedSize().scaleEffect(scale, anchor: .topLeading)
                .frame(width: size.width, height: size.height, alignment: .topLeading))
        }
        p.setFrame(NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height),
                   display: false)
        p.alphaValue = 0
        p.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(0.12, .panelIn)
            p.animator().alphaValue = 1
        }
    }

    func hide() {
        guard let p = panel, p.isVisible else { return }
        p.orderOut(nil)
    }

    private func make() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = .modalPanel
        p.ignoresMouseEvents = true
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        p.setAccessibilityLabel("Polycarp shortcuts")
        return p
    }
}

/// Every shortcut in `count` columns, by group: what it does at the left, the keys as caps at the right, and where it
/// works under it when that is not everywhere. A long group goes on in the next column.
struct KeysSheetView: View {
    let modifier: String
    var count = 3
    /// The rows for a rendered still; nil is yours.
    var given: [KeyBinding]? = nil
    /// Your tiling keys and your keys for the default apps are in it.
    private var rows: [KeyBinding] {
        given ?? Keymap.rows(DefaultAppsStore.shared.keys, in: Keymap.rows(SurfacesStore.shared.current))
    }

    /// Four or more columns are for a short screen: tighter gaps keep the text at full size instead of shrinking it.
    private var dense: Bool { count > 3 }

    var body: some View {
        let columns = KeysSheetLayout.pieces(rows, count: count, modifier: modifier)
        VStack(alignment: .leading, spacing: dense ? 12 : 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Shortcuts").font(Chrome.font(17, .semibold)).foregroundStyle(Chrome.wash())
                Spacer(minLength: 24)
                Text("Let go of \(modifier) to close. ⌘K in the launcher searches them.")
                    .font(Chrome.font(11.5)).foregroundStyle(Chrome.muted)
            }
            HStack(alignment: .top, spacing: 28) {
                ForEach(columns.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: dense ? 10 : 16) {
                        ForEach(columns[i].indices, id: \.self) { j in section(columns[i][j]) }
                    }
                    .frame(width: KeysSheetLayout.column, alignment: .topLeading)
                }
            }
        }
        .padding(dense ? 18 : 22)
        .background(Chrome.panelBackground(.launcherPanel))
        .clipShape(Chrome.shape(.launcherPanel))
        .overlay(Chrome.shape(.launcherPanel).strokeBorder(Chrome.edge(0.1), lineWidth: Chrome.width(.launcherPanel)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Polycarp shortcuts")
    }

    private func section(_ piece: KeysSheetLayout.Piece) -> some View {
        VStack(alignment: .leading, spacing: dense ? 4 : 7) {
            Text(piece.group.title.uppercased() + (piece.continued ? " (CONTINUED)" : ""))
                .font(Chrome.font(10.5, .semibold)).kerning(0.6).foregroundStyle(Chrome.muted)
            ForEach(piece.rows, id: \.id) { row($0) }
        }
    }

    /// Where a key works and when, under its title: the scope unless it works everywhere, then the binding's note.
    static func where_(_ b: KeyBinding) -> String? {
        let parts = [b.scope == .global ? nil : b.scope.title, b.note].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ". ")
    }

    private func row(_ b: KeyBinding) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(b.title).font(Chrome.font(12.5)).foregroundStyle(Chrome.wash(0.92)).fixedSize(horizontal: false, vertical: true)
                if let where_ = Self.where_(b) {
                    Text(where_).font(Chrome.font(10.5)).foregroundStyle(Chrome.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 6)
            KeyCaps(parts: KeysSheetLayout.caps(b, modifier: modifier))
        }
        .accessibilityElement(children: .combine)
    }
}

/// Keys as separate caps: ⌃ ⌘ K, not one run of symbols.
struct KeyCaps: View {
    let parts: [String]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(parts.indices, id: \.self) { i in
                Text(parts[i])
                    .font(Chrome.font(11, .semibold, rounded: true))
                    .foregroundStyle(Chrome.wash(0.9))
                    .padding(.horizontal, 5).padding(.vertical, 1.5)
                    .frame(minWidth: 18)
                    .background(Chrome.shape(.launcherKey, continuous: false).fill(Chrome.wash(0.1)))
            }
        }
        .fixedSize()
    }
}
