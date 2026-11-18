import AppKit

/// Writing a launcher row's text to a pasteboard. The general pasteboard in the app; a private named
/// one in tests, so a test never reads or replaces what the user copied.
public enum LauncherPasteboard {
    /// The nspasteboard.org marker for data that is only passing through: clipboard managers skip it.
    public static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    /// Replaces the pasteboard's contents with `text`. `transient` adds the marker, for text Polycarp
    /// puts there only to paste it (a snippet), so clipboard history doesn't keep it.
    public static func copy(_ text: String, transient: Bool = false, to pb: NSPasteboard = .general) {
        pb.clearContents()
        pb.setString(text, forType: .string)
        if transient { pb.setData(Data(), forType: transientType) }
    }
}
