import XCTest
@testable import BaneySpacesCore

/// Calling and messaging people from the launcher and the command (docs/contacts.md): the index finds people by name,
/// nickname and company, the people reached lately come first, the right number or address is picked, every link
/// carries what was typed, and nothing is shown or asked without Contacts access.
final class ContactsTests: XCTestCase {
    static let anna = ContactRecord(id: "anna", name: "Anna Smith", nickname: "Annie", organization: "Acme",
                                    phones: [ContactHandle(.phone, "(555) 010-2000", label: "home"),
                                             ContactHandle(.phone, "+1 555 010 3000", label: "mobile")],
                                    emails: [ContactHandle(.email, "anna+work@example.com", label: "work")])
    static let annaJ = ContactRecord(id: "annaj", name: "Anna Jones", phones: [ContactHandle(.phone, "555 010 4000", label: "work")])
    static let jose = ContactRecord(id: "jose", name: "José Álvarez", emails: [ContactHandle(.email, "jose@example.com")])
    static let acme = ContactRecord(id: "acme", name: "", organization: "Acme Plumbing", phones: [ContactHandle(.phone, "555 010 5000")])
    static let joanna = ContactRecord(id: "joanna", name: "Joanna Lee", phones: [ContactHandle(.phone, "555 010 6000", label: "iPhone")])
    static let mary = ContactRecord(id: "mary", name: "Mary-Jane Watson", phones: [ContactHandle(.phone, "555 010 7000")])
    static let people = [anna, annaJ, jose, acme, joanna, mary]

    private func names(_ index: ContactsIndex, _ q: String, ranks: [UInt16]? = nil) -> [String] {
        index.search(q, ranks: ranks).map { index.records[$0.index].name }
    }

    // MARK: Loading

    func testTheIndexHoldsEveryPersonAndFindsThemByNameNicknameAndCompany() {
        let index = ContactsIndex(Self.people)
        XCTAssertEqual(index.count, 6)
        XCTAssertEqual(index.index(of: "jose"), 2)
        XCTAssertEqual(names(index, "annie"), ["Anna Smith"], "a nickname finds the person")
        XCTAssertEqual(names(index, "acme").first, "Acme Plumbing", "a company card is named by its company")
        XCTAssertTrue(names(index, "acme").contains("Anna Smith"), "a company finds the people who work there")
        XCTAssertEqual(names(index, "jose alv"), ["José Álvarez"], "accents and case fold away")
        XCTAssertEqual(names(index, "mary jane"), ["Mary-Jane Watson"], "a hyphen in a name is a space in the query")
        XCTAssertEqual(ContactsIndex([]).search("anna"), [])
        XCTAssertEqual(index.search("   "), [])
    }

    func testACompanyCardTakesTheCompanyAsItsName() {
        XCTAssertEqual(Self.acme.name, "Acme Plumbing")
        XCTAssertEqual(ContactSummary(Self.acme, full: false).organization, nil, "not said twice")
    }

    // MARK: Ranking

    func testTheWholeNameBeatsAPrefixBeatsAWordBeatsInitialsBeatsLettersInside() {
        let index = ContactsIndex(Self.people)
        let tiers = { (q: String, name: String) -> Int? in
            index.search(q, limit: 10).first { index.records[$0.index].name == name }?.tier
        }
        XCTAssertEqual(tiers("anna smith", "Anna Smith"), 5)
        XCTAssertEqual(tiers("anna", "Anna Smith"), 4)
        XCTAssertEqual(tiers("smith", "Anna Smith"), 3)
        XCTAssertEqual(tiers("an sm", "Anna Smith"), 3)
        XCTAssertEqual(tiers("as", "Anna Smith"), 2)
        XCTAssertEqual(tiers("nna", "Joanna Lee"), 1)
        XCTAssertEqual(tiers("jnle", "Joanna Lee"), 0)
        XCTAssertNil(tiers("zz", "Anna Smith"))
        // Among prefixes, the shorter name first, then Contacts' own order; a match inside a word after.
        XCTAssertEqual(names(index, "anna"), ["Anna Smith", "Anna Jones", "Joanna Lee"])
        XCTAssertEqual(names(index, "j"), ["Joanna Lee", "José Álvarez", "Anna Jones", "Mary-Jane Watson"],
                       "names that start with it, shorter first, then the ones with a word that does")
    }

    func testPeopleReachedLatelyComeFirstAmongGoodMatchesOnly() throws {
        let index = ContactsIndex(Self.people)
        var recents = ContactRecents()
        recents.note(try XCTUnwrap(ContactLaunch(Self.anna, .call)), at: 1)
        XCTAssertEqual(names(index, "anna", ranks: index.ranks(recents)).first, "Anna Smith", "the one called lately beats the shorter name")
        recents.note(try XCTUnwrap(ContactLaunch(Self.joanna, .message)), at: 2)
        let ranks = index.ranks(recents)
        // Joanna matches "anna" only inside a word, so the recents don't lift her over real prefixes.
        XCTAssertEqual(names(index, "anna", ranks: ranks), ["Anna Smith", "Anna Jones", "Joanna Lee"])
        XCTAssertEqual(names(index, "jo", ranks: ranks).first, "Joanna Lee")
        XCTAssertTrue(index.search("joanna", ranks: ranks)[0].recent)
        XCTAssertEqual(ContactRecents(recents.uses).order, ["joanna", "anna"], "newest first")
    }

    // MARK: Picking the number or address

    func testTheHandleUsedLastWinsThenAMobileThenTheFirst() throws {
        XCTAssertEqual(ContactLinks.pick(.call, for: Self.anna)?.label, "mobile", "a mobile beats the first")
        XCTAssertEqual(ContactLinks.pick(.call, for: Self.annaJ)?.label, "work", "no mobile: the first")
        XCTAssertEqual(ContactLinks.pick(.call, for: Self.joanna)?.label, "iPhone", "an iPhone is a mobile")
        let home = Self.anna.phones[0]
        XCTAssertEqual(ContactLinks.pick(.call, for: Self.anna, lastUsed: home.fingerprint), home, "the one used last")
        XCTAssertEqual(ContactLinks.pick(.message, for: Self.anna, lastUsed: Self.anna.emails[0].fingerprint), Self.anna.emails[0])
        XCTAssertEqual(ContactLinks.pick(.call, for: Self.anna, lastUsed: Self.anna.emails[0].fingerprint)?.label, "mobile",
                       "a call goes to a phone when the person has one")
        XCTAssertEqual(ContactLinks.pick(.email, for: Self.anna)?.value, "anna+work@example.com")
        XCTAssertNil(ContactLinks.pick(.email, for: Self.annaJ))
        XCTAssertEqual(ContactLinks.pick(.call, for: Self.jose)?.kind, .email, "an address only: FaceTime audio")

        var recents = ContactRecents()
        recents.note(try XCTUnwrap(ContactLaunch(Self.anna, .call, lastUsed: home.fingerprint)), at: 1)
        XCTAssertEqual(recents.lastHandle("anna"), home.fingerprint)
    }

    func testReturnCallsAPersonWithANumberAndEmailsOneWithout() {
        XCTAssertEqual(Self.anna.verbs, [.call, .facetime, .message, .email])
        XCTAssertEqual(Self.annaJ.verbs, [.call, .facetime, .message])
        XCTAssertEqual(Self.jose.verbs, [.email, .message, .facetime, .call])
        XCTAssertEqual(ContactRecord(id: "x", name: "Nobody").verbs, [])
    }

    // MARK: Links

    func testANumberStopsAtItsExtensionOrPauseAndSpellsVanityLetters() throws {
        let cases: [(String, String)] = [
            ("555-010-2000 ext. 123", "5550102000"),
            ("+1 (555) 010-2000 x123", "+15550102000"),
            ("+1 (555) 010-2000 X 123", "+15550102000"),
            ("555-0100 ext. 23", "5550100"),
            ("555-0100 extn 23", "5550100"),
            ("+44 20 7946 0958 extension 7", "+442079460958"),
            ("555 0100,,4", "5550100"),
            ("555 0100;4", "5550100"),
            ("555 0100#4", "5550100"),
            ("555 0100*4", "5550100"),
            ("1-800-FLOWERS", "18003569377"),
            ("1-800-XBOX", "18009269"),
            ("1-800-MY-APPLE", "18006927753"),
            ("1-800-flowers", "18003569377"),
            // Annotation words and labels are notes, never spelled into digits.
            ("555-0100 (cell)", "5550100"),
            ("555-0100(cell)", "5550100"),
            ("555-0100 Mom", "5550100"),
            ("Tel +1 555 0100", "+15550100"),
            ("Mom 555-0100", "5550100"),
            ("1 800 my apple", "1800"),
            ("555-0100x23", "5550100"),
            ("Mom", ""),
            ("+1+555", "+1555"),
            ("ext. 123", ""),
            ("x", ""),
        ]
        for (raw, want) in cases {
            XCTAssertEqual(ContactHandle(.phone, raw).dialable, want, raw)
        }
        let ext = ContactHandle(.phone, "555-010-2000 ext. 123", label: "work")
        XCTAssertEqual(ContactLinks.url(.call, ext)?.absoluteString, "tel:5550102000")
        XCTAssertEqual(ContactLinks.url(.facetime, ext)?.absoluteString, "facetime:5550102000")
        XCTAssertEqual(ContactLinks.url(.message, ext)?.absoluteString, "sms://open?addresses=5550102000")
        XCTAssertEqual(ContactLinks.url(.call, ContactHandle(.phone, "1-800-FLOWERS"))?.absoluteString, "tel:18003569377")
        XCTAssertEqual(ext.fingerprint, ContactHandle(.phone, "555 010 2000").fingerprint, "the extension isn't part of who was called")
    }

    func testEachVerbBuildsItsLink() throws {
        let mobile = Self.anna.phones[1]
        XCTAssertEqual(mobile.dialable, "+15550103000")
        XCTAssertEqual(Self.anna.phones[0].dialable, "5550102000")
        XCTAssertEqual(ContactLinks.url(.call, mobile)?.absoluteString, "tel:+15550103000")
        XCTAssertEqual(ContactLinks.url(.facetime, mobile)?.absoluteString, "facetime:+15550103000")
        XCTAssertEqual(ContactLinks.url(.message, mobile)?.absoluteString, "sms://open?addresses=%2B15550103000")
        let mail = Self.anna.emails[0]
        XCTAssertEqual(ContactLinks.url(.email, mail)?.absoluteString, "mailto:anna+work@example.com")
        XCTAssertEqual(ContactLinks.url(.call, mail)?.absoluteString, "facetime-audio:anna+work@example.com")
        XCTAssertEqual(ContactLinks.url(.facetime, mail)?.absoluteString, "facetime:anna+work@example.com")
        XCTAssertNil(ContactLinks.url(.email, mobile), "email needs an address")
        XCTAssertNil(ContactLinks.url(.call, ContactHandle(.phone, "ext.")), "no digits, no link")
    }

    func testTheDraftReachesMessagesAsTypedWithSpacesPlusSignsAccentsAndEmoji() throws {
        let mobile = Self.anna.phones[1]
        for draft in ["running late", "1+1=2 & more #soon", "café à côté", "on my way 🏃‍♀️🚗", "50% off? yes/no"] {
            let url = try XCTUnwrap(ContactLinks.url(.message, mobile, text: draft), draft)
            XCTAssertFalse(url.absoluteString.contains(" "), draft)
            let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems, draft)
            XCTAssertEqual(items.first { $0.name == "addresses" }?.value, "+15550103000", draft)
            XCTAssertEqual(items.first { $0.name == "body" }?.value, draft, draft)
            XCTAssertEqual(items.count, 2, "an & in the draft never starts another field: \(draft)")
        }
        XCTAssertTrue(try XCTUnwrap(ContactLinks.url(.message, mobile, text: "a+b")).absoluteString.hasSuffix("body=a%2Bb"),
                      "a plus sign is escaped, never read as a space")
        let mail = try XCTUnwrap(ContactLinks.url(.email, Self.anna.emails[0], text: "see you 🎉"))
        XCTAssertEqual(URLComponents(url: mail, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "see you 🎉")
        XCTAssertEqual(ContactLinks.url(.message, mobile, text: "   ")?.absoluteString, "sms://open?addresses=%2B15550103000", "blank is no draft")
    }

    func testACallNeverCarriesADraft() throws {
        let launch = try XCTUnwrap(ContactLaunch(Self.anna, .call, text: "hello"))
        XCTAssertEqual(launch.text, "")
        XCTAssertEqual(launch.url.absoluteString, "tel:+15550103000")
    }

    // MARK: Reading what was typed

    func testAVerbFirstAndTheDraftAfterTheName() {
        let index = ContactsIndex(Self.people)
        let matches = { (s: String) in index.hasWordMatch(s) }
        XCTAssertEqual(ContactQuery.parse("anna", matches: matches), ContactQuery(verb: nil, name: "anna"))
        XCTAssertEqual(ContactQuery.parse("call anna", matches: matches), ContactQuery(verb: .call, name: "anna"))
        XCTAssertEqual(ContactQuery.parse("call", matches: matches), ContactQuery(verb: nil, name: "call"), "still typing: an app named Call")
        XCTAssertEqual(ContactQuery.parse("call ", matches: matches), ContactQuery(verb: .call, name: ""))
        XCTAssertEqual(ContactQuery.parse("message Anna running late", matches: matches),
                       ContactQuery(verb: .message, name: "Anna", text: "running late"))
        XCTAssertEqual(ContactQuery.parse("text anna smith  on my  way 🚗", matches: matches),
                       ContactQuery(verb: .message, name: "anna smith", text: "on my  way 🚗"), "the draft keeps its own spacing")
        XCTAssertEqual(ContactQuery.parse("message anna sm", matches: matches), ContactQuery(verb: .message, name: "anna sm"),
                       "still typing the name")
        XCTAssertEqual(ContactQuery.parse("call anna smith now", matches: matches), ContactQuery(verb: .call, name: "anna smith now"),
                       "a call takes no draft")
        XCTAssertEqual(ContactQuery.parse("mail jose see you", matches: matches), ContactQuery(verb: .email, name: "jose", text: "see you"))
    }

    // MARK: Launcher rows

    private func allowed() -> ContactsProvider {
        let p = ContactsProvider()
        p.use(ContactsIndex(Self.people))
        p.access = .allowed
        return p
    }

    func testANameShowsThePersonWithCallOnReturnAndTheNextOnCommandReturn() throws {
        let rows = allowed().results(for: "anna smith")
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.title, "Anna Smith")
        XCTAssertEqual(row.badge, "Call")
        guard case .contact(let call) = row.action, case .contact(let ft)? = row.second else { return XCTFail("contact actions") }
        XCTAssertEqual(call.url.absoluteString, "tel:+15550103000")
        XCTAssertEqual(ft.verb, .facetime)
        XCTAssertEqual(row.secondTitle, "FaceTime")
        XCTAssertEqual(row.placement, .normal, "a plain name waits below apps")
        XCTAssertTrue(allowed().results(for: "a").isEmpty, "one letter shows no people")
    }

    func testAVerbLeadsTheRowAndAMessageCarriesItsDraft() throws {
        let rows = allowed().results(for: "message Anna Smith running late")
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.placement, .top)
        XCTAssertEqual(row.badge, "Message")
        guard case .contact(let msg) = row.action else { return XCTFail("a message") }
        XCTAssertEqual(msg.text, "running late")
        XCTAssertEqual(URLComponents(url: msg.url, resolvingAgainstBaseURL: false)?.queryItems?.last?.value, "running late")
        XCTAssertTrue(row.subtitle.contains("you press Send"))
        guard case .contact(let call)? = row.second else { return XCTFail("the call after it") }
        XCTAssertEqual(call.verb, .call)
        XCTAssertTrue(allowed().results(for: "email anna jones").isEmpty, "no address, no email row")
    }

    func testCallWithNoNameYetOffersThePeopleCalledLately() throws {
        let p = allowed()
        var recents = ContactRecents()
        recents.note(try XCTUnwrap(ContactLaunch(Self.joanna, .call)), at: 1)
        p.use(recents)
        XCTAssertEqual(p.results(for: "call ").map(\.title), ["Joanna Lee"])
    }

    // MARK: A verb never takes an app's launch (review of #580, second-F4)

    static let apps = ["TextEdit", "Mail", "iPhone Mirroring", "FaceTime", "System Settings", "Phone", "Messages", "Contacts"]
    static let edith = ContactRecord(id: "edith", name: "Edith Park", phones: [ContactHandle(.phone, "555 010 8000", label: "mobile")])
    static let meredith = ContactRecord(id: "meredith", name: "Meredith Grey", phones: [ContactHandle(.phone, "555 010 9000")])

    private func provider(_ access: ContactsAccess, apps: [String] = ContactsTests.apps) -> ContactsProvider {
        let p = ContactsProvider()
        p.use(ContactsIndex(Self.people + [Self.edith, Self.meredith]))
        p.useApps(apps)
        p.access = access
        return p
    }

    func testAppNamesTypedWithAVerbWordStillOpenTheApp() {
        // The launcher draws provider rows placed `top` above apps, so no top row means the app's row comes first.
        for access in [ContactsAccess.notAsked, .denied, .failed, .loading, .allowed] {
            let p = provider(access)
            for typed in ["text edit", "text ed", "mail settings", "phone mirroring", "facetime", "facetime ", "phone ", "messages"] {
                let rows = LauncherProviders.results([p], for: typed)
                XCTAssertTrue(rows.top.isEmpty, "\(access) \"\(typed)\" put \(rows.top.map(\.title)) above the apps")
                XCTAssertFalse(rows.normal.contains { if case .contact(let l) = $0.action { return l.verb == .message || l.verb == .email } else { return false } },
                               "\(access) \"\(typed)\" offered a message or an email")
            }
        }
        XCTAssertTrue(provider(.allowed).results(for: "text edit").isEmpty, "Edith is not TextEdit")
        XCTAssertTrue(provider(.notAsked).results(for: "text edit").isEmpty, "TextEdit never asks for Contacts")
    }

    func testAVerbAndARealNameStillFindThePerson() throws {
        let p = provider(.allowed)
        let anna = try XCTUnwrap(LauncherProviders.results([p], for: "text anna").top.first)
        XCTAssertEqual(anna.title, "Anna Smith", "two Annas of one length: Contacts' own order")
        guard case .contact(let msg) = anna.action else { return XCTFail("a message") }
        XCTAssertEqual(msg.verb, .message)
        XCTAssertEqual(LauncherProviders.results([p], for: "text anna smith").top.first?.title, "Anna Smith")
        XCTAssertEqual(LauncherProviders.results([p], for: "call edith").top.map(\.title), ["Edith Park"])
        XCTAssertEqual(LauncherProviders.results([p], for: "mail jose see you").top.first?.title, "José Álvarez")
    }

    func testAfterAVerbOnlyRealNameMatchesShowAndOnlyStrongOnesLead() {
        // No TextEdit on this Mac: "text edit" is a message to Edith, never to Meredith, whose name only holds "edit".
        let p = provider(.allowed, apps: [])
        let rows = LauncherProviders.results([p], for: "text edit")
        XCTAssertEqual(rows.top.map(\.title), ["Edith Park"])
        XCTAssertFalse((rows.top + rows.normal).contains { $0.title == "Meredith Grey" })
        // Initials (tier 2) show but wait below the apps; letters scattered through a name never show after a verb.
        let initials = LauncherProviders.results([p], for: "call ep")
        XCTAssertTrue(initials.top.isEmpty)
        XCTAssertEqual(initials.normal.map(\.title), ["Edith Park"])
        XCTAssertTrue(LauncherProviders.results([p], for: "call eprk").normal.isEmpty)
        // Without access the ask and off rows never claim the top either.
        for row in [ContactsProvider.askRow, ContactsProvider.deniedRow, ContactsProvider.failedRow] {
            XCTAssertEqual(row.placement, .normal, row.id)
        }
    }

    // MARK: Without access

    func testWithoutAccessTheLauncherAsksOnlyWhenAContactFeatureIsUsed() {
        let p = ContactsProvider()
        p.use(ContactsIndex(Self.people))
        p.access = .notAsked
        XCTAssertTrue(p.results(for: "anna").isEmpty, "a plain search never asks")
        XCTAssertEqual(p.results(for: "call anna"), [ContactsProvider.askRow])
        XCTAssertEqual(p.results(for: "contacts"), [ContactsProvider.askRow])
        XCTAssertEqual(ContactsProvider.askRow.action, .contactsAccess)
        XCTAssertEqual(ContactsProvider.askRow.subtitle, ContactsAccess.why)
        XCTAssertFalse(ContactsAccess.why.contains("\u{2014}") || ContactsAccess.why.contains("\u{2013}"))
        p.access = .loading
        XCTAssertTrue(p.results(for: "call anna").isEmpty)
    }

    func testDeniedSaysSoInOneRowThatOpensTheContactsPane() {
        let p = ContactsProvider()
        p.use(ContactsIndex(Self.people))
        p.access = .denied
        XCTAssertEqual(p.results(for: "message anna hi"), [ContactsProvider.deniedRow])
        XCTAssertTrue(p.results(for: "anna").isEmpty)
        XCTAssertEqual(ContactsProvider.deniedRow.badge, "Open Settings")
        let entry = Permissions.entry(.contacts)
        XCTAssertEqual(entry.settingsURL, "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts")
        XCTAssertEqual(Permissions.action(entry, .denied), .openSettings(requestFirst: false, helper: false))
        XCTAssertEqual(Permissions.action(entry, .notAsked), .ask)
        // CNAuthorizationStatus: notDetermined, restricted, denied, authorized, limited.
        XCTAssertEqual([0, 1, 2, 3, 4, 9].map(Permissions.contactsState), [.notAsked, .denied, .denied, .granted, .granted, .unknown])
        XCTAssertEqual(ContactsAccess(.denied, loaded: false), .denied)
        XCTAssertEqual(ContactsAccess(.granted, loaded: false), .loading)
        XCTAssertEqual(ContactsAccess(.unknown, loaded: false), .notAsked)
    }

    func testTheCommandNeverAsksMacOSAndSaysWhatToDo() {
        let index = ContactsIndex(Self.people)
        let find = Wire.Request(op: .contacts, target: "anna", text: "find")
        let notAsked = ContactsCommand.answer(find, access: .notAsked, index: index, recents: ContactRecents())
        XCTAssertFalse(notAsked.reply.ok)
        XCTAssertTrue(notAsked.reply.error?.contains("never asks") == true)
        let denied = ContactsCommand.answer(find, access: .denied, index: index, recents: ContactRecents())
        XCTAssertTrue(denied.reply.error?.contains("Privacy & Security > Contacts") == true)
        XCTAssertNil(denied.open)
        XCTAssertFalse(Remote.allows(Wire.Request(op: .contacts, target: "anna", text: "find")), "another machine never reads people")
    }

    // MARK: The command

    func testFindGivesNamesAndKindsOfHandlesAndNumbersOnlyWhenAsked() throws {
        let index = ContactsIndex(Self.people)
        let plain = ContactsCommand.answer(Wire.Request(op: .contacts, target: "anna smith", text: "find"),
                                           access: .allowed, index: index, recents: ContactRecents())
        let anna = try XCTUnwrap(plain.reply.contacts?.first)
        XCTAssertEqual(anna.name, "Anna Smith")
        XCTAssertEqual(anna.handles.map(\.kind), ["phone", "phone", "email"])
        XCTAssertTrue(anna.handles.allSatisfy { $0.value == nil })
        XCTAssertEqual(anna.line, "Anna Smith (Annie, Acme)\tphone (home), phone (mobile), email (work)")
        let json = String(decoding: try JSONEncoder().encode(plain.reply), as: UTF8.self)
        XCTAssertFalse(json.contains("555"), "no number leaves the app without --full")
        XCTAssertNil(plain.open)
        let full = ContactsCommand.answer(Wire.Request(op: .contacts, target: "anna smith", text: "find", args: ["--full"]),
                                          access: .allowed, index: index, recents: ContactRecents())
        XCTAssertEqual(full.reply.contacts?.first?.handles.last?.value, "anna+work@example.com")
    }

    func testAnActionOpensTheSameLinkAndRefusesAnUnclearName() throws {
        let index = ContactsIndex(Self.people)
        let msg = ContactsCommand.answer(Wire.Request(op: .contacts, target: "anna smith", text: "message", args: ["--text", "running late 🏃"]),
                                         access: .allowed, index: index, recents: ContactRecents())
        let open = try XCTUnwrap(msg.open)
        XCTAssertEqual(open, ContactLaunch(Self.anna, .message, text: "running late 🏃"))
        XCTAssertEqual(msg.reply.info?["handle"], "phone (mobile)")
        XCTAssertNil(msg.reply.info?["value"])
        XCTAssertTrue(msg.reply.info?["note"]?.contains("never sends") == true)
        let unclear = ContactsCommand.answer(Wire.Request(op: .contacts, target: "anna", text: "call"),
                                             access: .allowed, index: index, recents: ContactRecents())
        XCTAssertNil(unclear.open)
        XCTAssertTrue(unclear.reply.error?.contains("Anna Smith, Anna Jones") == true, unclear.reply.error ?? "")
        let none = ContactsCommand.answer(Wire.Request(op: .contacts, target: "zed", text: "call"),
                                          access: .allowed, index: index, recents: ContactRecents())
        XCTAssertTrue(none.reply.error?.hasPrefix("no one") == true)
        let noMail = ContactsCommand.answer(Wire.Request(op: .contacts, target: "anna jones", text: "email"),
                                            access: .allowed, index: index, recents: ContactRecents())
        XCTAssertNil(noMail.open)
    }

    func testTheCommandLineBecomesOneRequest() throws {
        let r = try ContactsCommand.request(["message", "anna", "smith", "--text", "on my way", "--json"]).get()
        XCTAssertEqual(r, Wire.Request(op: .contacts, target: "anna smith", text: "message", args: ["--text", "on my way"]))
        XCTAssertEqual(try ContactsCommand.request(["find", "jo", "--full"]).get().args, ["--full"])
        XCTAssertThrowsError(try ContactsCommand.request(["call", "anna", "--text", "hi"]).get(), "a call takes no draft")
        XCTAssertThrowsError(try ContactsCommand.request(["send", "anna"]).get(), "there is no send")
        XCTAssertThrowsError(try ContactsCommand.request(["find"]).get())
        let back = try JSONDecoder().decode(Wire.Request.self, from: Data(#"{"op":"contacts","text":"find","target":"a"}"#.utf8))
        XCTAssertEqual(back.op, .contacts)
    }

    // MARK: Recents

    func testTheRecentsFileHoldsWhoAndWhenButNoNumberOrText() throws {
        var recents = ContactRecents()
        recents.note(try XCTUnwrap(ContactLaunch(Self.anna, .message, text: "secret plans 🎉")), at: 1_800_000_000)
        let text = String(decoding: recents.encoded(), as: UTF8.self)
        XCTAssertTrue(text.contains("\"anna\""))
        XCTAssertTrue(text.contains("1800000000"))
        XCTAssertFalse(text.contains("secret"), "no message text")
        XCTAssertFalse(text.contains("555") || text.contains("0103000"), "no number")
        XCTAssertEqual(ContactRecents.decode(recents.encoded()), recents)
        XCTAssertEqual(ContactRecents.decode(Data("not json".utf8)), ContactRecents())
        XCTAssertEqual(ContactRecents.decode(nil), ContactRecents())
        for n in 0..<(ContactRecents.limit + 20) { recents.note(try XCTUnwrap(ContactLaunch(Self.annaJ, .call)), at: Double(n)) }
        XCTAssertEqual(recents.uses.count, ContactRecents.limit, "a small file")
    }
}

/// A read of Contacts that fails backs off and then stops until the launcher opens (review of #580, sol-F2 and first-F1).
final class ContactsReadRetryTests: XCTestCase {
    func testAFailingReadBacksOffThenStops() {
        var retry = ContactsReadRetry()
        XCTAssertFalse(retry.gaveUp)
        XCTAssertEqual(retry.failed(), 1)
        XCTAssertEqual(retry.failed(), 5)
        XCTAssertEqual(retry.failed(), 30)
        XCTAssertFalse(retry.gaveUp, "the third retry is still to come")
        XCTAssertNil(retry.failed(), "after three retries it stops")
        XCTAssertTrue(retry.gaveUp)
        XCTAssertNil(retry.failed(), "and stays stopped")
        retry.reset()
        XCTAssertFalse(retry.gaveUp)
        XCTAssertEqual(retry.failed(), 1, "the launcher opening starts over")
    }

    func testAfterItStopsTheLauncherAndTheCommandSaySo() throws {
        let p = ContactsProvider()
        p.access = .failed
        XCTAssertEqual(p.results(for: "call anna"), [ContactsProvider.failedRow])
        XCTAssertTrue(p.results(for: "anna").isEmpty)
        XCTAssertEqual(ContactsProvider.failedRow.title, "Couldn't read Contacts")
        let r = ContactsCommand.answer(Wire.Request(op: .contacts, target: "anna", text: "find"), access: .failed,
                                       index: ContactsIndex([]), recents: ContactRecents())
        XCTAssertTrue(r.reply.error?.hasPrefix("Couldn't read Contacts") == true)
    }

    func testTheLibraryRetriesOnlyThroughThePolicy() throws {
        let lib = try Repo.code("Sources/BaneySpaces/ContactsLibrary.swift")
        XCTAssertTrue(lib.contains("retry.failed()"), "a failed read asks the policy for its back-off")
        XCTAssertTrue(lib.contains("retryWork == nil { load() }"), "a waiting retry is never read sooner")
        XCTAssertTrue(lib.contains("if now == .loading, retry.gaveUp { now = .failed }"))
        let launcher = try Repo.code("Sources/BaneySpaces/Launcher.swift")
        XCTAssertTrue(launcher.contains("ContactsLibrary.shared.launcherOpened()"))
        XCTAssertTrue(launcher.contains("ContactsLibrary.shared.provider.useApps("))
    }
}

/// The app's side, read from its sources (the app target can't be imported here).
final class ContactsSourceTests: XCTestCase {
    func testContactsAreReadOffTheMainThreadAndAgainWhenTheyChange() throws {
        let lib = try Repo.code("Sources/BaneySpaces/ContactsLibrary.swift")
        XCTAssertTrue(lib.contains("enumerateContacts"))
        XCTAssertTrue(lib.contains("CNContactStoreDidChange"))
        XCTAssertTrue(lib.contains("queue.async"), "the read runs on its own queue")
        XCTAssertTrue(lib.contains("CNContactThumbnailImageDataKey"))
        XCTAssertTrue(lib.contains("CNContactNicknameKey") && lib.contains("CNContactOrganizationNameKey"))
        // Never asked for at start: only `requestAccess`, and only from the permission flow after a click.
        XCTAssertFalse(lib.contains("requestAccess"))
        let model = try Repo.code("Sources/BaneySpaces/Permissions/PermissionsModel.swift")
        XCTAssertTrue(model.contains("requestAccess(for: .contacts)"))
    }

    func testTheUsageStringAndTheLauncherWiring() throws {
        let plist = try Repo.text("Resources/Info.plist")
        XCTAssertTrue(plist.contains("<key>NSContactsUsageDescription</key>"))
        let launcher = try Repo.code("Sources/BaneySpaces/Launcher.swift")
        XCTAssertTrue(launcher.contains("ContactsLibrary.shared.provider"))
        XCTAssertTrue(launcher.contains("case .contactsAccess"))
        XCTAssertTrue(launcher.contains("item.alternate"), "Command-Return runs a row's second action")
        let session = try Repo.code("Sources/BaneySpaces/Session/SessionController.swift")
        XCTAssertTrue(session.contains("r.op == .contacts"))
    }

    func testTheDocsAndSkillSayPolycarpNeverSends() throws {
        let doc = try String(contentsOf: Repo.root.deletingLastPathComponent().appendingPathComponent("docs/contacts.md"), encoding: .utf8)
        XCTAssertTrue(doc.contains("never sends"))
        let skill = try Repo.text("skill/SKILL.md")
        XCTAssertTrue(skill.contains("contacts find"))
        XCTAssertTrue(skill.contains("never sends"))
        for t in [doc, skill] { XCTAssertFalse(t.contains("\u{2014}") || t.contains("\u{2013}"), "no em or en dashes") }
    }
}

/// A key press asks the index on the main thread, so 5,000 people must answer in under 2 ms (GitHub's shared runners
/// get 10). The best of seven runs per query, which measures the code and not how busy the Mac is.
final class ContactsSpeedTests: XCTestCase {
    static let budgetMs = ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" ? 10.0 : 2.0

    static func people(_ n: Int) -> [ContactRecord] {
        let first = ["Anna", "Ben", "Carla", "David", "Elena", "Frank", "Grace", "Hugo", "Ingrid", "José", "Kofi", "Lena",
                     "Marta", "Nina", "Omar", "Paula", "Quinn", "Rosa", "Sven", "Tara", "Uma", "Victor", "Wen", "Ximena", "Yusuf", "Zoë"]
        let last = ["Smith", "Johnson", "Álvarez", "Nguyen", "Okafor", "Müller", "Rossi", "Kowalski", "Tanaka", "Haddad",
                    "O'Brien", "Silva", "Larsen", "Dubois", "Patel", "Kim", "Mendes", "Novak", "Ivanova", "Byrne"]
        let orgs = ["", "", "Acme", "Globex", "Initech", "St. Mary's Parish", "Umbrella", ""]
        var seed: UInt64 = 2026
        func next() -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int(seed >> 33) }
        return (0..<n).map { i in
            let name = "\(first[next() % first.count]) \(last[next() % last.count])\(i % 7 == 0 ? "-\(last[next() % last.count])" : "")"
            return ContactRecord(id: "p\(i)", name: name, nickname: i % 11 == 0 ? "Nick\(i)" : "", organization: orgs[next() % orgs.count],
                                 phones: [ContactHandle(.phone, "555 01\(i)", label: i % 2 == 0 ? "mobile" : "home")],
                                 emails: i % 3 == 0 ? [ContactHandle(.email, "p\(i)@example.com")] : [])
        }
    }

    func testFiveThousandPeopleAnswerAKeyPressInUnderTwoMilliseconds() {
        let people = Self.people(5000)
        let built = ContinuousClock.now
        let index = ContactsIndex(people)
        let buildMs = Double((ContinuousClock.now - built).components.attoseconds) / 1e15
            + Double((ContinuousClock.now - built).components.seconds) * 1000
        var recents = ContactRecents()
        for i in stride(from: 0, to: 400, by: 7) { recents.note(ContactLaunch(people[i], .call)!, at: Double(i)) }
        let ranks = index.ranks(recents)
        var report: [String] = []
        for q in ["a", "an", "ann", "anna sm", "smith", "jose alv", "obrien", "zzq", "nmrs", "acme", "st marys", "kofi okafor"] {
            var best = Double.infinity
            for _ in 0..<7 {
                let t = ContinuousClock.now
                _ = index.search(q, ranks: ranks, limit: 8)
                let d = ContinuousClock.now - t
                best = min(best, Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15)
            }
            report.append("\(q)=\(String(format: "%.3f", best))")
            XCTAssertLessThan(best, Self.budgetMs, "\"\(q)\" took \(best) ms over 5,000 people")
        }
        // The launcher's own path: a message with its draft parses the name by asking the index up to four times.
        let p = ContactsProvider()
        p.use(index)
        p.use(recents)
        p.access = .allowed
        var best = Double.infinity
        for _ in 0..<7 {
            let t = ContinuousClock.now
            _ = p.results(for: "message anna smith running late")
            let d = ContinuousClock.now - t
            best = min(best, Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15)
        }
        report.append("launcher-message=\(String(format: "%.3f", best))")
        XCTAssertLessThan(best, Self.budgetMs * 4, "a message query's rows took \(best) ms")
        print("contacts speed (ms, best of 7, 5,000 people, index built in \(String(format: "%.1f", buildMs)) ms): " + report.joined(separator: " "))
    }
}
