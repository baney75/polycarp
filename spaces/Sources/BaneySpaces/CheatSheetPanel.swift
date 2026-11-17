import AppKit
import BaneySpacesCore
import SwiftUI

/// The cheat sheet (K3): every live binding, made from the keymap the app registered, in the theme. Its chord shows it
/// and hides it; Esc, a click elsewhere or any other key hides it too. It never takes focus from your app.
final class CheatSheetPanel {
    private var panel: NSPanel?
    private let model = CheatSheetModel()
    private var monitors: [Any] = []

    var isShown: Bool { panel?.isVisible ?? false }

    func toggle(_ sections: [CheatSheet.Section]) {
        if isShown { hide() } else { show(sections) }
    }

    func show(_ sections: [CheatSheet.Section]) {
        model.sections = sections
        let p = panel ?? makePanel()
        panel = p
        if let host = p.contentView { host.layoutSubtreeIfNeeded(); p.setContentSize(host.fittingSize) }
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main {
            let v = screen.visibleFrame, size = p.frame.size
            p.setFrameOrigin(NSPoint(x: (v.midX - size.width / 2).rounded(), y: (v.midY - size.height / 2).rounded()))
        }
        p.alphaValue = 0
        p.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(0.18, .panelIn)
            p.animator().alphaValue = 1
        }
        // Any key or click elsewhere closes it; the sheet itself takes no keys, so your app keeps them.
        monitors = [NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hide()
        }].compactMap { $0 }
        Trace.log("cheat sheet shown: \(sections.reduce(0) { $0 + $1.rows.count }) rows")
    }

    func hide() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        guard let p = panel, p.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = Chrome.duration(0.12, .panelOut)
            p.animator().alphaValue = 0
        }, completionHandler: { [weak p] in p?.orderOut(nil) })
    }

    private func makePanel() -> NSPanel {
        let host = NSHostingView(rootView: CheatSheetView(model: model))
        // Not SwiftUI's default sizing: it set the panel's min and max size mid-layout and crashed the dock (ledger, 10-14).
        host.sizingOptions = [.intrinsicContentSize]
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        p.contentView = host
        return p
    }
}

final class CheatSheetModel: ObservableObject {
    @Published var sections: [CheatSheet.Section] = []
}

struct CheatSheetView: View {
    @ObservedObject var model: CheatSheetModel
    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        HStack(alignment: .top, spacing: 28) {
            ForEach(columns, id: \.self) { column in
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(column, id: \.self) { i in section(model.sections[i]) }
                }
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 20)
        .background(Chrome.panelBackground(.hudPanel))
        .padding(20)
        .environment(\.colorScheme, Chrome.scheme)
    }

    /// Two columns, the sections split where the rows come out most even.
    private var columns: [[Int]] {
        let counts = model.sections.map { $0.rows.count + 2 }
        guard counts.count > 1 else { return [Array(model.sections.indices)] }
        let total = counts.reduce(0, +)
        var best = 1, gap = Int.max, run = 0
        for i in 1..<counts.count {
            run += counts[i - 1]
            if abs(total - 2 * run) < gap { gap = abs(total - 2 * run); best = i }
        }
        return [Array(0..<best), Array(best..<counts.count)]
    }

    private func section(_ s: CheatSheet.Section) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(s.title).font(Chrome.font(12, .semibold)).foregroundStyle(Chrome.wash(0.6))
            ForEach(Array(s.rows.enumerated()), id: \.offset) { _, r in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(r.keys).font(Chrome.font(13, .medium)).strikethrough(r.taken)
                        .foregroundStyle(Chrome.wash(r.taken ? 0.4 : 1)).frame(minWidth: 92, alignment: .leading)
                    Text(r.taken ? r.does + " (another app holds this key)" : r.does)
                        .font(Chrome.font(13)).foregroundStyle(Chrome.wash(r.taken ? 0.45 : 0.85))
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
