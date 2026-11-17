import AppKit
import ApplicationServices
import Darwin

/// Brings a window forward through the window server itself, the way yabai and AltTab focus a window: the window
/// server makes its process the front one and posts the window its key-window events at once, and the app handles them
/// in order, before any key typed after. The Accessibility raise (`Window.focus`) asks the app instead, and a busy app
/// took up to three 100 ms timeouts to answer (`SwitchSteps`). The window server is also where the front process is
/// read first: LaunchServices reports it later, from a daemon in the background band when nothing boosts it.
/// Every call is looked up at run time, so a macOS without one falls back to the Accessibility raise.
/// `defaults write com.baney.polycarp focusThroughWindowServer -bool false` turns both off.
enum FrontProcess {
    static let defaultsKey = "focusThroughWindowServer"
    static var isOn: Bool { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }

    private typealias SetFront = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UInt32, UInt32) -> Int32
    private typealias GetFront = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>) -> Int32
    private typealias PostRecord = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutablePointer<UInt8>) -> Int32
    private typealias ForPID = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> Int32
    private typealias PIDFor = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafeMutablePointer<pid_t>) -> Int32

    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    private static let setFront: SetFront? = symbol(skyLight, "_SLPSSetFrontProcessWithOptions")
    private static let getFront: GetFront? = symbol(skyLight, "_SLPSGetFrontProcess")
    private static let postRecord: PostRecord? = symbol(skyLight, "SLPSPostEventRecordTo")
    private static let forPID: ForPID? = symbol(UnsafeMutableRawPointer(bitPattern: -2), "GetProcessForPID")
    private static let pidFor: PIDFor? = symbol(UnsafeMutableRawPointer(bitPattern: -2), "GetProcessPID")

    private static func symbol<T>(_ handle: UnsafeMutableRawPointer?, _ name: String) -> T? {
        guard let handle, let found = dlsym(handle, name) else { return nil }
        return unsafeBitCast(found, to: T.self)
    }

    /// Makes `window`'s process the front one and `window` its key window, without waiting on the app. False when it
    /// is off, a call is missing or the window server refused.
    static func bringForward(pid: pid_t, window: CGWindowID) -> Bool {
        guard isOn, let setFront, let postRecord, let forPID else { return false }
        var psn = ProcessSerialNumber()
        guard forPID(pid, &psn) == noErr, setFront(&psn, window, 0x200) == 0 else { return false }
        // The two key-window event records yabai posts (window_manager_make_key_window): 0xf8 bytes, the window number
        // at 0x3c, first 0x01 then 0x02 at 0x08.
        var record = [UInt8](repeating: 0, count: 0xf8)
        record[0x04] = 0xf8
        record[0x3a] = 0x10
        withUnsafeBytes(of: window.littleEndian) { for (i, b) in $0.enumerated() { record[0x3c + i] = b } }
        for i in 0x20..<0x30 { record[i] = 0xff }
        for step: UInt8 in [0x01, 0x02] {
            record[0x08] = step
            _ = postRecord(&psn, &record)
        }
        return true
    }

    /// The front process as the window server has it, or nil when it is off or can't say.
    static func pid() -> pid_t? {
        guard isOn, let getFront, let pidFor else { return nil }
        var psn = ProcessSerialNumber()
        var pid: pid_t = 0
        guard getFront(&psn) == 0, pidFor(&psn, &pid) == noErr, pid > 0 else { return nil }
        return pid
    }
}
