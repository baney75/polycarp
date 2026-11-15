import AppKit

/// What `agent open` hands macOS to start an app it isn't running yet: never brought forward, a copy of its own, and
/// nothing restored that the app had open (it would be Donovan's). A System Settings pane link (`SettingsPaneLink`)
/// goes as a URL the app opens, every other target as a file (#361 review, first-F1).
public struct AgentLaunchRequest: Equatable {
    public let app: URL
    public let targets: [URL]
    public let activates: Bool
    public let newInstance: Bool
    public let arguments: [String]

    public init(app: URL, paths: [String]) {
        self.app = app
        targets = AgentLaunch.targets(paths)
        activates = false
        newInstance = true
        arguments = ["-ApplePersistenceIgnoreState", "YES"]
    }

    public var configuration: NSWorkspace.OpenConfiguration {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = activates
        cfg.addsToRecentItems = false
        cfg.createsNewApplicationInstance = newInstance
        cfg.arguments = arguments
        return cfg
    }
}

public enum AgentLaunch {
    /// The gate's checked targets as URLs: a pane link as itself, anything else as a file path.
    public static func targets(_ paths: [String]) -> [URL] {
        paths.map { SettingsPaneLink.isLink($0) ? URL(string: $0) ?? URL(fileURLWithPath: $0) : URL(fileURLWithPath: $0) }
    }
}

/// The one call that starts an app for an agent, so a test can stand in for NSWorkspace.
public protocol AgentAppLauncher {
    func launch(_ request: AgentLaunchRequest, done: @escaping (NSRunningApplication?) -> Void)
}

public struct SystemAppLauncher: AgentAppLauncher {
    public init() {}
    public func launch(_ request: AgentLaunchRequest, done: @escaping (NSRunningApplication?) -> Void) {
        if request.targets.isEmpty {
            NSWorkspace.shared.openApplication(at: request.app, configuration: request.configuration) { app, _ in done(app) }
        } else {
            NSWorkspace.shared.open(request.targets, withApplicationAt: request.app, configuration: request.configuration) { app, _ in done(app) }
        }
    }
}
