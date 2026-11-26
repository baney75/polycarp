import XCTest
@testable import BaneySpacesCore

/// Window rules: float, tile, pin or a workspace, by app and words of a title.
final class TileRuleTests: XCTestCase {
    private func rule(_ line: String) -> TileRule { try! TileRule.read(line).get() }

    func testALineReadsAndWritesBack() {
        XCTAssertEqual(rule("com.apple.Notes 3"), TileRule(bundle: "com.apple.Notes", action: .workspace(3)))
        XCTAssertEqual(rule("com.apple.Safari  float  Picture in Picture"),
                       TileRule(bundle: "com.apple.Safari", action: .float, title: "Picture in Picture"))
        XCTAssertEqual(rule("com.apple.Music pin").action, .pin)
        XCTAssertEqual(rule("com.apple.Music tile").action, .tile)
        XCTAssertEqual(rule("com.apple.Safari float Picture in Picture").line, "com.apple.Safari float Picture in Picture")
        XCTAssertEqual(rule("com.apple.Notes 9").line, "com.apple.Notes 9")
        for bad in ["", "com.apple.Notes", "com.apple.Notes 0", "com.apple.Notes 10", "com.apple.Notes 03", "com.apple.Notes hide",
                    "bad id! float", "com.apple.Notes float " + String(repeating: "x", count: 200)] {
            guard case .failure(let p) = TileRule.read(bad) else { return XCTFail(bad) }
            XCTAssertFalse(p.message.isEmpty)
        }
        // Only the app is wrong: the line says so.
        for bad in ["com/apple/Notes float", "-notes 3", "notes!app pin"] {
            guard case .failure(let p) = TileRule.read(bad) else { return XCTFail(bad) }
            XCTAssertTrue(p.message.contains("bundle id"), bad)
        }
    }

    func testARuleMatchesItsAppAndWordsOfTheTitle() {
        let pip = rule("com.apple.Safari float picture in picture")
        XCTAssertTrue(pip.matches(bundle: "com.apple.Safari", title: "Picture in Picture"))
        XCTAssertTrue(pip.matches(bundle: "com.apple.safari", title: "A Picture in Picture window"))
        XCTAssertFalse(pip.matches(bundle: "com.apple.Safari", title: "Start Page"))
        XCTAssertFalse(pip.matches(bundle: "com.apple.Notes", title: "Picture in Picture"))
        XCTAssertTrue(rule("com.apple.Notes 3").matches(bundle: "com.apple.Notes", title: ""))
    }

    func testTheFirstFloatOrTileRuleWinsThenTheListThenTheBuiltIns() {
        let r = TileRules([rule("com.apple.Safari tile Docs"), rule("com.apple.Safari float"), rule("com.apple.calculator tile")],
                          float: ["com.apple.Notes"])
        XCTAssertFalse(r.floats(bundle: "com.apple.Safari", title: "Docs home"))
        XCTAssertTrue(r.floats(bundle: "com.apple.Safari", title: "News"))
        XCTAssertTrue(r.floats(bundle: "com.apple.Notes", title: ""))
        XCTAssertFalse(r.floats(bundle: "com.apple.calculator", title: ""), "a tile rule tiles a built-in")
        XCTAssertTrue(r.floats(bundle: "com.apple.Stickies", title: ""))
        XCTAssertTrue(TileRules().floats(bundle: "com.apple.Calculator", title: ""), "bundle ids in any case")
        XCTAssertFalse(TileRules().floats(bundle: "com.apple.Terminal", title: ""))
        // A rule that places a window says nothing of floating, and a float rule nothing of where it goes.
        let p = TileRules([rule("com.apple.Music 4"), rule("com.apple.Music float"), rule("com.apple.Music pin")])
        XCTAssertTrue(p.floats(bundle: "com.apple.Music", title: ""))
        XCTAssertEqual(p.placement(bundle: "com.apple.Music", title: ""), .workspace(4))
        XCTAssertNil(TileRules([rule("com.apple.Music float")]).placement(bundle: "com.apple.Music", title: ""))
        XCTAssertEqual(TileRules([rule("com.apple.Music float"), rule("com.apple.Music pin")]).placement(bundle: "com.apple.Music", title: ""), .pin)
    }

    func testANewWindowGoesWhereItsRuleSaysButNeverToOrFromTheAgent() {
        let r = TileRules([rule("com.apple.Notes 3"), rule("com.apple.Music pin"), rule("com.apple.Mail 9")])
        func place(_ bundle: String, at here: Int = 1, agentApp: Bool = false, waits: Bool = false) -> TileRules.Placed {
            r.place(bundle: bundle, title: "", at: here, agent: 9, agentApp: agentApp, waits: waits)
        }
        XCTAssertEqual(place("com.apple.Notes"), .to(3))
        XCTAssertEqual(place("com.apple.Music"), .pin)
        XCTAssertEqual(place("com.apple.Notes", at: 3), .stay, "already there")
        XCTAssertEqual(place("com.apple.Mail"), .stay, "never to the agent workspace")
        XCTAssertEqual(place("com.apple.Notes", at: 9), .stay, "never from it")
        XCTAssertEqual(place("com.apple.Music", at: 9), .stay)
        XCTAssertEqual(place("com.apple.Notes", agentApp: true), .stay, "an app working there stays with its windows")
        XCTAssertEqual(place("com.apple.Notes", waits: true), .stay, "a window that waits on you stays with its app")
        XCTAssertEqual(place("com.apple.Safari"), .stay)
        XCTAssertEqual(TileRules([rule("com.apple.Mail 9")]).place(bundle: "com.apple.Mail", title: "", at: 1, agent: nil, agentApp: false, waits: false), .to(9))
    }

    func testTheEngineFloatsByTheRulesAndKeepsItsFirstAnswer() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.rules = [self.rule("app float Inspector"), self.rule("calc tile")]; $0.floatApps = ["calc"] })
        f.open(1); f.open(2, bundle: "calc"); f.open(3)
        f.wins[1]!.w.title = "Main"
        f.wins[3]!.w.title = "Inspector"
        f.focused = 1
        f.rest()
        XCTAssertEqual(Set(f.tiled(1)), [1, 2], "a tile rule wins over the float list; the inspector floats")
        // A title that changes later moves no window in or out.
        f.wins[3]!.w.title = "Main"
        f.wins[1]!.w.title = "Inspector"
        XCTAssertEqual(f.rest(), 0)
        XCTAssertEqual(Set(f.tiled(1)), [1, 2])
        // A tab that takes a window's place keeps what the rules said of it.
        f.engine.rename(3, to: 9)
        XCTAssertEqual(f.engine.ruling[9], true)
        f.engine.rename(9, to: 3)
        // Tiling it by hand holds against its first answer, not its title now.
        f.engine.setFloating(3, false)
        f.rest()
        XCTAssertEqual(Set(f.tiled(1)), [1, 2, 3])
        // New rules are read again for every window; the hand's choice still holds.
        f.engine.apply(FakeWindows.options { $0.rules = [self.rule("calc float")] })
        f.rest()
        XCTAssertEqual(Set(f.tiled(1)), [1, 3])
        // A window that closed is forgotten.
        f.wins[3] = nil
        f.rest()
        XCTAssertNil(f.engine.ruling[3])
        XCTAssertNotNil(f.engine.ruling[1])
    }

    /// A brand-new window may have no title yet: its app's title rule waits for one instead of deciding without it.
    func testAWindowWithNoTitleYetWaitsForIt() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.rules = [self.rule("app float Inspector")] })
        f.open(1); f.open(2)
        f.focused = 1
        f.rest()
        XCTAssertEqual(Set(f.tiled(1)), [1, 2])
        f.wins[2]!.w.title = "Inspector"
        f.rest()
        XCTAssertEqual(f.tiled(1), [1], "the title came: it floats")
        // Only an app with a title rule waits; any other is decided at once.
        f.engine.apply(FakeWindows.options { $0.rules = [self.rule("other float Inspector")] })
        f.open(3, bundle: "other"); f.open(4, bundle: "plain")
        f.rest()
        XCTAssertNil(f.engine.ruling[3])
        XCTAssertEqual(f.engine.ruling[4], false)
        XCTAssertEqual(f.engine.ruling[1], false, "new rules, read again")
    }

    func testFloatingAWindowByHandIsKeptAgainstTheRules() {
        var f = FakeWindows()
        f.engine.apply(FakeWindows.options { $0.rules = [self.rule("app float Inspector")] })
        f.open(1); f.open(2)
        f.wins[2]!.w.title = "Inspector"
        f.focused = 2
        f.rest()
        XCTAssertEqual(f.tiled(1), [1])
        f.engine.setFloating(2, false)
        f.rest()
        XCTAssertEqual(Set(f.tiled(1)), [1, 2])
        XCTAssertEqual(f.engine.choice[2], false, "tiled against its rule")
        f.engine.setFloating(2, true)
        XCTAssertNil(f.engine.choice[2], "floating is what its rule says: no choice is kept")
    }

    func testTheSettingChecksEveryLine() throws {
        XCTAssertEqual(Surfaces.defaults.tiling.rules, [])
        XCTAssertEqual(Surfaces.defaults.tiling.float, [], "the small utilities are built in")
        let schema = Surfaces.schema.at(["properties", "tiling", "properties", "rules"])
        XCTAssertEqual(schema?.at(["uniqueItems"]), .bool(true))
        XCTAssertEqual(schema?.at(["items", "maxLength"]), .number(Double(TileRule.longest)))
        func check(_ json: String) -> (Surfaces.Tiling?, String) {
            guard case .success(let v) = SurfaceValue.parse(Data(json.utf8)) else { return (nil, "no JSON") }
            switch Surfaces.check(v) {
            case .success(let c): return (c.surfaces.tiling, "")
            case .failure(let e): return (nil, "\(e)")
            }
        }
        let ok = try XCTUnwrap(check(#"{"tiling":{"rules":["com.apple.Notes 3","com.apple.Safari float Picture in Picture"]}}"#).0)
        XCTAssertEqual(ok.rules.count, 2)
        XCTAssertEqual(TilingOptions(ok, agentWorkspace: nil).rules.map(\.line), ["com.apple.Notes 3", "com.apple.Safari float Picture in Picture"])
        for bad in [#"["com.apple.Notes 12"]"#, #"["com.apple.Notes 3","com.apple.Notes 3"]"#, #"[3]"#, #""com.apple.Notes 3""#] {
            let (t, why) = check(#"{"tiling":{"rules":\#(bad)}}"#)
            XCTAssertNil(t, bad)
            XCTAssertTrue(why.contains("tiling.rules"), why)
        }
    }

    /// Spaces applies a new window's rule right after the agent's claims, to windows no claim took, and traces no title.
    func testSpacesPlacesNewWindowsByTheRulesAfterClaims() throws {
        let code = try SourceText.code("Sources/BaneySpaces/Spaces.swift")
        XCTAssertTrue(code.contains("returned = placeClaimed(fresh, claimed: &claimed) || returned\n            returned = placeByRule(fresh.filter { !claimed.contains($0) }) || returned"))
        let claim = try XCTUnwrap(SourceText.block(after: "private func placeClaimed(", in: code))
        XCTAssertTrue(claim.contains("claimed.insert(id)\n            guard WaitingWindow.claimKeeps"), "a claimed window is the agent's, even one that waits")
        let place = try XCTUnwrap(SourceText.block(after: "private func placeByRule(", in: code))
        XCTAssertTrue(place.contains("rules.place(bundle: bundle, title: title(of: id), at: here, agent: agent, agentApp: agentApp, waits: waits)"))
        XCTAssertTrue(place.contains("model.workspace(of: $0.id) == a"))
        XCTAssertTrue(place.contains("$0.id == id && $0.modal == true"))
        XCTAssertTrue(place.contains("away = away || !model.isShown(n)"))
        XCTAssertTrue(place.contains("pin(id, true)"))
        for line in place.components(separatedBy: "\n") where line.contains("Trace.log") {
            XCTAssertFalse(line.contains("title"), line)
        }
        // Titles reach the engine only when a rule has words of one.
        let look = try XCTUnwrap(SourceText.block(after: "func look()", in: SourceText.code("Sources/BaneySpaces/Tiling.swift")))
        XCTAssertTrue(look.contains("if titled { facts[i].title = spaces.title(of: facts[i].id) }"))
        XCTAssertTrue(look.contains("let titled = engine.options.rules.contains { $0.title != nil }"))
    }
}
