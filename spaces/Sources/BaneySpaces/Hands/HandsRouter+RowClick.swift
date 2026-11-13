import BaneySpacesCore
import Foundation

// Item 3: a click on a row of an outline, table or list that the press doesn't select falls back to the selection write.
// The reads inside the transaction are inline (no check of their own): the transaction ran the acting check right before
// it started, both actions take it again, and it is asked once more before the write.
extension HandsRouter {
    /// A click on a collection item, in one transaction on the app's queue: read the selection, press, read it again, and
    /// only when the item is still not selected, write the selection on its container and read once more.
    func clickRow(_ w: HandsWindow, scope: ScopeDecision, ref: String, plan: ClickFallback.Plan, session: String, childrenBefore: Set<UInt32>) -> HandsEnvelope {
        var run = ClickFallback.Run()
        var treeBefore: JSONValue?, treeAfter: JSONValue?
        let reply = HandsEngine.shared.transaction(window: w, check: actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session)) { [self] cancelled in
            // The write's check: on the container it writes to, the same one before it and inside it (194 r1 first-F1).
            let writing = actingCheck(w, ref: plan.container, verb: "click", delivery: .headlessAX, session: session)
            // Each read keeps its tree: with no readback, the change it shows is the press's evidence (first-F4).
            func selected(_ tree: inout JSONValue?) -> Bool? {
                guard case .ok(let d) = HandsEngine.shared.snapshotInline(window: w, interactive: plan.view.interactive, compact: plan.view.compact,
                                                                            depth: UInt8(clamping: plan.view.depth), evidence: true) else { return nil }
                tree = d["tree"]
                return ClickFallback.selected(SnapshotRows.rows(of: d["tree"] ?? .null), plan)
            }
            run.before = selected(&treeBefore)
            switch HandsEngine.shared.actInline(window: w, ref: ref, kind: .click, check: actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session), cancelled: cancelled) {
            case .ok(let d): run.press = d
            case .failed(let e): run.pressError = e
            }
            run.afterPress = selected(&treeAfter)
            switch ClickFallback.afterPress(before: run.before, after: run.afterPress, pressError: run.pressError?.code) {
            case .done(let l): run.landed = l
            case .writeSelection:
                guard !cancelled() else { break }
                // A refusal here is kept: its code decides the next call (second-F9).
                if let e = writing() { run.writeError = e; break }
                switch HandsEngine.shared.actInline(window: w, ref: plan.container, kind: .select, text: plan.label, check: writing, cancelled: cancelled) {
                case .ok(let d): run.write = d
                case .failed(let e): run.writeError = e
                }
                var unused: JSONValue?
                run.afterWrite = selected(&unused)
                if run.afterWrite == true { run.landed = .selectionWrite }
            }
            return .ok(.null)
        }
        if case .failed(let e) = reply { return .failure(e) }
        run.diff = treeBefore.flatMap { b in treeAfter.map { AXDiff.between(b, $0) } }
        switch ClickFallback.answer(run, ref: ref, plan: plan, window: Int(w.id)) {
        case .failure(let e): return .failure(e)
        case .success(var o):
            o["target"] = targetJSON(w, scope)
            if let opened = openedChildren(pid: w.pid, before: childrenBefore, session: session) { o["opened"] = opened }
            return .success(.object(o))
        }
    }
}
