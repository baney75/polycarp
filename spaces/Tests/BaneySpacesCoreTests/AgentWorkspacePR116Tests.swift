import BaneySpacesCore
import Foundation
import XCTest

/// Review round 1 of #116, one class per blocking finding.

/// first-F1: every open that succeeds looks for its window; one with no session reports it owned by nobody, and only a real
/// overlap identifies none, saying so plainly.
final class OpenWithoutSessionTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 7_000_000)
    func win(_ id: UInt32, pid: Int32) -> HandsWindow { HandsWindow(id: id, pid: pid, app: "TextEdit", workspace: 9) }

    func testAnOpenWithNoSessionStillFindsItsWindowAndOwnsNone() {
        var s = SessionWindows()
        XCTAssertEqual(s.beginOpen(id: 1, session: "", app: "TextEdit", separate: true, pid: nil, known: [], at: t0), .noSession)
        s.launched(1, pid: 500)
        XCTAssertEqual(s.claim(1, windows: [win(30, pid: 500)], now: t0)?.id, 30, "agent open TextEdit notes.txt reports its window")
        XCTAssertNil(s.owner(of: 30), "owned by nobody")
    }

    func testANoSessionOpenStillCountsTowardAnOverlapAndNeverTakesALateWindow() {
        var s = SessionWindows()
        XCTAssertEqual(s.beginOpen(id: 1, session: "", app: "Word", separate: false, pid: 300, known: [1], at: t0), .noSession)
        s.endOpen(1)
        XCTAssertEqual(s.beginOpen(id: 2, session: "a", app: "Word", separate: false, pid: 300, known: [1], at: t0.addingTimeInterval(1)), .overlap)
        XCTAssertTrue(s.resolvePending(app: "Word", windows: [win(40, pid: 300)], now: t0.addingTimeInterval(2)).isEmpty)
    }

    func testTheNoteSaysPlainlyThatNoWindowWasIdentifiedAndWhy() {
        XCTAssertTrue(OpenNote.text(.overlap, app: "Word").hasPrefix("Polycarp identified no window"))
        XCTAssertTrue(OpenNote.text(.overlap, app: "Word").contains("still waiting for its window or overlapped one in the last 30 s"))
        XCTAssertFalse(OpenNote.text(.noSession, app: "Word").contains("overlap"), "no session is not blamed on an overlap")
        XCTAssertFalse(OpenNote.text(.owns, app: "Word").contains("overlap"))
    }

    func testTheRouterLooksForTheWindowUnlessTheOpenOverlapped() throws {
        let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/AgentWorkspacePR116Tests.swift", with: "Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("while start != .overlap, window == nil"))
        XCTAssertTrue(src.contains("OpenNote.text(start, app: display)"))
    }
}

/// sol-F1: on a split app, a usable window holding a sheet this session didn't raise is refused; unsure counts as not.
final class SheetOnSplitWindowTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 7_100_000)
    let w = HandsWindow(id: 7, pid: 300, app: "Word", workspace: 9)

    func testASheetFromBeforeTheActionIsNotThisSessions() {
        var a = ChildAttribution()
        a.observedSheets(on: [7], pid: 300, at: t0)
        a.acted(session: "a", pid: 300, at: t0.addingTimeInterval(1), existing: [], sheetsOn: [7])
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(2))
        XCTAssertFalse(a.sheetAttributed(on: 7, pid: 300, session: "a"))
        XCTAssertNotNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [false], split: true))
    }

    func testASheetTheActionRaisedIsThatSessionsUntilItCloses() {
        var a = ChildAttribution()
        a.acted(session: "a", pid: 300, at: t0, existing: [], sheetsOn: [])
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(1))
        XCTAssertTrue(a.sheetAttributed(on: 7, pid: 300, session: "a"))
        XCTAssertFalse(a.sheetAttributed(on: 7, pid: 300, session: "b"))
        XCTAssertNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [true], split: true))
        a.observedSheets(on: [], pid: 300, at: t0.addingTimeInterval(20))
        a.observedSheets(on: [7], pid: 300, at: t0.addingTimeInterval(21))
        XCTAssertFalse(a.sheetAttributed(on: 7, pid: 300, session: "a"), "a sheet that reopened later is not attributed")
    }

    func testUnsureIsRefusedOnASplitAppAndAnUnsplitAppIsUnaffected() {
        XCTAssertFalse(ChildAttribution().sheetAttributed(on: 7, pid: 300, session: "a"), "never seen")
        XCTAssertNotNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [true, false], split: true))
        XCTAssertNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [false], split: false))
        XCTAssertNil(ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: [], split: true))
    }

    func testTheGateChecksSheetsOnPlacedWindows() throws {
        let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/AgentWorkspacePR116Tests.swift", with: "Sources/BaneySpaces/Hands/HandsRouter.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("sheetProblem(now, agent: agent, session: session) ?? inspectProblem(now)"))
    }
}

/// sol-F2, first-F5: a moved-in window whose owner can't be confirmed goes back to Donovan; only a process known gone is dropped.
final class MovedInOwnerTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 7_200_000)
    func entry(started: Double?) -> MovedInWindows.Entry { .init(window: 8, pid: 100, startedAt: started, origin: .lent, from: 2, to: 9) }

    func testAnUnreadableStartTimeIsUnconfirmedNotGone() {
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: nil, alive: true), .unconfirmed)
        XCTAssertEqual(MovedInWindows.owner(entry(started: nil), startTime: 1000, alive: true), .unconfirmed, "first-F5: none read at the move")
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: 1000.1, alive: true), .same)
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: 2000, alive: true), .gone)
        XCTAssertEqual(MovedInWindows.owner(entry(started: 1000), startTime: nil, alive: false), .gone)
    }

    func testAtLaunchAnUnconfirmedEntryIsDeniedAndSentBack() {
        for started in [Double(1000), nil] {
            let l = MovedInWindows.launch([entry(started: started)], startTime: { _ in nil }, alive: { _ in true }, lends: LendBook(), now: now, mode: .full)
            XCTAssertEqual(l.sendBack.map(\.window), [8])
            XCTAssertTrue(l.drop.isEmpty)
            let w = HandsWindow(id: 8, pid: 100, app: "Word", workspace: 9)
            XCTAssertFalse(l.book.decide(w, base: .onAgentWorkspace, lends: LendBook(), now: now, mode: .full).allowed)
        }
    }

    func testSettleSendsAnUnconfirmedWindowBack() throws {
        let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/AgentWorkspacePR116Tests.swift", with: "Sources/BaneySpaces/Hands/HandsMovedIn.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("if who == .gone { b.drop(window: e.window) } else { live.append(e) }"))
    }
}

// MARK: review round 2 of #116

private func source(_ path: String) throws -> String {
    try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/BaneySpacesCoreTests/AgentWorkspacePR116Tests.swift", with: path), encoding: .utf8)
}

/// sol-F1: a child is usable only while its parent window also passes inspection (no outside document, no file panel).
final class ChildParentInspectionTests: XCTestCase {
    func child(parent: UInt32?) -> ChildWindowFacts {
        ChildWindowFacts(id: 50, pid: 300, app: "TextEdit", bundle: "com.apple.TextEdit", processName: "TextEdit", title: "Print",
                         role: "AXWindow", subrole: "AXDialog", modal: true, parent: parent)
    }
    let parent = HandsWindow(id: 7, pid: 300, app: "TextEdit", workspace: 9)

    func testAParentShowingAnOutsideDocumentAuthorizesNoChild() {
        let outside = HandsError(.needsSandbox, "outside document", suggestion: "", retry: .never)
        let placed = ChildWindowRule.inspected([(window: parent, scope: .onAgentWorkspace)]) { _ in outside }
        XCTAssertFalse(placed[0].scope.allowed)
        for p in [UInt32(7), nil] {
            XCTAssertFalse(ChildWindowRule.decide(child(parent: p), placed: placed, attributed: true, selfPid: 1).allowed, "parent \(String(describing: p))")
        }
        let clean = ChildWindowRule.inspected([(window: parent, scope: .onAgentWorkspace)]) { _ in nil }
        XCTAssertTrue(ChildWindowRule.decide(child(parent: 7), placed: clean, attributed: true, selfPid: 1).allowed)
    }

    func testTheRouterInspectsParentsInEveryChildDecision() throws {
        XCTAssertTrue(try source("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift").contains("ChildWindowRule.inspected(all.filter { $0.pid == c.pid }"))
    }
}

/// sol-F2: an open that asked for no window registers no claim, so a later window of the app is nobody's.
final class OpenAskedForNoWindowTests: XCTestCase {
    func testTheReplyKeyAndTheRouterSkip() throws {
        XCTAssertFalse(SessionWindows.asksForWindow([SessionWindows.noWindowKey: "1", "pid": "300"]))
        XCTAssertTrue(SessionWindows.asksForWindow(["pid": "300"]))
        XCTAssertTrue(try source("Sources/BaneySpaces/Session/SessionController.swift").contains("\"pid\": \"\\(pid)\", SessionWindows.noWindowKey: \"1\","))
        let router = try source("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let skip = try XCTUnwrap(router.range(of: "guard SessionWindows.asksForWindow(reply.info) else {"))
        let begin = try XCTUnwrap(router.range(of: "sessionWindows.beginOpen("))
        XCTAssertLessThan(skip.lowerBound, begin.lowerBound, "checked before any claim is registered")
    }

    func testAnUnclaimedPendingEntryExpires() {
        let t0 = Date(timeIntervalSince1970: 7_300_000)
        var s = SessionWindows()
        s.beginOpen(id: 1, session: "a", app: "Word", separate: false, pid: 300, known: [], at: t0)
        s.endOpen(1)
        let later = HandsWindow(id: 40, pid: 300, app: "Word", workspace: 9)
        XCTAssertTrue(s.resolvePending(app: "Word", windows: [later], now: t0.addingTimeInterval(31)).isEmpty)
        XCTAssertTrue(s.requests.isEmpty)
    }
}

/// second-F7: the skill's background recipe parses as written, and a CLI request carries a session that can be set.
final class BackgroundRecipeTests: XCTestCase {
    func testEveryRecipeCommandParsesWithASession() throws {
        let skill = try source("skill/SKILL.md")
        let part = try XCTUnwrap(skill.components(separatedBy: "## Work in the background").dropFirst().first)
        let block = try XCTUnwrap(part.components(separatedBy: "```").dropFirst().first)
        let lines = block.split(separator: "\n").map { String($0.split(separator: "#", maxSplits: 1)[0]).trimmingCharacters(in: .whitespaces) }
        XCTAssertTrue(lines.contains("export BANEYSPACES_SESSION=my-task-name"))
        let commands = lines.filter { $0.hasPrefix("baneyspaces agent ") }
        XCTAssertEqual(commands.count, 5)
        let session = HandsParse.cliSession(environment: ["BANEYSPACES_SESSION": "my-task-name"], tty: "")
        for c in commands {
            let words = c.split(separator: " ").dropFirst(2).map(String.init)
            switch HandsParse.command(words, session: session) {
            case .failure(let e): XCTFail("\(c): \(e.message)")
            case .success(let r): XCTAssertEqual(r.session, "my-task-name", c)
            }
        }
        guard case .success(let close) = HandsParse.command(["close", "--window", "4211"], session: session) else { return XCTFail() }
        XCTAssertEqual(close.int("window"), 4211)
        guard case .success(let reuse) = HandsParse.command(["open", "--new_window=false", "TextEdit"], session: session) else { return XCTFail("the skill's reuse flag") }
        XCTAssertEqual(reuse.bool("new_window"), false)
    }

    func testTheCLISessionComesFromTheEnvironmentThenTheTerminal() {
        XCTAssertEqual(HandsParse.cliSession(environment: ["BANEYSPACES_SESSION": "t1"], tty: "/dev/ttys004"), "t1")
        XCTAssertEqual(HandsParse.cliSession(environment: ["BANEYSPACES_SESSION": ""], tty: "/dev/ttys004"), "/dev/ttys004")
        XCTAssertEqual(HandsParse.cliSession(environment: [:], tty: ""), "default", "never empty, so close and attribution work")
    }
}

/// Mediums of round 2.
final class PR116Round2MediumTests: XCTestCase {
    func testTwoSessionsActingOnOneAppAttributeANewDialogToNeither() {
        let t0 = Date(timeIntervalSince1970: 7_400_000)
        var a = ChildAttribution()
        a.acted(session: "A", pid: 300, at: t0, existing: [])
        a.acted(session: "B", pid: 300, at: t0.addingTimeInterval(1), existing: [])
        a.observed([50], pid: 300, at: t0.addingTimeInterval(2))
        XCTAssertFalse(a.attributed(50, pid: 300, session: "A"))
        XCTAssertFalse(a.attributed(50, pid: 300, session: "B"))
        // B looked after it appeared: only A could have raised it.
        var b = ChildAttribution()
        b.acted(session: "A", pid: 300, at: t0, existing: [])
        b.acted(session: "B", pid: 300, at: t0.addingTimeInterval(1), existing: [51])
        b.observed([51], pid: 300, at: t0.addingTimeInterval(2))
        XCTAssertTrue(b.attributed(51, pid: 300, session: "A"))
    }

    func testANonEnglishSaveSheetIsRefusedOnShape() {
        let sheet = AXNodeInfo(role: "AXSheet", children: [AXNodeInfo(role: "AXStaticText", value: "Sichern unter:"), AXNodeInfo(role: "AXTextField"),
                                                           AXNodeInfo(role: "AXStaticText", value: "Ort:"), AXNodeInfo(role: "AXPopUpButton")])
        XCTAssertTrue(PanelDetector.looksLikeFilePanel(sheet))
    }

    func testChildReadsOnTheMainThreadRunOneAtATime() throws {
        XCTAssertTrue(try source("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift").contains("if Thread.isMainThread { for i in list.indices { readings[i] = readChildren("))
    }
}

/// PR #119 review round 1.
final class PR119Round1Tests: XCTestCase {
    func testCloseWaitsForTheProcessQueueAndRefusesWhenItIsBusy() throws {
        let ws = try source("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let serial = try XCTUnwrap(ws.range(of: "switch HandsEngine.shared.serialized(pid: w.pid, wait: Thread.isMainThread ? 0 : 10, {"))
        let press = try XCTUnwrap(ws.range(of: "cancelled() ? .failure(busy) : .success(host.close(w.id))"))
        XCTAssertLessThan(serial.lowerBound, press.lowerBound, "sol-F1: the close button is pressed only on the process's queue")
        XCTAssertTrue(ws.contains("}) ?? .failure(busy) {"), "and refused when the queue isn't free")
        XCTAssertTrue(try source("Sources/BaneySpaces/Hands/HandsEngine.swift").contains("queue(for: pid).async {\n            defer { done.signal() }\n            if cancelled() { return }"))
    }

    func testASheetsAppIsSplitWhenAnyWindowFailsInspection() throws {
        let ws = try source("Sources/BaneySpaces/Hands/HandsRouter+Workspaces.swift")
        let fn = try XCTUnwrap(ws.components(separatedBy: "func sheetProblem(").dropFirst().first?.components(separatedBy: "\n    }\n").first)
        XCTAssertTrue(fn.contains("ChildWindowRule.inspected(") && fn.contains("guard placed.contains(where: { !$0.scope.allowed })"), "sol-F2")
    }

    func testAReusedWindowNumberIsJudgedAfresh() {
        let t0 = Date(timeIntervalSince1970: 7_500_000)
        var a = ChildAttribution()
        a.acted(session: "A", pid: 300, at: t0, existing: [])
        a.observed([50], pid: 300, at: t0.addingTimeInterval(1), parents: [50: 7])
        XCTAssertTrue(a.attributed(50, pid: 300, session: "A"))
        a.observed([], pid: 300, at: t0.addingTimeInterval(30))
        a.observed([50], pid: 300, at: t0.addingTimeInterval(60))
        XCTAssertFalse(a.attributed(50, pid: 300, session: "A"), "sol-F3: the second appearance is nobody's")
        XCTAssertNil(a.parent(of: 50, pid: 300), "and keeps no parent from the first")
    }
}
