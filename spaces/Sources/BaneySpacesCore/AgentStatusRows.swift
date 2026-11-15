import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// The rows of `polycarp-spaces agent status`. 11-15 on 833ad1f (#311): after TextEdit pid 16828 quit, status still listed
/// its window 68007, read from the model, which keeps a window until the next scan. `agent windows` scans first and didn't.
/// A row whose process has exited is dropped without a scan.
public enum AgentStatusRows {
    public static func live<Row>(_ rows: [Row], pid: (Row) -> Int32?, alive: (Int32) -> Bool = processAlive) -> [Row] {
        rows.filter { pid($0).map(alive) ?? false }
    }

    /// The process runs: signal 0 reaches it, or it is there and not ours to signal.
    public static func processAlive(_ pid: Int32) -> Bool { pid > 0 && (kill(pid, 0) == 0 || errno == EPERM) }
}
