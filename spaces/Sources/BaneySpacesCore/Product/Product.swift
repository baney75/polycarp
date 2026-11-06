import Foundation

/// What the app is called and where it keeps things. The one place the names live, so a rename
/// is a change here and in `scripts/product.env`, and a test keeps the two equal.
///
/// The Swift modules keep the name BaneySpaces; only what a person or another program sees changed.
public enum Product {
    public static let name = "Polycarp"
    public static let bundleID = "com.baney.polycarp"
    /// The folder under ~/Library/Application Support.
    public static let supportFolder = "Polycarp"
    public static let socketName = "polycarp.sock"
    public static let lockName = "polycarp.lock"
    /// Marks that the first-launch import ran (see `SettingsImport`).
    public static let importedMarker = "imported"
    /// The bundled command, and the older names that still run it. Agents and hooks on other
    /// machines call these, so they stay.
    public static let commandName = "polycarp-spaces"
    public static let commandAliases = ["baneyspaces", "ghostdeck"]

    /// The app this one replaces. Migration code and nothing else reads these.
    public enum Legacy {
        public static let name = "BaneySpaces"
        public static let bundleID = "com.baney.baneyspaces"
        public static let supportFolder = "BaneySpaces"
        public static let socketNames = ["baneyspaces.sock", "deck.sock"]
        public static let appName = "BaneySpaces.app"
    }

    /// Silas, the dictation app whose voice is now inside Polycarp. Migration code and the old-app notice read these.
    public enum Silas {
        public static let name = "Silas"
        public static let bundleID = "com.baney.silas"
        public static let supportFolder = "Silas"
        public static let appName = "Silas.app"
    }

    public static func supportDir(home: URL) -> URL {
        home.appendingPathComponent("Library/Application Support/" + supportFolder, isDirectory: true)
    }

    /// Where the voice engine keeps its settings, dictionary, history and models.
    public static func voiceDir(home: URL) -> URL {
        supportDir(home: home).appendingPathComponent("voice", isDirectory: true)
    }

    public static func silasSupportDir(home: URL) -> URL {
        home.appendingPathComponent("Library/Application Support/" + Silas.supportFolder, isDirectory: true)
    }

    public static func legacySupportDir(home: URL) -> URL {
        home.appendingPathComponent("Library/Application Support/" + Legacy.supportFolder, isDirectory: true)
    }
}
