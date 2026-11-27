import BaneySpacesCore
import Foundation

/// `polycarp-spaces agent probe [--rounds N] [--seconds S] [--json]` (spec/tiling-speed.md R-TS12): starts the probe in
/// the running app, asks how it stands every half second until it ends, and prints its numbers. Exit 0 when every
/// sample landed, 1 on a miss or an early end, 2 on a refusal.
func probeCommand(_ args: [String]) -> Never {
    let start = Wire.Request(op: .agent, text: "probe", args: ["start", "\(getpid())", flag("--rounds", in: args) ?? "",
                                                                flag("--seconds", in: args) ?? ""])
    guard let first = Wire.call(start) else { fail("Polycarp isn't running, or hasn't finished starting (it needs Accessibility).", code: 2) }
    guard first.ok else { fail(first.error ?? "the probe was refused", code: 2) }
    var info = first.info ?? [:]
    while info["state"] == "running" {
        usleep(500_000)
        guard let r = Wire.call(Wire.Request(op: .agent, text: "probe", args: ["status"])), r.ok else { fail("Polycarp stopped answering") }
        info = r.info ?? [:]
    }
    guard info["state"] == "done", let json = info["result"], let stats = TilingProbe.decode(json) else {
        fail("the probe ended early: \(info["why"] ?? "?")")
    }
    if args.contains("--json") {
        out(json)
    } else {
        func ms(_ v: Int?) -> String { v.map(String.init) ?? "-" }
        out("kind          n    p50    p90    max  misses  writes")
        for s in stats {
            out(s.kind.padding(toLength: 12, withPad: " ", startingAt: 0) + [String(s.n), ms(s.p50), ms(s.p90), ms(s.max), String(s.misses), String(s.writes)]
                .enumerated().map { i, v in String(repeating: " ", count: max(0, [3, 7, 7, 7, 8, 8][i] - v.count)) + v }.joined())
        }
    }
    exit(TilingProbe.code(stats))
}
