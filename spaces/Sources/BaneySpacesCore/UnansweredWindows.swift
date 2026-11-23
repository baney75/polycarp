import Foundation

/// Windows a switch finds on screen that no workspace holds because their app didn't answer the last scan.
///
/// Finder answers its first Accessibility question slowly right after the launcher opens it: trace.log on 2026-11-22
/// has "Finder didn't answer (AXFocusedWindow: timeout); asked again in 5.0s" then "slow scan: windows+1-0; missed:
/// Finder" a second after each launcher open. For those 5 s Finder isn't asked, so its new window has no workspace. A
/// switch then neither took the window along nor kept Finder in sight for it: the window stayed on screen over the next
/// workspace and, once Finder answered, joined that one (21:16:10 open, 21:16:14 switch to 1, 21:16:24 Donovan dragged
/// window 118609, 920x436, back to tile 2). When Finder also had a window on another workspace, the switch hid Finder
/// whole, the new window with it, and nothing showed it again when Finder answered: it sat on the workspace you were on,
/// hidden, until you left and came back.
///
/// Now such a window is held on the workspace it was seen on, as a saved-layout window waits for its app: the switch
/// hides its app with that workspace, and the window lands there once the app answers.
public enum UnansweredWindows {
    /// The windows to hold, each with its app: on screen, held by no workspace, not already waiting, not one the app
    /// listed as a non-window (a sheet, a panel), and owned by an app the last scan couldn't read (`unsure`). A window
    /// of an app that answered and didn't list it (an overlay) is left alone, as before.
    public static func held(onScreen: [WindowID: Int32], placed: Set<WindowID>, waiting: Set<WindowID>,
                            notWindows: Set<WindowID>, unsure: Set<Int32>) -> [WindowID: Int32] {
        onScreen.filter { id, pid in
            unsure.contains(pid) && !placed.contains(id) && !waiting.contains(id) && !notWindows.contains(id)
        }
    }

    /// A waiting window (held, or from the saved layout) just got its workspace. The workspace applies again when that
    /// workspace isn't shown (its app goes out of sight with it), or when it is shown but Polycarp has its app hidden:
    /// the window has to come back. Before, only the first case applied again, so the window stayed hidden.
    public static func appliesAgain(workspaceShown: Bool, appHiddenByUs: Bool) -> Bool {
        !workspaceShown || appHiddenByUs
    }
}
