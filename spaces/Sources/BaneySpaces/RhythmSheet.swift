import AppKit
import BaneySpacesCore
import SwiftUI

/// The two prompts of the day: the morning sheet ("What is this day for?") and the evening examen. Each shows when
/// `PurposeKeeper` says it is due, once a day, as one card in the middle of the screen. It appears without taking the
/// keyboard, so nothing you are typing lands in it; click into it to answer. Return moves to the next line; ⌘Return
/// keeps the card, and Esc (Not today, Later) puts it off; either counts it as given. A card belongs to its day and
/// prompt (`RhythmSheets.step`). Main thread only.
final class RhythmSheet {
    static let shared = RhythmSheet()

    private var panel: NSPanel?
    private var showing: Rhythm.Prompt?
    private var shownOn: PurposeDay?
    /// The workspaces in use and the one you are on, from the app.
    var workspaces: () -> (inUse: Set<Int>, current: Int) = { ([], 1) }

    func start() {
        NotificationCenter.default.addObserver(forName: PurposeKeeper.promptDue, object: nil, queue: .main) { [weak self] _ in
            self?.dueChanged()
        }
        dueChanged()
    }

    /// Shows `prompt` now, due or not: the menu's "Evening Examen…".
    func show(_ prompt: Rhythm.Prompt) {
        if showing == prompt, let panel { panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        present(prompt, takeKeyboard: true)
    }

    private func dueChanged() {
        let keeper = PurposeKeeper.shared
        switch RhythmSheets.step(due: keeper.due, showing: showing, shownOn: shownOn, today: keeper.ledger.dayClock.day(of: Date())) {
        case .stay: break
        case .show(let prompt): present(prompt, takeKeyboard: false)
        case .close: close()
        }
    }

    private var today: PurposeDay { PurposeKeeper.shared.ledger.dayClock.day(of: Date()) }

    private func present(_ prompt: Rhythm.Prompt, takeKeyboard: Bool) {
        close()
        let keeper = PurposeKeeper.shared
        let named = keeper.purposes.snapshot
        let root: AnyView
        switch prompt {
        case .morningQuestion:
            let w = workspaces()
            let rows = RhythmSheets.morningRows(inUse: w.inUse, named: named.all, current: w.current)
            let model = MorningModel(oneThing: named.oneThing?.text ?? "",
                                     rows: rows.map { .init(workspace: $0, text: named.purpose(of: $0) ?? "") })
            root = AnyView(MorningView(model: model, done: { [weak self] keep in self?.finishMorning(model, keep: keep) }))
        case .eveningExamen:
            let rows = RhythmSheets.timeRows(seconds: keeper.ledger.today(), named: named.all)
            let model = ExamenModel(rows: rows, tomorrow: keeper.purposes.tomorrow?.text ?? "")
            root = AnyView(ExamenView(model: model, done: { [weak self] keep in self?.finishExamen(model, keep: keep) }))
        }
        let host = NSHostingView(rootView: root.environment(\.colorScheme, Chrome.scheme))
        let size = host.fittingSize
        let p = SheetPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
                           backing: .buffered, defer: false)
        p.level = .floating
        p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.isMovableByWindowBackground = true
        p.title = prompt == .morningQuestion ? RhythmSheets.morningTitle : RhythmSheets.examenTitle
        p.contentView = host
        if let screen = NSScreen.main {
            let v = screen.visibleFrame
            p.setFrameOrigin(NSPoint(x: v.midX - size.width / 2, y: v.minY + v.height * 0.58 - size.height / 2))
        }
        if takeKeyboard { p.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) } else { p.orderFrontRegardless() }
        panel = p
        showing = prompt
        shownOn = today
        Trace.log("rhythm: \(prompt.rawValue) shown")
    }

    /// Writes only what you changed on the card, so an edit made elsewhere since it opened stands.
    private func finishMorning(_ m: MorningModel, keep: Bool) {
        guard shownOn == today else { close(); dueChanged(); return }
        let store = PurposeKeeper.shared.purposes
        if keep {
            do {
                if m.oneThing != m.oneThingBefore { try store.setOneThing(m.oneThing, workspace: workspaces().current) }
                for row in m.rows where row.text != row.before { try store.setPurpose(row.text, for: row.workspace) }
            } catch {
                m.problem = (error as? Purposes.Problem)?.description ?? error.localizedDescription
                return
            }
        }
        // Closed first: `given` posts the next due prompt at once, and its card must not be the one closed.
        close()
        PurposeKeeper.shared.given(.morningQuestion)
        Trace.log("rhythm: morning \(keep ? "kept" : "skipped")")
        dueChanged()
    }

    /// An examen left open past the day's start is dropped: its time and its tomorrow belong to a day that is over.
    private func finishExamen(_ m: ExamenModel, keep: Bool) {
        guard shownOn == today else { close(); dueChanged(); return }
        let keeper = PurposeKeeper.shared
        guard keep else {
            close()
            keeper.given(.eveningExamen)
            Trace.log("rhythm: examen put off")
            dueChanged()
            return
        }
        do { try keeper.purposes.setTomorrow(m.tomorrow) } catch {
            m.problem = (error as? Purposes.Problem)?.description ?? error.localizedDescription
            return
        }
        close()
        keeper.keepExamen(RhythmSheets.answers(m.answers, tomorrow: m.tomorrow))
        dueChanged()
    }

    private func close() {
        panel?.orderOut(nil)
        panel = nil
        showing = nil
        shownOn = nil
    }
}

/// A borderless panel that can still take the keyboard once you click into it.
private final class SheetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// MARK: Morning

final class MorningModel: ObservableObject {
    struct Row: Identifiable {
        let workspace: Int
        var text: String
        let before: String
        var id: Int { workspace }
        init(workspace: Int, text: String) { self.workspace = workspace; self.text = text; before = text }
    }
    @Published var oneThing: String
    let oneThingBefore: String
    @Published var rows: [Row]
    @Published var problem: String?
    init(oneThing: String, rows: [Row]) { self.oneThing = oneThing; oneThingBefore = oneThing; self.rows = rows }
}

struct MorningView: View {
    @ObservedObject var model: MorningModel
    let done: (Bool) -> Void
    @FocusState private var focus: Int?

    var body: some View {
        SheetCard(title: RhythmSheets.morningTitle, line: RhythmSheets.morningLine, problem: model.problem) {
            Line(label: "One", placeholder: "The one thing today", text: $model.oneThing, limit: Purposes.oneThingLimit)
                .focused($focus, equals: 0).onSubmit { focus = model.rows.isEmpty ? nil : 1 }
            ForEach(Array($model.rows.enumerated()), id: \.element.id) { i, $row in
                Line(label: "\(row.workspace)", placeholder: "Name it, or leave it free", text: $row.text, limit: Purposes.purposeLimit)
                    .focused($focus, equals: i + 1).onSubmit { focus = i + 1 < model.rows.count ? i + 2 : nil }
            }
        } buttons: {
            SheetButton(title: "Not today", primary: false) { done(false) }.keyboardShortcut(.cancelAction)
            SheetButton(title: "Begin", primary: true) { done(true) }.keyboardShortcut(RhythmKeys.keep)
        }
    }
}

/// Return moves down the card; the main button takes ⌘Return, so Return never keeps a card half written.
enum RhythmKeys {
    static let keep = KeyboardShortcut(.return, modifiers: .command)
}

// MARK: Evening

final class ExamenModel: ObservableObject {
    let rows: [RhythmSheets.TimeRow]
    @Published var answers: [String] = Rhythm.examenQuestions.map { _ in "" }
    @Published var tomorrow: String
    @Published var problem: String?
    init(rows: [RhythmSheets.TimeRow], tomorrow: String) { self.rows = rows; self.tomorrow = tomorrow }
}

struct ExamenView: View {
    @ObservedObject var model: ExamenModel
    let done: (Bool) -> Void
    @FocusState private var focus: Int?

    var body: some View {
        SheetCard(title: RhythmSheets.examenTitle, line: RhythmSheets.examenLine, problem: model.problem) {
            if model.rows.isEmpty {
                Text("No time recorded today.").font(Chrome.font(12)).foregroundStyle(Chrome.muted)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.rows, id: \.workspace) { row in TimeBar(row: row) }
                }
                .padding(.bottom, 4)
            }
            ForEach(Rhythm.examenQuestions.indices, id: \.self) { i in
                Line(label: "\(i + 1)", placeholder: Rhythm.examenQuestions[i], text: $model.answers[i], limit: nil)
                    .focused($focus, equals: i).onSubmit { focus = i + 1 }
            }
            Line(label: "→", placeholder: RhythmSheets.tomorrowQuestion, text: $model.tomorrow, limit: Purposes.oneThingLimit)
                .focused($focus, equals: Rhythm.examenQuestions.count).onSubmit { focus = nil }
        } buttons: {
            SheetButton(title: "Later", primary: false) { done(false) }.keyboardShortcut(.cancelAction)
            SheetButton(title: "Keep", primary: true) { done(true) }.keyboardShortcut(RhythmKeys.keep)
        }
    }
}

private struct TimeBar: View {
    let row: RhythmSheets.TimeRow

    var body: some View {
        HStack(spacing: 10) {
            GeometryReader { g in
                Chrome.shape(.settingsCell)
                    .fill(row.share >= 1 ? Chrome.workspace(row.workspace) : Chrome.wash(0.18))
                    .frame(width: max(6, g.size.width * row.share))
            }
            .frame(width: 120, height: 6)
            Text(row.label).font(Chrome.voice(13)).foregroundStyle(Chrome.wash(0.9)).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 8)
            Text(row.time).font(Chrome.font(11, .medium)).monospacedDigit().foregroundStyle(Chrome.muted)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Shared pieces

/// One card: a serif title, a Kierkegaard line, the fields, and two buttons at the foot.
private struct SheetCard<Fields: View, Buttons: View>: View {
    let title: String
    let line: String
    let problem: String?
    @ViewBuilder let fields: () -> Fields
    @ViewBuilder let buttons: () -> Buttons

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(Chrome.voice(22)).foregroundStyle(Chrome.wash())
            Text(line).font(Chrome.voice(13)).italic().foregroundStyle(Chrome.muted).padding(.bottom, 6)
            fields()
            if let problem {
                Text(problem).font(Chrome.font(12, .medium)).foregroundStyle(Chrome.urgent)
            }
            HStack(spacing: 8) {
                Spacer()
                buttons()
            }
            .padding(.top, 6)
        }
        .padding(22)
        .frame(width: 380)
        .background(Chrome.panelBackground(.hudPanel))
    }
}

/// A numbered line to write on, with a quiet underline. An examen line (`limit` nil) wraps, and once answered keeps its
/// question above it in small type. Text over `limit` shows the count in the urgent color.
private struct Line: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    let limit: Int?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label).font(Chrome.font(11, .semibold)).foregroundStyle(Chrome.muted).frame(width: 26, alignment: .trailing)
            VStack(alignment: .leading, spacing: 3) {
                if limit == nil, !text.isEmpty {
                    Text(placeholder).font(Chrome.font(10.5, .medium)).foregroundStyle(Chrome.muted)
                }
                field
                Chrome.edge(0.5).frame(height: Chrome.width(.settingsCell))
            }
            if let limit, text.count > limit {
                Text("\(text.count)/\(limit)").font(Chrome.font(10, .medium)).monospacedDigit().foregroundStyle(Chrome.urgent)
            }
        }
    }

    @ViewBuilder private var field: some View {
        if limit == nil {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.plain).font(Chrome.voice(14)).foregroundStyle(Chrome.wash())
        } else {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain).font(Chrome.voice(14)).foregroundStyle(Chrome.wash())
        }
    }
}

private struct SheetButton: View {
    let title: String
    let primary: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Chrome.font(12, .medium))
                .foregroundStyle(primary ? Chrome.onAccent : Chrome.wash())
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(Chrome.shape(.settingsCell).fill(primary ? Chrome.accent : Chrome.wash(0.1)))
        }
        .buttonStyle(.plain)
    }
}
