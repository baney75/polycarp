import XCTest
@testable import BaneySpacesCore

final class BrowserConnectResultTests: XCTestCase {
    private func parse(_ json: String) -> BrowserConnectResult? { BrowserConnectResult.parse(Data(json.utf8)) }

    func testOnAnswerCarriesTheAddressAndThePasscodeOnce() throws {
        let r = try XCTUnwrap(parse(#"{"ok":true,"state":"on","message":"Connected.","connectorUrl":"https://pc-abc.example.com/mcp","hostname":"pc-abc.example.com","passcode":"aaaaa-bbbbb-ccccc-ddddd"}"#))
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.state, .on)
        XCTAssertEqual(r.connectorURL, "https://pc-abc.example.com/mcp")
        XCTAssertEqual(r.passcode, "aaaaa-bbbbb-ccccc-ddddd")
        XCTAssertTrue(r.showsConnector)
    }

    func testTheRoomStatesUseTheProductsFixedWords() throws {
        let full = try XCTUnwrap(parse(#"{"ok":false,"state":"at_capacity","message":"anything the helper says"}"#))
        XCTAssertEqual(full.headline, "Polycarp's free connections are full right now. Join the waitlist, or enter an invite code.")
        XCTAssertTrue(full.offersWaitlist)
        let invite = try XCTUnwrap(parse(#"{"ok":false,"state":"invite_only","message":"x"}"#))
        XCTAssertEqual(invite.headline, BrowserConnectResult.inviteWords)
        XCTAssertTrue(invite.offersWaitlist)
        let paused = try XCTUnwrap(parse(#"{"ok":false,"state":"paused","message":"x"}"#))
        XCTAssertEqual(paused.headline, BrowserConnectResult.pausedWords)
        XCTAssertFalse(paused.offersWaitlist)
        let bad = try XCTUnwrap(parse(#"{"ok":false,"state":"invite_invalid","message":"That invite code isn't valid, or it was already used."}"#))
        XCTAssertEqual(bad.headline, "That invite code isn't valid, or it was already used.")
        XCTAssertTrue(bad.offersWaitlist, "a bad code can try again or join the waitlist")
    }

    func testOfflineAndProblemShowTheHelpersPlainSentence() throws {
        XCTAssertEqual(try XCTUnwrap(parse(#"{"ok":false,"state":"offline","message":"Can't reach Polycarp's connection service. Check your internet connection and try again."}"#)).headline,
                       "Can't reach Polycarp's connection service. Check your internet connection and try again.")
        XCTAssertEqual(try XCTUnwrap(parse(#"{"ok":false,"state":"problem","message":""}"#)).headline, "Something went wrong. Try again.")
    }

    func testNothingTheWindowSaysMentionsTunnels() throws {
        for state in ["at_capacity", "invite_only", "paused", "on", "connecting", "off"] {
            let r = try XCTUnwrap(parse(#"{"ok":true,"state":"\#(state)","message":""}"#))
            XCTAssertFalse(r.headline.lowercased().contains("tunnel"), state)
        }
    }

    func testReadsTheLastJSONLineAndIgnoresNoise() throws {
        let r = try XCTUnwrap(parse("Getting the helper…\n{\"ok\":false,\"state\":\"offline\",\"message\":\"m\"}\n"))
        XCTAssertEqual(r.state, .offline)
        XCTAssertNil(parse("polycarp: command not found"))
        XCTAssertNil(parse(#"{"ok":true,"state":"nonsense"}"#))
        XCTAssertNil(parse(""))
    }

    func testStatusChecksComeThrough() throws {
        let r = try XCTUnwrap(parse(#"{"ok":false,"state":"problem","message":"m","checks":[{"name":"connection","status":"fail","detail":"not running"},{"name":"passcode","status":"ok","detail":"set"}]}"#))
        XCTAssertEqual(r.checks, [.init(name: "connection", status: "fail", detail: "not running"), .init(name: "passcode", status: "ok", detail: "set")])
    }

    func testHelperArgumentsAreSeparateWordsAndNeverASingleString() {
        XCTAssertEqual(BrowserConnectResult.Action.status.arguments, ["connect", "status", "--json"])
        XCTAssertEqual(BrowserConnectResult.Action.on(invite: nil, newPasscode: false).arguments, ["connect", "on", "--json"])
        XCTAssertEqual(BrowserConnectResult.Action.on(invite: "PC-AAAA-BBBB", newPasscode: true).arguments, ["connect", "on", "--json", "--invite", "PC-AAAA-BBBB", "--new-passcode"])
        XCTAssertEqual(BrowserConnectResult.Action.off.arguments, ["connect", "off", "--json"])
        XCTAssertEqual(BrowserConnectResult.Action.waitlist(email: "me@example.com").arguments, ["connect", "waitlist", "me@example.com", "--json"])
    }

    func testOnlyWellFormedEmailsAndInviteCodesAreSent() {
        XCTAssertTrue(BrowserConnectResult.looksLikeEmail("me@example.com"))
        XCTAssertTrue(BrowserConnectResult.looksLikeEmail("  me@example.com "))
        for bad in ["", "me", "me@", "@example.com", "me@example", "me @example.com", "me@@example.com", "-flag@example.com", "me@.com"] {
            XCTAssertFalse(BrowserConnectResult.looksLikeEmail(bad), bad)
        }
        XCTAssertEqual(BrowserConnectResult.cleanInvite(" pc-abcd-efgh-ijkl-mnop "), "PC-ABCD-EFGH-IJKL-MNOP")
        XCTAssertNil(BrowserConnectResult.cleanInvite("--json"))
        XCTAssertNil(BrowserConnectResult.cleanInvite("short"))
        XCTAssertNil(BrowserConnectResult.cleanInvite("PC-ABCD EFGH; rm -rf"))
    }

    func testConnectingTakesAMinuteNotForever() {
        XCTAssertGreaterThan(BrowserConnectResult.Action.on(invite: nil, newPasscode: false).timeout, BrowserConnectResult.Action.status.timeout)
    }
}

/// Source checks for the window, which can't run in a test: it is off until clicked, says nothing about tunnels,
/// and reaches the Browser tab with one line.
final class BrowserConnectViewSourceTests: XCTestCase {
    private func source(_ name: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("Sources/BaneySpaces/\(name)"), encoding: .utf8)
    }

    func testTheBrowserTabHasOneLineHookAndNothingElseOfTheView() throws {
        let tab = try source("BrowserSetup.swift")
        XCTAssertEqual(tab.components(separatedBy: "BrowserConnectView()").count - 1, 1)
        XCTAssertFalse(tab.contains("BrowserConnectModel"), "the tab only places the view")
    }

    func testOpeningTheTabOnlyReadsTheState() throws {
        let view = try source("BrowserConnectView.swift")
        let onAppear = try XCTUnwrap(view.range(of: ".onAppear {"))
        let line = view[onAppear.lowerBound...].prefix(while: { $0 != "\n" })
        XCTAssertTrue(line.contains("model.refresh()"), String(line))
        XCTAssertFalse(line.contains("connect"), "nothing turns on by itself")
    }

    func testOnlyButtonsTurnItOn() throws {
        let view = try source("BrowserConnectView.swift")
        for line in view.split(separator: "\n") where line.contains("model.connect(") {
            XCTAssertTrue(line.contains("Button("), "model.connect( must sit in a button: \(line)")
        }
    }

    func testThePlainWordsNeverSayTunnel() throws {
        XCTAssertFalse(try source("BrowserConnectView.swift").lowercased().contains("tunnel"))
        XCTAssertFalse(String(describing: BrowserConnectResult.fullWords + BrowserConnectResult.inviteWords + BrowserConnectResult.pausedWords).lowercased().contains("tunnel"))
    }

    func testItUsesTheChromeTokensNotHardCodedColors() throws {
        let view = try source("BrowserConnectView.swift")
        XCTAssertTrue(view.contains("Chrome.font("))
        XCTAssertTrue(view.contains("Chrome.shape(.settingsCell"))
        XCTAssertFalse(view.contains("Color(red:"))
        XCTAssertFalse(view.contains("Color(hex"))
        XCTAssertFalse(view.contains(".system(size:"))
    }
}
