import Foundation

// The browser extension and its helper moved to Tychicus (https://github.com/baney75/tychicus), and Polycarp.app no longer
// carries them. This file stays because Tychicus's tests read `BrowserBundle.bundleIDs` from it; `BrowserBundle.helper`
// points at Tychicus's own install. Everything Settings > Browser used left with it.

public enum BrowserBundle {
    /// Where the browser helper lives now: Tychicus.
    public static let home = URL(string: "https://github.com/baney75/tychicus")!

    /// The helper a Tychicus release install puts in place (`tychicus install --release`): the `release` link under
    /// `~/.local/share/tychicus`. Polycarp.app no longer carries a helper.
    public static func helper(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent(".local/share/tychicus/release/tychicus")
    }

    /// Each browser's bundle identifier, for finding its app wherever it lives. The same ids the helper uses to tell whether a
    /// browser is installed (`MAC_BUNDLE_IDS` in Tychicus's cli/src/install.ts); a Tychicus test keeps the two lists equal.
    public static let bundleIDs: [String: String] = [
        "Helium": "net.imput.helium",
        "Chrome": "com.google.Chrome",
        "Chrome Beta": "com.google.Chrome.beta",
        "Chrome Canary": "com.google.Chrome.canary",
        "Chromium": "org.chromium.Chromium",
        "Brave": "com.brave.Browser",
        "Edge": "com.microsoft.edgemac",
        "Arc": "company.thebrowser.Browser",
        "Vivaldi": "com.vivaldi.Vivaldi",
        "Opera": "com.operasoftware.Opera",
    ]
    public static func bundleID(for browser: String) -> String? { bundleIDs[browser] }
}
