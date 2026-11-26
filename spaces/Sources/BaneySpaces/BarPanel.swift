import AppKit
import Combine
import SwiftUI

/// A panel under the bar, opened by one of its buttons (the bell's list, the clock's calendar). It takes the keyboard
/// without bringing Polycarp forward, and goes on Esc, a click elsewhere or a second click on its button. Main thread only.
final class BarPanel: NSObject, NSWindowDelegate {
    /// What stays put as the panel changes size: its right edge near the button, or its middle under it.
    enum Anchor { case right, middle }

    private final class Panel: NSPanel {
        var onKey: (NSEvent) -> Bool = { _ in false }
        override var canBecomeKey: Bool { true }
        override func cancelOperation(_ sender: Any?) { orderOut(nil) }
        override func keyDown(with event: NSEvent) { if !onKey(event) { super.keyDown(with: event) } }
    }

    private let name: String
    private let anchor: Anchor
    private let width: CGFloat
    /// The screen it is open on, or nil once it is gone.
    var onShow: (CGDirectDisplayID?) -> Void = { _ in }
    /// A key it was sent: whether it was used.
    var onKey: (NSEvent) -> Bool = { _ in false }
    private var panel: Panel?
    private var point = NSPoint.zero
    private var screen: CGDirectDisplayID?
    private var closedOn: CGDirectDisplayID?
    private var sizing: AnyCancellable?
    private var clicks: Any?

    init(_ name: String, anchor: Anchor, width: CGFloat) {
        self.name = name; self.anchor = anchor; self.width = width
    }

    /// Shows it at `x`, or hides it. A button acts as it comes up: when that press already closed the panel on this
    /// screen as it went down, it is done. `view` is given the height there is and what closes the panel.
    func toggle(on screen: NSScreen, x: CGFloat, below: CGFloat, changes: AnyPublisher<Void, Never>,
                view: (CGFloat, @escaping () -> Void) -> some View) {
        if panel?.isVisible == true { panel?.orderOut(nil); return }
        if let closedOn, closedOn == screen.displayID, NSApp.currentEvent?.type == .leftMouseUp { return }
        let p = panel ?? make()
        panel = p
        p.onKey = { [weak self] in self?.onKey($0) ?? false }
        self.screen = screen.displayID
        let (least, most) = (screen.visibleFrame.minX + 8, screen.visibleFrame.maxX - 8)
        point = switch anchor {
        case .right: NSPoint(x: min(max(x, least + width), most), y: below - 6)
        case .middle: NSPoint(x: min(max(x, least + width / 2), most - width / 2), y: below - 6)
        }
        p.contentView = NSHostingView(rootView: view(min(620, point.y - screen.visibleFrame.minY - 16)) { [weak p] in p?.orderOut(nil) })
        fit()
        sizing = changes.sink { [weak self] _ in DispatchQueue.main.async { self?.fit() } }
        // A press on Polycarp's own bar doesn't take the keyboard from the panel, so it is watched for.
        clicks = clicks ?? NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] e in
            guard let self else { return e }
            let closes = self.panel?.isVisible == true && e.window !== self.panel
            self.closedOn = closes ? self.screen : nil
            if closes { self.panel?.orderOut(nil) }
            return e
        }
        p.alphaValue = 0
        p.makeKeyAndOrderFront(nil)
        onShow(self.screen)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(0.12, .panelIn)
            p.animator().alphaValue = 1
        }
    }

    func hide() { panel?.orderOut(nil) }

    private func fit() {
        guard let p = panel, let host = p.contentView else { return }
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        let x = anchor == .right ? point.x - size.width : (point.x - size.width / 2).rounded()
        p.setFrame(NSRect(x: x, y: point.y - size.height, width: size.width, height: size.height), display: true)
    }

    func windowDidResignKey(_ notification: Notification) {
        panel?.orderOut(nil)
        sizing = nil
        onShow(nil)
    }

    private func make() -> Panel {
        let p = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .statusBar
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary]
        p.delegate = self
        p.setAccessibilityLabel(name)
        return p
    }
}
