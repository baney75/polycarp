import AppKit
import BaneySpacesCore
import IOKit.ps
import IOKit.pwr_mgt

/// The wake alarm (`alarm.*` in surfaces.json, off by default). At `alarm.wakeAt` on the days `alarm.days` allows it
/// lights the display, takes the idle screen down, plays Glass once a minute up to five times until any input, and opens
/// the morning question if it hasn't been given today (`Alarm`). With `alarm.keepAwake` on and the Mac on power, it holds
/// off idle sleep for the last hour so the ring can come. It re-arms at launch, on a change to surfaces.json, on wake
/// from sleep and when the time zone changes. It never writes a system setting. Main thread only.
final class WakeAlarm {
    static let shared = WakeAlarm()

    private static let holdName = "Polycarp wake alarm" as CFString
    /// How often the hold is looked at again (power plugged in or out, the last hour starting).
    private static let holdLook: TimeInterval = 60
    /// How often input is looked for while it rings: the idle screen's pace.
    private static let ringLook: TimeInterval = IdleScreen.wakeInterval

    private var started = false
    private var next: Date?
    private var armedLine: String?
    private var ringTimer: Timer?
    private var holdTimer: Timer?
    private var stepTimer: Timer?
    private var ringing: Alarm.Ringing?
    private var sound: NSSound?
    private var lastIdle: TimeInterval = 0
    /// `kIOPMAssertPreventUserIdleSystemSleep` while held; 0 when not.
    private var hold: IOPMAssertionID = 0
    /// The user activity declared at the ring; 0 when none.
    private var activity: IOPMAssertionID = 0

    func start() {
        guard !started else { return }
        started = true
        let center = NotificationCenter.default
        center.addObserver(forName: SurfacesStore.didChange, object: nil, queue: .main) { [weak self] _ in self?.arm() }
        center.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { [weak self] _ in self?.arm() }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.arm()
        }
        let t = Timer(timeInterval: Self.holdLook, repeats: true) { [weak self] _ in self?.updateHold() }
        t.tolerance = 5
        RunLoop.main.add(t, forMode: .common)
        holdTimer = t
        arm()
    }

    /// Sets the run loop timer for the next ring, or none with `alarm.wake` off, and looks at the hold again.
    private func arm() {
        ringTimer?.invalidate()
        ringTimer = nil
        let now = Date()
        next = Alarm.nextRing(after: now, settings: SurfacesStore.shared.current.alarm, clock: DayClock())
        // One line each time the armed time changes; a change to another part of surfaces.json re-arms the same time.
        let line = next.map { "wake alarm: armed for \(Self.stamp($0))" } ?? "wake alarm: off"
        if line != armedLine, armedLine != nil || next != nil { Trace.log(line) }
        armedLine = line
        if let at = next {
            let t = Timer(fire: at, interval: 0, repeats: false) { [weak self] _ in self?.fire(scheduled: at) }
            t.tolerance = 1
            RunLoop.main.add(t, forMode: .common)
            ringTimer = t
        }
        updateHold()
    }

    private func fire(scheduled: Date) {
        let now = Date()
        // A timer held over a sleep fires on wake: past its minute it is a missed alarm, not one to play now.
        if Alarm.ringsNow(scheduled: scheduled, now: now), ringing == nil { ring(at: now) } else if ringing == nil {
            Trace.log("wake alarm: missed \(Self.stamp(scheduled)); the Mac was asleep")
        }
        armedLine = nil
        arm()
    }

    private func ring(at now: Date) {
        var id: IOPMAssertionID = 0
        if IOPMAssertionDeclareUserActivity(Self.holdName, kIOPMUserActiveLocal, &id) == kIOReturnSuccess { activity = id }
        if IdleCover.shared.isUp { IdleCover.shared.hide() }
        ringing = Alarm.Ringing(startedAt: now)
        lastIdle = PurposeKeeper.idleSeconds()
        step()
        let t = Timer(timeInterval: Self.ringLook, repeats: true) { [weak self] _ in self?.step() }
        RunLoop.main.add(t, forMode: .common)
        stepTimer = t
        let keeper = PurposeKeeper.shared
        if Alarm.opensMorningCard(state: keeper.rhythm, today: keeper.ledger.dayClock.day(of: now)) {
            RhythmSheet.shared.show(.morningQuestion)
        }
    }

    /// One look while ringing: input since the last look stops it; otherwise a ring when the next minute has come.
    private func step() {
        guard var r = ringing else { return }
        let idle = PurposeKeeper.idleSeconds()
        let input = IdleScreen.inputSince(lastIdle: lastIdle, idle: idle)
        lastIdle = idle
        let s = r.step(now: Date(), inputSince: input)
        ringing = r
        if s.ring {
            sound?.stop()
            sound = NSSound(named: "Glass")
            sound?.play()
            Trace.log("wake alarm: ring \(r.rings) of \(Alarm.Ringing.limit)")
        }
        if s.done { finish(r) }
    }

    private func finish(_ r: Alarm.Ringing) {
        stepTimer?.invalidate()
        stepTimer = nil
        if r.stopped { sound?.stop() }
        sound = nil
        ringing = nil
        if activity != 0 { IOPMAssertionRelease(activity); activity = 0 }
        Trace.log(r.stopped ? "wake alarm: stopped by input after \(r.rings) ring\(r.rings == 1 ? "" : "s")" : "wake alarm: done after \(r.rings) rings")
        updateHold()
    }

    /// Holds off idle sleep while `Alarm.shouldHoldAwake` says so, and while it rings; lets go otherwise.
    private func updateHold() {
        let want = ringing != nil || Alarm.shouldHoldAwake(now: Date(), next: next, onPower: Self.onPower(),
                                                            settings: SurfacesStore.shared.current.alarm)
        if want, hold == 0 {
            var id: IOPMAssertionID = 0
            if IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                           Self.holdName, &id) == kIOReturnSuccess {
                hold = id
                Trace.log("wake alarm: holding the Mac awake for the ring")
            }
        } else if !want, hold != 0 {
            IOPMAssertionRelease(hold)
            hold = 0
            Trace.log("wake alarm: hold released")
        }
    }

    /// Whether the Mac runs on power from the wall: the source IOKit says provides power now.
    static func onPower() -> Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return (type as String) == kIOPMACPowerKey
    }

    /// "2026-11-22 06:30", local.
    private static func stamp(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.string(from: d)
    }
}
