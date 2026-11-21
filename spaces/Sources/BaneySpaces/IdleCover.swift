import AppKit
import BaneySpacesCore
import IOKit.pwr_mgt
import SwiftUI
import SystemConfiguration

/// Polycarp's idle screen (`idle.*` in surfaces.json): after `startAfterMinutes` without input, one cover on each
/// screen with the machine's name, the time, a verse and a line of Kierkegaard (`IdleScreen`). Any key, click or move
/// takes it away. It takes the keyboard while up, so the key that wakes it never lands in the app under it, and gives it
/// back to that app after. It stays away while an app keeps the display awake (a video, a call). macOS's own screen
/// saver, display sleep and lock still come in their time, over it. Main thread only.
final class IdleCover {
    static let shared = IdleCover()

    private var watch: Timer?
    private var wake: Timer?
    private var windows: [NSWindow] = []
    private var lastIdle: TimeInterval = 0
    private var previous: NSRunningApplication?
    private var monitor: Any?
    private var cursorHidden = false

    var isUp: Bool { !windows.isEmpty }

    func start() {
        guard watch == nil else { return }
        let t = Timer(timeInterval: IdleScreen.watchInterval, repeats: true) { [weak self] _ in self?.look() }
        t.tolerance = 3
        RunLoop.main.add(t, forMode: .common)
        watch = t
        NotificationCenter.default.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in
            if !SurfacesStore.shared.current.idle.enabled { self?.hide() }
        }
    }

    /// Comes up when the time has come and nothing is keeping the display awake.
    private func look() {
        guard !isUp else { return }
        let idle = PurposeKeeper.idleSeconds()
        guard IdleScreen.shouldStart(idle: idle, settings: SurfacesStore.shared.current.idle, displayHeldAwake: Self.displayHeldAwake()) else { return }
        show(idle: idle)
    }

    /// Puts the cover up now, whatever the time since the last input.
    func show(idle: TimeInterval = PurposeKeeper.idleSeconds()) {
        guard !isUp else { return }
        let settings = SurfacesStore.shared.current.idle
        let front = NSWorkspace.shared.frontmostApplication
        previous = front?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : front
        let name = Self.machineName()
        for screen in NSScreen.screens {
            let w = CoverWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            w.level = .screenSaver
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            w.isOpaque = true
            w.backgroundColor = .black
            w.hidesOnDeactivate = false
            w.isReleasedWhenClosed = false
            w.animationBehavior = .none
            w.setFrame(screen.frame, display: false)
            w.contentView = NSHostingView(rootView: IdleView(settings: settings, machine: name, size: screen.frame.size,
                                                             backdrop: Self.backdrop(settings, size: screen.frame.size, scale: screen.backingScaleFactor)))
            w.alphaValue = 0
            w.orderFrontRegardless()
            windows.append(w)
        }
        NSApp.activate(ignoringOtherApps: true)
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
        let idle = PurposeKeeper.idleSeconds()
        if IdleScreen.inputSince(lastIdle: lastIdle, idle: idle) { hide(); return }
        lastIdle = idle
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
        previous?.activate()
        previous = nil
        Trace.log("idle: down")
    }

    /// Whether any app holds the display awake (`PreventUserIdleDisplaySleep`): video playback and calls do.
    static func displayHeldAwake() -> Bool {
        var status: Unmanaged<CFDictionary>?
        guard IOPMCopyAssertionsStatus(&status) == kIOReturnSuccess, let dict = status?.takeRetainedValue() as? [String: Any] else { return false }
        return (dict[kIOPMAssertPreventUserIdleDisplaySleep as String] as? Int ?? 0) > 0
    }

    /// The name in Sharing settings, read without the network lookup `Host` can make.
    static func machineName() -> String {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ProcessInfo.processInfo.hostName
    }

    /// The field style's picture: the desktop scene in its light now, without its own verse. Nil for the other styles,
    /// or when the desktop isn't a scene, which then shows the night sky.
    static func backdrop(_ settings: Surfaces.Idle, size: CGSize, scale: CGFloat) -> CGImage? {
        guard settings.style == .field, var scene = DesktopScene.of(SurfacesStore.shared.current.desktop, at: Date(), systemDark: Appearance.systemDark) else { return nil }
        scene.verse = nil
        return scene.image(width: Int(size.width * scale), height: Int(size.height * scale))
    }
}

/// Takes the keyboard while the cover is up, so a key that wakes it is swallowed here.
private final class CoverWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

private func color(_ hex: UInt32, _ opacity: Double = 1) -> Color {
    Color(.sRGB, red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
}

/// One screen of the idle screen. Sizes follow the screen's height, so it reads the same on a laptop and a large display.
struct IdleView: View {
    let settings: Surfaces.Idle
    let machine: String
    let size: CGSize
    let backdrop: CGImage?
    /// A fixed time for renders; nil follows the clock.
    var at: Date?

    private var moving: Bool { settings.effects && settings.style == .martyrNight && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && at == nil }

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
            Image(decorative: backdrop, scale: 1).resizable().scaledToFill().overlay(color(IdleScreen.Night.skyTop, 0.62))
        } else if settings.style == .verse {
            color(IdleScreen.Night.skyTop)
        } else {
            ZStack {
                LinearGradient(colors: [color(IdleScreen.Night.skyTop), color(IdleScreen.Night.skyFoot)], startPoint: .top, endPoint: .bottom)
                if moving {
                    TimelineView(.animation(minimumInterval: 1 / IdleSky.framesPerSecond)) { ctx in
                        sky(t: ctx.date.timeIntervalSinceReferenceDate)
                    }
                } else {
                    sky(t: 0, embers: settings.style == .martyrNight && at != nil && settings.effects)
                }
            }
        }
    }

    private static let stars = IdleSky.stars()
    private static let embers = IdleSky.embers()

    private func sky(t: Double, embers: Bool = true) -> some View {
        Canvas { g, s in
            for star in Self.stars {
                let r = star.size
                g.fill(Path(ellipseIn: CGRect(x: star.x * s.width - r / 2, y: star.y * s.height - r / 2, width: r, height: r)),
                       with: .color(color(IdleScreen.Night.text, IdleSky.twinkle(star, at: t))))
            }
            guard embers else { return }
            for e in Self.embers {
                let p = IdleSky.place(e, at: t)
                let r = e.size
                g.fill(Path(ellipseIn: CGRect(x: p.x * s.width - r / 2, y: p.y * s.height - r / 2, width: r, height: r)),
                       with: .color(color(IdleScreen.Night.ember, p.alpha)))
            }
        }
    }

    private func words(_ date: Date) -> some View {
        let c = IdleScreen.content(settings, at: date, machine: machine, twentyFourHour: MenuNow.usesTwentyFourHourClock)
        let h = size.height
        let shift = IdleScreen.drift(at: date)
        return ZStack {
            VStack(spacing: h * 0.018) {
                if let name = c.name {
                    Text(name).font(.system(size: h * 0.016, weight: .medium, design: .monospaced))
                        .foregroundStyle(color(IdleScreen.Night.gold)).lineLimit(1)
                }
                if let time = c.time {
                    Text(time).font(.system(size: h * 0.15, weight: .light, design: .serif)).monospacedDigit()
                        .foregroundStyle(color(IdleScreen.Night.text)).lineLimit(1)
                }
                if let verse = c.verse {
                    VStack(spacing: h * 0.01) {
                        Text("\u{201C}\(verse.text)\u{201D}").font(.system(size: h * (c.time == nil ? 0.034 : 0.024), design: .serif).italic())
                            .foregroundStyle(color(IdleScreen.Night.muted)).multilineTextAlignment(.center).lineSpacing(h * 0.006)
                        Text("\(verse.ref.uppercased())  \u{00B7}  BSB").font(.system(size: h * 0.011, weight: .semibold)).tracking(h * 0.0012)
                            .foregroundStyle(color(IdleScreen.Night.faint))
                    }
                    .frame(maxWidth: size.width * (c.time == nil ? 0.56 : 0.46))
                    .padding(.top, h * 0.01)
                }
            }
            .offset(x: shift.x, y: shift.y - h * 0.02)
            if let line = c.line {
                Text(line.text + " (Kierkegaard)").font(.system(size: h * 0.015, design: .serif).italic())
                    .foregroundStyle(color(IdleScreen.Night.faint)).lineLimit(2)
                    .frame(maxWidth: size.width * 0.6, alignment: .leading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(.horizontal, h * 0.04).padding(.bottom, h * 0.035)
                    .offset(x: shift.x * 0.5, y: shift.y * 0.5)
            }
        }
    }
}
