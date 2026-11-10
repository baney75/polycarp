import Foundation

/// Every macOS permission Polycarp uses, what each is for, and what Settings > Permissions shows about it now. Plain
/// state with no AppKit, so the words and the "what to show" rules are tested without macOS. The app reads the live
/// answers (`PermissionsModel`) and hands them here.
///
/// Each entry has to be true of the code: Accessibility is `AXIsProcessTrusted` (windows, agent hands, Silas's key and
/// typing), Screen Recording is `WindowShot`, Input Monitoring is `BackgroundWatch`'s listen-only tap, the microphone is
/// Silas, Automation is the launcher's scripts (`Scripts.swift`) and Notifications are the hand-over notes
/// (`LegacyWatcher`, `VoiceEngine.notifyIfDue`).
public enum PermissionID: String, CaseIterable, Sendable, Identifiable {
    case accessibility, screenRecording, inputMonitoring, microphone, automation, notifications
    public var id: Self { self }

    /// The welcome window's own name for the four it walks through.
    public init?(_ kind: PermissionKind) { self.init(rawValue: kind.rawValue) }
}

/// What macOS says now. `notAsked`: macOS has never been asked (or, for a list, Polycarp has never sent you there).
/// `unknown`: macOS can't say yet, such as an Automation target that isn't running.
public enum PermissionState: String, Sendable, Equatable {
    case granted, denied, notAsked, unknown

    /// The word beside a row.
    public var word: String {
        switch self {
        case .granted: "On"
        case .denied: "Off"
        case .notAsked: "Not set up"
        case .unknown: "Not checked yet"
        }
    }
}

/// How a person grants it. `prompt`: macOS shows its own box with Allow. `list`: the person adds Polycarp to a list in
/// System Settings and switches it on. `perApp`: Automation, which macOS asks about once for each app Polycarp scripts.
public enum GrantKind: String, Sendable, Equatable {
    case prompt, list, perApp
}

/// One thing a permission makes possible, owned by one part of Polycarp.
public struct PermissionUse: Equatable, Sendable {
    public let feature: Feature
    public let what: String
    public init(_ feature: Feature, _ what: String) { self.feature = feature; self.what = what }
}

public struct PermissionEntry: Equatable, Sendable, Identifiable {
    public let id: PermissionID
    public let title: String
    /// One line: what Polycarp uses it for.
    public let purpose: String
    /// One line: what it never does with it.
    public let never: String
    /// What stops without it, by part.
    public let uses: [PermissionUse]
    public let kind: GrantKind
    /// The pane in System Settings, by the name it has there.
    public let settingsName: String
    public let settingsURL: String
    /// Polycarp can't start the parts that use it without it.
    public let blocksStart: Bool
    /// Never more than nice to have, so it waits with the optional ones even while its part is on.
    public let niceToHave: Bool

    /// The parts that use it.
    public var features: Set<Feature> { Set(uses.map(\.feature)) }

    /// What stops without it, for the parts that are on.
    public func stops(with on: FeatureSet) -> [String] { uses.filter { on.contains($0.feature) }.map(\.what) }
}

public enum Permissions {
    static let pane = "x-apple.systempreferences:com.apple.preference.security?"

    public static let all: [PermissionEntry] = [
        PermissionEntry(
            id: .accessibility, title: "Accessibility",
            purpose: "Lets Polycarp show, hide and move windows, act for agents in the windows you allow, and type for Silas.",
            never: "It never reads what you type.",
            uses: [PermissionUse(.workspaces, "Workspaces, the dock and the overview"),
                   PermissionUse(.workspaces, "Agents working in their own windows"),
                   PermissionUse(.voice, "Silas's key and typing")],
            kind: .list, settingsName: "Accessibility", settingsURL: pane + "Privacy_Accessibility",
            blocksStart: true, niceToHave: false),
        PermissionEntry(
            id: .screenRecording, title: "Screen Recording",
            purpose: "Lets an agent take a picture of a window it may use, to check its own work.",
            never: "Pictures go only to that agent. Polycarp never records your screen or its sound.",
            uses: [PermissionUse(.workspaces, "Agent screenshots")],
            kind: .list, settingsName: "Screen & System Audio Recording", settingsURL: pane + "Privacy_ScreenCapture",
            blocksStart: false, niceToHave: false),
        PermissionEntry(
            id: .inputMonitoring, title: "Input Monitoring",
            purpose: "While an agent acts, Polycarp notices you at the keyboard or mouse, so the two of you don't collide.",
            never: "It listens only during that action and keeps nothing you type.",
            uses: [PermissionUse(.workspaces, "Agents pausing when you type or click")],
            kind: .list, settingsName: "Input Monitoring", settingsURL: pane + "Privacy_ListenEvent",
            blocksStart: false, niceToHave: false),
        PermissionEntry(
            id: .microphone, title: "Microphone",
            purpose: "Silas listens from when you press its key until you let go, and turns speech into text on this Mac.",
            never: "The audio is never saved or sent anywhere.",
            uses: [PermissionUse(.voice, "Silas dictation")],
            kind: .prompt, settingsName: "Microphone", settingsURL: pane + "Privacy_Microphone",
            blocksStart: false, niceToHave: false),
        PermissionEntry(
            id: .automation, title: "Automation",
            purpose: "Lets the launcher list your terminal and browser tabs and bring forward the one you pick.",
            never: "It types into a terminal only when you or an agent asks it to.",
            uses: [PermissionUse(.workspaces, "Tabs and terminals in the launcher")],
            kind: .perApp, settingsName: "Automation", settingsURL: pane + "Privacy_Automation",
            blocksStart: false, niceToHave: false),
        PermissionEntry(
            id: .notifications, title: "Notifications",
            purpose: "One note when Polycarp takes over from Silas or the older workspaces app, so you know the old app can go.",
            never: "No other alerts, sounds or badges.",
            uses: [PermissionUse(.voice, "The note that Silas can go"),
                   PermissionUse(.workspaces, "The note when the older workspaces app hands over")],
            kind: .prompt, settingsName: "Notifications",
            settingsURL: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.baney.polycarp",
            blocksStart: false, niceToHave: true),
    ]

    public static func entry(_ id: PermissionID) -> PermissionEntry { all.first { $0.id == id }! }

    // MARK: Reading macOS's answers

    /// A list permission (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`): macOS answers only yes or no, so a no
    /// is "off" once Polycarp has sent you to the list, and "not set up" before that.
    public static func listState(granted: Bool, asked: Bool) -> PermissionState {
        granted ? .granted : asked ? .denied : .notAsked
    }

    /// `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)`: 0 granted, 1 denied, 2 unknown (never asked).
    public static func hidState(_ access: UInt32) -> PermissionState {
        switch access {
        case 0: .granted
        case 1: .denied
        case 2: .notAsked
        default: .unknown
        }
    }

    /// `AVCaptureDevice.authorizationStatus(for: .audio).rawValue`: 0 not determined, 1 restricted, 2 denied, 3 authorized.
    public static func microphoneState(_ raw: Int) -> PermissionState {
        switch raw {
        case 0: .notAsked
        case 1, 2: .denied
        case 3: .granted
        default: .unknown
        }
    }

    /// `UNAuthorizationStatus.rawValue`: 0 not determined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral.
    public static func notificationState(_ raw: Int) -> PermissionState {
        switch raw {
        case 0: .notAsked
        case 1: .denied
        case 2, 3, 4: .granted
        default: .unknown
        }
    }

    /// `AEDeterminePermissionToAutomateTarget(…, askUserIfNeeded: false)`: noErr, errAEEventWouldRequireUserConsent
    /// (-1744), errAEEventNotPermitted (-1743), procNotFound (-600, the app isn't running, so macOS can't say).
    public static func appleEventState(_ status: Int32) -> PermissionState {
        switch status {
        case 0: .granted
        case -1744: .notAsked
        case -1743: .denied
        default: .unknown
        }
    }

    // MARK: What to show now

    /// The one button on a row.
    public enum Action: Equatable, Sendable {
        /// Granted: no button.
        case none
        /// macOS will show its own box with Allow.
        case ask
        /// Open the pane in System Settings. `requestFirst`: ask macOS once before, which puts Polycarp in the list for
        /// you. `helper`: show the drag helper beside System Settings.
        case openSettings(requestFirst: Bool, helper: Bool)
    }

    public static func action(_ entry: PermissionEntry, _ state: PermissionState) -> Action {
        if state == .granted { return .none }
        switch entry.kind {
        // macOS asks only once; after a no, the list is the only way back.
        case .prompt: return state == .notAsked ? .ask : .openSettings(requestFirst: false, helper: false)
        case .list: return .openSettings(requestFirst: state == .notAsked, helper: true)
        // Each app is asked about on its own (`automationAction`); the row opens the list of them.
        case .perApp: return .openSettings(requestFirst: false, helper: false)
        }
    }

    /// The button's words.
    public static func buttonTitle(_ entry: PermissionEntry, _ state: PermissionState) -> String? {
        switch action(entry, state) {
        case .none: nil
        case .ask: "Allow"
        case .openSettings: entry.kind == .perApp ? "Open Automation" : "Open \(entry.title)"
        }
    }

    /// The way in without a drag, said on every list row that isn't on yet.
    public static func keyboardWay(_ entry: PermissionEntry) -> String? {
        entry.kind == .list ? "In the list, drag in Polycarp or click + and pick it, then switch it on." : nil
    }

    /// One row of the pane.
    public struct Row: Equatable, Sendable, Identifiable {
        public let entry: PermissionEntry
        public let state: PermissionState
        /// Only for parts that are off, or never more than nice to have.
        public let optional: Bool
        /// What stops without it, for the parts that are on.
        public let stops: [String]
        public var id: PermissionID { entry.id }
        public var action: Action { Permissions.action(entry, state) }
    }

    public struct Plan: Equatable, Sendable {
        /// Needed by a part that is on, the ones Polycarp can't start without first.
        public let needed: [Row]
        /// Shown collapsed under "Optional".
        public let optional: [Row]
        /// Everything Polycarp can't start without is on.
        public var canStart: Bool { needed.allSatisfy { !$0.entry.blocksStart || $0.state == .granted } }
        /// How many needed ones are left, for the summary line.
        public var left: Int { needed.filter { $0.state != .granted }.count }
        /// The row to do next, whose button carries the accent: the first needed one that isn't on.
        public var next: PermissionID? { needed.first { $0.state != .granted }?.id }
    }

    /// The pane, as it should look for these answers and these parts.
    public static func plan(states: [PermissionID: PermissionState], features: FeatureSet) -> Plan {
        let rows = all.map { e -> Row in
            let used = !e.features.isDisjoint(with: features.on)
            return Row(entry: e, state: states[e.id] ?? .unknown, optional: !used || e.niceToHave, stops: e.stops(with: features))
        }
        let needed = rows.filter { !$0.optional }
        // Stable sort: the blocking ones first, the rest in catalog order.
        let ordered = needed.enumerated().sorted { a, b in
            a.element.entry.blocksStart != b.element.entry.blocksStart ? a.element.entry.blocksStart : a.offset < b.offset
        }.map(\.element)
        return Plan(needed: ordered, optional: rows.filter(\.optional))
    }

    /// The line at the top of the pane.
    public static func summary(_ plan: Plan) -> String {
        if !plan.canStart { return "Polycarp needs Accessibility to start. The rest can wait." }
        switch plan.left {
        case 0: return "Polycarp has everything it needs for what you use."
        case 1: return "One permission left for what you use."
        default: return "\(plan.left) permissions left for what you use."
        }
    }

    // MARK: Automation, one app at a time

    /// An app Polycarp sends Apple Events to.
    public struct AutomationTarget: Equatable, Sendable, Identifiable {
        public let bundleID: String
        public let name: String
        public let why: String
        public var id: String { bundleID }
        public init(bundleID: String, name: String, why: String) { self.bundleID = bundleID; self.name = name; self.why = why }
    }

    /// Every app with a scripted adapter in the session engine's catalog (`Catalog.known`, the list `Engine.script(for:)`
    /// reads), and System Events, which the launcher's "dark mode" command asks. Taken from the catalog, never copied.
    public static func automationTargets(_ known: [AppSpec] = Catalog.known) -> [AutomationTarget] {
        var seen = Set<String>()
        var out: [AutomationTarget] = []
        for spec in known where spec.adapter != .windows && seen.insert(spec.bundleID).inserted {
            out.append(AutomationTarget(bundleID: spec.bundleID, name: spec.name,
                                        why: spec.role == .browser ? "Tabs in the launcher" : "Terminals in the launcher"))
        }
        out.append(AutomationTarget(bundleID: "com.apple.systemevents", name: "System Events", why: "The launcher's dark mode command"))
        return out
    }

    public enum TargetAction: Equatable, Sendable {
        /// On, or nothing to do until the app runs.
        case none
        /// macOS shows its own box for this app.
        case ask
        /// Turned off: the Automation list is the only way back.
        case openSettings
    }

    public static func automationAction(_ state: PermissionState) -> TargetAction {
        switch state {
        case .granted, .unknown: .none
        case .notAsked: .ask
        case .denied: .openSettings
        }
    }

    /// The word beside one app.
    public static func automationWord(_ state: PermissionState) -> String {
        switch state {
        case .granted: "On"
        case .denied: "Off"
        case .notAsked: "Not asked yet"
        case .unknown: "Not running"
        }
    }

    /// The whole Automation row: on when every app macOS can answer for is on, off when any is off.
    public static func automationState(_ targets: [PermissionState]) -> PermissionState {
        if targets.contains(.denied) { return .denied }
        if targets.contains(.notAsked) { return .notAsked }
        if targets.contains(.granted) { return .granted }
        return .unknown
    }
}
