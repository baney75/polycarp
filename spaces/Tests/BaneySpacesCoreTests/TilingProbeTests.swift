import XCTest
@testable import BaneySpacesCore

/// spec/tiling-speed.md R-TS12, cases 42 to 61.
final class TilingProbeTests: XCTestCase {
    private func options(probing: Bool = false) -> TilingOptions {
        var s = Surfaces.defaults.tiling
        (s.enabled, s.on, s.off) = (false, [3, 9], [])
        var o = TilingOptions(s, agentWorkspace: 9)
        o.probing = probing
        return o
    }

    private func start(_ args: [String], agent: Int? = 9, running: Bool = false, active: Bool = true) -> TilingProbe.Start {
        TilingProbe.start(args, agentWorkspace: agent, running: running, active: active, alive: { $0 == 4242 })
    }

    private func code(_ s: TilingProbe.Start) -> String? {
        if case .refused(let r) = s { return r.info?["code"] }
        return nil
    }

    private func ask(_ s: TilingProbe.Start) -> TilingProbe.Ask? {
        if case .go(let a) = s { return a }
        return nil
    }

    private var session: TilingProbe.Session { TilingProbe.Session(.init(caller: 4242, rounds: 3, seconds: 180), workspace: 9, now: 100) }

    // MARK: R-TS12.13, R-TS12.3

    func testCase42AgentWorkspaceNeverTilesWithoutAProbe() {
        XCTAssertFalse(options().tiles(9), "even when the settings name it")
        XCTAssertTrue(options().tiles(3))
    }

    func testCase43AProbeTilesTheAgentWorkspaceAndNothingElseChanges() {
        XCTAssertTrue(options(probing: true).tiles(9))
        for n in Workspaces.range where n != 9 { XCTAssertEqual(options(probing: true).tiles(n), options().tiles(n), "workspace \(n)") }
        var s = Surfaces.defaults.tiling
        (s.enabled, s.on) = (false, [])
        var o = TilingOptions(s, agentWorkspace: 9)
        o.probing = true
        XCTAssertTrue(o.tiles(9), "a probe tiles it even when no setting tiles anything")
    }

    func testCase44ASettingsReloadKeepsTheProbeAndFreshOptionsHaveNone() {
        let reloaded = options(probing: true).reloaded(Surfaces.defaults.tiling, agentWorkspace: 9)
        XCTAssertTrue(reloaded.probing)
        XCTAssertTrue(reloaded.tiles(9))
        XCTAssertFalse(TilingOptions(Surfaces.defaults.tiling, agentWorkspace: 9).probing)
        XCTAssertFalse(options().reloaded(Surfaces.defaults.tiling, agentWorkspace: 9).probing)
        // The agent workspace moved to 4 mid-probe: the reload never tiles 4, not even until the session sees it.
        let moved = options(probing: true).reloaded(Surfaces.defaults.tiling, agentWorkspace: 4)
        XCTAssertFalse(moved.probing)
        XCTAssertFalse(moved.tiles(4))
    }

    func testCase45TileOnAndToggleOfTheAgentWorkspaceAreRefusedDuringAProbe() {
        let o = options(probing: true)
        XCTAssertEqual(o.refusesTurning(9), "the agent workspace never tiles")
        XCTAssertNil(o.refusesTurning(3))
        var engine = TilingEngine()
        engine.apply(o)
        XCTAssertEqual(engine.run(.toggle, on: 9, focused: nil), .nothing("the agent workspace never tiles"))
        XCTAssertEqual(engine.options, o, "nothing changed, so nothing is written to surfaces.json")
    }

    // MARK: R-TS12.4

    func testCase46TheAreaHangsLeftOfTheOnlyDisplay() {
        let a = TilingProbe.area(screens: [CGRect(x: 0, y: 0, width: 1512, height: 982)], usable: CGRect(x: 0, y: 40, width: 1512, height: 934))
        XCTAssertEqual(a, CGRect(x: -3512, y: 40, width: 1512, height: 934))
        XCTAssertTrue(Geometry.isStranded(a, screens: [CGRect(x: 0, y: 0, width: 1512, height: 982)]))
    }

    func testCase47TheAreaHangsLeftOfTheLeftmostDisplay() {
        let screens = [CGRect(x: -1920, y: 0, width: 1920, height: 1080), CGRect(x: 0, y: 0, width: 1512, height: 982)]
        let a = TilingProbe.area(screens: screens, usable: CGRect(x: 0, y: 40, width: 1512, height: 934))
        XCTAssertEqual(a.maxX, -3920)
        XCTAssertTrue(Geometry.isStranded(a, screens: screens))
    }

    // MARK: R-TS12.2

    func testCase48SecondsOutOfRangeAreBadAndMissingIs180() {
        XCTAssertEqual(code(start(["start", "4242", "3", "900"])), "bad_request")
        XCTAssertEqual(code(start(["start", "4242", "3", "0"])), "bad_request")
        XCTAssertEqual(ask(start(["start", "4242", "3"]))?.seconds, 180)
        XCTAssertEqual(ask(start(["start", "4242", "3", ""]))?.seconds, 180)
        XCTAssertEqual(code(start(["start", "77", "3", "10"])), "bad_request", "a caller already gone")
        XCTAssertEqual(code(start(["start", "x"])), "bad_request")
    }

    func testCase49RoundsOutOfRangeAreBadAndMissingIs3() {
        XCTAssertEqual(code(start(["start", "4242", "0"])), "bad_request")
        XCTAssertEqual(code(start(["start", "4242", "11"])), "bad_request")
        XCTAssertEqual(ask(start(["start", "4242"])), .init(caller: 4242, rounds: 3, seconds: 180))
    }

    func testCase50NoAgentWorkspaceIsRefused() {
        XCTAssertEqual(code(start(["start", "4242"], agent: nil)), "agent_workspace_off")
        XCTAssertEqual(code(start(["start", "4242"], active: false)), "probe_off")
    }

    func testCase51AProbeWhileOneRunsIsBusy() {
        XCTAssertEqual(code(start(["start", "4242"], running: true)), "probe_busy")
    }

    // MARK: R-TS12.9

    func testCase52TheCallerExitingEndsIt() {
        var s = session
        XCTAssertEqual(s.reply.info, ["state": "running"])
        XCTAssertTrue(s.end(.caller))
        XCTAssertEqual(s.reply.info, ["state": "ended", "why": "caller"])
        XCTAssertFalse(s.end(.done, result: "[]"), "the first end holds")
    }

    func testCase53TheDeadlineEndsIt() {
        XCTAssertNil(session.check(now: 279, active: true, agentWorkspace: 9))
        XCTAssertEqual(session.check(now: 280, active: true, agentWorkspace: 9), .deadline)
        let long = TilingProbe.Session(.init(caller: 1, rounds: 1, seconds: 900), workspace: 9, now: 0)
        XCTAssertEqual(long.deadline, 300, "never more than 300 s")
    }

    func testCase54TheAgentWorkspaceChangingEndsIt() {
        XCTAssertEqual(session.check(now: 101, active: true, agentWorkspace: 4), .workspace)
        XCTAssertEqual(session.check(now: 101, active: true, agentWorkspace: nil), .workspace)
        XCTAssertEqual(session.check(now: 101, active: false, agentWorkspace: 9), .inactive)
    }

    func testCase55AnyEndTurnsTheProbeOff() {
        for why in [TilingProbe.Why.done, .deadline, .caller, .inactive, .workspace, .error] {
            var s = session
            var o = options(probing: s.running)
            XCTAssertTrue(o.tiles(9))
            _ = s.end(why, result: "[]")
            o.probing = s.running
            XCTAssertFalse(o.tiles(9), why.rawValue)
        }
        XCTAssertEqual(TilingProbe.none.info?["state"], "ended", "a daemon that restarted has no probe")
    }

    // MARK: R-TS12.7

    func testCase56AProbeWindowJoinsTheAgentWorkspace() {
        var m = Workspaces()
        _ = m.switchTo(2)
        let added = m.sync(seen: [50], alive: [50])
        let homes = TilingProbe.homes(added.map { ($0, 700) }, probe: [700], agent: 9)
        XCTAssertEqual(homes, [50: 9])
        for (id, n) in homes { m.assign(id, to: n, focus: false) }
        XCTAssertEqual(m.workspace(of: 50), 9)
        XCTAssertEqual(m.current, 2)
    }

    func testCase57AnotherAppsWindowGoesTheUsualWay() {
        XCTAssertEqual(TilingProbe.homes([(51, 800)], probe: [700], agent: 9), [:])
        XCTAssertEqual(TilingProbe.homes([(50, 700)], probe: [700], agent: nil), [:])
    }

    // MARK: R-TS12.8

    func testCase58AProbeFocusMovesTheEngineFocusAlone() {
        let area = TilingProbe.area(screens: [CGRect(x: 0, y: 0, width: 1512, height: 982)], usable: CGRect(x: 0, y: 40, width: 1512, height: 934))
        var f = FakeWindows(area: area, workspace: 9)
        f.engine.apply(FakeWindows.options { $0.agentWorkspace = 9; $0.probing = true })
        for id in WindowID(1)...3 { f.open(id, pid: 700, workspace: 9, frame: CGRect(x: area.minX + 20, y: area.minY + 60, width: 400, height: 300)); f.focused = id; f.rest() }
        XCTAssertEqual(f.tiled(9).count, 3)
        let step = TilingProbe.step(f.engine.run(.focus(.right), on: 9, focused: 1))
        // The neighbor used last on the right: 3, opened last.
        XCTAssertEqual(step, .focus(3))
        f.engine.focused(1)
        XCTAssertEqual(f.engine.last(on: 9), 1)
        if case .focus(let id) = step { f.engine.focused(id) }
        XCTAssertEqual(f.engine.last(on: 9), 3, "the engine's focus moved")
        // Nothing the probe does focuses an app or leaves its workspace.
        XCTAssertEqual(TilingProbe.step(.cross(.right, carrying: nil)), .nothing("the probe stays on its workspace"))
        XCTAssertEqual(TilingProbe.step(.nextDisplay(2)), .nothing("the probe stays on its workspace"))
        XCTAssertEqual(TilingProbe.step(.toggle), .nothing("the probe stays on its workspace"))
    }

    func testCase59AProbeRefusesEveryOtherCommand() {
        XCTAssertFalse(TilingProbe.allows(.toggle))
        XCTAssertFalse(TilingProbe.allows(.scratchpad))
        XCTAssertFalse(TilingProbe.allows(.toScratchpad))
        XCTAssertFalse(TilingProbe.allows(.cycle(backward: false)))
        for c in TilingProbe.keys { XCTAssertTrue(TilingProbe.allows(c), "\(c)") }
        XCTAssertEqual(TilingProbe.keys.count, 12)
    }

    // MARK: R-TS12.12

    func testCase60PercentilesAreNearestRankAsSpeedReportTakesThem() {
        let stats = TilingProbe.stats([10, 20, 30, 40, 1000].map { TilingProbe.Sample(.new, ms: $0, writes: 1) })
        let new = stats.first { $0.kind == "new" }
        XCTAssertEqual(new?.n, 5)
        XCTAssertEqual(new?.p50, 30)
        XCTAssertEqual(new?.p90, 1000)
        XCTAssertEqual(new?.max, 1000)
        XCTAssertEqual(new?.misses, 0)
        XCTAssertEqual(TilingProbe.code(stats), 0)
        XCTAssertEqual(stats.map(\.kind), ["key focus", "key move", "key resize", "new", "close"])
        XCTAssertEqual(TilingProbe.decode(TilingProbe.json(stats)), stats)
    }

    func testCase61OneMissIsCountedAndFailsTheRun() {
        let samples = [TilingProbe.Sample(.close, ms: 12, writes: 1), .init(.close, ms: nil, writes: 0), .init(.close, ms: 20, writes: 2),
                       .init(.close, ms: 14, writes: 1), .init(.close, ms: 16, writes: 1)]
        let close = TilingProbe.stats(samples).first { $0.kind == "close" }
        XCTAssertEqual(close?.misses, 1)
        XCTAssertEqual(close?.n, 5)
        XCTAssertEqual(close?.writes, 2)
        XCTAssertEqual(TilingProbe.code(TilingProbe.stats(samples)), 1)
    }

    func testCase62ASwitchNeitherHidesNorParksTheProbeHelper() {
        // Helper pid 77 owns 5 and 6 on the agent workspace; his app 40 owns 1 (hidden), app 41 owns 2 (shown).
        let owner: [WindowID: Int32] = [1: 40, 2: 41, 5: 77, 6: 77]
        let plan = SwitchPlan(hide: [1, 5, 6], show: [2], focus: 2)
        let how = Concealment(plan: plan, owner: TilingProbe.switchOwners(owner, probe: [77]))
        XCTAssertFalse(how.hideApps.contains(77))
        XCTAssertFalse(how.park.contains(5))
        XCTAssertFalse(how.park.contains(6))
        XCTAssertTrue(how.hideApps.contains(40))
        // Without the probe, the helper would be hidden like any app with nothing here.
        XCTAssertTrue(Concealment(plan: plan, owner: owner).hideApps.contains(77))
        XCTAssertEqual(TilingProbe.switchOwners(owner, probe: []), owner)
    }

    func testCase63TheAgentWorkspaceInSightRefusesAStartAndEndsAProbe() {
        guard case .refused(let r) = TilingProbe.start(["start", "4242", "", ""], agentWorkspace: 9, running: false, active: true,
                                                     agentInSight: true, alive: { $0 == 4242 }) else { return XCTFail("started") }
        XCTAssertEqual(r.info?["code"], "probe_off")
        let session = TilingProbe.Session(.init(caller: 4242, rounds: 1, seconds: 60), workspace: 9, now: 0)
        XCTAssertNil(session.check(now: 1, active: true, agentWorkspace: 9, agentInSight: false))
        XCTAssertEqual(session.check(now: 1, active: true, agentWorkspace: 9, agentInSight: true), .workspace)
    }
}
