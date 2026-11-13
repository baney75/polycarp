import Carbon.HIToolbox
import BaneySpacesCore
import Foundation

/// What a key types in the Mac's current keyboard layout and in the ASCII-capable one command shortcuts use (a Russian
/// layout's cmd+c), with and without command held. Only reads the layout data; nothing is posted. The translation is
/// `KeyTranslation`'s, tested with Dvorak's and Russian's data.
enum KeyLayout {
    /// Text Input Sources are main-thread APIs and Hands requests never run on main, so the read hops there (198 r1 first-F1).
    static func characters(_ keyCode: UInt16) -> [Character] {
        Thread.isMainThread ? read(keyCode) : DispatchQueue.main.sync { read(keyCode) }
    }

    private static func read(_ keyCode: UInt16) -> [Character] {
        let sources = [TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(), TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()]
        return KeyTranslation.characters(keyCode, layouts: sources.compactMap { $0 }.compactMap(layoutData), keyboardType: UInt32(LMGetKbdType()))
    }

    private static func layoutData(_ source: TISInputSource) -> Data? {
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    }
}
