import AppKit
import BaneySpacesCore
import SwiftUI

/// Settings keeps its panes built while the window is open (#350, X2). Each pane is its own hosting view in the deck, and
/// a switch only shows one and hides the other, so going to a pane already built costs a frame, not a SwiftUI build of
/// the pane. The window opens with the pane in view alone; the rest are built one at a time on the main thread, each on
/// its own turn of the run loop and only once nothing has been typed or clicked for `quietFor`, so a build never starts
/// while you work and an input waits at most for one pane. Closing Settings lets go of every pane but the one on screen.
final class SettingsDeck: NSView {
    /// Builds the host for a pane (`SetupView` with `pane:` set).
    var make: (SettingsTab) -> NSView = { _ in NSView() }
    private(set) var built: [SettingsTab: NSView] = [:]
    private(set) var shown: SettingsTab?
    private var timer: Timer?
    private var closing: NSObjectProtocol?
    /// The time, in ms of main-thread CPU, each pane took to build hidden (`SettingsTiming`).
    private(set) var steps: [SettingsTab: Double] = [:]

    /// No input for this long, anywhere, before a hidden pane is built.
    static let quietFor: TimeInterval = 0.2
    /// Whether the person has been still long enough. The timing run, offscreen, passes `{ true }`.
    static var quiet: () -> Bool = {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!) >= quietFor
    }

    var complete: Bool { built.count == SettingsTab.allCases.count }

    override var isFlipped: Bool { true }

    /// Shows `tab`, building it now if it isn't yet, and starts building the rest.
    func show(_ tab: SettingsTab) {
        let fresh = built[tab] == nil
        let view = built[tab] ?? add(tab)
        if shown != tab {
            shown = tab
            for (t, v) in built { v.isHidden = t != tab }
            // Each pane opens at its top, as when it was built anew.
            if !fresh, let scroll = Self.scrollView(in: view) {
                scroll.contentView.scroll(to: .zero)
                scroll.reflectScrolledClipView(scroll.contentView)
            }
        }
        start()
    }

    /// Builds the next pane not yet built, hidden. One a call; false once every pane is built.
    @discardableResult
    func buildNext() -> Bool {
        guard let next = SettingsTab.allCases.first(where: { built[$0] == nil }) else { return false }
        let c = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let view = add(next)
        view.layoutSubtreeIfNeeded()   // the SwiftUI build happens now, not when it is first shown
        steps[next] = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - c) / 1e6
        return true
    }

    /// Lets go of every pane but the one on screen.
    func release() {
        stop()
        for (t, v) in built where t != shown { v.removeFromSuperview(); built[t] = nil }
    }

    private func add(_ tab: SettingsTab) -> NSView {
        let view = make(tab)
        view.frame = bounds
        view.autoresizingMask = [.width, .height]
        view.isHidden = tab != shown
        addSubview(view)
        built[tab] = view
        return view
    }

    private func start() {
        guard timer == nil, !complete, window != nil else { return }
        // A timer in the default mode: no build while a menu, a scroll or a drag is tracking.
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self, Self.quiet() else { return }
            if !self.buildNext() || self.complete { self.stop() }
        }
        RunLoop.main.add(t, forMode: .default)
        timer = t
    }

    private func stop() { timer?.invalidate(); timer = nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let closing { NotificationCenter.default.removeObserver(closing) }
        closing = nil
        guard let window else { stop(); return }
        closing = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            self?.release()
        }
        start()
    }

    deinit {
        timer?.invalidate()
        if let closing { NotificationCenter.default.removeObserver(closing) }
    }

    static func scrollView(in view: NSView) -> NSScrollView? {
        if let s = view as? NSScrollView { return s }
        for sub in view.subviews { if let s = scrollView(in: sub) { return s } }
        return nil
    }
}

/// The deck in the window's SwiftUI layout, beside the sidebar.
struct SettingsPanes: NSViewRepresentable {
    let tab: SettingsTab
    let make: (SettingsTab) -> NSView

    func makeNSView(context: Context) -> SettingsDeck {
        let deck = SettingsDeck()
        deck.make = make
        return deck
    }

    func updateNSView(_ deck: SettingsDeck, context: Context) {
        deck.make = make
        deck.show(tab)
    }
}
