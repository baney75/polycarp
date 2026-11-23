import AppKit
import BaneySpacesCore

/// Keeps macOS's own menu bar out of sight while Polycarp's bar is up (Donovan, 2026-11-23: "block the bar from coming
/// in any form"). With the macOS bar set to hide, pointing at the top edge still slid it in over Polycarp's, and a
/// pointer held off the edge didn't stop it: macOS reveals from the raw pointer events, before any event tap. So
/// Polycarp asks the window server, as yabai's `menubar_opacity 0` does, to draw that bar fully transparent, and then it
/// takes no clicks either. The window server ties the setting to Polycarp's connection: it ends when Polycarp quits or
/// crashes, so the macOS bar is never lost. Main thread only.
enum SystemMenuBar {
    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    private typealias MainConnection = @convention(c) () -> Int32
    private typealias SetInsetAndAlpha = @convention(c) (Int32, Double, Double, Float) -> Int32
    private static var hidden: Bool?

    /// Hide the macOS bar (`true`) or give it back. Asked again on every bar reload, since a display change can reset
    /// it; the trace notes only a change.
    static func hide(_ on: Bool) {
        guard let skyLight, let mc = dlsym(skyLight, "SLSMainConnectionID"), let sa = dlsym(skyLight, "SLSSetMenuBarInsetAndAlpha") else {
            if hidden != on { Trace.log("macOS menu bar: SkyLight's menu bar call is missing; it stays as macOS shows it") }
            hidden = on
            return
        }
        let cid = unsafeBitCast(mc, to: MainConnection.self)()
        let err = unsafeBitCast(sa, to: SetInsetAndAlpha.self)(cid, 0, 1, on ? 0 : 1)
        if hidden != on || err != 0 {
            Trace.log("macOS menu bar: \(on ? "hidden under Polycarp's bar" : "shown")\(err != 0 ? " (error \(err))" : "")")
        }
        hidden = on
    }
}
