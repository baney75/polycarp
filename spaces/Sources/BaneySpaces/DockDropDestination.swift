import AppKit
import BaneySpacesCore

/// The Workspace Dock as a drag destination for files and links from other apps, as the macOS Dock is. Its hosting view
/// registers for file URLs and URLs (`registerForDraggedTypes`) and forwards each `NSDraggingDestination` call here.
/// Over the dock the icon or tile under the pointer is the spring target (`WorkspaceDock.springLoad` brings it forward
/// after a moment); a tile whose kind takes the drag (`DockDropTargets`: an app that opens every item, a room later)
/// lights and gets the drop. The items are read from the drag's own pasteboard, which a destination may read during the
/// drag, never by the drag pasteboard's name.
final class DockDropDestination {
    static let types: [NSPasteboard.PasteboardType] = [.fileURL, .URL]

    private let model: DockModel
    /// The kinds of tile that take a drop. App icons are registered by the dock; another kind registers here.
    var targets = DockDropTargets()
    /// The pointer of a drag, in the dock's own space (`DockCarry.point`).
    var point: (NSDraggingInfo) -> CGPoint? = { _ in nil }
    /// A drag is over the dock's panel: the dock stays up, and the drag counts as one from another app even if the
    /// pasteboard watch (`OutsideDrag`) missed its start.
    private(set) var hovering = false
    /// The drag's files and links, read once per drag.
    private var items: (sequence: Int, urls: [URL])?
    /// The tile lit for the drop, as last traced.
    private var lit: DockDropHit?
    /// Called when a drag ends over the dock, dropped or not: per-drag memory goes.
    var onDragDone: () -> Void = {}

    init(model: DockModel) { self.model = model }

    /// The buttons have come up. AppKit's drop arrives a moment later, so the drag counts as stale only after
    /// `DockDropRelease.grace` with no drop or end; then no drag can be over the dock, whatever AppKit last said.
    func buttonsUp() {
        guard hovering || items != nil else { release.reset(); return }
        if release.buttonsUp(now: ProcessInfo.processInfo.systemUptime) { finish() }
    }

    /// A button is down: a drag still in progress isn't stale.
    func buttonsDown() { release.reset() }

    private var release = DockDropRelease()

    func entered(_ info: NSDraggingInfo) -> NSDragOperation {
        hovering = true
        release.reset()
        return update(info)
    }

    func updated(_ info: NSDraggingInfo) -> NSDragOperation { update(info) }

    func exited() {
        hovering = false
        lit = nil
        model.heldTarget = nil
        model.heldDrop = nil
        model.fileDrag = nil
    }

    /// The button came up over the dock: the tile lit when it did gets the drop, if it still takes it.
    func perform(_ info: NSDraggingInfo) -> Bool {
        let urls = urls(of: info)
        let key = model.heldDrop
        defer { finish() }
        guard let key, targets.accepts(key: key, urls: urls) else {
            Trace.log("dock drop: \(urls.count) item(s) let go on \(key ?? "nothing that takes them"); not taken")
            return false
        }
        Trace.log("dock drop: \(urls.count) item(s) on \(key)")
        // The drop is answered at once; the tile's work (an app brought forward, Accessibility calls a busy app can
        // stall) waits for the next turn of the run loop, so the source app isn't held up.
        let targets = targets
        DispatchQueue.main.async { targets.drop(key: key, urls: urls) }
        return true
    }

    func ended() { finish() }

    private func finish() {
        hovering = false
        items = nil
        lit = nil
        model.heldTarget = nil
        model.heldDrop = nil
        model.fileDrag = nil
        release.reset()
        // Per-drag memory (the apps resolved for the lit icons) goes after work already queued, so a drop `perform`
        // handed to the next turn of the run loop still finds the app it accepted, even one that quit since.
        let done = onDragDone
        DispatchQueue.main.async { done() }
    }

    private func update(_ info: NSDraggingInfo) -> NSDragOperation {
        let urls = urls(of: info)
        let p = point(info)
        let spring = p.flatMap { DockSpringTarget.at($0, frames: model.frames) }
        let hit = p.flatMap { targets.hit(at: $0, frames: model.frames, urls: urls) }
        if hit != lit {
            if let hit { Trace.log("dock file drag over \(hit.key) (\(hit.kind)): \(urls.count) item(s), \(hit.accepts ? "takes them" : "can't open them")") }
            lit = hit
        }
        let takes = hit?.accepts == true
        model.heldTarget = spring
        model.heldDrop = takes ? hit?.key : nil
        let state = DockModel.FileDrag(target: spring, canOpen: takes, dropKey: takes ? hit?.key : nil)
        if model.fileDrag != state { model.fileDrag = state }
        guard takes else { return [] }
        return DockDropDestination.operation(info.draggingSourceOperationMask)
    }

    /// Copy where the source allows it, the way the macOS Dock opens a file: the file stays where it is. Never `.move`:
    /// a source told its item moved deletes its own copy, and the dock only opened it.
    static func operation(_ allowed: NSDragOperation) -> NSDragOperation {
        for op: NSDragOperation in [.copy, .link, .generic] where allowed.contains(op) { return op }
        return []
    }

    private func urls(of info: NSDraggingInfo) -> [URL] {
        if let items, items.sequence == info.draggingSequenceNumber { return items.urls }
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] ?? []
        items = (info.draggingSequenceNumber, urls)
        return urls
    }
}
