import AppKit
import ApplicationServices
import BaneySpacesCore

/// Watches for the two full-screen gestures and hands them to `Spaces` as a fill (`FullScreenFill`). It's a real tap, because a
/// click on the green button has to not reach the app. One Accessibility hit test per plain click, capped at 30 ms so a frozen
/// app can't hold up the pointer; everything except the gestures goes straight through.
final class FullScreenGestures {
    /// Called on the main queue with the window to fill, or nil for the focused one.
    var onGesture: (WindowID?) -> Void = { _ in }

    private var tap: CFMachPort?
    private var loop: CFRunLoop?
    /// The press went to us, so its release must too, or the app sees a release with no press.
    private var swallowingUp = false
    private let hitTest: AXUIElement = {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.03)
        return system
    }()

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
                                                 fn: flags.contains(.maskSecondaryFn)) else { break }
            if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { DispatchQueue.main.async { self.onGesture(nil) } }
            return nil
        case .leftMouseDown:
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
    private func greenButtonWindow(at point: CGPoint) -> WindowID? {
        var raw: AXUIElement?
        guard AXUIElementCopyElementAtPosition(hitTest, Float(point.x), Float(point.y), &raw) == .success, let element = raw else { return nil }
        AXUIElementSetMessagingTimeout(element, 0.03)
        guard let subrole: String = element.value(kAXSubroleAttribute), subrole == FullScreenFill.buttonSubrole else { return nil }
        // A window already in native full screen keeps its own button: that's how the person leaves it.
        guard let window: AXUIElement = element.value(kAXWindowAttribute), !window.bool("AXFullScreen") else { return nil }
        return window.windowID
    }
}
