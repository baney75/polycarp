import AppKit
import BaneySpacesCore
import SwiftUI

/// A quick look at a page's readable text, which the person asked for in the launcher. Esc, or clicking elsewhere, closes
/// it, and the text goes with it: nothing keeps it.
final class PagePeek {
    static let shared = PagePeek()
    private var panel: PeekPanel?

    func show(_ page: BrowserText, site: String) {
        let p = panel ?? PeekPanel(onClose: { [weak self] in self?.close() })
        panel = p
        p.contentView = NSHostingView(rootView: PagePeekView(page: page, site: site).environment(\.colorScheme, Chrome.scheme))
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main ?? NSScreen.screens[0]
        let area = screen.visibleFrame
        let size = NSSize(width: min(680, area.width - 40), height: min(760, area.height - 40))
        p.setFrame(NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height), display: false)
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }

    func close() {
        guard let p = panel else { return }
        p.orderOut(nil)
        p.contentView = nil
    }
}

private final class PeekPanel: NSPanel {
    private let onClose: () -> Void
    init(onClose: @escaping () -> Void) {
        self.onClose = onClose
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .floating
        hidesOnDeactivate = false
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient]
        setAccessibilityLabel("Quick look at a page")
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: self, queue: .main) { [weak self] _ in
            self?.onClose()
        }
    }
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onClose() }
}

/// The page's title and site, then its paragraphs, in the theme's reading face.
struct PagePeekView: View {
    let page: BrowserText
    let site: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(page.title.isEmpty ? site : page.title).font(Chrome.font(17, .semibold)).foregroundStyle(Chrome.wash())
                    .lineLimit(2)
                Text("\(site) · Esc to close").font(Chrome.font(11.5)).foregroundStyle(Chrome.muted)
            }
            .padding(22)
            Divider().overlay(Chrome.edge(0.1))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(page.paragraphs.indices, id: \.self) { i in
                        Text(page.paragraphs[i]).font(Chrome.font(14)).foregroundStyle(Chrome.wash(0.92)).lineSpacing(3)
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(22)
            }
        }
        .background(Chrome.panelBackground(.launcherPanel))
        .clipShape(Chrome.shape(.launcherPanel))
        .overlay(Chrome.shape(.launcherPanel).strokeBorder(Chrome.edge(0.1), lineWidth: Chrome.width(.launcherPanel)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quick look at \(site)")
    }
}
