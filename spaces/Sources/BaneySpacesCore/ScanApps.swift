import Foundation

/// Which apps a window scan covers. Workspaces hold the windows of regular apps (the ones with a Dock icon), and the
/// list of them is cached (`RunningApps.regular`) because reading it costs about 12 ms. But an app can change its
/// activation policy while it runs, and macOS announces neither direction: no launch, quit or activation comes with it.
///
/// Silas (com.baney.silas) does both. It starts as a menu bar (accessory) app, turns regular when its window opens from
/// the menu bar, and turns accessory again when that window closes. Its window can come up without Silas activating, so
/// nothing cleared the cache: every refresh compared the window server's list for the cached apps, saw no change, and
/// skipped the scan. The window never got a workspace and stayed in sight on every workspace (2026-11-22).
public enum ScanApps {
    /// Whether the cached list of regular apps must be read again before a refresh decides nothing changed.
    /// `outsiders` are the apps drawing an app-level window on screen now that the list leaves out; `before` are the
    /// ones the last refresh saw. A new one may be an app that just turned regular. One that stays (a menu bar app's
    /// own window) costs one read when it appears, not one on every refresh.
    public static func listStale(outsiders: Set<Int32>, before: Set<Int32>) -> Bool {
        !outsiders.isSubset(of: before)
    }

    /// The apps a scan asks: every regular app, and every app still running that owns a window a workspace holds,
    /// regular or not. Silas closing its window hides it (the window server keeps it, off screen) and turns Silas
    /// accessory. Scans asked only regular apps, so Silas was never asked again, `closedWindows` never heard that the
    /// window was gone, and the window kept its workspace: Silas stayed on that workspace's dock tile, and every switch
    /// away hid Silas and every switch back showed it. Asked until it has no window there, Silas says the window is
    /// closed, and the workspace lets it go. `running` is asked only about apps outside `regular`.
    public static func covered(regular: Set<Int32>, tracked: Set<Int32>, running: (Int32) -> Bool) -> Set<Int32> {
        regular.union(tracked.subtracting(regular).filter(running))
    }
}
