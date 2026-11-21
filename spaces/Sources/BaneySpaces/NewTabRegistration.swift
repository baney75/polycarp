import BaneySpacesCore
import Foundation

/// Registers the new tab page's native messaging host with Helium, Chrome and Chromium (docs/newtab.md): on launch,
/// off the main thread, it writes `com.polycarp.newtab.json` into each of their folders that exists, pointing at the
/// bundled `polycarp-spaces`. A debug build, not in a .app, registers nothing.
enum NewTabRegistration {
    static func start() {
        let bundle = Bundle.main.bundleURL
        guard bundle.pathExtension == "app", let resources = Bundle.main.resourceURL else { return }
        let cli = resources.appendingPathComponent("bin", isDirectory: true).appendingPathComponent(Product.commandName).path
        DispatchQueue.global(qos: .utility).async {
            guard FileManager.default.isExecutableFile(atPath: cli) else {
                Trace.log("newtab host: no bundled \(Product.commandName), nothing registered")
                return
            }
            let result = NewTabHost.register(cliPath: cli, home: FileManager.default.homeDirectoryForCurrentUser)
            Trace.log(result.line)
        }
    }
}
