import Foundation

/// Runs differ's standalone server with the Node the app carries, and reports
/// when it exits. Only the latest server's exit is reported: one the app
/// stopped or replaced itself is not news.
final class ServerProcess {
    struct Launch {
        let node: URL
        let serverDirectory: URL
        let exitWithParent: URL
        let port: Int
        let differHome: URL

        var log: URL { differHome.appendingPathComponent("server.log") }

        /// What the server needs from the app's bundle, or nil when this build
        /// carries no server, as `xcodebuild test` and Xcode's Run produce.
        static func inBundle(_ bundle: Bundle, port: Int, differHome: URL) -> Launch? {
            guard let resources = bundle.resourceURL else { return nil }
            let launch = Launch(
                node: bundle.bundleURL.appendingPathComponent("Contents/Helpers/node"),
                serverDirectory: resources.appendingPathComponent("server"),
                exitWithParent: resources.appendingPathComponent("server-exit-with-parent.cjs"),
                port: port,
                differHome: differHome
            )
            let files = [launch.node, launch.serverDirectory.appendingPathComponent("server.js"), launch.exitWithParent]
            return files.allSatisfy { FileManager.default.fileExists(atPath: $0.path) } ? launch : nil
        }
    }

    let launch: Launch
    var onExit: (() -> Void)?
    private var current: Process?
    private var scheduled: Task<Void, Never>?

    init(_ launch: Launch) {
        self.launch = launch
    }

    var isRunningOrScheduled: Bool {
        scheduled != nil || current?.isRunning == true
    }

    /// Stops any server the app is running and starts a fresh one after
    /// `delay` seconds.
    func start(after delay: TimeInterval) {
        let old = current
        stop()
        scheduled = Task { [weak self] in
            // Let the old server release the port before its replacement
            // binds, or the replacement exits at once and counts as a death.
            if let old { await Self.waitForExit(old, timeout: 2, thenKill: true) }
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled, let self else { return }
            self.scheduled = nil
            self.spawn()
        }
    }

    /// Drops a start that hasn't happened yet, when a differ the app didn't
    /// start already answers on the port.
    func cancelScheduled() {
        scheduled?.cancel()
        scheduled = nil
    }

    func stop() {
        cancelScheduled()
        current?.terminate()
        current = nil
    }

    /// Stops the server and waits up to `timeout` for it to exit, so quitting
    /// the app leaves nothing on the port.
    func stopAndWait(timeout: TimeInterval) async {
        let process = current
        stop()
        guard let process else { return }
        await Self.waitForExit(process, timeout: timeout, thenKill: false)
    }

    private static func waitForExit(_ process: Process, timeout: TimeInterval, thenKill: Bool) async {
        let until = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < until {
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard thenKill, process.isRunning else { return }
        kill(process.processIdentifier, SIGKILL)
        while process.isRunning {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private func spawn() {
        let process = Process()
        process.executableURL = launch.node
        // Preload by argument rather than NODE_OPTIONS, so `claude` and the
        // other Node programs the server runs don't inherit it.
        process.arguments = ["--require", launch.exitWithParent.path, "server.js"]
        process.currentDirectoryURL = launch.serverDirectory
        // Give the server a bare PATH: `lib/exec.ts` appends where Homebrew
        // and Claude Code live, and an app launched from the Dock has no
        // shell's PATH to pass on anyway.
        process.environment = [
            "PORT": String(launch.port),
            "HOSTNAME": "127.0.0.1",
            "DIFFER_HOME": launch.differHome.path,
            "HOME": NSHomeDirectory(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        if let log = openLog() {
            process.standardOutput = log
            process.standardError = log
        }
        let id = ObjectIdentifier(process)
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.exited(id) }
        }
        do {
            try process.run()
            current = process
        } catch {
            NSLog("differ: couldn't start the server: \(error)")
            Task { @MainActor in self.onExit?() }
        }
    }

    private func exited(_ id: ObjectIdentifier) {
        guard let current, ObjectIdentifier(current) == id else { return }
        self.current = nil
        onExit?()
    }

    private func openLog() -> FileHandle? {
        let manager = FileManager.default
        try? manager.createDirectory(at: launch.differHome, withIntermediateDirectories: true)
        if !manager.fileExists(atPath: launch.log.path) {
            manager.createFile(atPath: launch.log.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: launch.log) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }
}
