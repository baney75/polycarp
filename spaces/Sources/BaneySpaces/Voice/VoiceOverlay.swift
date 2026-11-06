import AppKit
import BaneySpacesCore

/// The pill that shows while dictating: a level meter while listening, "Writing…" after. Ported from voice/overlay.html
/// and overlay.ts (16 bars that flow right to left, eased, tapered at the edges; a ticking clock; the learned
/// "from → to" for a couple of seconds). A native panel with Core Animation layers, no web view. It never takes focus
/// or clicks: non-activating, ignores the mouse, can't become key or main, and joins every Space including
/// full-screen ones, like the Tauri overlay (`order_overlay`). Colors, corner radius and durations come from `Chrome`.
final class VoiceOverlay {
    private let panel: NSPanel
    private let root = CALayer()
    private let bars: [CALayer]
    private let dot = CALayer()
    private let clock = CATextLayer()
    private let label = CATextLayer()
    private var latest: Float = 0
    private var targets = [CGFloat](repeating: 0, count: 16)
    private var shown = [CGFloat](repeating: 0, count: 16)
    private var timer: Timer?
    private var startedAt = Date()
    private var learnedWork: DispatchWorkItem?
    private var face: Face = .idle

    private enum Face { case idle, recording, writing, learned }

    private static let size = NSSize(width: 260, height: 64)

    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    init() {
        panel = Panel(contentRect: NSRect(origin: .zero, size: Self.size), styleMask: [.borderless, .nonactivatingPanel],
                      backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        let host = NSView(frame: NSRect(origin: .zero, size: Self.size))
        host.wantsLayer = true
        host.layer = root
        root.cornerCurve = .continuous
        panel.contentView = host
        bars = (0..<16).map { _ in CALayer() }
        for b in bars { root.addSublayer(b) }
        for l in [dot, clock, label] { root.addSublayer(l) }
        dot.cornerRadius = 4
        for t in [clock, label] { t.contentsScale = 2; t.alignmentMode = .left }
        clock.alignmentMode = .right
        accessibility()
    }

    private func accessibility() {
        panel.setAccessibilityRole(.group)
        panel.setAccessibilityLabel("Dictation")
    }

    // MARK: Driven by the engine

    func level(_ v: Float) { latest = v }

    func status(_ s: VoiceStatus, enabled: Bool) {
        guard enabled else { return hide() }
        switch s {
        case .recording:
            if face != .recording { begin() }
        case .transcribing: show(.writing, "Writing…")
        case .typing: show(.writing, "Typing…")
        default:
            if face != .learned { hide() }
        }
    }

    func learned(from: String, to: String) {
        show(.learned, "\(from) → \(to)")
        learnedWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.hide() }
        learnedWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: w)
    }

    // MARK: Faces

    private func begin() {
        learnedWork?.cancel()   // a pending hide of the learned pill must not hide a live recording
        face = .recording
        startedAt = Date()
        targets = [CGFloat](repeating: 0, count: 16)
        shown = targets
        layout()
        present()
        timer?.invalidate()
        var tick = 0
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            guard let self, self.face == .recording else { return }
            tick += 1
            // The history shifts about 22 times a second (every third frame at 60 Hz) so the wave flows.
            if tick % 3 == 0 { self.targets.removeFirst(); self.targets.append(Self.shape(self.latest)) }
            self.draw()
        }
    }

    private func show(_ f: Face, _ text: String) {
        timer?.invalidate()
        face = f
        label.string = text
        layout()
        present()
    }

    private func hide() {
        timer?.invalidate()
        face = .idle
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = Chrome.duration(0.18, .panelOut)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            if self?.face == .idle { self?.panel.orderOut(nil) }
        })
    }

    private func present() {
        place()
        panel.alphaValue = 1
        // Ordered in without becoming key or activating the app (a background app's panel).
        panel.orderFrontRegardless()
    }

    /// Bottom center of the main display, 72 pt up, as the Tauri overlay sits.
    private func place() {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let f = screen.frame
        panel.setFrame(NSRect(x: f.midX - Self.size.width / 2, y: f.minY + 72, width: Self.size.width, height: Self.size.height), display: false)
    }

    /// Speech levels sit low; lift quiet sounds so the bars feel alive (overlay.ts `shape`).
    static func shape(_ level: Float) -> CGFloat { CGFloat(min(1, pow(max(0, level), 0.6) * 1.15)) }

    private func layout() {
        let panelColor = NSColor(Chrome.panel(0.94)).cgColor
        let tint = NSColor(Chrome.accent).cgColor
        let text = NSColor(Chrome.wash()).cgColor
        root.backgroundColor = panelColor
        root.cornerRadius = Chrome.radius(.hudPanel)
        root.borderColor = NSColor(Chrome.edge(0.12)).cgColor
        root.borderWidth = Chrome.width(.hudPanel)
        let isRec = face == .recording
        for b in bars { b.isHidden = !isRec; b.backgroundColor = tint; b.cornerRadius = 1.5 }
        dot.isHidden = !isRec
        dot.backgroundColor = tint
        clock.isHidden = !isRec
        label.isHidden = isRec
        for t in [clock, label] {
            t.foregroundColor = text
            t.font = NSFont.systemFont(ofSize: 13, weight: .medium)
            t.fontSize = 13
        }
        let h = Self.size.height
        dot.frame = CGRect(x: 18, y: h / 2 - 4, width: 8, height: 8)
        clock.frame = CGRect(x: Self.size.width - 62, y: h / 2 - 9, width: 44, height: 18)
        label.frame = CGRect(x: 22, y: h / 2 - 9, width: Self.size.width - 44, height: 18)
        label.alignmentMode = .center
        draw()
    }

    private func draw() {
        guard face == .recording else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let ease: CGFloat = reduce ? 1 : 0.28
        let areaX: CGFloat = 38, areaW: CGFloat = Self.size.width - 38 - 70
        let slot = areaW / CGFloat(bars.count), maxH: CGFloat = 34
        for i in bars.indices {
            // The edges taper so the wave reads as a soft lozenge.
            let edge = CGFloat(sin((Double(i) + 0.5) / Double(bars.count) * .pi)) * 0.55 + 0.45
            shown[i] += (targets[i] * edge - shown[i]) * ease
            let h = maxH * (0.14 + shown[i] * 0.86)
            bars[i].frame = CGRect(x: areaX + CGFloat(i) * slot + slot * 0.2, y: Self.size.height / 2 - h / 2, width: slot * 0.6, height: h)
        }
        let s = Int(Date().timeIntervalSince(startedAt))
        clock.string = String(format: "%d:%02d", s / 60, s % 60)
        CATransaction.commit()
    }
}
