import BaneySpacesCore
import Darwin
import Foundation

/// `polycarp-spaces run-job <name>`: what a terminal is told to run when Polycarp opens a program in it. Polycarp writes
/// the job; this reads it once and becomes it, so no word of it passes through a command line (R-D10). Not in the usage:
/// nobody types it.
enum RunJobCommand {
    static func run(_ args: [String]) -> Never {
        let home = FileManager.default.homeDirectoryForCurrentUser
        guard args.count == 1, let job = TerminalJobs(folder: TerminalJobs.folder(home: home)).take(args[0]) else {
            fail("that was started already, or too long ago; open it again from Polycarp")
        }
        if chdir(job.folder) != 0 { fail("can't open \(job.folder): \(String(cString: strerror(errno)))") }
        for (key, value) in job.environment(ProcessInfo.processInfo.environment) { setenv(key, value, 1) }
        var words = job.exec.map { strdup($0) }
        words.append(nil)
        execv(job.exec[0], words)
        fail("can't start \(job.exec[0]): \(String(cString: strerror(errno)))")
    }

    /// The window is this command's own and closes with it, so a line nobody has read yet waits for Return.
    private static func fail(_ line: String) -> Never {
        FileHandle.standardError.write(Data("polycarp-spaces: \(line)\n".utf8))
        if isatty(0) != 0 { FileHandle.standardError.write(Data("Press Return to close.\n".utf8)); _ = readLine() }
        exit(1)
    }
}
