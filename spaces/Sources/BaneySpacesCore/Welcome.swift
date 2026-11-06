import Foundation

/// A macOS permission Polycarp asks for on first run.
public enum PermissionKind: String, CaseIterable, Sendable {
    case accessibility, screenRecording, inputMonitoring, microphone
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
            why: "Polycarp shows, hides and moves other apps' windows. Agents you allow can read and act in the windows they're allowed to use. It is the one permission Polycarp can't run without.",
            isRequired: true,
            settingsName: "Accessibility",
            settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            after: "Turn on Polycarp in the list. This window updates by itself."),
        PermissionStep(
            kind: .screenRecording,
            title: "Let agents see their own work",
            why: "An agent can take a picture of a window on its own workspace, or one you've lent it, to check its work. With Full Access it can capture any window. Pictures go only to that agent.",
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
        PermissionStep(
            kind: .microphone,
            title: "Let Silas hear you",
            why: "Silas: hold a key, speak and it types. It listens only from when you press the key until you let go or tap again. Speech becomes text on this Mac, and the audio isn't saved or sent anywhere.",
            isRequired: false,
            settingsName: "Microphone",
            settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            after: "Choose Allow in the box macOS shows, or turn on Polycarp in the list. This window updates by itself."),
    ]

    /// macOS's answer about the microphone, without the framework: `AVCaptureDevice.authorizationStatus(for: .audio)` mapped.
    public enum MicrophoneAccess: Sendable { case notDetermined, authorized, denied }

    /// "Allow" on the microphone row: macOS asks itself while it has never been asked, so Settings opens only after a
    /// no (macOS never asks twice, and the list is the only way back).
    public static func opensSettingsWhenAllowing(microphone: MicrophoneAccess) -> Bool { microphone == .denied }

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
