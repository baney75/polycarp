import CoreServices
import Foundation

/// What a key types, read from a keyboard layout's `uchr` data (a Text Input Source's Unicode key layout data). The
/// app's `KeyLayout` hands it the current layouts; tests hand it any layout's, so Dvorak and Russian are checked on
/// any Mac (198 r2 first-F2). Only translates; nothing is posted.
public enum KeyTranslation {
    /// UCKeyTranslate's modifier state is the Carbon modifier mask shifted right by 8: command (cmdKey, 1 << 8) is 1.
    public static let command: UInt32 = 1

    /// The characters `keyCode` types in each layout, without and with command held.
    public static func characters(_ keyCode: UInt16, layouts: [Data], keyboardType: UInt32) -> [Character] {
        layouts.flatMap { layout in [0, command].compactMap { character(keyCode, modifiers: $0, layout: layout, keyboardType: keyboardType) } }
    }

    static func character(_ keyCode: UInt16, modifiers: UInt32, layout data: Data, keyboardType: UInt32) -> Character? {
        data.withUnsafeBytes { bytes -> Character? in
            guard bytes.count >= MemoryLayout<UCKeyboardLayout>.size,
                  let layout = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
            var dead: UInt32 = 0, length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, keyCode, UInt16(kUCKeyActionDown), modifiers, keyboardType,
                                        OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
            guard status == noErr, length > 0 else { return nil }
            return String(utf16CodeUnits: chars, count: length).first
        }
    }
}
