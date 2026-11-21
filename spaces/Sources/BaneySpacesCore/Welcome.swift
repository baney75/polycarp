import Foundation

/// A macOS permission Polycarp asks for on first run.
public enum PermissionKind: String, CaseIterable, Sendable {
    case accessibility
}

/// What the welcome window says about one permission, in the order they're asked for. Every word here has to be true of
/// what the code does.
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
            why: "Polycarp shows, hides and moves other apps' windows. It is the one permission Polycarp can't run without.",
            isRequired: true,
            settingsName: "Accessibility",
            settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            after: "Turn on Polycarp in the list. This window updates by itself."),
    ]

    /// The last row: not a permission, so it never blocks starting and is never "current". On by default.
    public enum StartAtLogin {
        public static let title = "Start with your Mac"
        public static let why = "Polycarp opens when you log in, so your workspaces are there each day."
        /// Shown only when macOS wants the person to approve the login item.
        public static let approval = "macOS needs you to approve it in Login Items."
        public static let approvalButton = "Approve in Login Items"

        /// Whether to register the login item as the welcome window opens: on unless the person already decided
        /// (Settings, or 0.1's "offered"), and not again for one macOS already knows about.
        public static func shouldRegister(chosen: Bool, offered: Bool, registered: Bool) -> Bool { !chosen && !offered && !registered }
    }

    /// The button that is the default action (Return) now: the current permission's Allow button while one is left, so
    /// the walk is press, flip, press, flip; the finish button only when nothing is left to ask. Nil when neither shows.
    public enum DefaultAction: Equatable { case allow(PermissionKind), finish }
    public static func defaultAction(granted: Set<PermissionKind>, skipped: Set<PermissionKind>) -> DefaultAction? {
        if let k = next(granted: granted, skipped: skipped) { return .allow(k) }
        return canStart(granted: granted) ? .finish : nil
    }

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
