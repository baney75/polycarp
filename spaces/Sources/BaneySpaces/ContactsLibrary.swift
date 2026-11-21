import AppKit
import BaneySpacesCore
import Contacts

/// The people in macOS Contacts, for the launcher's rows and `polycarp-spaces contacts` (docs/contacts.md). It reads
/// names, nicknames, companies, numbers, addresses and small pictures on its own queue into a `ContactsIndex`, and
/// reads them again when Contacts changes. It never asks macOS for access: only the permission flow does, after the
/// owner picks the launcher's Allow row or the button in Settings > Permissions (`PermissionsModel.perform`).
final class ContactsLibrary {
    static let shared = ContactsLibrary()

    /// The launcher's rows, on the main thread.
    let provider = ContactsProvider()
    /// The launcher redraws its rows when the people or the access change.
    var onChange: () -> Void = {}

    private let queue = DispatchQueue(label: "polycarp.contacts", qos: .userInitiated)
    private var loaded = false
    private var loading = false
    /// A change that came in while a read ran: read once more after it.
    private var again = false
    private var observer: NSObjectProtocol?
    private var debounce: DispatchWorkItem?
    /// Failed reads back off and then stop until the launcher opens (`ContactsReadRetry`).
    private var retry = ContactsReadRetry()
    private var retryWork: DispatchWorkItem?
    static let recentsURL = Spaces.folder.appendingPathComponent(ContactRecents.fileName)

    private init() {}

    /// At launch: the recents, and the people when access is already on. Asks nothing.
    func start() {
        queue.async { [weak self] in
            let recents = ContactRecents.decode(try? Data(contentsOf: Self.recentsURL))
            DispatchQueue.main.async { self?.provider.use(recents) }
        }
        observer = NotificationCenter.default.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.changed()
        }
        refreshAccess()
    }

    var state: PermissionState { Permissions.contactsState(CNContactStore.authorizationStatus(for: .contacts).rawValue) }

    /// Reads macOS's answer (no prompt) and loads the people the first time it is yes. The launcher calls it each time
    /// it opens, so a switch turned on in System Settings counts at once.
    func refreshAccess() {
        var now = ContactsAccess(state, loaded: loaded)
        if now == .loading, retry.gaveUp { now = .failed }
        if now != provider.access { provider.access = now; onChange() }
        // A retry already waiting keeps its back-off: this never reads sooner.
        if now == .loading, retryWork == nil { load() }
        if now == .denied || now == .notAsked {
            retry.reset()
            retryWork?.cancel()
            retryWork = nil
            if loaded {
                loaded = false
                provider.use(ContactsIndex([]))
            }
        }
    }

    /// The launcher opened: after reads that all failed, try once more from the start.
    func launcherOpened() {
        if retry.gaveUp { retry.reset() }
        refreshAccess()
    }

    /// Contacts changed: read again once it has been quiet for a second.
    private func changed() {
        // A failed read waits out its back-off, or the next launcher open once it stopped.
        guard state == .granted, !retry.gaveUp, retryWork == nil else { return refreshAccess() }
        debounce?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.load(force: true) }
        debounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    private func load(force: Bool = false) {
        guard force || !loaded else { return }
        guard !loading else { again = true; return }
        loading = true
        let started = ProcessInfo.processInfo.systemUptime
        queue.async { [weak self] in
            let people = Self.read()
            let index = ContactsIndex(people ?? [])
            let ms = Int(((ProcessInfo.processInfo.systemUptime - started) * 1000).rounded())
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading = false
                if let people {
                    self.loaded = true
                    self.retry.reset()
                    self.provider.use(index)
                    // Counts only: never a name.
                    Trace.log("contacts: read \(people.count) people in \(ms) ms")
                } else if !self.loaded {
                    self.scheduleRetry()
                }
                if self.again { self.again = false; self.load(force: true); return }
                self.refreshAccess()
                self.onChange()
            }
        }
    }

    /// A read failed: try again after the next back-off, or stop and say so until the launcher opens.
    private func scheduleRetry() {
        guard let delay = retry.failed() else {
            Trace.log("contacts: read failed \(retry.failures) times; stopped until the launcher opens")
            return
        }
        let work = DispatchWorkItem { [weak self] in
            self?.retryWork = nil
            self?.load(force: true)
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Every person, off the main thread. Nil when Contacts refused.
    private static func read() -> [ContactRecord]? {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactNicknameKey as CNKeyDescriptor, CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactThumbnailImageDataKey as CNKeyDescriptor,
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.unifyResults = true
        let formatter = CNContactFormatter()
        formatter.style = .fullName
        var out: [ContactRecord] = []
        do {
            try CNContactStore().enumerateContacts(with: request) { c, _ in
                let phones = c.phoneNumbers.map { ContactHandle(.phone, $0.value.stringValue, label: label($0.label)) }
                let emails = c.emailAddresses.map { ContactHandle(.email, $0.value as String, label: label($0.label)) }
                let name = formatter.string(from: c) ?? ""
                guard !(name.isEmpty && c.organizationName.isEmpty), !(phones.isEmpty && emails.isEmpty) else { return }
                out.append(ContactRecord(id: c.identifier, name: name, nickname: c.nickname, organization: c.organizationName,
                                         phones: phones, emails: emails, thumbnail: c.thumbnailImageData))
            }
        } catch {
            Trace.log("contacts: read failed (\((error as NSError).code))")
            return nil
        }
        return out
    }

    /// "mobile", "iPhone", "home", "work": Contacts' own words for its labels.
    private static func label(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        if raw == CNLabelPhoneNumberMobile { return "mobile" }
        if raw == CNLabelPhoneNumberiPhone { return "iPhone" }
        return CNLabeledValue<NSString>.localizedString(forLabel: raw)
    }

    // MARK: Acting

    /// Opens the link (the Phone app, FaceTime, Messages with the draft, Mail) and notes who and when in the recents.
    /// Messages gets the draft in its box; Polycarp never sends it.
    func open(_ launch: ContactLaunch, from caller: String) {
        NSWorkspace.shared.open(launch.url)
        var recents = provider.recents
        recents.note(launch, at: Date().timeIntervalSince1970)
        provider.use(recents)
        let data = recents.encoded()
        queue.async {
            try? FileManager.default.createDirectory(at: Spaces.folder, withIntermediateDirectories: true)
            try? data.write(to: Self.recentsURL, options: .atomic)
        }
        Trace.log("contacts: \(launch.verb.rawValue) opened by \(caller)")
    }

    /// `polycarp-spaces contacts …` on the socket. Never asks macOS: a command isn't the owner's first use.
    func handle(_ r: Wire.Request) -> Wire.Reply {
        guard r.caller?.hasPrefix("remote ") != true else { return .init(ok: false, error: "contacts are read on this Mac only") }
        refreshAccess()
        let (reply, launch) = ContactsCommand.answer(r, access: provider.access, index: provider.index, recents: provider.recents)
        if let launch { open(launch, from: r.caller ?? "the command") }
        return reply
    }
}
