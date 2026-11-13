import CoreGraphics
import Foundation

/// A right click (`click-at` with `button: right`). Its context menu is a window of its own, which AppKit draws on a
/// display a person can see and which takes the keyboard while it is open. Agent windows wait parked off every display
/// (`Geometry.hidingSpot`), so a right click there would bring the menu onto Donovan's screen. Three rules:
///
/// 1. Nothing is posted unless the window is the agent workspace's own (not lent, not Full Access) and the agent
///    workspace is shown on the display that holds most of it (`gate`), and unless the cancel's key permit is planned.
/// 2. The menu is proved by its own window: one of the app's, at the pop-up menu level, new since the press (`menus`).
/// 3. It never stays open. The call presses the item it names, or lists the items and cancels the menu. A menu anywhere
///    but that display, or one shown after the agent workspace was put away, is cancelled and the call fails (`verdict`).
///
/// All frames are in the window server's coordinates: top-left origin of the primary display, y down.
public enum ContextMenu {
    /// The pop-up menu window level (`kCGPopUpMenuWindowLevel`).
    public static let level = 101
    /// How long the press has to show its menu.
    public static let wait: TimeInterval = 1.0

    /// The display a menu must stay on: the one holding most of the window. Nil for a window parked off every display.
    public static func display(window: CGRect, displays: [CGRect]) -> CGRect? {
        let keyed = Dictionary(uniqueKeysWithValues: displays.enumerated().map { ($0.offset, $0.element) })
        return Geometry.display(of: window, in: keyed).map { displays[$0] }
    }

    /// Rule 1, before anything is posted. `point` is the click in screen coordinates. `agentWindow`: the window is on
    /// the agent workspace by scope and by placement now; a lent window is Donovan's, wherever it sits (210 r1 second-S4).
    public static func gate(agentShown: Bool, agentWindow: Bool, window: CGRect, point: CGPoint, displays: [CGRect]) -> HandsError? {
        guard agentShown, agentWindow, let d = display(window: window, displays: displays), d.contains(point) else {
            return HandsError(.outsideAgentWorkspace,
                              "a right click opens its menu where Donovan can see it unless the agent workspace is on screen under the window; it isn't, so nothing was posted",
                              suggestion: "Use `click` on a ref for the element's own action, or `menu` for the app's menu bar.", retry: .never, nextCall: .null)
        }
        return nil
    }

    /// Rule 1 for a right click on a ref (`click` with `button: right`): the engine's AXShowMenu opens the menu at the
    /// element, inside the window, so the window must be on screen under the agent workspace just the same. Nothing is
    /// sent to the app otherwise.
    public static func gate(agentShown: Bool, agentWindow: Bool, window: CGRect, displays: [CGRect]) -> HandsError? {
        guard gate(agentShown: agentShown, agentWindow: agentWindow, window: window, point: CGPoint(x: window.midX, y: window.midY), displays: displays) != nil else { return nil }
        return HandsError(.outsideAgentWorkspace,
                          "a right click opens its menu where Donovan can see it unless the agent workspace is on screen under the window; it isn't, so nothing was sent",
                          suggestion: "Use `click` without button for the element's own action, or `menu` for the app's menu bar.", retry: .never, nextCall: .null)
    }

    /// The roles whose `select` or `click` opens a pop-up menu. The engine names a pop-up button `combobox` (its
    /// `ax_role_to_str`), and a combobox's select opens its list when the value can't be set. AppKit draws that menu on a
    /// display a person can see, so a parked window's comes onto Donovan's screen.
    public static let popups: Set<String> = ["combobox", "popupbutton", "menubutton"]

    /// A role as the engine or AppKit spells it (`popupbutton`, `AXPopUpButton`, `pop_up_button`), in the engine's form.
    public static func role(_ raw: String) -> String {
        var r = raw.lowercased().filter { $0.isLetter }
        if r.hasPrefix("ax") { r.removeFirst(2) }
        return r
    }

    /// Rule 1 for a `select` or `click` on a ref that opens a pop-up: the window gate, before anything is sent. `role`
    /// nil: it couldn't be read, so a select may open one (a click is let through: most clicks aren't on pop-ups).
    /// `window` nil: not on any display.
    public static func popupGate(verb: String, role: String?, agentShown: Bool, window: CGRect?, displays: [CGRect]) -> HandsError? {
        let opens: Bool
        switch verb {
        case "select": opens = role.map { popups.contains(Self.role($0)) } ?? true
        case "click": opens = role.map { popups.contains(Self.role($0)) } ?? false
        default: opens = false
        }
        guard opens else { return nil }
        // Only where the window sits: a pop-up in a lent window is the app Donovan lent, not a menu on a parked one.
        if let window, gate(agentShown: agentShown, agentWindow: true, window: window, displays: displays) == nil { return nil }
        return HandsError(.outsideAgentWorkspace,
                          "a \(verb) on a pop-up opens its menu where Donovan can see it unless the agent workspace is on screen under the window; it isn't, so nothing was sent",
                          suggestion: verb == "select" ? "Use set-value on a combobox, or ask Donovan to show the agent workspace." : "Ask Donovan to show the agent workspace, then try again.",
                          retry: .never, nextCall: .null)
    }

    /// `click` on a ref: the plain press, or a right click with the item it presses (nil lists the items and cancels).
    public enum RefClick: Equatable, Sendable { case press, right(item: String?) }

    public static func refClick(button: String?, item: String?) -> Result<RefClick, HandsError> {
        let example = #"Example: {"ref":"12","button":"right","item":"Rename"}"#
        switch (button ?? "left").lowercased() {
        case "left":
            return item == nil ? .success(.press) : .failure(HandsError(.badArguments, "item goes with button: right", suggestion: example, retry: .safe, nextCall: .null))
        case "right":
            if let item, item.trimmingCharacters(in: .whitespaces).isEmpty { return .failure(HandsError(.badArguments, "item is empty", suggestion: example, retry: .safe, nextCall: .null)) }
            return .success(.right(item: item))
        default:
            return .failure(HandsError(.badArguments, "button must be left or right", suggestion: example, retry: .safe, nextCall: .null))
        }
    }

    public struct Shown: Equatable, Sendable {
        public var id: UInt32, frame: CGRect
        public init(id: UInt32, frame: CGRect) { self.id = id; self.frame = frame }
    }

    /// Rule 2: the on-screen windows of `pid` at the pop-up menu level that `before` didn't list, from a window server
    /// list. One ordered out or kept off screen is no menu a person sees (210 r1 second-S3).
    public static func menus(_ list: [[String: Any]], pid: Int32, before: Set<UInt32>) -> [Shown] {
        list.compactMap { w in
            guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == level, (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true, (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value, !before.contains(id),
                  let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return nil }
            return Shown(id: id, frame: r)
        }
    }

    public enum Verdict: Equatable, Sendable { case none, onAgent([Shown]), elsewhere([Shown]) }

    /// Rule 3: where the menus are. `agentShown` is read after they appeared; `display` is the window's (`display`).
    public static func verdict(_ menus: [Shown], agentShown: Bool, display: CGRect?) -> Verdict {
        guard !menus.isEmpty else { return .none }
        guard agentShown, let display, menus.allSatisfy({ display.contains($0.frame) }) else { return .elsewhere(menus) }
        return .onAgent(menus)
    }

    /// The item `want` names, or why not: no such item, a disabled one, a submenu, or one the menu bar would refuse too.
    /// `enabled` lines up with `items`; nil where it couldn't be read.
    public static func choose(_ items: [MenuPath.MenuItem], enabled: [Bool?], want: String) -> Result<Int, HandsError> {
        let path = "context menu > \(want)"
        guard let at = items.firstIndex(where: { !$0.title.isEmpty && MenuPath.same($0.title, want) }) else {
            let names = items.map(\.title).filter { !$0.isEmpty }
            return .failure(HandsError(.actionFailed, "the context menu has no item \"\(want)\"; it has: \(names.joined(separator: ", "))",
                                       suggestion: "Pass one of those titles as item.", retry: .safe, nextCall: .null))
        }
        let i = items[at]
        if let e = MenuPath.itemRule(i, path: path) { return .failure(e) }
        if leavesTheApp(i) { return .failure(MenuPath.refuse(path, why: MenuPath.outside)) }
        if i.submenu {
            return .failure(HandsError(.notSupported, "\(path) opens a submenu, and a context menu's submenus are not used yet",
                                       suggestion: "Do it in the app's own window with click, type or set-value.", retry: .never, nextCall: .null))
        }
        guard enabled.indices.contains(at), enabled[at] == true else {
            return .failure(HandsError(.actionFailed, "\(path) is \(enabled.indices.contains(at) && enabled[at] == nil ? "unreadable" : "disabled")",
                                       suggestion: "Change what is selected, then right click again.", retry: .safe, nextCall: .null))
        }
        return .success(at)
    }

    /// The item's ref in the engine's read of the open menu (surface menu): an enabled item titled `title` of the menu
    /// itself, never one inside a submenu.
    public static func ref(_ tree: JSONValue, title: String) -> String? {
        MenuPath.items(under: tree).first { MenuPath.same($0["name"]?.string ?? "", title) && !($0["states"]?.array ?? []).contains("disabled") }?["ref_id"]?.string
    }

    /// What context menus add past the menu bar's rules: Services, Look Up, web search, Translate, Open With, Finder.
    /// AppKit gives these items no identifier, so past Services' they are known by English title only: in another
    /// language Look Up or Translate is not caught (210 r1 second-S6).
    static let outsideTitles = ["services", "look up", "search with", "translate", "open with", "show in finder", "reveal in finder"]
    static func leavesTheApp(_ i: MenuPath.MenuItem) -> Bool {
        i.id.contains("services") || i.id.contains("lookup") || outsideTitles.contains { i.name.hasPrefix($0) }
    }

    public static func noMenu(_ app: String) -> HandsError {
        HandsError(.unverified, "the right click showed no context menu in \(app)",
                   suggestion: "Take a shot to see what is under the point, then try another point.", retry: .afterSnapshot, nextCall: .null)
    }

    public static func elsewhere(_ app: String, cancelled: Bool) -> HandsError {
        HandsError(.outsideAgentWorkspace, "\(app)'s context menu opened where Donovan can see it, outside the agent workspace; "
                   + (cancelled ? "it was cancelled" : "Polycarp couldn't cancel it, so it may still be open"),
                   suggestion: "Use `click` on a ref for the element's own action.", retry: .never, nextCall: .null)
    }

    /// The menu was left open: its cancel didn't take. Said first, over whatever else went wrong.
    public static func stillOpen(_ app: String) -> HandsError {
        HandsError(.actionFailed, "\(app)'s context menu is still open on the agent workspace: Polycarp couldn't cancel it",
                   suggestion: "Press Escape with `press` on the window, then take a shot to check.", retry: .never, nextCall: .null)
    }

    /// The cancel's key permit couldn't be planned, so nothing is posted: a menu that couldn't be cancelled would hold
    /// Donovan's keyboard (210 r1 first-F1).
    public static func noCancel(_ app: String) -> HandsError {
        HandsError(.notSupported, "a right click in \(app) would open a menu Polycarp couldn't cancel: Escape can't be sent to this window now, so nothing was posted",
                   suggestion: "Use `click` on a ref for the element's own action, or `menu` for the app's menu bar.", retry: .never, nextCall: .null)
    }

    /// A menu that came after the wait (210 r1 first-F2): cancelled, and said.
    public static func late(_ app: String) -> HandsError {
        HandsError(.unverified, "\(app)'s context menu came late, after Polycarp stopped waiting, so it was cancelled",
                   suggestion: "Try the right click again once the app is idle.", retry: .afterSnapshot, nextCall: .null)
    }

    /// The item was pressed but its menu stayed open and wouldn't cancel. Never retried: the command may have run (210 r1 second-S1).
    public static func pressedOpen(_ app: String, item: String) -> HandsError {
        HandsError(.actionFailed, "context menu > \(item) was pressed in \(app), but its menu is still open: Polycarp couldn't cancel it",
                   suggestion: "Take a shot to see whether the command ran before doing anything else.", retry: .never, nextCall: .null)
    }

    public static func notPressed(_ app: String, item: String) -> HandsError {
        HandsError(.actionFailed, "\(app) didn't take context menu > \(item), so the menu was cancelled",
                   suggestion: "Take a shot to see the window, then try again.", retry: .afterSnapshot, nextCall: .null)
    }

    /// The menu's items couldn't be read (a busy app times out), so none is pressed and the menu is cancelled.
    public static func unread(_ app: String, cancelled: Bool) -> HandsError {
        HandsError(.engineError, "\(app)'s context menu couldn't be read" + (cancelled ? ", so it was cancelled" : ", and Polycarp couldn't cancel it"),
                   suggestion: "Try the right click again.", retry: .safe, nextCall: .null)
    }
}
