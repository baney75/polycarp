import Foundation

/// `agent open` of an app that is already running asks its one process for a new window and claims that window for the
/// agent workspace. A claim on the app in front doesn't hold (`ClaimRule`), and some apps come forward when asked for a
/// window, so it opens on Donovan's workspace: Finder did (11-15, window 67151 on workspace 1). Those apps are refused
/// before anything is pressed, and a window that gets out anyway is named in the answer, never left unsaid.
public final class RunningOpen: @unchecked Sendable {
    public static let shared = RunningOpen()
    /// Apps whose New Window brings them forward, so their new window can't be made the agent's.
    public static let comesForward: Set<String> = ["com.apple.finder"]

    private let lock = NSLock()
    /// Apps that left a window on Donovan's side in this run of Polycarp: refused like `comesForward` from then on.
    private var strayed: Set<String> = []

    public init() {}

    /// nil when a running copy of the app may be asked for a window.
    public func refusal(app: String, bundle: String) -> HandsError? {
        let key = bundle.lowercased()
        lock.lock(); let seen = strayed.contains(key); lock.unlock()
        guard seen || Self.comesForward.contains(where: { $0.lowercased() == key }) else { return nil }
        return HandsError(.needsSandbox,
                          "\(app) is already running and opens its new windows on Donovan's workspace, so Polycarp can't make one the agent's"
                          + (seen ? " (it did on an earlier open)" : ""),
                          suggestion: "Polycarp pressed nothing. Work with files directly, or ask Donovan to lend \(app).", retry: .never)
    }

    /// The new windows of `pid` (not in `known`) that are not on the agent workspace.
    public static func strays(of pid: Int32, known: Set<UInt32>, in windows: [HandsWindow], agent: Int?) -> [HandsWindow] {
        windows.filter { $0.pid == pid && !known.contains($0.id) && $0.workspace != agent }.sorted { $0.id < $1.id }
    }

    /// Who gets the keyboard back after an open that left its app in front: the app in front before it, when that was
    /// another app. nil when nothing is owed.
    public static func giveBack(front: Int32?, opened: Int32, before: Int32?) -> Int32? {
        guard front == opened, let before, before != opened else { return nil }
        return before
    }

    /// The answer when an open left windows on Donovan's side. It names each one, and remembers the app so the next open is
    /// refused up front.
    public func escaped(app: String, bundle: String, windows: [HandsWindow], agent: Int?, keyboardReturned: Bool) -> HandsError {
        lock.lock(); strayed.insert(bundle.lowercased()); lock.unlock()
        let list = windows.map { "window \($0.id) on " + ($0.workspace.map { "workspace \($0)" } ?? "no workspace") }.joined(separator: ", ")
        return HandsError(.outsideAgentWorkspace,
                          "\(app) opened \(list), not the agent workspace\(agent.map { " (\($0))" } ?? ""). Polycarp left it there: it is Donovan's"
                          + (keyboardReturned ? ", and the keyboard was given back" : ""),
                          suggestion: "Don't act on or close it; tell Donovan which window it left. Polycarp won't ask \(app) for a window again while it runs.",
                          retry: .never)
    }
}
