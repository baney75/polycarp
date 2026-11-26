import AppKit
import BaneySpacesCore
import SwiftUI

/// Where a dragged tiled window would go: a line in the theme's focused border color around that place, and a wash of it
/// inside, or what style.css's `tiling` says. It takes no clicks and no focus.
final class TilingOutline {
    private var panel: NSPanel?
    private(set) var frame: CGRect?

    /// Shows it around `target`, in Accessibility coordinates.
    func show(_ target: CGRect) {
        guard target != frame, let screen = NSScreen.screens.first else { return }
        let first = frame == nil
        frame = target
        let p = panel ?? makePanel()
        panel = p
        let to = Geometry.toAX(target, primaryHeight: screen.frame.height)
        if first {
            (p.contentView as? NSHostingView<TilingOutlineView>)?.rootView = TilingOutlineView()
            p.setFrame(to, display: true)
            p.alphaValue = 0
            p.orderFrontRegardless()
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(0.12, first ? .panelIn : .row)
            p.animator().alphaValue = 1
            if !first { p.animator().setFrame(to, display: true) }
        }
    }

    func hide() {
        guard frame != nil, let p = panel else { return }
        frame = nil
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = Chrome.duration(0.12, .panelOut)
            p.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            if self?.frame == nil { p.orderOut(nil) }
        })
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        let view = NSHostingView(rootView: TilingOutlineView())
        view.sizingOptions = []
        p.contentView = view
        return p
    }
}

/// Read each time it comes up, so a theme or a sheet changed since the last drag shows.
struct TilingOutlineView: View {
    private var style: ComputedStyle {
        let line = WindowBorderStyle(Chrome.look)
        let color = StyleColor(line.focused)
        var s = Styles.shared.book.outline
        s.background = s.background ?? .color(StyleColor(line.focused, alpha: 0.14))
        s.border = s.border ?? .solid(width: line.width, color: color)
        s.borderRadius = s.borderRadius ?? line.radius
        return s
    }

    var body: some View { Color.clear.modifier(StyledBox(style: style)) }
}
