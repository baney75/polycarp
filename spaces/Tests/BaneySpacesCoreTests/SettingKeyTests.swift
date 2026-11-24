import XCTest
@testable import BaneySpacesCore

/// `baneyspaces set appearance.theme omarchy`, `set appearance.palette nord`.
final class SettingKeyTests: XCTestCase {
    func testTheSettingsHaveTheSpecNames() {
        XCTAssertEqual(SettingKey.allCases.map(\.rawValue), ["appearance.theme", "appearance.palette"])
    }

    /// The Workspace Dock was removed (2026-11-23): an agent that still sets or reads its switch hears why, not "no setting".
    func testTheDockSwitchIsRefusedWithWhereItsFeaturesWent() {
        for text in ["false", "true", nil] {
            guard case .refused(let why) = SettingKey.ask(target: "dock.enabled", text: text) else { return XCTFail("dock.enabled \(text ?? "get")") }
            XCTAssertTrue(why.contains("Workspace Dock was removed"), why)
            XCTAssertTrue(why.contains("launcher"), why)
        }
        guard case .refused = SettingKey.ask(target: " Dock.Enabled ", text: "false") else { return XCTFail("case and spaces") }
    }

    func testThemesAndPalettesTakeTheirValues() {
        XCTAssertEqual(SettingKey.ask(target: "appearance.theme", text: "omarchy"), .set(.theme, "omarchy"))
        XCTAssertEqual(SettingKey.ask(target: "appearance.theme", text: "Minimal"), .set(.theme, "minimal"))
        XCTAssertEqual(SettingKey.ask(target: "appearance.palette", text: "auto"), .set(.palette, "auto"))
        XCTAssertEqual(SettingKey.ask(target: "appearance.palette", text: "nord"), .set(.palette, "nord"))
        XCTAssertEqual(SettingKey.ask(target: nil, text: nil), .list)
    }

    func testAWrongValueOrNameIsRefusedWithWhatWouldWork() {
        for (k, v) in [("appearance.theme", "vaporwave"), ("appearance.palette", "nope"), ("nothing", "x")] {
            guard case .refused(let why) = SettingKey.ask(target: k, text: v) else { return XCTFail("\(k) \(v)") }
            XCTAssertFalse(why.isEmpty)
        }
    }

    func testAnEmptyNameIsRefusedWhenAValueCameWithIt() {
        guard case .refused = SettingKey.ask(target: "", text: "omarchy") else { return XCTFail("an unset variable is not 'list everything'") }
        guard case .refused = SettingKey.ask(target: nil, text: "omarchy") else { return XCTFail("a value with no name") }
        XCTAssertEqual(SettingKey.ask(target: "", text: nil), .list)
    }

    func testEveryPaletteTheCatalogHasIsASettableValue() {
        for name in PaletteCatalog.shared.names { XCTAssertEqual(SettingKey.palette.normalized(name), name) }
    }

    /// Donovan, 2026-11-01: "agents should be able to customize in any way they choose."
    func testAnAgentTokenMayChangeHowThisMacLooks() {
        for key in SettingKey.allCases {
            XCTAssertTrue(Remote.allows(Wire.Request(op: .setting, target: key.rawValue, text: "x", caller: "claude")), key.rawValue)
            XCTAssertTrue(Remote.allows(Wire.Request(op: .setting, target: key.rawValue)), key.rawValue)
        }
        // The request, caller included, survives the wire.
        let set = Wire.Request(op: .setting, target: "appearance.palette", text: "nord", caller: "claude-code")
        let back = try? JSONDecoder().decode(Wire.Request.self, from: JSONEncoder().encode(set))
        XCTAssertEqual(back, set)
        XCTAssertEqual(back?.caller, "claude-code")
    }

    func testWorkspaceAndWindowOpsStayUserOnly() {
        for op in [Wire.Request.Op.focus, .open, .send, .notify, .remote, .event] {
            XCTAssertFalse(Remote.allows(Wire.Request(op: op, target: "x", text: "x")), "\(op)")
        }
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "on")))
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "move")))
        XCTAssertFalse(Remote.allows(Wire.Request(op: .agent, text: "windows")))
    }

    func testEachChangeIsLoggedWithItsCallerAndTheLogNeverHoldsTheToken() throws {
        let token = Remote.newToken()
        let fp = Remote.fingerprint(token)
        XCTAssertEqual(fp.count, 8)
        XCTAssertNotEqual(fp, String(token.prefix(8)), "a fingerprint is a hash, not a piece of the token")
        XCTAssertEqual(fp, Remote.fingerprint(token))
        let controller = try Repo.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(controller.contains(#"Trace.log("setting \(key.rawValue)=\(v) by \(r.caller ?? "unnamed caller")")"#))
        let server = try Repo.code("Sources/BaneySpaces/Session/Server.swift")
        XCTAssertTrue(server.contains("Remote.fingerprint(req.token"))
        XCTAssertLessThan(try XCTUnwrap(server.range(of: "req.caller =")).lowerBound, try XCTUnwrap(server.range(of: "req.token = nil")).lowerBound)
        let cli = try Repo.code("Sources/baneyspaces-cli/main.swift")
        XCTAssertTrue(cli.contains("BANEYSPACES_AGENT"))
    }
}
