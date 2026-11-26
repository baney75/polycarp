import AppKit
import BaneySpacesCore
import SwiftUI

/// The strips of tabs above the groups in sight, a small panel for each. They lie under every window, so one that floats
/// covers them, and take no focus: a click on a tab goes to its window.
final class TilingStrips {
    typealias Tab = TilingTabs.Tab
    typealias Strip = TilingTabs.Drawn

    private var panels: [NSPanel] = []
    private var shown: [Strip] = []

    /// Shows these and no others; `pick` is told which tab was clicked.
    func show(_ strips: [Strip], pick: @escaping (WindowID) -> Void) {
        guard strips != shown, let screen = NSScreen.screens.first else { return }
        for (i, s) in strips.enumerated() {
            if i == panels.count { panels.append(makePanel()) }
            let p = panels[i]
            let old = shown.indices.contains(i) ? shown[i] : nil
            if old?.tabs != s.tabs { (p.contentView as? StripHost)?.rootView = TilingStripView(tabs: s.tabs, pick: pick) }
            if old?.frame != s.frame { p.setFrame(Geometry.toAX(s.frame, primaryHeight: screen.frame.height), display: true) }
            if !p.isVisible { p.orderFrontRegardless() }
        }
        for p in panels.dropFirst(strips.count) { p.orderOut(nil) }
        shown = strips
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.hidesOnDeactivate = false
        p.animationBehavior = .none
        // One under the bar, whose level is how tiling tells the bar's own windows.
        p.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.normalWindow)) + BarLayout.levelBelowWindows - 1)
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        let view = StripHost(rootView: TilingStripView(tabs: [], pick: { _ in }))
        view.sizingOptions = []
        p.contentView = view
        return p
    }
}

/// A click counts though another app is in front.
private final class StripHost: NSHostingView<TilingStripView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private struct TilingStripView: View {
    let tabs: [TilingStrips.Tab]
    let pick: (WindowID) -> Void
    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        HStack(spacing: 4) {
            ForEach(tabs) { tab in
                Button { pick(tab.id) } label: {
                    HStack(spacing: 6) {
                        if let icon = NSRunningApplication(processIdentifier: tab.pid)?.icon {
                            Image(nsImage: icon).resizable().frame(width: 14, height: 14)
                        }
                        Text(tab.title).font(Chrome.font(11, tab.front ? .semibold : .medium)).lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(Chrome.wash(tab.front ? 1 : 0.65))
                    }
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Chrome.shape(.overviewChip).fill(tab.front ? Chrome.lit(Chrome.accent, 0.28) : Chrome.cell(0.06)))
                    .background(Chrome.shape(.overviewChip).fill(Chrome.panel(0.9)))
                    .overlay(Chrome.shape(.overviewChip).strokeBorder(tab.front ? Chrome.focusEdge(Chrome.accent) : Chrome.edge(0.1),
                                                                      lineWidth: Chrome.width(.overviewChip, focused: tab.front)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(tab.front ? [.isButton, .isSelected] : .isButton)
            }
        }
    }
}

extension Tiling {
    /// Draws the strips of the workspaces in sight. One on the move has none until it is let go.
    func drawStrips() {
        let moving = drag.flatMap { $0.phase == .moving ? $0.window : nil }
        let tabs = spaces.active ? spaces.shownWorkspaces.sorted().flatMap(engine.tabs) : []
        guard !tabs.isEmpty || strips != nil else { return }
        if strips == nil { strips = TilingStrips() }
        strips?.show(TilingTabs.drawn(tabs, moving: moving) { id in
            let pid = spaces.window(id)?.pid ?? 0
            return (spaces.title(of: id), NSRunningApplication(processIdentifier: pid)?.localizedName ?? "", pid)
        }) { [weak self] id in
            guard let self, let n = self.spaces.model.workspace(of: id) else { return }
            self.engine.focused(id)
            self.drawStrips()
            self.spaces.focus(id, on: n, announce: false)
        }
    }
}
