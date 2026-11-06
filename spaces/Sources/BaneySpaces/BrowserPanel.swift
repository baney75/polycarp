import AppKit
import Combine
import BaneySpacesCore
import SwiftUI

/// The small panel that sits beside the browser while the extension is being added: a tile to drag onto the extensions
/// page, and a way to load the folder by hand. It never takes focus, stays above the browser, and closes itself 1.5 s after
/// the extension connects. Status comes from `BrowserModel`, which polls the helper with one request in flight.
final class BrowserDropPanel {
    static let shared = BrowserDropPanel()
    private var panel: NSPanel?
    private var model: BrowserDropModel?

    func show(browser: String, folder: URL) {
        close()
        let m = BrowserDropModel(browser: browser, folder: folder, onClose: { [weak self] in self?.close() })
        let host = NSHostingView(rootView: BrowserDropView(model: m))
        host.sizingOptions = [.intrinsicContentSize]
        let size = host.fittingSize
        let p = DropPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = .floating
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        p.contentView = host
        p.setFrameOrigin(Self.origin(for: size, browser: BrowserBundle.appName(for: browser)))
        p.orderFrontRegardless()   // in front, without making it the key window or activating Polycarp
        panel = p; model = m
        m.start()
        // The browser's window may not exist yet when the page is first asked for; place the panel again once it does.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self, let p = self.panel else { return }
            p.setFrameOrigin(Self.origin(for: p.frame.size, browser: BrowserBundle.appName(for: browser)))
        }
    }

    func close() {
        model?.stop()
        panel?.orderOut(nil)
        panel = nil; model = nil
    }

    /// Beside the browser's largest window: to its right if the screen has room, else to its left, else inside its right edge.
    static func origin(for size: NSSize, browser appName: String) -> NSPoint {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        var best: CGRect?
        let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for info in infos where (info[kCGWindowOwnerName as String] as? String) == appName && (info[kCGWindowLayer as String] as? Int) == 0 {
            guard let b = info[kCGWindowBounds as String] as? [String: CGFloat],
                  let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { continue }
            if best == nil || r.width * r.height > best!.width * best!.height { best = r }
        }
        let visible = screen.visibleFrame
        guard let w = best else { return NSPoint(x: visible.maxX - size.width - 24, y: visible.maxY - size.height - 48) }
        // CG's origin is the top left of the primary screen; Cocoa's is the bottom left.
        let top = primaryHeight - w.minY
        let y = min(max(top - size.height - 40, visible.minY + 8), visible.maxY - size.height - 8)
        let gap: CGFloat = 12
        var x = w.maxX + gap
        if x + size.width > visible.maxX { x = w.minX - gap - size.width }
        if x < visible.minX { x = min(w.maxX - size.width - 16, visible.maxX - size.width - 8) }
        return NSPoint(x: x, y: y)
    }
}

private final class DropPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class BrowserDropModel: ObservableObject {
    let browser: String
    let folder: URL
    @Published var state: BrowserPanelState = .waiting
    @Published var showSteps = false
    private let onClose: () -> Void
    private let browserModel = BrowserModel.shared
    private var watching = false
    private var observer: AnyCancellable?
    private var closing = false

    init(browser: String, folder: URL, onClose: @escaping () -> Void) {
        self.browser = browser; self.folder = folder; self.onClose = onClose
    }

    func start() {
        guard !watching else { return }
        watching = true
        browserModel.startWatching()
        observer = browserModel.$status.receive(on: DispatchQueue.main).sink { [weak self] status in self?.apply(status) }
    }

    func stop() {
        guard watching else { return }
        watching = false
        observer?.cancel(); observer = nil
        browserModel.stopWatching()
    }

    func apply(_ status: BrowserStatus?) {
        state = BrowserPanelState.next(status, bundledVersion: browserModel.bundledVersion)
        if state.closesItself, !closing {
            closing = true
            DispatchQueue.main.asyncAfter(deadline: .now() + BrowserPanelState.closeDelay) { [weak self] in self?.onClose() }
        }
    }

    /// Only on the click: the folder's path goes to the pasteboard, then the two steps are shown.
    func useLoadUnpacked() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(folder.path, forType: .string)
        showSteps = true
    }
}

struct BrowserDropView: View {
    @ObservedObject var model: BrowserDropModel
    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        VStack(spacing: 12) {
            switch model.state {
            case .connected:
                Image(systemName: "checkmark.circle.fill").font(Chrome.font(40)).foregroundStyle(Color.green)
                Text("Connected").font(Chrome.font(15, .bold))
            case .reload(let loaded, let current):
                Image(systemName: "arrow.clockwise.circle.fill").font(Chrome.font(40)).foregroundStyle(Chrome.accent)
                Text("Reload the extension").font(Chrome.font(15, .bold))
                Text("\(model.browser) is running version \(loaded); Polycarp has \(current). Press the reload arrow on its card on the Extensions page.")
                    .font(Chrome.font(11)).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            case .waiting:
                Text("Drag this onto the Extensions page").font(Chrome.font(13, .bold))
                DragTile(folder: model.folder)
                Text("Turn on Developer mode first, at the top right, if the page doesn't take it.")
                    .font(Chrome.font(11)).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                Button("Use Load unpacked instead") { model.useLoadUnpacked() }
                if model.showSteps {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("The folder's path is copied.").font(Chrome.font(11, .medium))
                        Text("1. In the dialog press ⌘⇧G.\n2. Paste, then press Return.").font(Chrome.font(11)).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(16)
        .frame(width: 272)
        .background(Chrome.shape(.settingsCallout).fill(Chrome.panel()))
        .overlay(Chrome.shape(.settingsCallout).strokeBorder(Chrome.edge(0.25), lineWidth: 1))
        .environment(\.colorScheme, Chrome.scheme)
        .padding(6)
    }
}

/// The tile: the leaf mark on the accent. A drag from it is a real file-URL drag of the Extension folder, the same item
/// Finder would hand over, so the Extensions page loads it as it loads a dropped folder.
struct DragTile: View {
    let folder: URL
    var body: some View {
        ZStack {
            Chrome.shape(.settingsTile).fill(Chrome.accent)
            VStack(spacing: 6) {
                Image(systemName: "leaf.fill").font(Chrome.font(44)).foregroundStyle(Chrome.onAccent)
                Text("Polycarp").font(Chrome.font(12, .bold)).foregroundStyle(Chrome.onAccent)
            }
            DragSourceView(folder: folder)
        }
        .frame(width: 140, height: 120)
        .help("Drag onto the Extensions page")
    }
}

private struct DragSourceView: NSViewRepresentable {
    let folder: URL
    func makeNSView(context: Context) -> DragSource { DragSource(folder: folder) }
    func updateNSView(_ view: DragSource, context: Context) { view.folder = folder }
}

final class DragSource: NSView, NSDraggingSource {
    var folder: URL
    init(folder: URL) { self.folder = folder; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    override func mouseDragged(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: ExtensionDrag.writer(for: folder))
        let icon = NSWorkspace.shared.icon(forFile: folder.path)
        item.setDraggingFrame(NSRect(x: bounds.midX - 32, y: bounds.midY - 32, width: 64, height: 64), contents: icon)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}
