import BaneySpacesCore
import Foundation

// Item 3: a click on a row of an outline, table or list that the press doesn't select falls back to the selection write.
// The reads inside the transaction are inline (no check of their own): the transaction ran the acting check right before
// it started, both actions take it again, and it is asked once more before the write.
extension HandsRouter {
    /// A click on a collection item, in one transaction on the app's queue: read the selection, press, read it again, and
    /// only when the item is still not selected, write the selection on its container and read once more.
    func clickRow(_ w: HandsWindow, scope: ScopeDecision, ref: String, plan: ClickFallback.Plan, session: String, childrenBefore: Set<UInt32>) -> HandsEnvelope {
        var before: Bool?, afterPress: Bool?, afterWrite: Bool?
        var press: JSONValue?, write: JSONValue?, pressError: HandsError?, writeError: HandsError?, refused = false
        var landed = ClickFallback.Landed.none
        var treeBefore: JSONValue?, treeAfter: JSONValue?
        let reply = HandsEngine.shared.transaction(window: w, check: actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session)) { [self] cancelled in
            let acting = actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session)
            // Each read keeps its tree: with no readback, the change it shows is the press's evidence (first-F4).
            func selected(_ tree: inout JSONValue?) -> Bool? {
                guard case .ok(let d) = HandsEngine.shared.snapshotInline(window: w, interactive: plan.view.interactive, compact: plan.view.compact,
                                                                            depth: UInt8(clamping: plan.view.depth), evidence: true) else { return nil }
                tree = d["tree"]
                return ClickFallback.selected(SnapshotRows.rows(of: d["tree"] ?? .null), plan)
            }
            before = selected(&treeBefore)
            switch HandsEngine.shared.actInline(window: w, ref: ref, kind: .click, check: actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session), cancelled: cancelled) {
            case .ok(let d): press = d
            case .failed(let e): pressError = e
            }
            afterPress = selected(&treeAfter)
            switch ClickFallback.afterPress(before: before, after: afterPress, pressError: pressError?.code) {
            case .done(let l): landed = l
            case .writeSelection:
                guard !cancelled() else { break }
                // A refusal here is kept: its code decides the next call (second-F9).
                if let e = acting() { writeError = e; refused = true; break }
                switch HandsEngine.shared.actInline(window: w, ref: plan.container, kind: .select, text: plan.label, check: actingCheck(w, ref: plan.container, verb: "click", delivery: .headlessAX, session: session), cancelled: cancelled) {
                case .ok(let d): write = d
                case .failed(let e): writeError = e
                }
                var unused: JSONValue?
                afterWrite = selected(&unused)
                if afterWrite == true { landed = .selectionWrite }
            }
            return .ok(.null)
        }
        if case .failed(let e) = reply { return .failure(e) }
        // Nothing landed and the press itself failed: its error, with what was tried.
        if landed == .none, write == nil, let pressError { return .failure(ClickFallback.failure(press: pressError, write: writeError, refused: refused)) }
        let diff = treeBefore.flatMap { b in treeAfter.map { AXDiff.between(b, $0) } }
        let engineVerified = press?["disposition"]?["delivery"]?.string == "delivered_verified"
        let verified = ClickFallback.verified(landed: landed, afterPress: afterPress, engineVerified: engineVerified, treeChanged: diff?.changed ?? false)
        func flag(_ b: Bool?) -> JSONValue { b.map(JSONValue.bool) ?? .null }
        var o: [String: JSONValue] = [
            "action": "click", "ref": .string(ref), "verified": .bool(verified), "landed": .string(landed.rawValue),
            "evidence": .object(["kind": "selection_readback", "item": .string(plan.label), "selected_before": flag(before),
                                 "selected_after_press": flag(afterPress), "selected_after_write": flag(afterWrite)]),
            "engine": press ?? .null, "target": targetJSON(w, scope),
        ]
        if afterPress == nil, let diff { o["press_evidence"] = diff.json() }
        if let e = ClickFallback.pressError(pressError) { o["press_error"] = e }
        if let write { o["selection_write"] = .object(["container": .string(plan.container), "engine": write]) }
        if let writeError {
            o["selection_write"] = .object(["container": .string(plan.container), "error": .string(writeError.message), "code": .string(writeError.code.rawValue)])
        }
        if let code = ClickFallback.nextCode(verified: verified, writeError: writeError?.code) { o["next_call"] = HandsNextCall.after(code, window: Int(w.id)) }
        if let opened = openedChildren(pid: w.pid, before: childrenBefore, session: session) { o["opened"] = opened }
        return .success(.object(o))
    }
}
