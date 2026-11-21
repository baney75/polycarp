#if POLYCARP_TERMINAL
import AppKit
import BaneySpacesCore
import CGhostty

/// One libghostty surface in an AppKit view: libghostty draws into it with Metal (it sets up the view's layer itself), and
/// this view hands it the size, scale, focus, keys, text input (IME included), mouse and scroll. Ported, trimmed, from
/// Ghostty's macos/Sources/Ghostty/Surface View/SurfaceView_AppKit.swift at the pin; tabs, splits, search, Quick Look,
/// secure input and the inspector stay in Ghostty-the-app for now.
final class TerminalSurfaceView: NSView, NSTextInputClient {
    private(set) var surface: ghostty_surface_t?
    var cellSize = NSSize(width: 8, height: 16)
    /// Called when the surface's program has ended and its window should go.
    var onClose: (() -> Void)?
    var onTitle: ((String) -> Void)?

    private var focused = false
    private var markedText = NSMutableAttributedString()
    /// Text that `interpretKeyEvents` produced during one keyDown; nil outside one.
    private var keyTextAccumulator: [String]?
    private var contentSize = NSSize.zero
    private var cursor = NSCursor.iBeam

    init(app: ghostty_app_t, commandLine: String?, workingDirectory: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        var cfg = ghostty_surface_config_new()
        cfg.userdata = Unmanaged.passUnretained(self).toOpaque()
        cfg.platform_tag = GHOSTTY_PLATFORM_MACOS
        cfg.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(self).toOpaque()))
        cfg.scale_factor = Double(NSScreen.main?.backingScaleFactor ?? 2)
        cfg.font_size = 0
        // A command (an agent, ssh, yours) leaves its last words on screen when it ends; a plain shell just closes.
        cfg.wait_after_command = commandLine != nil
        cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
        // libghostty copies the strings during ghostty_surface_new.
        surface = workingDirectory.withCString { wd in
            cfg.working_directory = wd
            if let commandLine {
                return commandLine.withCString { cmd in
                    cfg.command = cmd
                    return ghostty_surface_new(app, &cfg)
                }
            }
            return ghostty_surface_new(app, &cfg)
        }
        updateTrackingAreas()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Frees the surface (its program gets SIGHUP). Called once, as its window closes.
    func free() {
        guard let s = surface else { return }
        surface = nil
        ghostty_surface_free(s)
    }

    /// The program ended or asked to close: the window that holds this view decides how.
    func closeHost() { onClose?() }

    func setTitle(_ t: String) { onTitle?(t) }

    /// Whether closing now would end a program still running (Ghostty's own rule).
    var needsConfirmClose: Bool { surface.map { ghostty_surface_needs_confirm_quit($0) } ?? false }

    // MARK: Size, scale, focus

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        sizeDidChange(newSize)
    }

    private func sizeDidChange(_ size: NSSize) {
        contentSize = size
        guard let surface else { return }
        let px = convertToBacking(size)
        ghostty_surface_set_size(surface, UInt32(max(1, px.width)), UInt32(max(1, px.height)))
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if let window {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer?.contentsScale = window.backingScaleFactor
            CATransaction.commit()
        }
        guard let surface, frame.width > 0, frame.height > 0 else { return }
        let fb = convertToBacking(frame)
        ghostty_surface_set_content_scale(surface, fb.width / frame.width, fb.height / frame.height)
        sizeDidChange(contentSize)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        viewDidChangeBackingProperties()
        if let screen = window?.screen, let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, let surface {
            ghostty_surface_set_display_id(surface, n.uint32Value)
        }
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { setFocus(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { setFocus(false) }
        return ok
    }

    private func setFocus(_ on: Bool) {
        guard focused != on, let surface else { return }
        focused = on
        ghostty_surface_set_focus(surface, on)
    }

    /// The window was hidden or shown (the quick terminal): libghostty stops drawing what nobody sees.
    func setVisible(_ visible: Bool) {
        guard let surface else { return }
        ghostty_surface_set_occlusion(surface, visible)
    }

    // MARK: Keys

    override func keyDown(with event: NSEvent) {
        guard let surface else { interpretKeyEvents([event]); return }
        // Option-as-alt and the like: the modifiers libghostty wants the text translated with.
        let wanted = Self.flags(ghostty_surface_key_translation_mods(surface, Self.mods(event.modifierFlags)))
        var translationMods = event.modifierFlags
        for f in [NSEvent.ModifierFlags.shift, .control, .option, .command] {
            if wanted.contains(f) { translationMods.insert(f) } else { translationMods.remove(f) }
        }
        // The same event object when nothing changed: Korean input needs it to be.
        let translation: NSEvent = translationMods == event.modifierFlags ? event : (NSEvent.keyEvent(
            with: event.type, location: event.locationInWindow, modifierFlags: translationMods, timestamp: event.timestamp,
            windowNumber: event.windowNumber, context: nil, characters: event.characters(byApplyingModifiers: translationMods) ?? "",
            charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "", isARepeat: event.isARepeat, keyCode: event.keyCode) ?? event)
        let action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        keyTextAccumulator = []
        defer { keyTextAccumulator = nil }
        let hadMarked = markedText.length > 0
        interpretKeyEvents([translation])
        syncPreedit(clearIfNeeded: hadMarked)
        if let list = keyTextAccumulator, !list.isEmpty {
            for text in list { _ = key(action, event, translation: translation, text: text) }
        } else {
            _ = key(action, event, translation: translation, text: Self.characters(translation),
                    composing: markedText.length > 0 || hadMarked)
        }
    }

    override func keyUp(with event: NSEvent) {
        _ = key(GHOSTTY_ACTION_RELEASE, event)
    }

    override func flagsChanged(with event: NSEvent) {
        let bit: UInt32
        switch event.keyCode {
        case 0x39: bit = GHOSTTY_MODS_CAPS.rawValue
        case 0x38, 0x3C: bit = GHOSTTY_MODS_SHIFT.rawValue
        case 0x3B, 0x3E: bit = GHOSTTY_MODS_CTRL.rawValue
        case 0x3A, 0x3D: bit = GHOSTTY_MODS_ALT.rawValue
        case 0x37, 0x36: bit = GHOSTTY_MODS_SUPER.rawValue
        default: return
        }
        if hasMarkedText() { return }
        let down = Self.mods(event.modifierFlags).rawValue & bit != 0
        _ = key(down ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE, event)
    }

    /// ⌘ and ⌃ keys reach here first. A Ghostty binding (⌘C, ⌘V, ⌘K…) goes to libghostty; anything else carries on
    /// through AppKit and comes back as a keyDown.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, focused, let surface else { return false }
        var ev = Self.keyEvent(GHOSTTY_ACTION_PRESS, event)
        let isBinding = (event.characters ?? "").withCString { p -> Bool in
            ev.text = p
            var flags = ghostty_binding_flags_e(0)
            return ghostty_surface_key_is_binding(surface, ev, &flags)
        }
        guard isBinding else { return false }
        keyDown(with: event)
        return true
    }

    private func key(_ action: ghostty_input_action_e, _ event: NSEvent, translation: NSEvent? = nil, text: String? = nil,
                     composing: Bool = false) -> Bool {
        guard let surface else { return false }
        var ev = Self.keyEvent(action, event, translationMods: translation?.modifierFlags)
        ev.composing = composing
        // libghostty encodes control characters itself (ctrl+enter does the wrong thing otherwise).
        if let text, let first = text.utf8.first, first >= 0x20 {
            return text.withCString { p in
                ev.text = p
                return ghostty_surface_key(surface, ev)
            }
        }
        return ghostty_surface_key(surface, ev)
    }

    /// Ghostty's `NSEvent.ghosttyKeyEvent`: control and command never take part in producing text.
    static func keyEvent(_ action: ghostty_input_action_e, _ e: NSEvent, translationMods: NSEvent.ModifierFlags? = nil) -> ghostty_input_key_s {
        var k = ghostty_input_key_s()
        k.action = action
        k.keycode = UInt32(e.keyCode)
        k.text = nil
        k.composing = false
        k.mods = mods(e.modifierFlags)
        k.consumed_mods = mods((translationMods ?? e.modifierFlags).subtracting([.control, .command]))
        k.unshifted_codepoint = 0
        if e.type == .keyDown || e.type == .keyUp, let c = e.characters(byApplyingModifiers: [])?.unicodeScalars.first {
            k.unshifted_codepoint = c.value
        }
        return k
    }

    /// Ghostty's `ghosttyCharacters`: a lone control character goes without ctrl; function keys' private-use
    /// characters never go.
    static func characters(_ e: NSEvent) -> String? {
        guard let chars = e.characters else { return nil }
        if chars.count == 1, let s = chars.unicodeScalars.first {
            if s.value < 0x20 { return e.characters(byApplyingModifiers: e.modifierFlags.subtracting(.control)) }
            if s.value >= 0xF700 && s.value <= 0xF8FF { return nil }
        }
        return chars
    }

    static func mods(_ f: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var m = GHOSTTY_MODS_NONE.rawValue
        if f.contains(.shift) { m |= GHOSTTY_MODS_SHIFT.rawValue }
        if f.contains(.control) { m |= GHOSTTY_MODS_CTRL.rawValue }
        if f.contains(.option) { m |= GHOSTTY_MODS_ALT.rawValue }
        if f.contains(.command) { m |= GHOSTTY_MODS_SUPER.rawValue }
        if f.contains(.capsLock) { m |= GHOSTTY_MODS_CAPS.rawValue }
        let raw = f.rawValue
        if raw & UInt(NX_DEVICERSHIFTKEYMASK) != 0 { m |= GHOSTTY_MODS_SHIFT_RIGHT.rawValue }
        if raw & UInt(NX_DEVICERCTLKEYMASK) != 0 { m |= GHOSTTY_MODS_CTRL_RIGHT.rawValue }
        if raw & UInt(NX_DEVICERALTKEYMASK) != 0 { m |= GHOSTTY_MODS_ALT_RIGHT.rawValue }
        if raw & UInt(NX_DEVICERCMDKEYMASK) != 0 { m |= GHOSTTY_MODS_SUPER_RIGHT.rawValue }
        return ghostty_input_mods_e(m)
    }

    static func flags(_ m: ghostty_input_mods_e) -> NSEvent.ModifierFlags {
        var f = NSEvent.ModifierFlags()
        if m.rawValue & GHOSTTY_MODS_SHIFT.rawValue != 0 { f.insert(.shift) }
        if m.rawValue & GHOSTTY_MODS_CTRL.rawValue != 0 { f.insert(.control) }
        if m.rawValue & GHOSTTY_MODS_ALT.rawValue != 0 { f.insert(.option) }
        if m.rawValue & GHOSTTY_MODS_SUPER.rawValue != 0 { f.insert(.command) }
        return f
    }

    // MARK: Text input (IME)

    func hasMarkedText() -> Bool { markedText.length > 0 }

    func markedRange() -> NSRange { markedText.length > 0 ? NSRange(location: 0, length: markedText.length) : NSRange() }

    func selectedRange() -> NSRange { NSRange() }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        switch string {
        case let v as NSAttributedString: markedText = NSMutableAttributedString(attributedString: v)
        case let v as String: markedText = NSMutableAttributedString(string: v)
        default: return
        }
        // Outside a keyDown (a layout switch mid-composition), libghostty hears now.
        if keyTextAccumulator == nil { syncPreedit() }
    }

    func unmarkText() {
        guard markedText.length > 0 else { return }
        markedText.mutableString.setString("")
        syncPreedit()
    }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }

    func characterIndex(for point: NSPoint) -> Int { 0 }

    /// Where the IME's candidate window goes: at the cursor, as libghostty reports it.
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let surface else { return .zero }
        var x = 0.0, y = 0.0, w = Double(cellSize.width), h = Double(cellSize.height)
        ghostty_surface_ime_point(surface, &x, &y, &w, &h)
        let local = NSRect(x: x, y: frame.height - y, width: range.length == 0 ? 0 : w, height: max(h, cellSize.height))
        let inWindow = convert(local, to: nil)
        return window?.convertToScreen(inWindow) ?? inWindow
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        guard NSApp.currentEvent != nil, let surface else { return }
        let chars: String
        switch string {
        case let v as NSAttributedString: chars = v.string
        case let v as String: chars = v
        default: return
        }
        unmarkText()
        if keyTextAccumulator != nil { keyTextAccumulator?.append(chars); return }
        let n = chars.utf8CString.count
        guard n > 1 else { return }
        chars.withCString { ghostty_surface_text(surface, $0, UInt(n - 1)) }
    }

    /// Selectors AppKit maps keys to (moveLeft:, cancel:…): the key event already went to libghostty, so nothing
    /// more, and no beep.
    override func doCommand(by selector: Selector) {}

    private func syncPreedit(clearIfNeeded: Bool = true) {
        guard let surface else { return }
        if markedText.length > 0 {
            let s = markedText.string
            let n = s.utf8CString.count
            s.withCString { ghostty_surface_preedit(surface, $0, UInt(n - 1)) }
        } else if clearIfNeeded {
            ghostty_surface_preedit(surface, nil, 0)
        }
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .inVisibleRect, .activeAlways],
                                       owner: self, userInfo: nil))
        super.updateTrackingAreas()
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: cursor) }

    func setCursorShape(_ shape: ghostty_action_mouse_shape_e) {
        switch shape {
        case GHOSTTY_MOUSE_SHAPE_DEFAULT: cursor = .arrow
        case GHOSTTY_MOUSE_SHAPE_POINTER: cursor = .pointingHand
        case GHOSTTY_MOUSE_SHAPE_CROSSHAIR: cursor = .crosshair
        case GHOSTTY_MOUSE_SHAPE_EW_RESIZE, GHOSTTY_MOUSE_SHAPE_COL_RESIZE: cursor = .resizeLeftRight
        case GHOSTTY_MOUSE_SHAPE_NS_RESIZE, GHOSTTY_MOUSE_SHAPE_ROW_RESIZE: cursor = .resizeUpDown
        case GHOSTTY_MOUSE_SHAPE_NOT_ALLOWED: cursor = .operationNotAllowed
        default: cursor = .iBeam
        }
        window?.invalidateCursorRects(for: self)
    }

    private func button(_ state: ghostty_input_mouse_state_e, _ b: ghostty_input_mouse_button_e, _ e: NSEvent) -> Bool {
        guard let surface else { return false }
        return ghostty_surface_mouse_button(surface, state, b, Self.mods(e.modifierFlags))
    }

    override func mouseDown(with e: NSEvent) {
        if window?.firstResponder !== self { window?.makeFirstResponder(self) }
        _ = button(GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, e)
    }

    override func mouseUp(with e: NSEvent) {
        _ = button(GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, e)
        if let surface { ghostty_surface_mouse_pressure(surface, 0, 0) }
    }

    override func rightMouseDown(with e: NSEvent) {
        if !button(GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, e) { super.rightMouseDown(with: e) }
    }

    override func rightMouseUp(with e: NSEvent) {
        if !button(GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, e) { super.rightMouseUp(with: e) }
    }

    override func otherMouseDown(with e: NSEvent) { _ = button(GHOSTTY_MOUSE_PRESS, Self.other(e.buttonNumber), e) }
    override func otherMouseUp(with e: NSEvent) { _ = button(GHOSTTY_MOUSE_RELEASE, Self.other(e.buttonNumber), e) }

    private static func other(_ n: Int) -> ghostty_input_mouse_button_e {
        switch n {
        case 2: GHOSTTY_MOUSE_MIDDLE
        case 3: GHOSTTY_MOUSE_FOUR
        case 4: GHOSTTY_MOUSE_FIVE
        default: GHOSTTY_MOUSE_UNKNOWN
        }
    }

    override func mouseMoved(with e: NSEvent) {
        guard let surface else { return }
        let p = convert(e.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, p.x, frame.height - p.y, Self.mods(e.modifierFlags))
    }

    override func mouseDragged(with e: NSEvent) { mouseMoved(with: e) }
    override func rightMouseDragged(with e: NSEvent) { mouseMoved(with: e) }
    override func otherMouseDragged(with e: NSEvent) { mouseMoved(with: e) }
    override func mouseEntered(with e: NSEvent) { mouseMoved(with: e) }

    override func mouseExited(with e: NSEvent) {
        // A drag still reports positions; otherwise -1, -1 says the pointer left.
        guard let surface, NSEvent.pressedMouseButtons == 0 else { return }
        ghostty_surface_mouse_pos(surface, -1, -1, Self.mods(e.modifierFlags))
    }

    override func scrollWheel(with e: NSEvent) {
        guard let surface else { return }
        var x = e.scrollingDeltaX, y = e.scrollingDeltaY
        let precise = e.hasPreciseScrollingDeltas
        if precise { x *= 2; y *= 2 }
        // Ghostty's packed scroll mods: bit 0 precision, bits 1 to 3 the momentum phase.
        var m: Int32 = precise ? 1 : 0
        m |= Int32(Self.momentum(e.momentumPhase)) << 1
        ghostty_surface_mouse_scroll(surface, x, y, ghostty_input_scroll_mods_t(m))
    }

    private static func momentum(_ p: NSEvent.Phase) -> UInt32 {
        switch p {
        case .began: GHOSTTY_MOUSE_MOMENTUM_BEGAN.rawValue
        case .stationary: GHOSTTY_MOUSE_MOMENTUM_STATIONARY.rawValue
        case .changed: GHOSTTY_MOUSE_MOMENTUM_CHANGED.rawValue
        case .ended: GHOSTTY_MOUSE_MOMENTUM_ENDED.rawValue
        case .cancelled: GHOSTTY_MOUSE_MOMENTUM_CANCELLED.rawValue
        case .mayBegin: GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN.rawValue
        default: GHOSTTY_MOUSE_MOMENTUM_NONE.rawValue
        }
    }

    override func pressureChange(with e: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_pressure(surface, UInt32(max(0, e.stage)), Double(e.pressure))
    }
}
#endif
