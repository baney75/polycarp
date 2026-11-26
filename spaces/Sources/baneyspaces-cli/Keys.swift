import BaneySpacesCore
import Foundation

/// `polycarp-spaces keys`: every Polycarp shortcut, with this Mac's modifier read where the app keeps it (the "modifier"
/// default in the app's domain) and the tiling keys as surfaces.json has them. Works with the app running or not. `--json` is an array of
/// {id, keys, display, title, group, scope}, which `polycarp mcp`'s `keys_list` wraps in its envelope.
enum KeysCommand {
    static let usage = """
    usage: polycarp-spaces keys [--json | --markdown]

      (none)       every shortcut, grouped like a cheat sheet, with your modifier
      --json       the same as an array of {id, keys, display, title, group, scope}; in keys, "mod" is your modifier
      --markdown   the tables docs/keys.md holds (with ⌘ for the modifier)
    """

    /// The app's modifier setting, read the way the app reads it: `Modifier.current`, in the app's own domain.
    static var modifierSetting: String? {
        CFPreferencesCopyAppValue("modifier" as CFString, Product.bundleID as CFString) as? String
    }

    /// The shortcuts as surfaces.json has them; with no file, or one that doesn't read, as Polycarp comes.
    static var rows: [KeyBinding] {
        if case .document(let d) = SurfacesFile.load(path: SurfacesFile.path()) { return Keymap.rows(d.surfaces) }
        return Keymap.rows(.defaults)
    }

    static func run(_ args: [String], remote: Bool) -> Never {
        if remote { fail("keys reads this Mac's settings; run it on the other machine", code: 2) }
        let symbol = Keymap.modifierSymbol(setting: modifierSetting)
        switch args {
        case []: print(Keymap.cheatSheet(modifierSymbol: symbol, rows: rows))
        case ["--json"]: print(Keymap.json(modifierSymbol: symbol, rows: rows))
        case ["--markdown"]: print(Keymap.markdown())
        case ["help"], ["-h"], ["--help"]: print(usage)
        default: fail(usage, code: 2)
        }
        exit(0)
    }
}
