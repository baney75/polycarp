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
        var press: JSONValue?, write: JSONValue?, pressError: HandsError?, writeError: HandsError?
        var landed = ClickFallback.Landed.none
        let reply = HandsEngine.shared.transaction(window: w, check: actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session)) { [self] cancelled in
            let acting = actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session)
            func selected() -> Bool? {
                guard case .ok(let d) = HandsEngine.shared.snapshotInline(window: w, interactive: false, compact: false, depth: 10, evidence: true) else { return nil }
                return ClickFallback.selected(SnapshotRows.rows(of: d["tree"] ?? .null), plan)
            }
            before = selected()
            switch HandsEngine.shared.actInline(window: w, ref: ref, kind: .click, check: actingCheck(w, ref: ref, verb: "click", delivery: .headlessAX, session: session), cancelled: cancelled) {
            case .ok(let d): press = d
            case .failed(let e): pressError = e
            }
            afterPress = selected()
            switch ClickFallback.afterPress(before: before, after: afterPress, pressError: pressError?.code) {
            case .done(let l): landed = l
            case .writeSelection:
                guard !cancelled(), acting() == nil else { break }
                switch HandsEngine.shared.actInline(window: w, ref: plan.container, kind: .select, text: plan.label, check: actingCheck(w, ref: plan.container, verb: "click", delivery: .headlessAX, session: session), cancelled: cancelled) {
                case .ok(let d): write = d
                case .failed(let e): writeError = e
                }
                afterWrite = selected()
                if afterWrite == true { landed = .selectionWrite }
            }
            return .ok(.null)
        }
        if case .failed(let e) = reply { return .failure(e) }
        // Nothing landed and the press itself failed: its error, with what was tried.
        if landed == .none, write == nil, let pressError { return .failure(pressError) }
        let verified = landed != .none
        func flag(_ b: Bool?) -> JSONValue { b.map(JSONValue.bool) ?? .null }
        var o: [String: JSONValue] = [
            "action": "click", "ref": .string(ref), "verified": .bool(verified), "landed": .string(landed.rawValue),
            "evidence": .object(["kind": "selection_readback", "item": .string(plan.label), "selected_before": flag(before),
                                 "selected_after_press": flag(afterPress), "selected_after_write": flag(afterWrite)]),
            "engine": press ?? .null, "target": targetJSON(w, scope),
        ]
        if let write { o["selection_write"] = .object(["container": .string(plan.container), "engine": write]) }
        if let writeError { o["selection_write"] = .object(["container": .string(plan.container), "error": .string(writeError.message)]) }
        if !verified { o["next_call"] = HandsNextCall.after(.unverified, window: Int(w.id)) }
        if let opened = openedChildren(pid: w.pid, before: childrenBefore, session: session) { o["opened"] = opened }
        return .success(.object(o))
    }
}
