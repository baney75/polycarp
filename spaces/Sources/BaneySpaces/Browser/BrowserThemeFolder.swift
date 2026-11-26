import AppKit
import BaneySpacesCore

/// Keeps `browser-theme/` in Polycarp's folder in step with the Polycarp theme in force (`BrowserTheme`): written when the
/// theme or Dark Mode changes, removed while there is no theme, so the browser draws its own look. Polycarp Browser loads
/// it when it starts. Main thread only.
enum BrowserThemeFolder {
    static let folder = Spaces.folder.appendingPathComponent("browser-theme", isDirectory: true)

    static func sync(_ theme: PolycarpTheme?, systemDark: Bool, at folder: URL = folder) {
        let file = folder.appendingPathComponent("manifest.json")
        guard let theme else {
            if FileManager.default.fileExists(atPath: folder.path) { try? FileManager.default.removeItem(at: folder) }
            return
        }
        let data = BrowserTheme.manifest(theme, systemDark: systemDark)
        guard (try? Data(contentsOf: file)) != data else { return }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
        } catch { Trace.log("browser theme not written: \(error.localizedDescription)") }
    }
}
