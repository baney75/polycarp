import AppKit
import BaneySpacesCore

/// `query`: the agent API's read surface (spec/agent-api.md). The facts are read on the main thread in one pass; the
/// scope guard then decides, per window, what this caller may see, the same decision every hands verb makes.
extension HandsRouter {
    func query(_ req: HandsRequest) -> HandsEnvelope {
        let name = req.string("what") ?? AgentAPI.Query.state.rawValue
        guard let q = AgentAPI.Query(rawValue: name) else {
            return .failure(HandsError(.badArguments, "there is no query \(name)",
                                       suggestion: "Queries: " + AgentAPI.Query.allCases.map(\.rawValue).joined(separator: ", ") + ".", retry: .never))
        }
        guard let (facts, view) = apiRead(session: req.session ?? "") else {
            return .failure(HandsError(.notRunning, "Polycarp hasn't finished starting", suggestion: "Try again in a moment.", retry: .safe))
        }
        return .success(AgentAPI.result(q, facts, view))
    }

    /// The facts and what this caller may see of them. A window in scope that the window server gave no title (no Screen
    /// Recording) gets its title from Accessibility; a window out of scope is never read.
    func apiRead(session: String) -> (AgentAPI.Facts, AgentAPI.View)? {
        guard var (facts, agent) = onMain({ host.facts().map { ($0, host.agentWorkspace()) } }) else { return nil }
        let inScope = Set(facts.windows.filter { decide($0.window, agent, session: session).allowed }.map(\.window.id))
        let untitled = facts.windows.filter { inScope.contains($0.window.id) && $0.window.title.isEmpty }.map(\.window.id)
        if !untitled.isEmpty {
            let titles = onMain { host.titles(untitled) }
            for i in facts.windows.indices { if let t = titles[facts.windows[i].window.id] { facts.windows[i].window.title = t } }
        }
        return (facts, AgentAPI.View(access: access, inScope: inScope))
    }
}
