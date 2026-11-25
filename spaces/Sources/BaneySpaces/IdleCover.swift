import AppKit
import BaneySpacesCore
import IOKit
import IOKit.pwr_mgt
import SwiftUI
import SystemConfiguration

/// Polycarp's idle screen (`idle.*` in surfaces.json): after `startAfterMinutes` without input, one cover on each
/// screen with the machine's name, the time, a verse and a line of Kierkegaard (`IdleScreen`). Any key, click or move
/// takes it away. It takes the keyboard while up without activating Polycarp, so the key that wakes it never lands in
/// the app under it, which keeps its place. It stays away while an app keeps the display awake (a video, a call) and
/// once macOS's screen saver, lock or display sleep has the screen; those still come in their time, over it. Main thread only.
final class IdleCover {
    static let shared = IdleCover()

    private var watch: Timer?
    private var wake: Timer?
    private var windows: [NSWindow] = []
    private var lastIdle: TimeInterval = 0
    private var monitor: Any?
    private var cursorHidden = false
    private var screenSaverRunning = false
    /// The idle paper drawn once, by what it was drawn from (`paperKey`); one picture serves every screen.
    private var paperCache: (key: String, image: CGImage?)?
    /// The key being drawn off the main thread, so a look doesn't start a second.
    private var paperDrawing: String?
    private let paperQueue = DispatchQueue(label: "polycarp.idle.paper", qos: .utility)

    var isUp: Bool { !windows.isEmpty }

    func start() {
        guard watch == nil else { return }
        let d = DistributedNotificationCenter.default()
        d.addObserver(forName: .init("com.apple.screensaver.didstart"), object: nil, queue: .main) { [weak self] _ in self?.screenSaverRunning = true }
        d.addObserver(forName: .init("com.apple.screensaver.didstop"), object: nil, queue: .main) { [weak self] _ in self?.screenSaverRunning = false }
        let t = Timer(timeInterval: IdleScreen.watchInterval, repeats: true) { [weak self] _ in self?.look() }
        t.tolerance = 3
        RunLoop.main.add(t, forMode: .common)
        watch = t
        NotificationCenter.default.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in
            if !SurfacesStore.shared.current.idle.enabled { self?.hide() }
            self?.prewarm()
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.prewarm()
        }
        prewarm()
    }

    /// What the idle paper would be drawn from now, and at what size: the largest screen's pixels. Nil with no paper.
    private struct PaperJob {
        let key: String, paper: Paper, desktop: Surfaces.Desktop, width: Int, height: Int, date: Date, systemDark: Bool, background: RGB

        init?() {
            let surfaces = SurfacesStore.shared.current
            guard surfaces.idle.enabled, let paper = surfaces.paper(on: .idle),
                  let big = NSScreen.screens.max(by: { $0.frame.width * $0.backingScaleFactor < $1.frame.width * $1.backingScaleFactor }) else { return nil }
            self.paper = paper
            desktop = surfaces.desktop
            let w = Int((big.frame.width * big.backingScaleFactor).rounded()), h = Int((big.frame.height * big.backingScaleFactor).rounded())
            width = w
            height = h
            date = Date()
            systemDark = Appearance.systemDark
            background = Appearance.shared.look.color("background")
            // A scene looks different with the hour and `solid` with the theme, so those are in the key too.
            var key = "\(paper.id)|\(w)x\(h)"
            switch paper {
            case .scene(.solid): key += "|" + Paper.hex(background)
            case .scene(let s):
                var d = desktop
                d.scene = s
                key += "|" + (DesktopScene.of(d, at: date, systemDark: systemDark).map { $0.fileName(width: w, height: h) } ?? "")
            default: break
            }
            self.key = key
        }

        func draw() -> CGImage? {
            paper.image(width: width, height: height, desktop: desktop, papers: ThemeWallpaperApplier.papers.folder, at: date,
                        systemDark: systemDark, background: background)
        }
    }

    /// Draws the idle paper off the main thread when what it is drawn from has changed, so the cover comes up with it
    /// ready. Cheap when nothing changed: the watch calls it each look.
    private func prewarm() {
        guard let job = PaperJob() else { paperCache = nil; return }
        guard paperCache?.key != job.key, paperDrawing != job.key else { return }
        paperDrawing = job.key
        paperQueue.async { [weak self] in
            let image = job.draw()
            DispatchQueue.main.async {
                guard let self else { return }
                if self.paperDrawing == job.key { self.paperDrawing = nil }
                if PaperJob()?.key == job.key { self.paperCache = (job.key, image) }
            }
        }
    }

    /// The idle paper for the cover now: the drawn one when it is current, else drawn here once for every screen.
    private func paperImage() -> CGImage? {
        guard let job = PaperJob() else { return nil }
        if let c = paperCache, c.key == job.key { return c.image }
        let image = job.draw()
        paperCache = (job.key, image)
        return image
    }

    /// Comes up when the time has come and nothing is keeping the display awake.
    private func look() {
        let settings = SurfacesStore.shared.current.idle
        guard !isUp, settings.enabled else { return }
        prewarm()
        let idle = Self.idleSeconds()
        guard IdleScreen.shouldStart(idle: idle, settings: settings, displayHeldAwake: Self.displayHeldAwake(),
                                     systemHasScreen: screenSaverRunning || Self.locked() || Self.displaysAsleep()) else { return }
        show(idle: idle)
    }

    /// Puts the cover up now, whatever the time since the last input.
    func show(idle: TimeInterval = IdleCover.idleSeconds()) {
        // With no screen there is no window to take away, so the hidden cursor and the monitor would stay.
        guard !isUp, !NSScreen.screens.isEmpty else { return }
        let settings = SurfacesStore.shared.current.idle
        let name = Self.machineName()
        let paper = paperImage()
        for screen in NSScreen.screens {
            let w = CoverWindow(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            w.becomesKeyOnlyIfNeeded = false
            w.level = .screenSaver
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            w.isOpaque = true
            w.backgroundColor = .black
            w.hidesOnDeactivate = false
            w.isReleasedWhenClosed = false
            w.animationBehavior = .none
            w.setFrame(screen.frame, display: false)
            w.contentView = NSHostingView(rootView: IdleView(settings: settings, machine: name, size: screen.frame.size,
                                                             backdrop: paper ?? Self.backdrop(settings, size: screen.frame.size, scale: screen.backingScaleFactor)))
            w.alphaValue = 0
            w.orderFrontRegardless()
            windows.append(w)
        }
        // A non-activating panel takes the keyboard without Polycarp becoming the active app, which a timer can't
        // count on from behind another app, so the waking key reaches the monitor below.
        windows.first?.makeKey()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(1.2, .panelIn)
            for w in windows { w.animator().alphaValue = 1 }
        }
        if !cursorHidden { NSCursor.hide(); cursorHidden = true }
        // The key or click that wakes it goes nowhere else.
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]) { [weak self] _ in
            self?.hide()
            return nil
        }
        lastIdle = idle
        let t = Timer(timeInterval: IdleScreen.wakeInterval, repeats: true) { [weak self] _ in self?.checkInput() }
        RunLoop.main.add(t, forMode: .common)
        wake = t
        Trace.log("idle: up (\(settings.style.rawValue), \(windows.count) screen\(windows.count == 1 ? "" : "s"))")
    }

    /// A move of the pointer, or input that reached another process first, shows as the idle time going down.
    private func checkInput() {
        let idle = Self.idleSeconds()
        if IdleScreen.inputSince(lastIdle: lastIdle, idle: idle) { hide(); return }
        lastIdle = idle
    }

    /// Seconds since the last keyboard, mouse or trackpad input: IOHIDSystem's HIDIdleTime, the same value
    /// `ioreg -c IOHIDSystem` prints. 0 when it can't be read.
    static func idleSeconds() -> TimeInterval {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
        guard service != 0 else { return 0 }
        defer { IOObjectRelease(service) }
        guard let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? NSNumber else { return 0 }
        return value.doubleValue / 1_000_000_000
    }

    func hide() {
        guard isUp else { return }
        wake?.invalidate()
        wake = nil
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        for w in windows { w.orderOut(nil) }
        windows = []
        if cursorHidden { NSCursor.unhide(); cursorHidden = false }
        Trace.log("idle: down")
    }

    /// Whether any app holds the display awake (`PreventUserIdleDisplaySleep`): video playback and calls do.
    static func displayHeldAwake() -> Bool {
        var status: Unmanaged<CFDictionary>?
        guard IOPMCopyAssertionsStatus(&status) == kIOReturnSuccess, let dict = status?.takeRetainedValue() as? [String: Any] else { return false }
        return (dict[kIOPMAssertPreventUserIdleDisplaySleep as String] as? Int ?? 0) > 0
    }

    /// Whether the session's screen is locked.
    static func locked() -> Bool {
        (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
    }

    /// Whether every display is asleep.
    static func displaysAsleep() -> Bool {
        let ids = NSScreen.screens.compactMap { $0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID }
        return !ids.isEmpty && ids.allSatisfy { CGDisplayIsAsleep($0) != 0 }
    }

    /// The name in Sharing settings, read without the network lookup `Host` can make.
    static func machineName() -> String {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ProcessInfo.processInfo.hostName
    }

    /// The picture behind the words without a paper, dimmed: the field style's desktop scene in its light now, without
    /// its own verse. Nil for the other styles, or when the desktop isn't a scene, which then shows the night sky. The
    /// idle screen's paper (`idle.paper`, else `paper`), when one is set and draws, comes first in any style
    /// (`paperImage`).
    static func backdrop(_ settings: Surfaces.Idle, size: CGSize, scale: CGFloat) -> CGImage? {
        guard settings.style == .field, var scene = DesktopScene.of(SurfacesStore.shared.current.desktop, at: Date(), systemDark: Appearance.systemDark) else { return nil }
        scene.verse = nil
        return scene.image(width: Int(size.width * scale), height: Int(size.height * scale))
    }
}

/// Takes the keyboard while the cover is up, without activating Polycarp, so a key that wakes it is swallowed here
/// and the app in front keeps its place.
private final class CoverWindow: NSPanel {
    override var canBecomeKey: Bool { true }
}

private func color(_ c: RGB, _ opacity: Double = 1) -> Color { Color(nsColor: c.nsColor).opacity(opacity) }

/// One screen of the idle screen. Sizes follow the screen's height, so it reads the same on a laptop and a large display.
struct IdleView: View {
    let settings: Surfaces.Idle
    let machine: String
    let size: CGSize
    let backdrop: CGImage?
    /// A fixed time for renders; nil follows the clock.
    var at: Date?

    private var colors: IdleScreen.Colors { .of(settings.style, look: Chrome.look, overPicture: backdrop != nil) }
    private var embers: Bool { settings.effects && [.martyrNight, .theme].contains(settings.style) }
    private var moving: Bool { embers && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && at == nil }

    var body: some View {
        ZStack {
            background
            if let at { words(at) } else {
                TimelineView(.everyMinute) { ctx in words(ctx.date) }
            }
        }
        .frame(width: size.width, height: size.height)
        .clipped()
    }

    @ViewBuilder private var background: some View {
        if let backdrop {
            Image(decorative: backdrop, scale: 1).resizable().scaledToFill().overlay(color(colors.skyTop, 0.62))
        } else if settings.style == .verse {
            color(colors.skyTop)
        } else {
            ZStack {
                LinearGradient(colors: [color(colors.skyTop), color(colors.skyFoot)], startPoint: .top, endPoint: .bottom)
                if moving {
                    TimelineView(.animation(minimumInterval: 1 / IdleSky.framesPerSecond)) { ctx in
                        sky(t: ctx.date.timeIntervalSinceReferenceDate)
                    }
                } else {
                    sky(t: 0, embers: embers && at != nil)
                }
            }
        }
    }

    /// The words' face: the theme's display font in the `theme` style, else the system serif.
    private func serif(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        (settings.style == .theme ? Chrome.display(size) : nil) ?? .system(size: size, weight: weight, design: .serif)
    }

    private static let stars = IdleSky.stars()
    private static let embers = IdleSky.embers()

    private func sky(t: Double, embers: Bool = true) -> some View {
        Canvas { g, s in
            for star in Self.stars where colors.stars {
                let r = star.size
                g.fill(Path(ellipseIn: CGRect(x: star.x * s.width - r / 2, y: star.y * s.height - r / 2, width: r, height: r)),
                       with: .color(color(colors.text, IdleSky.twinkle(star, at: t))))
            }
            guard embers else { return }
            for e in Self.embers {
                let p = IdleSky.place(e, at: t)
                let r = e.size
                g.fill(Path(ellipseIn: CGRect(x: p.x * s.width - r / 2, y: p.y * s.height - r / 2, width: r, height: r)),
                       with: .color(color(colors.ember, p.alpha)))
            }
        }
    }

    private func words(_ date: Date) -> some View {
        let c = IdleScreen.content(settings, at: date, machine: machine, twentyFourHour: IdleScreen.usesTwentyFourHourClock)
        let h = size.height
        let shift = IdleScreen.drift(at: date)
        return ZStack {
            VStack(spacing: h * 0.018) {
                if let name = c.name {
                    Text(name).font(.system(size: h * 0.016, weight: .medium, design: .monospaced))
                        .foregroundStyle(color(colors.name)).lineLimit(1)
                }
                if let time = c.time {
                    Text(time).font(serif(h * 0.15, .light)).monospacedDigit()
                        .foregroundStyle(color(colors.text)).lineLimit(1)
                }
                if let verse = c.verse {
                    VStack(spacing: h * 0.01) {
                        Text("\u{201C}\(verse.text)\u{201D}").font(serif(h * (c.time == nil ? 0.034 : 0.024)).italic())
                            .foregroundStyle(color(colors.muted)).multilineTextAlignment(.center).lineSpacing(h * 0.006)
                        Text("\(verse.ref.uppercased())  \u{00B7}  BSB").font(.system(size: h * 0.011, weight: .semibold)).tracking(h * 0.0012)
                            .foregroundStyle(color(colors.faint))
                    }
                    .frame(maxWidth: size.width * (c.time == nil ? 0.56 : 0.46))
                    .padding(.top, h * 0.01)
                }
            }
            .offset(x: shift.x, y: shift.y - h * 0.02)
            if let line = c.line {
                Text(line.text + " (Kierkegaard)").font(serif(h * 0.015).italic())
                    .foregroundStyle(color(colors.faint)).lineLimit(2)
                    .frame(maxWidth: size.width * 0.6, alignment: .leading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(.horizontal, h * 0.04).padding(.bottom, h * 0.035)
                    .offset(x: shift.x * 0.5, y: shift.y * 0.5)
            }
        }
    }
}
