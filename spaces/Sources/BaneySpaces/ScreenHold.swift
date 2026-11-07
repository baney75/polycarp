import BaneySpacesCore
import Darwin
import Foundation

/// Holds what the screen shows while a workspace switch changes several apps' windows, so the person sees one cut instead of
/// each app arriving and leaving on its own. It is SkyLight's own screen-update freeze, which the window server also ends by
/// itself if this process dies. A hold never lasts past `ScreenHoldPolicy.longest`, whatever a switch is waiting for.
enum ScreenHold {
    private typealias Connection = @convention(c) () -> Int32
    private typealias Update = @convention(c) (Int32) -> Int32

    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    private static let connection: Connection? = symbol("SLSMainConnectionID")
    private static let disable: Update? = symbol("SLSDisableUpdate")
    private static let reenable: Update? = symbol("SLSReenableUpdate")

    private static func symbol<T>(_ name: String) -> T? {
        guard let skyLight, let found = dlsym(skyLight, name) else { return nil }
        return unsafeBitCast(found, to: T.self)
    }

    private static let lock = NSLock()
    private static var held = false
    private static var generation = 0

    /// Off the main thread, because the main thread is what might be stuck when the time runs out.
    private static let watchdog = DispatchQueue(label: "polycarp.screen-hold", qos: .userInteractive)

    static func begin() {
        guard ScreenHoldPolicy.isOn, let connection, let disable, reenable != nil else { return }
        lock.lock()
        defer { lock.unlock() }
        guard !held else { return }
        guard disable(connection()) == 0 else { return }
        held = true
        generation += 1
        let mine = generation
        watchdog.asyncAfter(deadline: .now() + ScreenHoldPolicy.longest) {
            lock.lock()
            defer { lock.unlock() }
            guard held, generation == mine else { return }
            Trace.log("screen hold: ended by its time limit")
            endLocked()
        }
    }

    static func end() {
        lock.lock()
        defer { lock.unlock() }
        endLocked()
    }

    private static func endLocked() {
        guard held, let connection, let reenable else { return }
        held = false
        _ = reenable(connection())
    }
}
