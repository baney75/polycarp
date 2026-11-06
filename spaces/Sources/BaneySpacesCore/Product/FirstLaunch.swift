import Foundation

/// The in-place install step a person never ran by hand: the first launch from an Applications folder runs the bundled
/// `install-app.sh --in-place` (command links, theme if none is set, the old tools stepping aside). `AppDelegate.linkCommandIfNeeded`
/// asks this, so the rule is in one tested place.
public enum FirstLaunch {
    /// Run it when this copy is directly in /Applications or ~/Applications and the `polycarp-spaces` command link doesn't already
    /// point into this copy. Never from the disk image, Downloads, a translocated path or a build folder.
    public static func shouldRunInstallStep(bundle: URL, home: URL, commandLinkTarget: String?) -> Bool {
        guard MoveToApplications.classify(bundle: bundle, home: home) == .installed else { return false }
        if let target = commandLinkTarget, target.hasPrefix(bundle.path + "/") { return false }
        return true
    }
}
