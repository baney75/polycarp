import AppKit
import Carbon.HIToolbox

/// System-wide shortcuts through RegisterEventHotKey. A registered shortcut never reaches the
/// front app. Like every global shortcut on macOS, it stops while an app holds Secure Input.
final class Hotkeys {
    private var refs: [EventHotKeyRef] = []
    private var actions: [UInt32: () -> Void] = [:]
    /// Chords that act only once held (the recovery chord): how long, and the hold waiting for its key to come up.
    private var holds: [UInt32: TimeInterval] = [:]
    private var holding: [UInt32: DispatchWorkItem] = [:]
    private var handler: EventHandlerRef?
    private static var shared: Hotkeys?

    static let digitKeyCodes = [kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5,
                                kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9]

    init() {
        Hotkeys.shared = self
        var specs = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                     EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            // The session engine registers its own shortcuts under other signatures; those aren't ours.
            guard id.signature == OSType(0x42414E59) else { return OSStatus(eventNotHandledErr) }
            let down = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            DispatchQueue.main.async { Hotkeys.shared?.fire(id.id, down: down) }
            return noErr
        }, 2, &specs, nil, &handler)
    }

    private func fire(_ id: UInt32, down: Bool) {
        guard let seconds = holds[id] else { if down { actions[id]?() }; return }
        guard down else { holding.removeValue(forKey: id)?.cancel(); return }
        // A held key can repeat its press; the first one starts the wait.
        guard holding[id] == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.holding[id] = nil
            self?.actions[id]?()
        }
        holding[id] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func removeAll() {
        refs.forEach { UnregisterEventHotKey($0) }
        refs.removeAll()
        actions.removeAll()
        holds.removeAll()
        holding.values.forEach { $0.cancel() }
        holding.removeAll()
    }

    /// A chord that acts only after it is held down for `seconds`; letting go sooner does nothing.
    @discardableResult
    func registerHold(keyCode: Int, modifiers: Int, seconds: TimeInterval, _ action: @escaping () -> Void) -> Bool {
        guard register(keyCode: keyCode, modifiers: modifiers, action) else { return false }
        holds[UInt32(actions.count)] = seconds
        return true
    }

    /// Returns false if macOS refused the shortcut.
    @discardableResult
    func register(keyCode: Int, modifiers: Int, _ action: @escaping () -> Void) -> Bool {
        let id = UInt32(actions.count + 1)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers),
                                         EventHotKeyID(signature: OSType(0x42414E59), id: id),
                                         GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            NSLog("Polycarp: macOS refused shortcut %d (status %d)", keyCode, status)
            return false
        }
        refs.append(ref)
        actions[id] = action
        return true
    }
}
