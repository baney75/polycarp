import AppKit
import BaneySpacesCore
import Combine
import SwiftUI

/// The month the bar's calendar is on.
final class CalendarModel: ObservableObject {
    @Published private(set) var grid: MonthGrid
    private(set) var today: Date

    init(now: Date = Date()) {
        today = now
        grid = MonthGrid(of: now, today: now)
    }

    func open(now: Date = Date()) {
        today = now
        grid = MonthGrid(of: now, today: now)
    }

    func go(_ months: Int) { grid = MonthGrid(of: grid.month(by: months), today: today) }

    var isHere: Bool { Calendar.current.isDate(grid.month, equalTo: today, toGranularity: .month) }

    /// Left and right go a month, up and down a year, T back to today.
    func key(_ event: NSEvent) -> Bool {
        switch event.specialKey {
        case .leftArrow: go(-1)
        case .rightArrow: go(1)
        case .upArrow: go(-12)
        case .downArrow: go(12)
        default:
            guard event.charactersIgnoringModifiers?.lowercased() == "t" else { return false }
            open(now: today)
        }
        return true
    }
}

/// The calendar the clock opens: today, and a month at a time.
struct BarCalendar: View {
    static let width: CGFloat = 276
    @ObservedObject var model: CalendarModel
    @ObservedObject private var appearance = Appearance.shared
    let close: () -> Void
    @State private var wheel = BarScroll()

    private static let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                Text(model.today.formatted(.dateTime.weekday(.wide))).font(Chrome.font(12)).foregroundStyle(Chrome.muted)
                Text(model.today.formatted(.dateTime.month(.wide).day()))
                    .font(Chrome.display(22) ?? Chrome.font(22, .semibold)).foregroundStyle(Chrome.wash())
            }
            .padding(.leading, 6)
            Chrome.edge(0.14).frame(height: 1)
            HStack(spacing: 0) {
                Text(model.grid.month.formatted(.dateTime.month(.wide).year()))
                    .font(Chrome.font(12.5, .semibold)).foregroundStyle(Chrome.wash(0.9)).padding(.leading, 6)
                Spacer(minLength: 8)
                if !model.isHere { BarPanelButton("Today") { model.open(now: model.today) } }
                BarPanelButton(symbol: "chevron.left", "The month before") { model.go(-1) }
                BarPanelButton(symbol: "chevron.right", "The next month") { model.go(1) }
            }
            .frame(height: 26)
            LazyVGrid(columns: Self.columns, spacing: 2) {
                ForEach(Array(model.grid.weekdays.enumerated()), id: \.offset) { _, name in
                    Text(name).font(Chrome.font(11)).foregroundStyle(Chrome.muted).frame(height: 20)
                }
                ForEach(model.grid.days) { day($0) }
            }
            .background {
                PointerArea(onScroll: { event in
                    model.go(wheel.step(Double(event.scrollingDeltaY), precise: event.hasPreciseScrollingDeltas,
                                        momentum: !event.momentumPhase.isEmpty, at: event.timestamp))
                }) { _ in }
            }
            Chrome.edge(0.14).frame(height: 1)
            BarPanelButton("Open Calendar") {
                close()
                if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.iCal") { NSWorkspace.shared.open(app) }
            }
            .padding(.leading, -2)
        }
        .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 9)
        .frame(width: Self.width)
        .background(Chrome.panelBackground(.launcherMini))
        .clipShape(Chrome.shape(.launcherMini))
        .environment(\.colorScheme, Chrome.scheme)
    }

    private func day(_ d: MonthGrid.Day) -> some View {
        Text("\(d.number)")
            .font(Chrome.font(12.5, d.isToday ? .semibold : .regular)).monospacedDigit()
            .foregroundStyle(d.isToday ? Chrome.onAccent : !d.inMonth ? Chrome.wash(0.28) : Chrome.wash(d.isWeekend ? 0.62 : 0.92))
            .frame(width: 30, height: 28)
            .background { if d.isToday { Chrome.shape(.launcherThumb).fill(Chrome.accent) } }
            .frame(maxWidth: .infinity)
            .accessibilityLabel(d.date.formatted(.dateTime.weekday(.wide).month(.wide).day().year()) + (d.isToday ? ", today" : ""))
    }
}
