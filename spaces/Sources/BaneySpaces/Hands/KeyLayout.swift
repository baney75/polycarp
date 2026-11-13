import Carbon
import Foundation

/// What a key types in the Mac's current keyboard layout and in the ASCII-capable one command shortcuts use (a Russian
/// layout's cmd+c). Only reads the layout data; nothing is posted.
enum KeyLayout {
    static func characters(_ keyCode: UInt16) -> [Character] {
        let sources = [TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(), TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()]
        return sources.compactMap { $0.flatMap { character(keyCode, in: $0) } }
    }

    static func character(_ keyCode: UInt16, in source: TISInputSource) -> Character? {
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        return data.withUnsafeBytes { bytes -> Character? in
            guard let layout = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
            var dead: UInt32 = 0, length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, keyCode, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
            guard status == noErr, length > 0 else { return nil }
            return String(utf16CodeUnits: chars, count: length).first
        }
    }
}
