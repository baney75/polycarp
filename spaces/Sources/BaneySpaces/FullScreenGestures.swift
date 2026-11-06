import AppKit
import ApplicationServices
import BaneySpacesCore

/// Watches for the two full-screen gestures and hands them to `Spaces` as a fill (`FullScreenFill`). It's a real tap, because a
/// click on the green button has to not reach the app. Ordinary clicks cost one read of the window server and no call to any
/// app; only a click in a window's top-left corner asks the app what's there. Everything except the gestures goes straight
/// through.
final class FullScreenGestures {
    /// Called on the main queue with the window to fill, or nil for the focused one.
    var onGesture: (AXUIElement?) -> Void = { _ in }

    private var tap: CFMachPort?
    private var loop: CFRunLoop?
    /// The press went to us, so its release must too, or the app sees a release with no press.
    private var swallowingUp = false
    /// One for the whole process: setting a timeout on it would change every Accessibility call's, so it keeps the app's.
    private let systemWide = AXUIElementCreateSystemWide()

    static var isEnabled: Bool { FullScreenFill.isEnabled(stored: UserDefaults.standard.object(forKey: FullScreenFill.enabledKey)) }

    func start() {
        guard tap == nil else { return }
        let mask = (CGEventMask(1) << CGEventType.leftMouseDown.rawValue) | (CGEventMask(1) << CGEventType.leftMouseUp.rawValue)
            | (CGEventMask(1) << CGEventType.keyDown.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        let thread = Thread { [self] in
            guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
                                               callback: { _, type, event, info in
                                                   guard let info else { return Unmanaged.passUnretained(event) }
                                                   return Unmanaged<FullScreenGestures>.fromOpaque(info).takeUnretainedValue().handle(type, event)
                                               }, userInfo: me) else {
                return NSLog("Polycarp: could not watch the full-screen gestures")
            }
            tap = port
            loop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(loop, CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0), .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        thread.name = "Polycarp full-screen gestures"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // A release that came while the tap was off will never arrive here.
            swallowingUp = false
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard Self.isEnabled else { return Unmanaged.passUnretained(event) }
        let flags = event.flags
        switch type {
        case .keyDown:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            guard FullScreenFill.isFullScreenKey(code: code, control: flags.contains(.maskControl), command: flags.contains(.maskCommand),
                                                 shift: flags.contains(.maskShift), option: flags.contains(.maskAlternate),
                                                 fn: flags.contains(.maskSecondaryFn)),
                  // In native full screen this key is how you leave it, so it goes to macOS.
                  !Windows.frontIsFullScreen() else { break }
            if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { DispatchQueue.main.async { self.onGesture(nil) } }
            return nil
        case .leftMouseDown:
            swallowingUp = false
            guard FullScreenFill.isPlainClick(command: flags.contains(.maskCommand), control: flags.contains(.maskControl),
                                              shift: flags.contains(.maskShift), option: flags.contains(.maskAlternate)),
                  let window = greenButtonWindow(at: event.location) else { break }
            swallowingUp = true
            DispatchQueue.main.async { self.onGesture(window) }
            return nil
        case .leftMouseUp:
            if swallowingUp {
                swallowingUp = false
                return nil
            }
        default:
            break
        }
        return Unmanaged.passUnretained(event)
    }

    /// The window whose green button is under the pointer, if one is.
    private func greenButtonWindow(at point: CGPoint) -> AXUIElement? {
        guard Self.isInTopWindowsCorner(point) else { return nil }
        var raw: AXUIElement?
        guard AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &raw) == .success, let element = raw else { return nil }
        AXUIElementSetMessagingTimeout(element, 0.05)
        guard let subrole: String = element.value(kAXSubroleAttribute), subrole == FullScreenFill.buttonSubrole else { return nil }
        // A window already in native full screen keeps its own button: that's how the person leaves it.
        guard let window: AXUIElement = element.value(kAXWindowAttribute), !window.bool("AXFullScreen") else { return nil }
        return window
    }

    /// From the window server only, so a frozen app can't slow this: the topmost ordinary window under the point, and whether
    /// the point is in its traffic-light corner.
    private static func isInTopWindowsCorner(_ point: CGPoint) -> Bool {
        let onScreen = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for info in onScreen where (info[kCGWindowLayer as String] as? Int) == 0 {
            guard let box = info[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: box),
                  bounds.contains(point) else { continue }
            return FullScreenFill.isInButtonCorner(point, window: bounds)
        }
        return false
    }
}
