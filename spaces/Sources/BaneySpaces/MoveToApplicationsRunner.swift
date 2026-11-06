import AppKit
import BaneySpacesCore

/// Opened from the disk image, Downloads or a translocated (temporary, read-only) path, Polycarp asks once to move itself to
/// Applications (`MoveToApplications` decides and words it). It runs before anything else starts and ends this process:
/// the copy opens, or the person chose Quit, or a plain alert said what happened. Never run twice (the copy carries `--after-move`).
enum MoveToApplicationsRunner {
    static func runIfNeeded(home: URL) {
        let bundle = Bundle.main.bundleURL
        guard MoveToApplications.shouldAsk(arguments: CommandLine.arguments, bundle: bundle, home: home) else { return }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        guard alert(MoveToApplications.askTitle, MoveToApplications.askDetail, buttons: [MoveToApplications.moveButton, MoveToApplications.quitButton]) else { exit(0) }

        let fm = FileManager.default
        let original = MoveToApplications.original(of: bundle, resolve: originalPath)
        let thisVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let plan = MoveToApplications.plan(
            bundle: bundle, original: original, home: home, canWrite: { fm.isWritableFile(atPath: $0.path) },
            installed: MoveToApplications.installedCopies(home: home), installedVersion: installedVersion,
            thisVersion: thisVersion, mountedImages: mountedImages())
        try? fm.createDirectory(at: plan.destination.deletingLastPathComponent(), withIntermediateDirectories: true)

        if !plan.openInstalledOnly {
            // Every installed copy that runs is asked to quit and waited for (by its process, not its flags); if one won't,
            // nothing is changed.
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: Product.bundleID).filter { app in
                !app.isTerminated && plan.existing.contains { $0.standardizedFileURL == app.bundleURL?.standardizedFileURL }
            }
            running.forEach { $0.terminate() }
            let gone = MoveToApplications.wait(until: { running.allSatisfy { $0.isTerminated || kill($0.processIdentifier, 0) != 0 } },
                                               pause: { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) })
            guard gone else {
                _ = alert(MoveToApplications.stillOpenTitle, MoveToApplications.stillOpenDetail, buttons: ["OK"])
                exit(0)
            }
            do { try replace(plan, fm) } catch {
                _ = alert(MoveToApplications.failedTitle, MoveToApplications.failedDetail, buttons: ["OK"])
                exit(1)
            }
        }

        // Open the installed copy, and only when it really is open let go of the disk image and tidy Downloads.
        guard openAndWait(plan.destination) else {
            _ = alert(MoveToApplications.didNotOpenTitle, MoveToApplications.didNotOpenDetail, buttons: ["OK"])
            exit(1)
        }
        if let original = plan.trashOriginal { try? fm.trashItem(at: original, resultingItemURL: nil) }
        if let volume = plan.eject {
            let cmd = MoveToApplications.ejectCommand(volume: volume)
            let eject = Process()
            eject.executableURL = URL(fileURLWithPath: cmd[0])
            eject.arguments = Array(cmd.dropFirst())
            eject.standardOutput = FileHandle.nullDevice; eject.standardError = FileHandle.nullDevice
            try? eject.run()
        }
        exit(0)
    }

    /// Copy beside the final place under another name; set the old copy aside (not into the Trash yet); move the new one in; only
    /// then trash the old one. If anything fails, the old copy is put back.
    private static func replace(_ plan: MoveToApplications.Plan, _ fm: FileManager) throws {
        let folder = plan.destination.deletingLastPathComponent()
        let temp = folder.appendingPathComponent(".\(Product.name)-moving.app")
        let aside = folder.appendingPathComponent(".\(Product.name)-old.app")
        try? fm.removeItem(at: temp); try? fm.removeItem(at: aside)
        do {
            try fm.copyItem(at: plan.source, to: temp)
            MoveToApplications.clearDownloadMark(at: temp)
            let hadOld = fm.fileExists(atPath: plan.destination.path)
            if hadOld { try fm.moveItem(at: plan.destination, to: aside) }
            do { try fm.moveItem(at: temp, to: plan.destination) } catch {
                if hadOld { try? fm.moveItem(at: aside, to: plan.destination) }
                throw error
            }
            if hadOld { try? fm.trashItem(at: aside, resultingItemURL: nil) }
        } catch {
            try? fm.removeItem(at: temp)
            throw error
        }
    }

    /// `open` ran and exited 0, and then an instance of the installed copy is really running (up to 10 s).
    private static func openAndWait(_ app: URL) -> Bool {
        let open = Process()
        open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        open.arguments = ["-n", app.path, "--args", MoveToApplications.movedFlag]
        guard (try? open.run()) != nil else { return false }
        open.waitUntilExit()
        guard open.terminationStatus == 0 else { return false }
        return MoveToApplications.wait(until: {
            NSRunningApplication.runningApplications(withBundleIdentifier: Product.bundleID)
                .contains { !$0.isTerminated && $0.bundleURL?.standardizedFileURL == app.standardizedFileURL }
        }, limit: 10, pause: { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) })
    }

    private static func installedVersion(_ app: URL) -> String? {
        (NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")))?["CFBundleVersion"] as? String
    }

    /// The mount points `hdiutil info -plist` lists; nothing else is ever ejected.
    private static func mountedImages() -> Set<String> {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        p.arguments = ["info", "-plist"]
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return MoveToApplications.mountedImages(infoPlist: data)
    }

    /// macOS's own answer for where a translocated app really is (Security's SecTranslocateCreateOriginalPathForURL).
    private static func originalPath(_ url: URL) -> URL? {
        typealias Fn = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        guard let h = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
              let sym = dlsym(h, "SecTranslocateCreateOriginalPathForURL") else { return nil }
        let fn = unsafeBitCast(sym, to: Fn.self)
        var err: Unmanaged<CFError>?
        return fn(url as CFURL, &err)?.takeRetainedValue() as URL?
    }

    /// True when the first button was pressed.
    private static func alert(_ title: String, _ detail: String, buttons: [String]) -> Bool {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = detail
        buttons.forEach { a.addButton(withTitle: $0) }
        return a.runModal() == .alertFirstButtonReturn
    }
}
