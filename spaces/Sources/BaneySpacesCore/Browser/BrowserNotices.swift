import Foundation

/// A browser's part of the notification list: the site a web notification is from, and a download that finished.
public enum BrowserNotices {
    /// The site a banner from this browser names, which Chromium puts in the subtitle. Its alerts come from a helper of its
    /// own. Nil for another app's banner, and for one that names no site (the browser's own, an extension's).
    public static func site(_ b: NoticeBanner, from bundleID: String) -> String? {
        guard let bundle = b.bundle, bundle == bundleID || bundle.hasPrefix(bundleID + ".framework.") else { return nil }
        let host = BrowserMessage.site("https://" + b.subtitle)
        let letters = host.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "-" }
        return letters && host.contains(".") && !host.hasPrefix(".") && !host.hasSuffix(".") ? host : nil
    }

    /// The entry for a download that finished.
    public static func done(_ f: BrowserWindows.Front, app: String) -> NoticeBanner {
        NoticeBanner(app: app, bundle: f.peer.bundleID, title: f.tab.title, subtitle: "Downloaded", body: f.tab.site, path: [])
    }
}
