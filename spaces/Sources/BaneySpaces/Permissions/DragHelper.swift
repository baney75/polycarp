import AppKit
import BaneySpacesCore
import SwiftUI

/// The small panel beside System Settings that holds a Polycarp tile to drag into a Privacy list (`PermissionHelper` has
/// the rules). It never takes the keyboard or brings Polycarp forward, so System Settings stays the app you're in. System
/// Settings' frame comes from the window server's list (owner and bounds only); nothing here scripts it, clicks in it or
/// types into it.
final class DragHelper {
    static let shared = DragHelper()

    private var panel: HelperPanel?
    private let view = HelperViewModel()
    private var phase: PermissionHelper.Phase = .closed
    private var permission: PermissionID?
    private var timer: Timer?
    private var lastFrame: CGRect?

    /// Up, or waiting for System Settings to come up.
    var isActive: Bool { phase != .closed }

    /// A list permission's button was pressed and its pane is opening. Shows nothing until System Settings is on screen.
    func begin(for id: PermissionID) {
        guard let url = PermissionHelper.dragURL(bundleURL: Bundle.main.bundleURL) else { return }
        permission = id
        view.appURL = url
        view.done = false
        phase = .waiting(since: Self.now)
        guard timer == nil else { return }
        let t = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 0.05
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func tick() {
        guard let permission else { return close() }
        let frame = Self.settingsFrame()
        let granted = PermissionsModel.shared.readNow(permission) == .granted
        let was = phase
        phase = PermissionHelper.step(phase, now: Self.now, settings: frame, granted: granted)
        switch phase {
        case .waiting: break
        case .closed: close()
        case .showing:
            if let frame { place(beside: frame) }
        case .done:
            if case .done = was {} else {
                view.done = true
                PermissionsModel.shared.wake(force: true)
            }
            if let frame { place(beside: frame) }
        }
    }

    private func place(beside settings: CGRect) {
        let screens = NSScreen.screens.map(\.visibleFrame)
        let target = PermissionHelper.frame(beside: settings, screens: screens)
        let p = panel ?? makePanel()
        if lastFrame != target || !p.isVisible {
            p.setFrame(target, display: true)
            lastFrame = target
        }
        guard !p.isVisible else { return }
        let fade = Chrome.duration(0.18, .panelIn)
        p.alphaValue = fade > 0 ? 0 : 1
        // Shown without making Polycarp the active app or the panel key: System Settings keeps the keyboard.
        p.orderFrontRegardless()
        if fade > 0 {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = fade
                p.animator().alphaValue = 1
            }
        }
    }

    private func close() {
        timer?.invalidate(); timer = nil
        phase = .closed
        permission = nil
        lastFrame = nil
        guard let p = panel, p.isVisible else { return }
        let fade = Chrome.duration(0.14, .panelOut)
        if fade > 0 {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = fade
                p.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                guard self?.phase == .closed else { return }
                p.orderOut(nil)
            })
        } else {
            p.orderOut(nil)
        }
    }

    private func makePanel() -> HelperPanel {
        let p = HelperPanel()
        let host = NSHostingView(rootView: HelperView(model: view))
        host.sizingOptions = []
        p.contentView = host
        panel = p
        return p
    }

    /// System Settings' main window in AppKit coordinates, from the window server's list. Nil when it isn't on screen.
    static func settingsFrame() -> CGRect? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: PermissionHelper.settingsBundleID).map(\.processIdentifier))
        guard !pids.isEmpty,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        let windows: [PermissionHelper.ServerWindow] = list.compactMap { w in
            guard let pid = w[kCGWindowOwnerPID as String] as? Int32,
                  let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary) else { return nil }
            return PermissionHelper.ServerWindow(pid: pid, layer: w[kCGWindowLayer as String] as? Int ?? 0,
                                                 alpha: w[kCGWindowAlpha as String] as? Double ?? 1, bounds: bounds)
        }
        guard let server = PermissionHelper.settingsWindow(in: windows, pids: pids),
              let main = NSScreen.screens.first else { return nil }
        return PermissionHelper.appKitRect(server, mainDisplayHeight: main.frame.height)
    }
}

/// Never key, never main, never brings Polycarp forward, and stays up while System Settings is the active app.
final class HelperPanel: NSPanel {
    init() {
        super.init(contentRect: NSRect(origin: .zero, size: PermissionHelper.size),
                   styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        worksWhenModal = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        collectionBehavior = [.fullScreenAuxiliary, .transient, .ignoresCycle]
        setAccessibilityLabel("Polycarp permission helper")
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class HelperViewModel: ObservableObject {
    @Published var appURL: URL?
    @Published var done = false
}

/// The panel's content: the tile and one line, or a check once the permission is on.
struct HelperView: View {
    @ObservedObject var model: HelperViewModel
    @ObservedObject private var appearance = Appearance.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                if model.done {
                    Image(systemName: "checkmark.circle.fill").font(Chrome.font(34)).foregroundStyle(Chrome.done)
                        .transition(.opacity)
                } else if let url = model.appURL {
                    AppTile(url: url).frame(width: 52, height: 52)
                        .accessibilityLabel("Polycarp app")
                        .accessibilityHint("Drag it into the list in System Settings")
                } else {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 52, height: 52)
                }
            }
            .frame(width: 56, height: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text(model.done ? PermissionHelper.doneLine : PermissionHelper.instruction)
                    .font(Chrome.font(13, .semibold)).fixedSize(horizontal: false, vertical: true)
                if !model.done {
                    Text("Or click + and pick Polycarp.").font(Chrome.font(11)).foregroundStyle(Chrome.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .foregroundStyle(Chrome.wash())
        .background(Chrome.shape(.settingsCallout).fill(Chrome.panel()))
        .overlay(Chrome.shape(.settingsCallout).strokeBorder(Chrome.edge(0.18), lineWidth: Chrome.width(.settingsCallout)))
        .environment(\.colorScheme, Chrome.scheme)
        .animation(reduceMotion ? nil : Chrome.ease(0.18), value: model.done)
    }
}

/// The app's icon as a drag source: the file it carries is this running copy of Polycarp, which a Privacy list adds.
private struct AppTile: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> AppTileView { AppTileView(url: url) }
    func updateNSView(_ view: AppTileView, context: Context) { view.url = url }
}

final class AppTileView: NSView, NSDraggingSource {
    var url: URL { didSet { needsDisplay = true } }
    private var dragging = false

    init(url: URL) {
        self.url = url
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("Polycarp app")
    }

    required init?(coder: NSCoder) { nil }

    private var icon: NSImage { NSWorkspace.shared.icon(forFile: url.path) }

    override func draw(_ dirtyRect: NSRect) { icon.draw(in: bounds) }
    // A click in the panel goes to the tile without bringing Polycarp forward first.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    override func mouseDown(with event: NSEvent) { dragging = false }

    override func mouseDragged(with event: NSEvent) {
        guard !dragging else { return }
        dragging = true
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        item.setDraggingFrame(bounds, contents: icon)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy, .link, .generic] : []
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { dragging = false }
}
