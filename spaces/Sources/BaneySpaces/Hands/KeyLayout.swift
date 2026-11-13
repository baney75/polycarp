import Carbon.HIToolbox
import Foundation

/// What a key types in the Mac's current keyboard layout and in the ASCII-capable one command shortcuts use (a Russian
/// layout's cmd+c), with and without command held. Only reads the layout data; nothing is posted.
enum KeyLayout {
    /// Text Input Sources are main-thread APIs and Hands requests never run on main, so the read hops there (198 r1 first-F1).
    static func characters(_ keyCode: UInt16) -> [Character] {
        Thread.isMainThread ? read(keyCode) : DispatchQueue.main.sync { read(keyCode) }
    }

    private static func read(_ keyCode: UInt16) -> [Character] {
        let sources = [TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(), TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()]
        let command = UInt32((cmdKey >> 8) & 0xFF)
        return sources.compactMap { $0 }.flatMap { s in [0, command].compactMap { character(keyCode, modifiers: $0, in: s) } }
    }

    private static func character(_ keyCode: UInt16, modifiers: UInt32, in source: TISInputSource) -> Character? {
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        return data.withUnsafeBytes { bytes -> Character? in
            guard let layout = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
            var dead: UInt32 = 0, length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, keyCode, UInt16(kUCKeyActionDown), modifiers, UInt32(LMGetKbdType()),
                                        OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
            guard status == noErr, length > 0 else { return nil }
            return String(utf16CodeUnits: chars, count: length).first
        }
    }
}
