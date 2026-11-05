import Foundation

/// The BaneySpaces app a Mac may still have next to Polycarp. Polycarp shows one calm line about it
/// in Settings > General and never removes it by itself.
///
/// There is no Remove button yet. BaneySpaces' own uninstaller (`Contents/Resources/uninstall.sh`)
/// starts the old binary three times (`--restore-shortcuts`, `--restore-dock`, `--unregister-login`),
/// and that build has no one-copy guard, so each start would run a second copy of the old app beside
/// Polycarp. It also strips the `baneyspaces hook` entries and command links that Polycarp's
/// aliases serve. Until the old app is replaced by a build that answers those flags without
/// starting, running it is not safe while Polycarp runs.
public enum LegacyApp {
    /// Where the old app is looked for, in order.
    public static func searchFolders(home: URL) -> [URL] {
        [home.appendingPathComponent("Applications", isDirectory: true), URL(fileURLWithPath: "/Applications", isDirectory: true)]
    }

    /// The installed old app, found by its name and confirmed by its bundle ID so that an unrelated
    /// folder of that name doesn't count.
    public static func installed(in folders: [URL]) -> URL? {
        for dir in folders {
            let app = dir.appendingPathComponent(Product.Legacy.appName, isDirectory: true)
            let plist = app.appendingPathComponent("Contents/Info.plist")
            guard let data = try? Data(contentsOf: plist),
                  let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  info["CFBundleIdentifier"] as? String == Product.Legacy.bundleID else { continue }
            return app
        }
        return nil
    }

    /// The Settings line, or nil when the old app is not installed. "Imported its settings" only when the import
    /// finished; when part of it is still to come, the line says which.
    public static func line(installed: URL?, supportDir: URL) -> String? {
        guard installed != nil else { return nil }
        let base = "\(Product.Legacy.name) is still installed."
        if let left = SettingsImport.pending(in: supportDir), !left.isEmpty {
            return base + " \(Product.name) has not imported \(left.joined(separator: ", ")) yet and will try again the next time it starts."
        }
        let imported = FileManager.default.fileExists(atPath: supportDir.appendingPathComponent(Product.importedMarker).path)
        return base + (imported ? " \(Product.name) imported its settings." : "")
    }
}
