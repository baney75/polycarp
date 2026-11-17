import AppKit
import BaneySpacesCore
import LocalAuthentication
import Security

/// The agent access mode Donovan picked (Settings > Agents), read by the hands on any thread. Only `set`, called
/// from Settings or the menu after `AccessConsent` when it widens access, changes it; nothing on the socket and no
/// line in config.toml does. Like every saved setting, another process of his could rewrite the defaults domain;
/// that is outside the host threat model (docs/agent-computer-use.md), so a mode other than Default is logged at launch.
final class AgentAccess {
    static let shared = AgentAccess()
    private let lock = NSLock()
    private var mode = AgentAccessMode(saved: UserDefaults.standard.string(forKey: AgentAccessMode.defaultsKey))
    /// Processes `agent open` reached only because of Full Access: an app off the list it started, or one of Donovan's
    /// running apps it claimed a window of. Their windows are refused again once the mode is no longer Full Access,
    /// even on the agent workspace. Kept by start time, so a reused pid is never taken for one.
    private var grants = AgentOwnedSet()
    /// The same grants as saved: those of processes that have quit drop out at the next launch.
    private var saved: [[Double]] = []
    /// Called on the main thread after the mode changes: the menu bar, Settings, state.json.
    var onChange: ((AgentAccessMode) -> Void)?

    /// Where the grants are kept, so a relaunch of BaneySpaces doesn't forget them: pid and start time pairs.
    static let grantsKey = "agentAccessGrants"

    private init() {
        if mode != .standard { Trace.log("agent access at launch: \(mode.rawValue) (saved in Settings)") }
        // Only the processes still running as the same process (pid and start time) come back.
        for pair in UserDefaults.standard.array(forKey: Self.grantsKey) as? [[Double]] ?? [] where pair.count == 2 {
            let pid = Int32(pair[0])
            if let t = AgentOwned.startTime(pid), abs(t - pair[1]) < 0.5 { grants.add(pid, startedAt: t); saved.append(pair) }
        }
    }

    var current: AgentAccessMode {
        lock.lock(); defer { lock.unlock() }
        return mode
    }

    func grant(_ pid: Int32) {
        guard let t = AgentOwned.startTime(pid) else { return }
        lock.lock()
        grants.add(pid, startedAt: t)
        saved.removeAll { Int32($0[0]) == pid }
        saved.append([Double(pid), t])
        let all = saved
        lock.unlock()
        UserDefaults.standard.set(all, forKey: Self.grantsKey)
    }

    /// Whether `pid` is one Full Access let in.
    func grantedUnderFull(_ pid: Int32) -> Bool {
        lock.lock(); let g = grants; lock.unlock()
        return g.contains(pid, startedAt: AgentOwned.startTime(pid))
    }

    /// Main thread only. The caller has already asked Donovan when the change widens access.
    func set(_ new: AgentAccessMode) {
        lock.lock(); let old = mode; mode = new; lock.unlock()
        guard old != new else { return }
        UserDefaults.standard.set(new.rawValue, forKey: AgentAccessMode.defaultsKey)
        Trace.log("agent access: \(old.rawValue) -> \(new.rawValue)")
        onChange?(new)
    }

    /// Asks first when `new` widens access; true when the mode is now `new`. Main thread only.
    @discardableResult
    func request(_ new: AgentAccessMode) -> Bool {
        let old = current
        guard old != new else { return true }
        if new.widens(from: old), !AccessConsent.ask(new) { return false }
        set(new)
        return true
    }

    /// "Turn on everything": asks once, and true when the person said yes. Main thread only. What it covers beyond this mode, the
    /// caller turns on (`BrowserModel.turnOnEverything`).
    @discardableResult
    func requestEverything() -> Bool {
        guard AccessConsent.askEverything() else { return false }
        if current != .full { set(.full) }
        return true
    }
}

/// Donovan's "Agents may change what you see" (`ViewControl`). Like the access mode it is read once at launch and changed
/// only from Settings. The stored value is sealed (`ViewControl.seal`) under a key in the app's own Keychain item, so a
/// `defaults write`, a hand edit of the plist or a value copied from an earlier turn-on reads as off. Turning it off
/// deletes the key; turning it on makes a new one. Polycarp's own windows are never an agent's, so no agent clicks it.
final class ViewControlSetting {
    static let shared = ViewControlSetting()
    private let lock = NSLock()
    private var on: Bool

    private init() {
        let stored = UserDefaults.standard.object(forKey: ViewControl.defaultsKey)
        // No stored value, no Keychain read: a launch with the switch off never touches the Keychain.
        on = stored != nil && ViewControl.isOn(stored, key: ViewControlKey.read())
        if on {
            Trace.log("agent view control at launch: on (sealed in Settings)")
        } else if stored != nil {
            Trace.log("agent view control at launch: off (the saved value has no valid seal)")
        }
    }

    var enabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return on
    }

    /// Settings > Agents only, on the main thread.
    func set(_ new: Bool) {
        lock.lock(); let old = on; lock.unlock()
        guard old != new else { return }
        if new {
            let key = ViewControl.newKey()
            guard ViewControlKey.write(key) else {
                Trace.log("agent view control: stays off, the Keychain refused its key")
                return
            }
            UserDefaults.standard.set(ViewControl.seal(key: key), forKey: ViewControl.defaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: ViewControl.defaultsKey)
            ViewControlKey.delete()
        }
        lock.lock(); on = new; lock.unlock()
        Trace.log("agent view control: \(new ? "on" : "off")")
    }
}

/// The view control key: one generic password item the app makes, readable without a prompt only by the app that made it.
/// Reads never show a Keychain dialog; one that would counts as no key, so the switch reads off.
enum ViewControlKey {
    static let service = "com.baney.polycarp.agentViewControl"
    static let account = "seal-key"

    static func read() -> Data? {
        let noPrompt = LAContext()
        noPrompt.interactionNotAllowed = true
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne,
                                kSecUseAuthenticationContext as String: noPrompt]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func write(_ key: Data) -> Bool {
        delete()
        let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: account, kSecValueData as String: key,
                                   kSecAttrLabel as String: "Polycarp agent view control"]
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                       kSecAttrAccount as String: account] as CFDictionary)
    }
}
