import Foundation

/// The four switches of the day's rhythm, kept in the app's defaults under these names.
public struct RhythmSettings: Equatable, Sendable {
    public enum Key {
        public static let morningQuestion = "morningQuestion"
        public static let eveningExamen = "eveningExamen"
        public static let examenHour = "examenHour"
        public static let restOnSunday = "restOnSunday"
    }

    /// Ask the morning question once a day.
    public var morningQuestion = true
    /// Offer the evening examen once a day.
    public var eveningExamen = true
    /// The hour the evening starts, local time. Kept between the day's start and 11 pm.
    public var examenHour = 18 { didSet { examenHour = Self.clampHour(examenHour) } }
    /// Sunday is the Lord's Day: the surfaces rest.
    public var restOnSunday = true

    public init(morningQuestion: Bool = true, eveningExamen: Bool = true, examenHour: Int = 18, restOnSunday: Bool = true) {
        self.morningQuestion = morningQuestion
        self.eveningExamen = eveningExamen
        self.examenHour = Self.clampHour(examenHour)
        self.restOnSunday = restOnSunday
    }

    /// The defaults to register, so an unset key reads as its default rather than off or 0.
    public static let registered: [String: Any] = [
        Key.morningQuestion: true, Key.eveningExamen: true, Key.examenHour: 18, Key.restOnSunday: true,
    ]

    /// What `defaults` holds, each missing key at its default.
    public init(defaults: UserDefaults) {
        func bool(_ k: String, _ d: Bool) -> Bool { defaults.object(forKey: k) == nil ? d : defaults.bool(forKey: k) }
        self.init(morningQuestion: bool(Key.morningQuestion, true), eveningExamen: bool(Key.eveningExamen, true),
                  examenHour: defaults.object(forKey: Key.examenHour) == nil ? 18 : defaults.integer(forKey: Key.examenHour),
                  restOnSunday: bool(Key.restOnSunday, true))
    }

    static func clampHour(_ h: Int) -> Int { min(23, max(DayClock.startHour + 1, h)) }
}

/// Which prompts have been given, by day. Days compare in order, so a prompt given on a later day (after a flight
/// west, the local date can go back) is never asked again on an earlier one.
public struct RhythmState: Codable, Equatable, Sendable {
    public var morningAsked: PurposeDay?
    public var examenOffered: PurposeDay?
    public init(morningAsked: PurposeDay? = nil, examenOffered: PurposeDay? = nil) {
        self.morningAsked = morningAsked; self.examenOffered = examenOffered
    }
}

/// When the morning question and the evening examen are due, and whether today is the Lord's Day. Pure: a clock, the
/// settings and what was already given decide it. The app asks on input (`LedgerTracker`'s tick sees it), so "due" means
/// the first time you are at the Mac once the moment has come.
public enum Rhythm {
    public enum Prompt: String, Sendable { case morningQuestion, eveningExamen }

    /// The question the day starts with.
    public static let morningQuestion = "What is the one thing today?"

    /// The evening examen, in order: thanks, the day reviewed against the one thing, sorrow, and tomorrow.
    public static let examenQuestions = [
        "What am I thankful for today?",
        "Where did I will the one thing?",
        "Where was I divided?",
        "What do I confess, and what do I ask for tomorrow?",
    ]

    /// When the evening starts on `day`: `examenHour`:00 local on its date.
    public static func eveningStart(of day: PurposeDay, settings: RhythmSettings, clock: DayClock) -> Date {
        clock.time(on: day, hour: settings.examenHour)
    }

    /// Input within this long means someone is at the Mac. A prompt never comes due to an empty room (the 4 am rollover,
    /// a night with the Mac awake); it waits for the next real input.
    public static let recentInput: TimeInterval = 120

    /// What to show now, if anything, with `idle` seconds since the last input. The examen once the evening has started;
    /// the morning question before then. A day whose first input comes after the evening starts gets the examen only: a
    /// morning question at 7 pm asks too late.
    public static func due(now: Date, idle: TimeInterval, state: RhythmState, settings: RhythmSettings, clock: DayClock) -> Prompt? {
        guard idle < recentInput else { return nil }
        let today = clock.day(of: now)
        let evening = now >= eveningStart(of: today, settings: settings, clock: clock)
        if settings.eveningExamen, evening, notYet(state.examenOffered, today) { return .eveningExamen }
        if settings.morningQuestion, !(evening && settings.eveningExamen), notYet(state.morningAsked, today) { return .morningQuestion }
        return nil
    }

    /// `state` with `prompt` given today. Giving the examen also counts the morning as past, so it can't come after it.
    public static func given(_ prompt: Prompt, now: Date, state: RhythmState, clock: DayClock) -> RhythmState {
        let today = clock.day(of: now)
        var s = state
        switch prompt {
        case .morningQuestion: s.morningAsked = later(s.morningAsked, today)
        case .eveningExamen:
            s.examenOffered = later(s.examenOffered, today)
            s.morningAsked = later(s.morningAsked, today)
        }
        return s
    }

    /// Whether the day `now` falls in is a Sunday. The Lord's Day runs from 4 am Sunday to 4 am Monday, like every day here.
    public static func isLordsDay(now: Date, clock: DayClock) -> Bool { clock.weekday(of: clock.day(of: now)) == 1 }

    /// Whether the surfaces rest now: Sunday with `restOnSunday` on.
    public static func rests(now: Date, settings: RhythmSettings, clock: DayClock) -> Bool {
        settings.restOnSunday && isLordsDay(now: now, clock: clock)
    }

    private static func notYet(_ given: PurposeDay?, _ today: PurposeDay) -> Bool { given.map { $0 < today } ?? true }
    private static func later(_ a: PurposeDay?, _ b: PurposeDay) -> PurposeDay { a.map { max($0, b) } ?? b }
}
