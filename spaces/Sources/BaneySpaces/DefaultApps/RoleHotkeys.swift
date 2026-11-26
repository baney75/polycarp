import AppKit
import BaneySpacesCore

/// The keys that open the default apps, registered with the rest (`AppDelegate.registerShortcuts`).
enum RoleHotkeys {
    static func register(_ hotkeys: Hotkeys) {
        let store = DefaultAppsStore.shared
        store.refused = []
        for b in store.now.keys.active {
            let code = b.chord.keyCode, chordMods = b.chord.carbon
            let given = hotkeys.register(keyCode: code, modifiers: chordMods) { RoleOpener.key(b.role, new: b.new) }
            if !given { store.refused.insert(b.chord) }
        }
    }
}
