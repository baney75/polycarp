import AppKit
import BaneySpacesCore

/// The pill that shows while dictating: a level meter while listening, "Writing…" after. Ported from voice/overlay.html
/// and overlay.ts (16 bars that flow right to left, eased, tapered at the edges; a ticking clock; the learned
/// "from → to" for a couple of seconds). A native panel with Core Animation layers, no web view. It never takes focus
/// or clicks: non-activating, ignores the mouse, can't become key or main, and joins every Space including
/// full-screen ones, like the Tauri overlay (`order_overlay`). Colors, fonts, corner radius and durations come from
/// `Chrome`. A notice (a failed dictation, a press while busy, Escape stopping the typing) takes the pill for a few
/// seconds with an icon and up to two lines, then whatever is still going on shows again.
final class VoiceOverlay {
    private let panel: NSPanel
    private let root = CALayer()
    private let bars: [CALayer]
    private let dot = CALayer()
    private let clock = CATextLayer()
    private let label = CATextLayer()
    private let hint = CATextLayer()
    private let icon = CALayer()
    private var latest: Float = 0
    private var targets = [CGFloat](repeating: 0, count: 16)
    private var shown = [CGFloat](repeating: 0, count: 16)
    private var timer: Timer?
    private var startedAt = Date()
    private var learnedWork: DispatchWorkItem?
    private var noticeWork: DispatchWorkItem?
    private var face: Face = .idle
    private var themeObserver: NSObjectProtocol?
    private var announced: VoiceStatus?
    private var notice: VoiceNotice?
    /// The microphone has sent a level: the dot fills. Until then it is a ring, so a slow-to-open device shows.
    private var heard = false
    /// What the engine last said, to show again when a notice ends.
    private var last: (status: VoiceStatus, enabled: Bool) = (.ready, true)

    private enum Face { case idle, recording, writing, typing, learned, notice }

    private static let pill = NSSize(width: 260, height: 64)
    /// Room for an icon and two lines of a sentence like "A password field has the keyboard, so…".
    private static let wide = NSSize(width: 360, height: 72)
    private var size: NSSize { face == .notice ? Self.wide : Self.pill }

    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    init() {
        panel = Panel(contentRect: NSRect(origin: .zero, size: Self.pill), styleMask: [.borderless, .nonactivatingPanel],
                      backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        let host = NSView(frame: NSRect(origin: .zero, size: Self.pill))
        host.wantsLayer = true
        host.layer = root
        root.cornerCurve = .continuous
        panel.contentView = host
        bars = (0..<16).map { _ in CALayer() }
        for b in bars { root.addSublayer(b) }
        for l in [dot, clock, label, hint, icon] { root.addSublayer(l) }
        dot.cornerRadius = 4
        for t in [clock, label, hint] { t.contentsScale = 2; t.alignmentMode = .left }
        clock.alignmentMode = .right
        icon.contentsGravity = .resizeAspect
        icon.contentsScale = 2
        accessibility()
        // A theme or Dark Mode change while the pill is up redraws it in the new look at once.
        themeObserver = NotificationCenter.default.addObserver(forName: Appearance.didChange, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.face != .idle else { return }
            self.layout()
        }
    }

    deinit { if let themeObserver { NotificationCenter.default.removeObserver(themeObserver) } }

    private func announce(_ words: String) {
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: words, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }

    private func accessibility() {
        panel.setAccessibilityRole(.group)
        panel.setAccessibilityLabel("Silas")
    }

    // MARK: Driven by the engine

    func level(_ v: Float) {
        latest = v
        if !heard, face == .recording { heard = true; layout() }
    }

    func status(_ s: VoiceStatus, enabled: Bool) {
        // VoiceOver hears each phase once, with or without the pill.
        if let words = VoiceAccess.announcement(from: announced, to: s) { announce(words) }
        announced = s
        last = (s, enabled)
        // A notice stays up for its time; only a new dictation takes the pill from it.
        if face == .notice, s != .recording { return }
        guard enabled else { return hide() }
        switch s {
        case .recording:
            if face != .recording { begin() }
        case .transcribing: show(.writing, "Writing…")
        case .typing: show(.typing, "Typing…")
        default:
            if face != .learned { hide() }
        }
    }

    /// Shown even with the listening indicator turned off: the person pressed the key and needs to know why nothing
    /// happened.
    func notice(_ n: VoiceNotice) {
        learnedWork?.cancel()
        noticeWork?.cancel()
        notice = n
        show(.notice, n.message)
        announce(n.announcement)
        let w = DispatchWorkItem { [weak self] in
            guard let self, self.face == .notice else { return }
            self.notice = nil
            self.face = .idle
            // Still typing shows the typing face again; anything else hides the pill.
            self.status(self.last.status, enabled: self.last.enabled)
        }
        noticeWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + n.seconds, execute: w)
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
        noticeWork?.cancel()
        notice = nil
        face = .recording
        heard = false
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

    /// Bottom center of the display holding the window you're typing into (`VoiceOverlayPlace`), 72 pt up.
    private func place() {
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return }
        let i = VoiceOverlayPlace.screen(window: Self.frontWindow(primaryHeight: screens[0].frame.height), pointer: NSEvent.mouseLocation,
                                         screens: screens.map(\.frame))
        panel.setFrame(VoiceOverlayPlace.frame(size: size, on: screens[i].frame), display: false)
        panel.contentView?.frame = NSRect(origin: .zero, size: size)
    }

    /// The frontmost app's front window, from the window list (bounds only: no Accessibility call, no prompt).
    private static func frontWindow(primaryHeight: CGFloat) -> CGRect? {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
            if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) {
                return VoiceOverlayPlace.cocoa(r, primaryHeight: primaryHeight)
            }
        }
        return nil
    }

    private static func symbol(_ name: String, color: NSColor, size: CGFloat) -> CGImage? {
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: .semibold).applying(.init(paletteColors: [color]))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { return nil }
        var rect = NSRect(origin: .zero, size: image.size)
        return image.cgImage(forProposedRect: &rect, context: nil, hints: [.ctm: AffineTransform(scale: 2)])
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
        let isRec = face == .recording, isNotice = face == .notice
        // The bars round off as much as the theme's panel does, up to a pill: a square theme gets square bars.
        let barRound = min(1.5, Chrome.radius(.hudPanel))
        for b in bars { b.isHidden = !isRec; b.backgroundColor = tint; b.cornerRadius = barRound }
        dot.isHidden = !isRec
        // A ring until the microphone sends its first level, then filled.
        dot.backgroundColor = heard ? tint : NSColor.clear.cgColor
        dot.borderColor = tint
        dot.borderWidth = heard ? 0 : 1.5
        clock.isHidden = !isRec
        label.isHidden = isRec
        hint.isHidden = face != .typing
        icon.isHidden = !isNotice
        let font = Chrome.nsFont(13, .medium), small = Chrome.nsFont(11)
        for t in [clock, label] {
            t.foregroundColor = text
            t.font = font
            t.fontSize = font.pointSize
        }
        hint.foregroundColor = NSColor(Chrome.muted).cgColor
        hint.font = small
        hint.fontSize = small.pointSize
        hint.string = "Press Esc to stop"
        hint.alignmentMode = .center
        let w = size.width, h = size.height
        let line = ceil(font.ascender - font.descender + font.leading) + 2
        dot.frame = CGRect(x: 18, y: h / 2 - 4, width: 8, height: 8)
        clock.frame = CGRect(x: w - 62, y: h / 2 - 9, width: 44, height: 18)
        label.isWrapped = isNotice
        label.truncationMode = .end
        switch face {
        case .notice:
            let n = notice ?? VoiceNotice(kind: .error, message: "")
            let color = NSColor(n.kind == .error ? Chrome.urgent : Chrome.accent)
            icon.contents = Self.symbol(n.symbol, color: color, size: 16)
            icon.frame = CGRect(x: 18, y: h / 2 - 10, width: 20, height: 20)
            let x: CGFloat = 48, textW = w - x - 18
            // One line sits centered; two lines fill the middle.
            let need = (n.message as NSString).boundingRect(with: NSSize(width: textW, height: 100), options: [.usesLineFragmentOrigin],
                                                            attributes: [.font: font]).height
            let textH = min(ceil(need), line * 2)
            label.frame = CGRect(x: x, y: (h - textH) / 2, width: textW, height: textH)
            label.alignmentMode = .left
        case .typing:
            let lineSmall = ceil(small.ascender - small.descender) + 2
            let top = (h + line + lineSmall) / 2
            label.frame = CGRect(x: 22, y: top - line, width: w - 44, height: line)
            hint.frame = CGRect(x: 22, y: top - line - lineSmall, width: w - 44, height: lineSmall)
            label.alignmentMode = .center
        default:
            label.frame = CGRect(x: 22, y: (h - line) / 2, width: w - 44, height: line)
            label.alignmentMode = .center
        }
        draw()
    }

    private func draw() {
        guard face == .recording else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let reduce = Chrome.reduceMotion
        if reduce {
            // A still meter: bars of one height, lit from the left with the level. Nothing flows.
            let lit = VoiceAccess.lit(level: latest, bars: bars.count)
            let areaX: CGFloat = 38, slot = (size.width - 38 - 70) / CGFloat(bars.count), h: CGFloat = 14
            let tint = NSColor(Chrome.accent)
            for i in bars.indices {
                bars[i].frame = CGRect(x: areaX + CGFloat(i) * slot + slot * 0.2, y: size.height / 2 - h / 2, width: slot * 0.6, height: h)
                bars[i].backgroundColor = (i < lit ? tint : tint.withAlphaComponent(0.22)).cgColor
            }
            let s = Int(Date().timeIntervalSince(startedAt))
            clock.string = String(format: "%d:%02d", s / 60, s % 60)
            CATransaction.commit()
            return
        }
        let ease: CGFloat = 0.28
        let areaX: CGFloat = 38, areaW: CGFloat = size.width - 38 - 70
        let slot = areaW / CGFloat(bars.count), maxH: CGFloat = 34
        for i in bars.indices {
            // The edges taper so the wave reads as a soft lozenge.
            let edge = CGFloat(sin((Double(i) + 0.5) / Double(bars.count) * .pi)) * 0.55 + 0.45
            shown[i] += (targets[i] * edge - shown[i]) * ease
            let h = maxH * (0.14 + shown[i] * 0.86)
            bars[i].frame = CGRect(x: areaX + CGFloat(i) * slot + slot * 0.2, y: size.height / 2 - h / 2, width: slot * 0.6, height: h)
        }
        let s = Int(Date().timeIntervalSince(startedAt))
        clock.string = String(format: "%d:%02d", s / 60, s % 60)
        CATransaction.commit()
    }
}
