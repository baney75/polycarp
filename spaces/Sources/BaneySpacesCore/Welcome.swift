import Foundation

/// A macOS permission Polycarp asks for on first run.
public enum PermissionKind: String, CaseIterable, Sendable {
    case accessibility, screenRecording, inputMonitoring
}

/// What the welcome window says about one permission, in the order they're asked for. Every word here has to be true of
/// what the code does: `WindowShot` needs Screen Recording, and `SessionTap` is listen-only and made only for one action.
public struct PermissionStep: Equatable, Sendable {
    public let kind: PermissionKind
    public let title: String
    public let why: String
    public let isRequired: Bool
    public let settingsName: String
    public let settingsURL: String
    /// What's left to do once macOS has been asked, shown under the button.
    public let after: String
}

/// The first-run walk through permissions. Plain state, so it can be tested without macOS.
public enum Welcome {
    public static let steps: [PermissionStep] = [
        PermissionStep(
            kind: .accessibility,
            title: "Arrange your windows",
            why: "Polycarp shows, hides and moves other apps' windows. This is the one permission it can't run without. It can't read what you type.",
            isRequired: true,
            settingsName: "Accessibility",
            settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            after: "Turn on Polycarp in the list. This window updates by itself."),
        PermissionStep(
            kind: .screenRecording,
            title: "Let agents see their own work",
            why: "An agent can take a picture of a window on its own workspace, or one you've lent it, to check what it did. Those pictures go to the agent you're using. Nothing else is captured.",
            isRequired: false,
            settingsName: "Screen & System Audio Recording",
            settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            after: "Turn on Polycarp in the list. macOS may ask to reopen it, which is fine."),
        PermissionStep(
            kind: .inputMonitoring,
            title: "Stay out of your way",
            why: "While an agent acts, Polycarp checks whether you're using the keyboard or mouse, so the two of you don't collide. It only listens during that action and doesn't keep what you type.",
            isRequired: false,
            settingsName: "Input Monitoring",
            settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
            after: "Turn on Polycarp in the list. This window updates by itself."),
    ]

    public static func step(_ kind: PermissionKind) -> PermissionStep { steps.first { $0.kind == kind }! }

    /// The permission to ask for now: the first one not granted and not skipped. Nil when none is left.
    public static func next(granted: Set<PermissionKind>, skipped: Set<PermissionKind>) -> PermissionKind? {
        steps.first { !granted.contains($0.kind) && !skipped.contains($0.kind) }?.kind
    }

    /// Polycarp can start once everything required is granted. A required permission can't be skipped.
    public static func canStart(granted: Set<PermissionKind>) -> Bool {
        steps.allSatisfy { !$0.isRequired || granted.contains($0.kind) }
    }

    /// Whether a person may pass on this one for now.
    public static func canSkip(_ kind: PermissionKind) -> Bool { !step(kind).isRequired }

    /// The welcome window shows on first run, and whenever the one required permission is missing (macOS forgot it after
    /// an update, say). Optional ones never bring it back: a person who skipped them isn't asked twice.
    public static func shouldShow(hasFinished: Bool, granted: Set<PermissionKind>, forced: Bool) -> Bool {
        forced || !hasFinished || !canStart(granted: granted)
    }

    public static let finishedKey = "welcomeFinished"
}
