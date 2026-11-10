import XCTest
@testable import BaneySpacesCore

/// Settings > Permissions and the drag helper: the catalog is true of the code, macOS's answers map to the right state, each
/// row's one button does the right thing for its kind, and the helper shows only beside System Settings, never over its list.
final class PermissionsTests: XCTestCase {
    private func states(_ s: PermissionState) -> [PermissionID: PermissionState] {
        Dictionary(uniqueKeysWithValues: PermissionID.allCases.map { ($0, s) })
    }

    // MARK: The catalog

    func testEveryPermissionIsListedOnceWithItsKindAndExactPane() {
        XCTAssertEqual(Permissions.all.map(\.id), PermissionID.allCases)
        let want: [PermissionID: (GrantKind, String)] = [
            .accessibility: (.list, "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
            .screenRecording: (.list, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
            .inputMonitoring: (.list, "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"),
            .microphone: (.prompt, "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
            .automation: (.perApp, "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"),
            .notifications: (.prompt, "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.baney.polycarp"),
        ]
        for e in Permissions.all {
            XCTAssertEqual(e.kind, want[e.id]?.0, "\(e.id)")
            XCTAssertEqual(e.settingsURL, want[e.id]?.1, "\(e.id)")
            XCTAssertFalse(e.purpose.isEmpty); XCTAssertFalse(e.never.isEmpty); XCTAssertFalse(e.uses.isEmpty)
        }
        XCTAssertEqual(Permissions.all.filter(\.blocksStart).map(\.id), [.accessibility], "Accessibility is the one Polycarp can't start without")
    }

    func testTheWelcomeWalkAndThePaneOpenTheSamePane() {
        for kind in PermissionKind.allCases {
            let id = try! XCTUnwrap(PermissionID(kind))
            XCTAssertEqual(Permissions.entry(id).settingsURL, Welcome.step(kind).settingsURL, "\(kind)")
        }
    }

    func testTheBundleIDInTheNotificationsLinkIsTheApps() throws {
        let plist = try Repo.text("Resources/Info.plist")
        XCTAssertTrue(plist.contains("<key>CFBundleIdentifier</key><string>com.baney.polycarp</string>"))
    }

    func testThePromptKindsHaveTheirUsageStringsOrNeedNone() throws {
        let plist = try Repo.text("Resources/Info.plist")
        // macOS shows these strings in its own box; without them the request fails.
        XCTAssertTrue(plist.contains("NSMicrophoneUsageDescription"))
        XCTAssertTrue(plist.contains("NSAppleEventsUsageDescription"))
        let entitlements = try Repo.text("Resources/Polycarp.entitlements")
        XCTAssertTrue(entitlements.contains("com.apple.security.device.audio-input"))
    }

    func testEachPermissionNamesThePartsThatUseIt() {
        XCTAssertEqual(Permissions.entry(.accessibility).features, [.workspaces, .voice])
        XCTAssertEqual(Permissions.entry(.microphone).features, [.voice])
        XCTAssertEqual(Permissions.entry(.screenRecording).features, [.workspaces])
        XCTAssertEqual(Permissions.entry(.inputMonitoring).features, [.workspaces])
        XCTAssertEqual(Permissions.entry(.automation).features, [.workspaces])
        XCTAssertEqual(Permissions.entry(.accessibility).stops(with: FeatureSet([.voice])), ["Silas's key and typing"])
    }

    // MARK: macOS's answers

    func testListAnswersAreYesOrNoAndANoIsOffOnlyAfterAsking() {
        XCTAssertEqual(Permissions.listState(granted: true, asked: false), .granted)
        XCTAssertEqual(Permissions.listState(granted: false, asked: false), .notAsked)
        XCTAssertEqual(Permissions.listState(granted: false, asked: true), .denied)
    }

    func testTheSystemsRawAnswersMapToState() {
        // IOHIDAccessType: granted, denied, unknown.
        XCTAssertEqual([0, 1, 2, 9].map { Permissions.hidState(UInt32($0)) }, [.granted, .denied, .notAsked, .unknown])
        // AVAuthorizationStatus: notDetermined, restricted, denied, authorized.
        XCTAssertEqual([0, 1, 2, 3, 7].map(Permissions.microphoneState), [.notAsked, .denied, .denied, .granted, .unknown])
        // UNAuthorizationStatus: notDetermined, denied, authorized, provisional, ephemeral.
        XCTAssertEqual([0, 1, 2, 3, 4, 8].map(Permissions.notificationState), [.notAsked, .denied, .granted, .granted, .granted, .unknown])
        // noErr, errAEEventWouldRequireUserConsent, errAEEventNotPermitted, procNotFound.
        XCTAssertEqual([0, -1744, -1743, -600].map(Permissions.appleEventState), [.granted, .notAsked, .denied, .unknown])
    }

    // MARK: The one button

    func testEachKindsButtonDoesTheRightThing() {
        let mic = Permissions.entry(.microphone), ax = Permissions.entry(.accessibility), auto = Permissions.entry(.automation)
        // macOS asks once, with its own box; after a no, only the list.
        XCTAssertEqual(Permissions.action(mic, .notAsked), .ask)
        XCTAssertEqual(Permissions.action(mic, .denied), .openSettings(requestFirst: false, helper: false))
        // A list: the pane and the helper, and macOS's own request the first time, which puts Polycarp in the list.
        XCTAssertEqual(Permissions.action(ax, .notAsked), .openSettings(requestFirst: true, helper: true))
        XCTAssertEqual(Permissions.action(ax, .denied), .openSettings(requestFirst: false, helper: true))
        XCTAssertEqual(Permissions.action(auto, .notAsked), .openSettings(requestFirst: false, helper: false))
        for e in Permissions.all { XCTAssertEqual(Permissions.action(e, .granted), .none, "\(e.id)"); XCTAssertNil(Permissions.buttonTitle(e, .granted)) }
        XCTAssertEqual(Permissions.buttonTitle(mic, .notAsked), "Allow")
        XCTAssertEqual(Permissions.buttonTitle(ax, .denied), "Open Accessibility")
        XCTAssertEqual(Permissions.buttonTitle(auto, .denied), "Open Automation")
    }

    func testOnlyListRowsShowTheHelperAndEachSaysTheKeyboardWay() {
        for e in Permissions.all {
            let helper = Permissions.action(e, .denied) == .openSettings(requestFirst: false, helper: true)
            XCTAssertEqual(helper, e.kind == .list, "\(e.id)")
            XCTAssertEqual(Permissions.keyboardWay(e) != nil, e.kind == .list, "\(e.id)")
        }
        XCTAssertTrue(Permissions.keyboardWay(Permissions.entry(.screenRecording))!.contains("click + and pick"))
    }

    // MARK: What to show now

    func testRequiredFirstAndTheRestOptionalForPartsThatAreOff() {
        var s = states(.notAsked)
        s[.microphone] = .granted
        let all = Permissions.plan(states: s, features: .all)
        XCTAssertEqual(all.needed.map(\.id), [.accessibility, .screenRecording, .inputMonitoring, .microphone, .automation])
        XCTAssertEqual(all.optional.map(\.id), [.notifications], "nice to have waits with the optional ones")
        XCTAssertEqual(all.next, .accessibility)
        XCTAssertFalse(all.canStart)

        let voice = Permissions.plan(states: s, features: FeatureSet([.voice]))
        XCTAssertEqual(voice.needed.map(\.id), [.accessibility, .microphone])
        XCTAssertEqual(voice.optional.map(\.id), [.screenRecording, .inputMonitoring, .automation, .notifications])
        XCTAssertTrue(voice.optional.allSatisfy(\.optional))
        XCTAssertEqual(voice.needed.first?.stops, ["Silas's key and typing"])

        let browser = Permissions.plan(states: s, features: FeatureSet([.browser]))
        XCTAssertEqual(browser.needed, [], "the browser part needs nothing from macOS")
        XCTAssertTrue(browser.canStart)
    }

    func testTheSummaryAndNextFollowTheAnswers() {
        var s = states(.granted)
        XCTAssertEqual(Permissions.summary(Permissions.plan(states: s, features: .all)), "Polycarp has everything it needs for what you use.")
        XCTAssertNil(Permissions.plan(states: s, features: .all).next)
        s[.screenRecording] = .denied
        XCTAssertEqual(Permissions.summary(Permissions.plan(states: s, features: .all)), "One permission left for what you use.")
        XCTAssertEqual(Permissions.plan(states: s, features: .all).next, .screenRecording)
        s[.automation] = .notAsked
        XCTAssertEqual(Permissions.summary(Permissions.plan(states: s, features: .all)), "2 permissions left for what you use.")
        s[.accessibility] = .notAsked
        XCTAssertEqual(Permissions.summary(Permissions.plan(states: s, features: .all)), "Polycarp needs Accessibility to start. The rest can wait.")
        // An optional one that's off never counts as left.
        var o = states(.granted); o[.notifications] = .denied
        XCTAssertEqual(Permissions.plan(states: o, features: .all).left, 0)
    }

    // MARK: Automation, per app

    func testAutomationTargetsComeFromTheSessionCatalog() {
        let ids = Permissions.automationTargets().map(\.bundleID)
        let scripted = Catalog.known.filter { $0.adapter != .windows }.map(\.bundleID)
        XCTAssertEqual(Array(ids.dropLast()), scripted, "every scripted app, in the catalog's order")
        XCTAssertEqual(ids.last, "com.apple.systemevents")
        XCTAssertFalse(ids.contains("org.alacritty"), "an app read only through Accessibility needs no Automation")
        // A scripted app added to the catalog shows up with no second list to edit.
        let extra = AppSpec(bundleID: "com.example.browser", name: "Example", role: .browser, adapter: .chromium)
        XCTAssertTrue(Permissions.automationTargets(Catalog.known + [extra]).contains { $0.bundleID == "com.example.browser" })
    }

    func testAutomationPerAppButtonsAndTheRowsSum() {
        XCTAssertEqual(Permissions.automationAction(.notAsked), .ask)
        XCTAssertEqual(Permissions.automationAction(.denied), .openSettings)
        XCTAssertEqual(Permissions.automationAction(.unknown), .none, "an app that isn't running can't be asked about")
        XCTAssertEqual(Permissions.automationAction(.granted), .none)
        XCTAssertEqual(Permissions.automationState([.granted, .unknown]), .granted)
        XCTAssertEqual(Permissions.automationState([.granted, .notAsked]), .notAsked)
        XCTAssertEqual(Permissions.automationState([.notAsked, .denied]), .denied)
        XCTAssertEqual(Permissions.automationState([.unknown]), .unknown)
        XCTAssertEqual(Permissions.automationState([]), .unknown)
    }

    // MARK: The drag helper

    func testItFindsSystemSettingsMainWindowAndNothingElse() {
        let main = CGRect(x: 100, y: 80, width: 715, height: 600)
        let windows = [
            PermissionHelper.ServerWindow(pid: 7, layer: 0, alpha: 1, bounds: main),
            PermissionHelper.ServerWindow(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 200, y: 200, width: 420, height: 220)), // a sheet
            PermissionHelper.ServerWindow(pid: 7, layer: 25, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 2000, height: 1000)),  // not a window
            PermissionHelper.ServerWindow(pid: 9, layer: 0, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1500, height: 900)),    // another app
            PermissionHelper.ServerWindow(pid: 7, layer: 0, alpha: 0, bounds: CGRect(x: 0, y: 0, width: 1400, height: 900)),    // invisible
        ]
        XCTAssertEqual(PermissionHelper.settingsWindow(in: windows, pids: [7]), main)
        XCTAssertNil(PermissionHelper.settingsWindow(in: windows, pids: [3]))
    }

    func testWindowServerBoundsFlipToAppKit() {
        let r = PermissionHelper.appKitRect(CGRect(x: 100, y: 50, width: 700, height: 600), mainDisplayHeight: 1000)
        XCTAssertEqual(r, CGRect(x: 100, y: 350, width: 700, height: 600))
    }

    func testItSitsBesideSystemSettingsAndNeverOverTheList() {
        let screen = CGRect(x: 0, y: 0, width: 1512, height: 945)
        let gap = PermissionHelper.gap
        // Room on the right.
        let mid = CGRect(x: 300, y: 200, width: 715, height: 640)
        let right = PermissionHelper.frame(beside: mid, screens: [screen])
        XCTAssertEqual(right.minX, mid.maxX + gap)
        XCTAssertTrue(screen.contains(right))
        XCTAssertLessThanOrEqual(right.maxY, mid.maxY, "level with the list, not above the window")
        // Against the right edge: the left.
        let atRight = CGRect(x: 790, y: 200, width: 715, height: 640)
        let left = PermissionHelper.frame(beside: atRight, screens: [screen])
        XCTAssertEqual(left.maxX, atRight.minX - gap)
        // Wide: under it.
        let wide = CGRect(x: 100, y: 300, width: 1300, height: 600)
        let below = PermissionHelper.frame(beside: wide, screens: [screen])
        XCTAssertEqual(below.maxY, wide.minY - gap)
        // Filling the screen: on the sidebar, clear of the list.
        let full = screen
        let onSidebar = PermissionHelper.frame(beside: full, screens: [screen])
        XCTAssertTrue(full.contains(onSidebar))
        for settings in [mid, atRight, wide, full] {
            let f = PermissionHelper.frame(beside: settings, screens: [screen])
            XCTAssertFalse(f.intersects(PermissionHelper.listArea(of: settings)), "over the list beside \(settings)")
            XCTAssertTrue(screen.contains(f), "off screen beside \(settings)")
        }
    }

    func testItStaysOnTheScreenSystemSettingsIsOn() {
        let left = CGRect(x: -1920, y: 0, width: 1920, height: 1080), main = CGRect(x: 0, y: 0, width: 1512, height: 945)
        let settings = CGRect(x: -1400, y: 200, width: 715, height: 640)
        let f = PermissionHelper.frame(beside: settings, screens: [main, left])
        XCTAssertTrue(left.contains(f))
    }

    func testItShowsOnlyBesideSystemSettingsAndGoesWhenDoneOrClosed() {
        let s = CGRect(x: 0, y: 0, width: 700, height: 600)
        typealias P = PermissionHelper
        // Waiting: nothing on screen until System Settings is.
        XCTAssertEqual(P.step(.waiting(since: 0), now: 1, settings: nil, granted: false), .waiting(since: 0))
        XCTAssertFalse(P.isVisible(.waiting(since: 0)))
        XCTAssertEqual(P.step(.waiting(since: 0), now: 1, settings: s, granted: false), .showing(missingSince: nil))
        XCTAssertEqual(P.step(.waiting(since: 0), now: P.waitForSettings + 1, settings: nil, granted: false), .closed, "System Settings never came")
        XCTAssertEqual(P.step(.waiting(since: 0), now: 1, settings: s, granted: true), .closed, "already on: never shows")
        // Showing: granted turns to done, which closes after its moment.
        XCTAssertEqual(P.step(.showing(missingSince: nil), now: 5, settings: s, granted: true), .done(since: 5))
        XCTAssertTrue(P.isVisible(.done(since: 5)))
        XCTAssertEqual(P.step(.done(since: 5), now: 5 + P.successFor / 2, settings: s, granted: true), .done(since: 5))
        XCTAssertEqual(P.step(.done(since: 5), now: 5 + P.successFor + 0.01, settings: s, granted: true), .closed)
        // System Settings closing closes it, but a blink while it changes panes doesn't.
        XCTAssertEqual(P.step(.showing(missingSince: nil), now: 5, settings: nil, granted: false), .showing(missingSince: 5))
        XCTAssertEqual(P.step(.showing(missingSince: 5), now: 5.2, settings: s, granted: false), .showing(missingSince: nil))
        XCTAssertEqual(P.step(.showing(missingSince: 5), now: 5 + P.goneAfter + 0.01, settings: nil, granted: false), .closed)
        XCTAssertEqual(P.step(.closed, now: 9, settings: s, granted: false), .closed, "closed stays closed until the next button")
    }

    func testTheTileCarriesTheRunningAppAndOnlyAnApp() {
        let app = URL(fileURLWithPath: "/Applications/Polycarp.app")
        XCTAssertEqual(PermissionHelper.dragURL(bundleURL: app), app)
        XCTAssertNil(PermissionHelper.dragURL(bundleURL: URL(fileURLWithPath: "/tmp/build/debug")), "a swift build run has no app to add")
        XCTAssertEqual(PermissionHelper.instruction, "Drag Polycarp into the list, then switch it on")
    }

    // MARK: The words

    func testTheWordsArePlainWithNoDashesOrScareWords() throws {
        var text = Permissions.all.flatMap { [$0.title, $0.purpose, $0.never] + $0.uses.map(\.what) }
        text += [PermissionHelper.instruction, PermissionHelper.doneLine]
        text += Permissions.all.compactMap(Permissions.keyboardWay)
        for files in ["Sources/BaneySpacesCore/Permissions.swift", "Sources/BaneySpacesCore/PermissionHelper.swift",
                      "Sources/BaneySpaces/Permissions/PermissionsPane.swift", "Sources/BaneySpaces/Permissions/DragHelper.swift",
                      "Sources/BaneySpaces/Permissions/PermissionsModel.swift"] {
            text.append(try Repo.text(files))
        }
        for t in text {
            XCTAssertFalse(t.contains("\u{2014}") || t.contains("\u{2013}"), "an em or en dash in: \(t.prefix(80))")
            for word in ["danger", "warning", "WARNING", "risk", "must allow", "spy"] {
                XCTAssertFalse(t.contains(word), "\"\(word)\" in: \(t.prefix(80))")
            }
        }
    }
}

/// The app target can't be imported here, so these read its sources: the section is in Settings, the helper never takes
/// focus or touches System Settings, and the welcome window uses the same row.
final class PermissionsSourceTests: XCTestCase {
    func testPermissionsIsASettingsSection() throws {
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertTrue(setup.contains(#"permissions = "Permissions""#))
        XCTAssertTrue(setup.contains("case .permissions: PermissionsPane("))
        let kit = try Repo.code("Sources/BaneySpaces/SettingsKit.swift")
        XCTAssertTrue(kit.contains("tabs: [.permissions, .automation, .updates]"))
        XCTAssertTrue(FeatureSet(Set()).showsSettingsTab("Permissions"), "every part, and none, shows Permissions")
    }

    func testGeneralNoLongerHasItsOwnAllowButton() throws {
        let setup = try Repo.code("Sources/BaneySpaces/Setup.swift")
        XCTAssertFalse(setup.contains(#"Button("Allow Polycarp", action: model.allow)"#), "Permissions owns the button now")
        XCTAssertTrue(setup.contains("model.tab = .permissions"))
        // The old-grant reset is untouched and still reachable from the new section.
        XCTAssertTrue(setup.contains(#"p.arguments = ["reset", "Accessibility", "com.baney.polycarp"]"#))
        XCTAssertTrue(setup.contains("run: model.fixPermission"))
    }

    func testTheHelperNeverTakesFocusAndOnlyReadsTheWindowList() throws {
        let helper = try Repo.code("Sources/BaneySpaces/Permissions/DragHelper.swift")
        XCTAssertTrue(helper.contains(".nonactivatingPanel"))
        XCTAssertTrue(helper.contains("override var canBecomeKey: Bool { false }"))
        XCTAssertTrue(helper.contains("override var canBecomeMain: Bool { false }"))
        XCTAssertTrue(helper.contains("hidesOnDeactivate = false"), "it must stay up while System Settings is in front")
        XCTAssertTrue(helper.contains("orderFrontRegardless()"))
        XCTAssertTrue(helper.contains("CGWindowListCopyWindowInfo"))
        XCTAssertTrue(helper.contains("Chrome.duration("), "fades follow the theme and Reduce Motion")
        XCTAssertTrue(helper.contains("accessibilityReduceMotion"))
        XCTAssertTrue(helper.contains("NSDraggingItem(pasteboardWriter: url as NSURL)"), "the drag carries the app's file URL")
        for file in ["DragHelper", "PermissionsPane", "PermissionsModel"] {
            let code = try Repo.code("Sources/BaneySpaces/Permissions/\(file).swift")
            for banned in ["makeKeyAndOrderFront", "NSApp.activate", "tccutil", "NSAppleScript", "osascript", "AXUIElementCreateApplication",
                           "CGEvent(", "AXUIElementPerformAction", "AXUIElementSetAttributeValue"] {
                XCTAssertFalse(code.contains(banned), "\(file) uses \(banned): the helper never acts on System Settings or takes focus")
            }
        }
    }

    func testThePaneReadsOnlyWhileSomeoneCanSeeIt() throws {
        let model = try Repo.code("Sources/BaneySpaces/Permissions/PermissionsModel.swift")
        XCTAssertTrue(model.contains("occlusionState.contains(.visible)"))
        XCTAssertTrue(model.contains("guard shouldRead else { timer?.invalidate(); timer = nil; return }"))
        XCTAssertTrue(model.contains("timeInterval: 1,"), "a change in System Settings shows within about a second")
        XCTAssertTrue(model.contains("AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false)"),
                      "reading Automation never asks")
    }

    func testTheWelcomeWindowUsesTheSameRowAndButton() throws {
        let welcome = try Repo.code("Sources/BaneySpaces/WelcomeWindow.swift")
        XCTAssertTrue(welcome.contains("PermissionRowView("))
        XCTAssertTrue(welcome.contains("PermissionsModel.shared.perform(id)"))
        XCTAssertFalse(welcome.contains("CGRequestScreenCaptureAccess"), "one place asks macOS: PermissionsModel")
    }
}
