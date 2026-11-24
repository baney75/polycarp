import Foundation

// The browser extension and its helper were removed from Polycarp, and Polycarp.app no longer carries them. This file
// stays because a test outside this repo reads `BrowserBundle.bundleIDs` from it. Everything Settings > Browser used left
// with the extension.

public enum BrowserBundle {
    /// Each browser's bundle identifier, for finding its app wherever it lives. The same ids the old helper used to tell
    /// whether a browser is installed (`MAC_BUNDLE_IDS`).
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
